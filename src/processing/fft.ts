import type { AnalysisSelection, FftDetrend, FftWindowType, FftZeroPad, SpectrumResult } from '../types';
import { AnalysisExclusionMask, QualityFlag } from '../data/quality';
import { analyzeTimebase, resampleLinear } from './sampling';

type ComplexBuffers = {
  re: Float64Array;
  im: Float64Array;
  length: number;
};

export interface SpectrumOptions {
  selection?: AnalysisSelection | null;
  windowType?: FftWindowType;
  detrend?: FftDetrend;
  zeroPadMode?: FftZeroPad;
  zeroPadFactor?: number;
  windowOpts?: { beta?: number };
  quality?: ArrayLike<number> | null;
  cacheKey?: string;
}

export interface WindowResult {
  window: Float64Array;
  coherentGain: number;
  enbw: number;
  powerSum: number;
}

export interface SampleRateEstimate {
  fs: number;
  warnings: string[];
  medianDt?: number;
  maxRelativeDeviation?: number;
}

function modifiedBessel0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 50; k += 1) {
    term *= (x * x) / (4 * k * k);
    sum += term;
    if (term < 1e-12) break;
  }
  return sum;
}

export const FFT = {
  nextPowerOfTwo(n: number): number {
    if (!Number.isFinite(n) || n <= 1) return 1;
    return 2 ** Math.ceil(Math.log2(n));
  },

  forward(data: ArrayLike<number>, options: { zeroPadMode?: FftZeroPad; zeroPadFactor?: number } = {}): ComplexBuffers {
    const { zeroPadMode = 'nextPow2', zeroPadFactor = 1 } = options;
    const sourceLength = data.length;
    if (sourceLength === 0) {
      return { re: new Float64Array(0), im: new Float64Array(0), length: 0 };
    }

    const desiredLength = (() => {
      if (zeroPadMode === 'none') return sourceLength;
      if (zeroPadMode === 'factor' && Number.isFinite(zeroPadFactor) && zeroPadFactor > 1) {
        return this.nextPowerOfTwo(Math.max(sourceLength, Math.ceil(sourceLength * zeroPadFactor)));
      }
      return this.nextPowerOfTwo(sourceLength);
    })();

    const safeLength = Number.isFinite(desiredLength) && desiredLength > 0 ? desiredLength : 1;
    const re = new Float64Array(safeLength);
    const im = new Float64Array(safeLength);
    for (let i = 0; i < sourceLength; i++) re[i] = data[i];
    this.transform(re, im);
    return { re, im, length: safeLength };
  },

  inverse(re: Float64Array, im: Float64Array, originalLength?: number): number[] {
    const n = re.length;
    const reWork = re.slice();
    const imWork = im.slice();
    for (let i = 0; i < n; i++) imWork[i] = -imWork[i];
    this.transform(reWork, imWork);

    const output: number[] = [];
    const length = originalLength ?? n;
    for (let i = 0; i < length; i++) {
      output.push(reWork[i] / n);
    }
    return output;
  },

  getMagnitudeDB(
    re: ArrayLike<number>,
    im: ArrayLike<number>,
    options: { coherentGain?: number; lengthOverride?: number; sampleCount?: number } = {}
  ): number[] {
    const linear = this.getLinearMagnitude(re, im, options);
    return linear.map((magnitude) => 20 * Math.log10(Math.max(magnitude, 1e-12)));
  },

  getLinearMagnitude(
    re: ArrayLike<number>,
    im: ArrayLike<number>,
    options: { coherentGain?: number; lengthOverride?: number; sampleCount?: number } = {}
  ): number[] {
    const { coherentGain = 1, lengthOverride = null, sampleCount = null } = options;
    const transformLength = re.length;
    const normalizationLength = sampleCount || lengthOverride || transformLength;
    const half = Math.floor(transformLength / 2);
    const scale = 2 / (normalizationLength * (coherentGain || 1));
    const mags: number[] = [];
    for (let i = 0; i <= half; i += 1) {
      const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]) * scale;
      mags.push(i === 0 || (transformLength % 2 === 0 && i === half) ? mag * 0.5 : mag);
    }
    return mags;
  },

  getPowerSpectralDensity(
    re: ArrayLike<number>,
    im: ArrayLike<number>,
    options: { fs: number; windowPower: number }
  ): number[] {
    const transformLength = re.length;
    const half = Math.floor(transformLength / 2);
    const denominator = options.fs * options.windowPower;
    const psd: number[] = [];
    for (let i = 0; i <= half; i += 1) {
      const power = re[i] * re[i] + im[i] * im[i];
      const oneSidedFactor = i === 0 || (transformLength % 2 === 0 && i === half) ? 1 : 2;
      psd.push(denominator > 0 ? (oneSidedFactor * power) / denominator : 0);
    }
    return psd;
  },

  getPhaseDegrees(re: ArrayLike<number>, im: ArrayLike<number>, options: { lengthOverride?: number } = {}): number[] {
    const n = options.lengthOverride || re.length;
    const half = Math.floor(n / 2);
    const phase: number[] = [];
    for (let i = 0; i <= half; i += 1) {
      phase.push(Math.atan2(im[i], re[i]) * (180 / Math.PI));
    }
    return phase;
  },

  transform(re: Float64Array, im: Float64Array): void {
    if (re.length !== im.length) throw new Error('Real and imaginary FFT buffers must have equal lengths.');
    if (re.length <= 1) return;
    if (this.isPowerOfTwo(re.length)) {
      this.transformRadix2(re, im);
      return;
    }
    this.transformBluestein(re, im);
  },

  isPowerOfTwo(value: number): boolean {
    return value > 0 && Number.isInteger(Math.log2(value));
  },

  transformRadix2(re: Float64Array, im: Float64Array): void {
    const n = re.length;
    if (!this.isPowerOfTwo(n)) throw new Error('Radix-2 FFT requires a power-of-two buffer length.');
    let target = 0;
    for (let i = 0; i < n - 1; i++) {
      if (i < target) {
        const tempRe = re[i];
        re[i] = re[target];
        re[target] = tempRe;
        const tempIm = im[i];
        im[i] = im[target];
        im[target] = tempIm;
      }
      let k = n >> 1;
      while (k <= target) {
        target -= k;
        k >>= 1;
      }
      target += k;
    }

    for (let step = 1; step < n; step <<= 1) {
      const jump = step << 1;
      const deltaAngle = -Math.PI / step;
      const sine = Math.sin(0.5 * deltaAngle);
      const multiplierRe = -2.0 * sine * sine;
      const multiplierIm = Math.sin(deltaAngle);
      let wRe = 1.0;
      let wIm = 0.0;

      for (let group = 0; group < step; group++) {
        for (let pair = group; pair < n; pair += jump) {
          const match = pair + step;
          const prodRe = wRe * re[match] - wIm * im[match];
          const prodIm = wRe * im[match] + wIm * re[match];
          re[match] = re[pair] - prodRe;
          im[match] = im[pair] - prodIm;
          re[pair] += prodRe;
          im[pair] += prodIm;
        }
        const tempWRe = wRe;
        wRe = wRe * multiplierRe - wIm * multiplierIm + wRe;
        wIm = wIm * multiplierRe + tempWRe * multiplierIm + wIm;
      }
    }
  },

  transformBluestein(re: Float64Array, im: Float64Array): void {
    const n = re.length;
    const convolutionLength = this.nextPowerOfTwo(2 * n - 1);
    const aRe = new Float64Array(convolutionLength);
    const aIm = new Float64Array(convolutionLength);
    const bRe = new Float64Array(convolutionLength);
    const bIm = new Float64Array(convolutionLength);

    for (let i = 0; i < n; i += 1) {
      const angle = (Math.PI * ((i * i) % (2 * n))) / n;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      aRe[i] = re[i] * cosine + im[i] * sine;
      aIm[i] = im[i] * cosine - re[i] * sine;
      bRe[i] = cosine;
      bIm[i] = sine;
      if (i > 0) {
        bRe[convolutionLength - i] = cosine;
        bIm[convolutionLength - i] = sine;
      }
    }

    this.transformRadix2(aRe, aIm);
    this.transformRadix2(bRe, bIm);
    for (let i = 0; i < convolutionLength; i += 1) {
      const real = aRe[i] * bRe[i] - aIm[i] * bIm[i];
      const imaginary = aRe[i] * bIm[i] + aIm[i] * bRe[i];
      aRe[i] = real;
      aIm[i] = -imaginary;
    }
    this.transformRadix2(aRe, aIm);

    for (let i = 0; i < n; i += 1) {
      const convolutionReal = aRe[i] / convolutionLength;
      const convolutionImaginary = -aIm[i] / convolutionLength;
      const angle = (Math.PI * ((i * i) % (2 * n))) / n;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      re[i] = convolutionReal * cosine + convolutionImaginary * sine;
      im[i] = convolutionImaginary * cosine - convolutionReal * sine;
    }
  },

  applyDetrend(values: ArrayLike<number> = [], mode: FftDetrend = 'none'): number[] {
    const n = values.length;
    const copy = Array.from(values);
    if (n === 0 || mode === 'none') return copy;
    if (mode === 'removeMean') {
      const mean = copy.reduce((acc, v) => acc + v, 0) / n;
      return copy.map((v) => v - mean);
    }
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;
    for (let i = 0; i < n; i += 1) {
      sumX += i;
      sumY += copy[i];
      sumXY += i * copy[i];
      sumXX += i * i;
    }
    const denom = n * sumXX - sumX * sumX;
    const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
    const intercept = (sumY - slope * sumX) / n;
    return copy.map((v, idx) => v - (slope * idx + intercept));
  },

  getWindow(windowType: FftWindowType = 'hann', length = 0, opts: { beta?: number } = {}): WindowResult {
    const n = Math.max(1, length);
    if (n <= 1) return { window: new Float64Array([1]), coherentGain: 1, enbw: 1, powerSum: 1 };
    const window = new Float64Array(n);
    if (windowType === 'rectangular') {
      window.fill(1);
      return { window, coherentGain: 1, enbw: 1, powerSum: n };
    }

    const pi = Math.PI;
    switch (windowType) {
      case 'hamming':
        for (let i = 0; i < n; i += 1) window[i] = 0.54 - 0.46 * Math.cos((2 * pi * i) / (n - 1));
        break;
      case 'blackman':
        for (let i = 0; i < n; i += 1)
          window[i] = 0.42 - 0.5 * Math.cos((2 * pi * i) / (n - 1)) + 0.08 * Math.cos((4 * pi * i) / (n - 1));
        break;
      case 'blackman-harris':
        for (let i = 0; i < n; i += 1) {
          window[i] =
            0.35875 -
            0.48829 * Math.cos((2 * pi * i) / (n - 1)) +
            0.14128 * Math.cos((4 * pi * i) / (n - 1)) -
            0.01168 * Math.cos((6 * pi * i) / (n - 1));
        }
        break;
      case 'flattop':
        for (let i = 0; i < n; i += 1) {
          window[i] =
            1 -
            1.93 * Math.cos((2 * pi * i) / (n - 1)) +
            1.29 * Math.cos((4 * pi * i) / (n - 1)) -
            0.388 * Math.cos((6 * pi * i) / (n - 1)) +
            0.0322 * Math.cos((8 * pi * i) / (n - 1));
        }
        break;
      case 'kaiser': {
        const beta = Number.isFinite(opts.beta) ? (opts.beta as number) : 6;
        const denom = modifiedBessel0(beta);
        for (let i = 0; i < n; i += 1) {
          const ratio = (2 * i) / (n - 1) - 1;
          window[i] = modifiedBessel0(beta * Math.sqrt(1 - ratio * ratio)) / denom;
        }
        break;
      }
      case 'hann':
      default:
        for (let i = 0; i < n; i += 1) window[i] = 0.5 * (1 - Math.cos((2 * pi * i) / (n - 1)));
        break;
    }

    let sum = 0;
    let power = 0;
    for (let i = 0; i < n; i += 1) {
      sum += window[i];
      power += window[i] * window[i];
    }
    const coherentGain = sum / n;
    const enbw = coherentGain === 0 ? 1 : power / (coherentGain * coherentGain * n);
    return { window, coherentGain, enbw, powerSum: power };
  },

  applyWindow(signal: ArrayLike<number> = [], window: ArrayLike<number> | null = null): Float64Array {
    if (!window || window.length !== signal.length) return Float64Array.from(signal);
    const out = new Float64Array(signal.length);
    for (let i = 0; i < signal.length; i += 1) out[i] = signal[i] * window[i];
    return out;
  },

  computeFreqAxis(length: number, fs: number): { freq: number[]; deltaF: number } {
    const n = Math.max(1, length);
    const half = Math.floor(n / 2);
    const delta = fs / n;
    const freq: number[] = [];
    for (let i = 0; i <= half; i += 1) freq.push(i * delta);
    return { freq, deltaF: delta };
  },

  inferSampleRate(timeArray: ArrayLike<number> = []): SampleRateEstimate {
    const analysis = analyzeTimebase(timeArray);
    return {
      fs: analysis.sampleRate,
      warnings: analysis.warnings,
      medianDt: analysis.medianDt || undefined,
      maxRelativeDeviation: analysis.maxRelativeDeviation
    };
  },

  computeSpectrum(
    signal: ArrayLike<number> = [],
    timeArray: ArrayLike<number> = [],
    options: SpectrumOptions = {}
  ): SpectrumResult {
    const {
      selection = null,
      windowType = 'hann',
      detrend = 'removeMean',
      zeroPadMode = 'nextPow2',
      zeroPadFactor = 1,
      windowOpts = {},
      quality = null
    } = options;

    const indices =
      selection && selection.i0 !== null && selection.i1 !== null
        ? {
            start: Math.max(0, Math.min(selection.i0, selection.i1)),
            end: Math.min(signal.length - 1, Math.max(selection.i0, selection.i1))
          }
        : { start: 0, end: Math.max(0, signal.length - 1) };

    const source = Array.from(signal).slice(indices.start, indices.end + 1);
    const sourceQuality = quality ? Array.from(quality).slice(indices.start, indices.end + 1) : [];
    const hasAlignedTime = timeArray.length >= indices.end + 1;
    const sourceTime = hasAlignedTime
      ? Array.from(timeArray).slice(indices.start, indices.end + 1)
      : source.map((_, index) => index);
    const warnings: string[] = hasAlignedTime
      ? []
      : ['No aligned timebase was supplied; using a 1 Hz sample interval.'];
    const sliced: number[] = [];
    const slicedTime: number[] = [];
    let omitted = 0;
    let qualityExcluded = 0;
    for (let i = 0; i < Math.min(source.length, sourceTime.length); i += 1) {
      const value = Number(source[i]);
      const time = Number(sourceTime[i]);
      const blocked = ((Number(sourceQuality[i]) || QualityFlag.None) & AnalysisExclusionMask) !== 0;
      if (Number.isFinite(value) && Number.isFinite(time) && !blocked) {
        sliced.push(value);
        slicedTime.push(time);
      } else {
        omitted += 1;
        if (blocked) qualityExcluded += 1;
      }
    }
    const nonFiniteOnly = omitted - qualityExcluded;
    if (nonFiniteOnly > 0) {
      warnings.push(`Excluded ${nonFiniteOnly} non-finite sample pair(s) from frequency analysis.`);
    }
    if (qualityExcluded > 0) {
      warnings.push(`Excluded ${qualityExcluded} sample(s) carrying analysis-blocking quality flags.`);
    }

    if (sliced.length < 2) {
      const empty: SpectrumResult = {
        freq: [],
        magnitude: [],
        linearMagnitude: [],
        psd: [],
        phase: [],
        warnings: [...warnings, 'Selection too short for FFT.'],
        meta: {
          fs: 1,
          deltaF: 0,
          nyquist: 0,
          coherentGain: 1,
          enbw: 1,
          enbwHz: 0,
          windowPower: 0,
          sampleCount: sliced.length,
          fftLength: 0,
          resampled: false
        },
        re: new Float64Array(0),
        im: new Float64Array(0),
        length: sliced.length
      };
      return empty;
    }

    const timebase = analyzeTimebase(slicedTime);
    warnings.push(...timebase.warnings);
    if (!timebase.valid) {
      const empty: SpectrumResult = {
        freq: [],
        magnitude: [],
        linearMagnitude: [],
        psd: [],
        phase: [],
        warnings,
        meta: {
          fs: timebase.sampleRate,
          deltaF: 0,
          nyquist: timebase.sampleRate / 2,
          coherentGain: 1,
          enbw: 1,
          enbwHz: 0,
          windowPower: 0,
          sampleCount: sliced.length,
          fftLength: 0,
          resampled: false,
          medianDt: timebase.medianDt || undefined
        },
        re: new Float64Array(0),
        im: new Float64Array(0),
        length: 0
      };
      return empty;
    }

    let analysisSignal = sliced;
    let analysisTime = slicedTime;
    let resampled = false;
    if (!timebase.uniform) {
      const uniform = resampleLinear(slicedTime, [sliced], timebase.medianDt);
      analysisSignal = uniform.values[0];
      analysisTime = uniform.time;
      resampled = true;
      warnings.push(`Resampled ${sliced.length} samples to ${analysisSignal.length} uniformly spaced samples.`);
    }

    const fs = 1 / (analysisTime[1] - analysisTime[0]);
    const detrended = this.applyDetrend(analysisSignal, detrend);
    const { window, coherentGain, enbw, powerSum } = this.getWindow(windowType, detrended.length, windowOpts);
    const windowed = this.applyWindow(detrended, window);
    const { re, im, length } = this.forward(windowed, { zeroPadMode, zeroPadFactor });
    const { freq, deltaF } = this.computeFreqAxis(length, fs);
    const sampleCount = detrended.length;

    const result: SpectrumResult = {
      freq,
      magnitude: this.getMagnitudeDB(re, im, { coherentGain, sampleCount }),
      linearMagnitude: this.getLinearMagnitude(re, im, { coherentGain, sampleCount }),
      psd: this.getPowerSpectralDensity(re, im, { fs, windowPower: powerSum }),
      phase: this.getPhaseDegrees(re, im, { lengthOverride: length }),
      warnings,
      meta: {
        fs,
        deltaF,
        nyquist: fs / 2,
        coherentGain,
        enbw,
        enbwHz: (enbw * fs) / sampleCount,
        windowPower: powerSum,
        sampleCount,
        fftLength: length,
        resampled,
        medianDt: analysisTime[1] - analysisTime[0]
      },
      re,
      im,
      length
    };
    return result;
  }
};
