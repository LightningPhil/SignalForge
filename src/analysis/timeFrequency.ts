import { FFT } from '../processing/fft';
import { antiAliasAndDecimate } from '../processing/sampling';
import type { AnalysisSelection, FftDetrend, FftWindowType } from '../types';

export interface SpectrogramOptions {
  selection?: AnalysisSelection | null;
  windowSize?: number;
  overlap?: number;
  windowType?: FftWindowType;
  detrend?: FftDetrend;
  maxPoints?: number;
  freqMin?: number;
  freqMax?: number | null;
  windowOpts?: { beta?: number };
}

export interface SpectrogramResult {
  timeBins: number[];
  freqBins: number[];
  magnitudeDb: number[][];
  warnings: string[];
  meta: {
    fs?: number;
    medianDt?: number;
    hop?: number;
    windowSize?: number;
    overlap?: number;
    nFrames?: number;
    freqResolution?: number;
    nyquist?: number;
    antiAliasCutoffHz?: number;
  };
}

function sliceBySelection(
  signal: number[],
  time: number[],
  selection: AnalysisSelection | null
): { y: number[]; t: number[] } {
  if (!selection || selection.i0 === null || selection.i1 === null) {
    return { y: signal.slice(), t: time.slice() };
  }
  const start = Math.max(0, selection.i0);
  const end = Math.min(signal.length - 1, selection.i1);
  return { y: signal.slice(start, end + 1), t: time.slice(start, end + 1) };
}

function downsampleForSpectrogram(
  y: number[],
  t: number[],
  maxPoints = 40000
): { y: number[]; t: number[]; factor: number; cutoffHz: number | null } {
  if (!maxPoints || y.length <= maxPoints) return { y, t, factor: 1, cutoffHz: null };
  const stride = Math.ceil(y.length / maxPoints);
  const reduced = antiAliasAndDecimate(t, y, stride);
  return { y: reduced.values, t: reduced.time, factor: reduced.factor, cutoffHz: reduced.cutoffHz };
}

export const TimeFrequency = {
  computeSpectrogram(
    signal: ArrayLike<number> = [],
    timeArray: ArrayLike<number> = [],
    options: SpectrogramOptions = {}
  ): SpectrogramResult {
    const {
      selection = null,
      windowSize = 512,
      overlap = 0.5,
      windowType = 'hann',
      detrend = 'removeMean',
      maxPoints = 40000,
      freqMin = 0,
      freqMax = null,
      windowOpts = {}
    } = options;

    const warnings: string[] = [];
    if (!signal.length || !timeArray.length) {
      return { timeBins: [], freqBins: [], magnitudeDb: [], warnings: ['No signal data'], meta: {} };
    }

    const sliced = sliceBySelection(Array.from(signal), Array.from(timeArray), selection);
    let downsampled: ReturnType<typeof downsampleForSpectrogram>;
    try {
      downsampled = downsampleForSpectrogram(sliced.y, sliced.t, maxPoints);
    } catch (error) {
      return {
        timeBins: [],
        freqBins: [],
        magnitudeDb: [],
        warnings: [error instanceof Error ? error.message : String(error)],
        meta: {}
      };
    }
    if (downsampled.factor > 1) {
      warnings.push(
        `Applied IIR anti-alias filtering at ${downsampled.cutoffHz?.toPrecision(4)} Hz before ` +
          `${downsampled.factor}x spectrogram decimation.`
      );
    }

    const {
      fs,
      warnings: timingWarnings,
      medianDt
    } = FFT.inferSampleRate(downsampled.t.length ? downsampled.t : timeArray);
    warnings.push(...(timingWarnings || []));
    if (!Number.isFinite(fs) || fs <= 0) {
      return { timeBins: [], freqBins: [], magnitudeDb: [], warnings: ['Invalid sampling rate'], meta: {} };
    }

    const segmentLength = Math.min(windowSize, downsampled.y.length);
    const hop = Math.max(1, Math.floor(segmentLength * (1 - overlap)));
    if (segmentLength < 2 || hop <= 0) {
      return { timeBins: [], freqBins: [], magnitudeDb: [], warnings: ['Spectrogram window too small'], meta: {} };
    }

    const { window, coherentGain } = FFT.getWindow(windowType, segmentLength, windowOpts);
    const zeroPadLength = FFT.nextPowerOfTwo(segmentLength);
    const { freq: freqAxis, deltaF } = FFT.computeFreqAxis(zeroPadLength, fs);

    let freqStart = 0;
    let freqEnd = freqAxis.length;
    if (Number.isFinite(freqMin) && freqMin > 0) {
      const idx = freqAxis.findIndex((f) => f >= freqMin);
      if (idx !== -1) freqStart = idx;
    }
    if (Number.isFinite(freqMax) && freqMax && freqMax > 0) {
      const idx = freqAxis.findIndex((f) => f > freqMax);
      if (idx !== -1) freqEnd = idx;
    }

    const freqBins = freqAxis.slice(freqStart, freqEnd);
    const frames: number[][] = [];
    const timeBins: number[] = [];

    for (let start = 0; start + segmentLength <= downsampled.y.length; start += hop) {
      const segment = downsampled.y.slice(start, start + segmentLength);
      const windowed = FFT.applyWindow(FFT.applyDetrend(segment, detrend), window);
      const { re, im } = FFT.forward(windowed, { zeroPadMode: 'factor', zeroPadFactor: zeroPadLength / segmentLength });
      frames.push(FFT.getMagnitudeDB(re, im, { coherentGain, sampleCount: segmentLength }).slice(freqStart, freqEnd));
      timeBins.push(downsampled.t[Math.min(downsampled.t.length - 1, start + Math.floor(segmentLength / 2))]);
    }

    return {
      timeBins,
      freqBins,
      magnitudeDb: freqBins.map((_, fi) => frames.map((frame) => frame[fi])),
      warnings,
      meta: {
        fs,
        medianDt,
        hop,
        windowSize: segmentLength,
        overlap,
        nFrames: frames.length,
        freqResolution: deltaF,
        nyquist: fs / 2,
        antiAliasCutoffHz: downsampled.cutoffHz || undefined
      }
    };
  }
};
