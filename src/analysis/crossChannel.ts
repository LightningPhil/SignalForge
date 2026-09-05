import { FFT, type SpectrumOptions } from '../processing/fft';
import { AnalysisExclusionMask } from '../data/quality';
import { analyzeTimebase, resampleLinear } from '../processing/sampling';
import type { AnalysisSelection } from '../types';

export interface DelayEstimate {
  delaySeconds: number;
  delaySamples: number;
  correlationPeak: number;
  confidence: number;
  warnings: string[];
}

export interface TransferFunctionResult {
  freq: number[];
  magnitudeDb: number[];
  phaseDeg: number[];
  coherence: number[];
  warnings: string[];
  meta: {
    fs: number | null;
    segmentLength: number;
    segmentCount: number;
    overlap: number;
  };
}

export interface TransferFunctionOptions extends SpectrumOptions {
  segmentLength?: number;
  overlap?: number;
  inputQuality?: ArrayLike<number> | null;
  outputQuality?: ArrayLike<number> | null;
}

export interface DelayOptions {
  selection?: AnalysisSelection | null;
  maxLagSeconds?: number | null;
  minimumOverlapFraction?: number;
  inputQuality?: ArrayLike<number> | null;
  outputQuality?: ArrayLike<number> | null;
}

interface PreparedPair {
  time: number[];
  input: number[];
  output: number[];
  fs: number;
  warnings: string[];
}

function normalizeSelection(selection: AnalysisSelection | null, length: number): { start: number; end: number } {
  if (!selection || selection.i0 === null || selection.i1 === null) return { start: 0, end: length - 1 };
  return {
    start: Math.max(0, Math.min(selection.i0, selection.i1, length - 1)),
    end: Math.min(length - 1, Math.max(selection.i0, selection.i1))
  };
}

function wrapPhaseDegrees(value: number): number {
  let wrapped = value;
  while (wrapped > 180) wrapped -= 360;
  while (wrapped < -180) wrapped += 360;
  return wrapped;
}

function floorPowerOfTwo(value: number): number {
  return value > 1 ? 2 ** Math.floor(Math.log2(value)) : 1;
}

function preparePair(
  time: ArrayLike<number>,
  input: ArrayLike<number>,
  output: ArrayLike<number>,
  selection: AnalysisSelection | null,
  inputQuality?: ArrayLike<number> | null,
  outputQuality?: ArrayLike<number> | null
): PreparedPair {
  const limit = Math.min(time.length, input.length, output.length);
  const selected = normalizeSelection(selection, limit);
  const selectedTime: number[] = [];
  const selectedInput: number[] = [];
  const selectedOutput: number[] = [];
  let omitted = 0;
  let qualityExcluded = 0;

  for (let index = selected.start; index <= selected.end; index += 1) {
    const timestamp = Number(time[index]);
    const inputValue = Number(input[index]);
    const outputValue = Number(output[index]);
    const blocked =
      ((Number(inputQuality?.[index]) || 0) & AnalysisExclusionMask) !== 0 ||
      ((Number(outputQuality?.[index]) || 0) & AnalysisExclusionMask) !== 0;
    if (!blocked && Number.isFinite(timestamp) && Number.isFinite(inputValue) && Number.isFinite(outputValue)) {
      selectedTime.push(timestamp);
      selectedInput.push(inputValue);
      selectedOutput.push(outputValue);
    } else if (blocked) {
      qualityExcluded += 1;
    } else {
      omitted += 1;
    }
  }

  const warnings = omitted > 0 ? [`Excluded ${omitted} invalid aligned sample pair(s).`] : [];
  if (qualityExcluded > 0) {
    warnings.push(`Excluded ${qualityExcluded} aligned pair(s) carrying analysis-blocking quality flags.`);
  }
  const timebase = analyzeTimebase(selectedTime);
  warnings.push(...timebase.warnings);
  if (!timebase.valid || selectedTime.length < 2) {
    return { time: [], input: [], output: [], fs: 1, warnings };
  }
  if (timebase.uniform) {
    return {
      time: selectedTime,
      input: selectedInput,
      output: selectedOutput,
      fs: timebase.sampleRate,
      warnings
    };
  }

  const uniform = resampleLinear(selectedTime, [selectedInput, selectedOutput], timebase.medianDt);
  warnings.push(`Resampled ${selectedTime.length} aligned pairs to ${uniform.time.length} uniform samples.`);
  return {
    time: uniform.time,
    input: uniform.values[0],
    output: uniform.values[1],
    fs: 1 / (uniform.time[1] - uniform.time[0]),
    warnings
  };
}

function removeMean(values: number[]): number[] {
  if (values.length === 0) return [];
  let sum = 0;
  for (const value of values) sum += value;
  const mean = sum / values.length;
  return values.map((value) => value - mean);
}

function correlationAtLag(input: number[], output: number[], lag: number, minimumOverlap: number): number {
  const start = Math.max(0, -lag);
  const end = Math.min(input.length, output.length - lag);
  if (end - start < minimumOverlap) return Number.NaN;
  let cross = 0;
  let inputEnergy = 0;
  let outputEnergy = 0;
  for (let index = start; index < end; index += 1) {
    const outputIndex = index + lag;
    cross += input[index] * output[outputIndex];
    inputEnergy += input[index] * input[index];
    outputEnergy += output[outputIndex] * output[outputIndex];
  }
  const denominator = Math.sqrt(inputEnergy * outputEnergy);
  return denominator > 0 ? cross / denominator : 0;
}

function parabolicOffset(left: number, center: number, right: number): number {
  const denominator = left - 2 * center + right;
  if (Math.abs(denominator) < 1e-15) return 0;
  return Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / denominator));
}

function complementaryErrorFunction(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const polynomial = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const errorFunction = sign * (1 - polynomial * Math.exp(-x * x));
  return 1 - errorFunction;
}

function adjustedCorrelationConfidence(correlation: number, sampleCount: number, lagCount: number): number {
  if (sampleCount < 16) return 0;
  const bounded = Math.min(1 - Number.EPSILON, Math.abs(correlation));
  const fisherZ = Math.atanh(bounded) * Math.sqrt(Math.max(1, sampleCount - 3));
  const singleLagProbability = complementaryErrorFunction(fisherZ / Math.SQRT2);
  const familyWiseProbability = Math.min(1, singleLagProbability * Math.max(1, lagCount) * 1.25);
  return Math.max(0, Math.min(1, 1 - familyWiseProbability));
}

export const CrossChannel = {
  estimateDelay(
    time: number[] = [],
    input: number[] = [],
    output: number[] = [],
    options: DelayOptions = {}
  ): DelayEstimate {
    const prepared = preparePair(
      time,
      input,
      output,
      options.selection || null,
      options.inputQuality,
      options.outputQuality
    );
    if (prepared.time.length < 3) {
      return {
        delaySeconds: 0,
        delaySamples: 0,
        correlationPeak: 0,
        confidence: 0,
        warnings: [...prepared.warnings, 'Insufficient aligned data for delay estimation.']
      };
    }

    const meanFreeInput = removeMean(prepared.input);
    const meanFreeOutput = removeMean(prepared.output);
    const minimumOverlapFraction = Math.max(0.1, Math.min(1, options.minimumOverlapFraction ?? 0.5));
    const minimumOverlap = Math.min(
      prepared.time.length,
      Math.max(3, Math.ceil(prepared.time.length * minimumOverlapFraction))
    );
    const requestedLimit =
      options.maxLagSeconds !== null && options.maxLagSeconds !== undefined
        ? Math.floor(Math.abs(options.maxLagSeconds) * prepared.fs + 1e-6)
        : 2000;
    const maxLagSamples = Math.max(0, Math.min(requestedLimit, prepared.time.length - minimumOverlap));
    const boundaryWarnings: string[] = [];
    if (maxLagSamples === 0) {
      boundaryWarnings.push(
        'The maximum lag rounds to zero samples at this sample rate; the delay could not be searched.'
      );
    }
    const correlations = new Map<number, number>();
    let bestLag = 0;
    let bestCorrelation = 0;
    let bestScore = -Infinity;

    for (let lag = -maxLagSamples; lag <= maxLagSamples; lag += 1) {
      const correlation = correlationAtLag(meanFreeInput, meanFreeOutput, lag, minimumOverlap);
      if (!Number.isFinite(correlation)) continue;
      correlations.set(lag, correlation);
      const score = Math.abs(correlation);
      if (score > bestScore) {
        bestScore = score;
        bestCorrelation = correlation;
        bestLag = lag;
      }
    }

    const left = Math.abs(correlations.get(bestLag - 1) ?? bestCorrelation);
    const center = Math.abs(bestCorrelation);
    const right = Math.abs(correlations.get(bestLag + 1) ?? bestCorrelation);
    const fractionalOffset =
      bestLag > -maxLagSamples && bestLag < maxLagSamples ? parabolicOffset(left, center, right) : 0;
    const delaySamples = bestLag + fractionalOffset;
    const warnings = [...prepared.warnings, ...boundaryWarnings];
    const overlapAtPeak = prepared.time.length - Math.abs(bestLag);
    const lagCount = maxLagSamples * 2 + 1;
    if (bestCorrelation < 0) warnings.push('Best alignment is polarity-inverted (negative correlation).');
    if (Math.abs(bestLag) === maxLagSamples && maxLagSamples > 0) {
      warnings.push('Correlation peak reached the configured lag boundary.');
    }
    if (overlapAtPeak < 16) {
      warnings.push('Fewer than 16 overlapping samples are insufficient for a reliable delay confidence.');
    }

    return {
      delaySeconds: delaySamples / prepared.fs,
      delaySamples,
      correlationPeak: bestCorrelation,
      confidence: adjustedCorrelationConfidence(bestCorrelation, overlapAtPeak, lagCount),
      warnings
    };
  },

  computeTransferFunction(
    input: number[] = [],
    output: number[] = [],
    time: number[] = [],
    options: TransferFunctionOptions = {}
  ): TransferFunctionResult {
    const prepared = preparePair(
      time,
      input,
      output,
      options.selection || null,
      options.inputQuality,
      options.outputQuality
    );
    const empty = (warnings: string[]): TransferFunctionResult => ({
      freq: [],
      magnitudeDb: [],
      phaseDeg: [],
      coherence: [],
      warnings,
      meta: { fs: prepared.fs || null, segmentLength: 0, segmentCount: 0, overlap: 0 }
    });
    if (prepared.time.length < 16) {
      return empty([...prepared.warnings, 'At least 16 aligned samples are required for Welch analysis.']);
    }

    const requestedSegment = options.segmentLength
      ? Math.floor(options.segmentLength)
      : floorPowerOfTwo(Math.min(1024, Math.max(16, prepared.time.length / 8)));
    const segmentLength = Math.max(8, Math.min(prepared.time.length, requestedSegment));
    const overlap = Math.max(0, Math.min(0.9, options.overlap ?? 0.5));
    const hop = Math.max(1, Math.floor(segmentLength * (1 - overlap)));
    const { window } = FFT.getWindow(options.windowType || 'hann', segmentLength, options.windowOpts);
    const detrend = options.detrend || 'removeMean';
    const zeroPadMode = options.zeroPadMode || 'nextPow2';
    const zeroPadFactor = options.zeroPadFactor || 1;
    let sxx: number[] = [];
    let syy: number[] = [];
    let sxyReal: number[] = [];
    let sxyImaginary: number[] = [];
    let fftLength = 0;
    let segmentCount = 0;

    for (let start = 0; start + segmentLength <= prepared.input.length; start += hop) {
      const inputSegment = FFT.applyWindow(
        FFT.applyDetrend(prepared.input.slice(start, start + segmentLength), detrend),
        window
      );
      const outputSegment = FFT.applyWindow(
        FFT.applyDetrend(prepared.output.slice(start, start + segmentLength), detrend),
        window
      );
      const inputTransform = FFT.forward(inputSegment, { zeroPadMode, zeroPadFactor });
      const outputTransform = FFT.forward(outputSegment, { zeroPadMode, zeroPadFactor });
      fftLength = inputTransform.length;
      const binCount = Math.floor(fftLength / 2) + 1;
      if (sxx.length === 0) {
        sxx = new Array<number>(binCount).fill(0);
        syy = new Array<number>(binCount).fill(0);
        sxyReal = new Array<number>(binCount).fill(0);
        sxyImaginary = new Array<number>(binCount).fill(0);
      }

      for (let bin = 0; bin < binCount; bin += 1) {
        const inputReal = inputTransform.re[bin];
        const inputImaginary = inputTransform.im[bin];
        const outputReal = outputTransform.re[bin];
        const outputImaginary = outputTransform.im[bin];
        sxx[bin] += inputReal * inputReal + inputImaginary * inputImaginary;
        syy[bin] += outputReal * outputReal + outputImaginary * outputImaginary;
        sxyReal[bin] += outputReal * inputReal + outputImaginary * inputImaginary;
        sxyImaginary[bin] += outputImaginary * inputReal - outputReal * inputImaginary;
      }
      segmentCount += 1;
    }

    if (segmentCount === 0) return empty([...prepared.warnings, 'No complete Welch segments were available.']);
    const { freq } = FFT.computeFreqAxis(fftLength, prepared.fs);
    const magnitudeDb = new Array<number>(freq.length);
    const phaseDeg = new Array<number>(freq.length);
    const coherence = new Array<number>(freq.length);

    for (let bin = 0; bin < freq.length; bin += 1) {
      const inputPower = sxx[bin] / segmentCount;
      const outputPower = syy[bin] / segmentCount;
      const crossReal = sxyReal[bin] / segmentCount;
      const crossImaginary = sxyImaginary[bin] / segmentCount;
      const transferReal = inputPower > 0 ? crossReal / inputPower : 0;
      const transferImaginary = inputPower > 0 ? crossImaginary / inputPower : 0;
      magnitudeDb[bin] = 20 * Math.log10(Math.max(Math.hypot(transferReal, transferImaginary), 1e-12));
      phaseDeg[bin] = wrapPhaseDegrees((Math.atan2(transferImaginary, transferReal) * 180) / Math.PI);
      const denominator = inputPower * outputPower;
      coherence[bin] =
        segmentCount >= 2 && denominator > 0
          ? Math.max(0, Math.min(1, (crossReal * crossReal + crossImaginary * crossImaginary) / denominator))
          : Number.NaN;
    }

    const warnings = prepared.warnings.slice();
    if (segmentCount < 4) {
      warnings.push('Fewer than four Welch segments are available; coherence uncertainty is high.');
    }
    return {
      freq,
      magnitudeDb,
      phaseDeg,
      coherence,
      warnings,
      meta: { fs: prepared.fs, segmentLength, segmentCount, overlap }
    };
  }
};
