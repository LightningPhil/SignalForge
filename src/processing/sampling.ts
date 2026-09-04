import type { FrequencyAxis } from '../types';
import { QualityFlag } from '../data/quality';
import { FFT } from './fft';
import { applyIirCascade, designButterworth, iirPaddingPlan, type Biquad } from './iir';

export interface TimebaseAnalysis {
  valid: boolean;
  uniform: boolean;
  sampleRate: number;
  medianDt: number;
  madDt: number;
  relativeMad: number;
  maxRelativeDeviation: number;
  warnings: string[];
}

export interface ResampledSeries {
  time: number[];
  values: number[][];
  analysis: TimebaseAnalysis;
}

export interface DecimatedSeries {
  time: number[];
  values: number[];
  factor: number;
  cutoffHz: number | null;
  filterOrder: number | null;
  paddingSamples: number;
  requiredPaddingSamples: number;
  settlingTruncated: boolean;
  skippedFilterRuns: number;
}

export interface TimebaseAlignment {
  values: number[];
  warnings: string[];
}

const DECIMATION_FILTER_ORDER = 8;
const ALIGNMENT_FILTER_ORDER = 16;

function fourierResample(values: number[], outputLength: number): number[] {
  if (values.length === outputLength) return values.slice();
  const transformed = FFT.forward(values, { zeroPadMode: 'none' });
  const outputReal = new Float64Array(outputLength);
  const outputImaginary = new Float64Array(outputLength);
  const sharedLength = Math.min(values.length, outputLength);
  const positiveLimit = Math.floor((sharedLength - 1) / 2);
  outputReal[0] = transformed.re[0];
  outputImaginary[0] = transformed.im[0];
  for (let bin = 1; bin <= positiveLimit; bin += 1) {
    outputReal[bin] = transformed.re[bin];
    outputImaginary[bin] = transformed.im[bin];
    outputReal[outputLength - bin] = transformed.re[values.length - bin];
    outputImaginary[outputLength - bin] = transformed.im[values.length - bin];
  }
  if (sharedLength % 2 === 0) {
    const targetBin = sharedLength / 2;
    outputReal[targetBin] = transformed.re[targetBin];
    outputImaginary[targetBin] = 0;
  }
  const scale = outputLength / values.length;
  return FFT.inverse(outputReal, outputImaginary).map((value) => value * scale);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function analyzeTimebase(
  timeArray: ArrayLike<number> | null | undefined,
  uniformTolerance = 0.01
): TimebaseAnalysis {
  const warnings: string[] = [];
  if (!timeArray || timeArray.length < 2) {
    return {
      valid: false,
      uniform: false,
      sampleRate: 1,
      medianDt: 0,
      madDt: 0,
      relativeMad: Infinity,
      maxRelativeDeviation: Infinity,
      warnings: ['At least two finite, increasing timestamps are required.']
    };
  }

  const deltas: number[] = [];
  let valid = true;
  for (let i = 0; i < timeArray.length - 1; i += 1) {
    const current = Number(timeArray[i]);
    const next = Number(timeArray[i + 1]);
    if (!Number.isFinite(current) || !Number.isFinite(next)) {
      valid = false;
      continue;
    }
    const delta = next - current;
    if (!(delta > 0)) {
      valid = false;
      continue;
    }
    deltas.push(delta);
  }

  if (deltas.length !== timeArray.length - 1) {
    warnings.push('Timebase contains non-finite, duplicate or decreasing timestamps.');
  }
  if (deltas.length === 0) {
    return {
      valid: false,
      uniform: false,
      sampleRate: 1,
      medianDt: 0,
      madDt: 0,
      relativeMad: Infinity,
      maxRelativeDeviation: Infinity,
      warnings
    };
  }

  const medianDt = median(deltas);
  const deviations = deltas.map((value) => Math.abs(value - medianDt));
  const madDt = median(deviations);
  const relativeMad = medianDt > 0 ? madDt / medianDt : Infinity;
  let maxRelativeDeviation = 0;
  for (const delta of deltas) {
    maxRelativeDeviation = Math.max(maxRelativeDeviation, Math.abs(delta - medianDt) / medianDt);
  }
  const uniform = valid && maxRelativeDeviation <= uniformTolerance;
  if (!uniform && valid) {
    warnings.push(
      `Non-uniform sampling detected (maximum interval deviation ${(maxRelativeDeviation * 100).toPrecision(3)}%).`
    );
  }

  return {
    valid,
    uniform,
    sampleRate: medianDt > 0 ? 1 / medianDt : 1,
    medianDt,
    madDt,
    relativeMad,
    maxRelativeDeviation,
    warnings
  };
}

export function estimateSampleRate(timeArray: ArrayLike<number> | null | undefined): number {
  return analyzeTimebase(timeArray).sampleRate;
}

export function resampleLinear(
  timeArray: ArrayLike<number>,
  valueSeries: ArrayLike<number>[],
  targetDt?: number
): ResampledSeries {
  const analysis = analyzeTimebase(timeArray);
  if (!analysis.valid) {
    throw new Error(analysis.warnings[0] || 'Cannot resample an invalid timebase.');
  }
  const sourceLength = Math.min(timeArray.length, ...valueSeries.map((values) => values.length));
  if (sourceLength < 2) {
    throw new Error('At least two aligned samples are required for resampling.');
  }

  const requestedDt = targetDt && targetDt > 0 ? targetDt : analysis.medianDt;
  const start = Number(timeArray[0]);
  const end = Number(timeArray[sourceLength - 1]);
  const intervals = Math.max(1, Math.round((end - start) / requestedDt));
  const dt = (end - start) / intervals;
  const count = intervals + 1;
  const time = new Array<number>(count);
  const values = valueSeries.map(() => new Array<number>(count));
  let sourceIndex = 0;

  for (let outputIndex = 0; outputIndex < count; outputIndex += 1) {
    const target = outputIndex === count - 1 ? end : start + outputIndex * dt;
    time[outputIndex] = target;
    while (sourceIndex + 1 < sourceLength - 1 && Number(timeArray[sourceIndex + 1]) < target) {
      sourceIndex += 1;
    }
    const t0 = Number(timeArray[sourceIndex]);
    const t1 = Number(timeArray[Math.min(sourceLength - 1, sourceIndex + 1)]);
    const fraction = t1 > t0 ? Math.max(0, Math.min(1, (target - t0) / (t1 - t0))) : 0;
    valueSeries.forEach((series, seriesIndex) => {
      const y0 = Number(series[sourceIndex]);
      const y1 = Number(series[Math.min(sourceLength - 1, sourceIndex + 1)]);
      values[seriesIndex][outputIndex] = y0 + (y1 - y0) * fraction;
    });
  }

  return { time, values, analysis };
}

export function interpolateLinearToTimebase(
  sourceTime: ArrayLike<number>,
  sourceValues: ArrayLike<number>,
  targetTime: ArrayLike<number>
): number[] {
  const sourceLength = Math.min(sourceTime.length, sourceValues.length);
  const analysis = analyzeTimebase(Array.from(sourceTime).slice(0, sourceLength));
  if (!analysis.valid) throw new Error(analysis.warnings[0] || 'Cannot interpolate an invalid source timebase.');
  const output = new Array<number>(targetTime.length);
  let sourceIndex = 0;
  const firstTime = Number(sourceTime[0]);
  const lastTime = Number(sourceTime[sourceLength - 1]);
  for (let targetIndex = 0; targetIndex < targetTime.length; targetIndex += 1) {
    const target = Number(targetTime[targetIndex]);
    if (!Number.isFinite(target) || target < firstTime || target > lastTime) {
      output[targetIndex] = Number.NaN;
      continue;
    }
    while (sourceIndex + 1 < sourceLength - 1 && Number(sourceTime[sourceIndex + 1]) < target) {
      sourceIndex += 1;
    }
    const rightIndex = Math.min(sourceLength - 1, sourceIndex + 1);
    const leftTime = Number(sourceTime[sourceIndex]);
    const rightTime = Number(sourceTime[rightIndex]);
    const leftValue = Number(sourceValues[sourceIndex]);
    const rightValue = Number(sourceValues[rightIndex]);
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
      output[targetIndex] = Number.NaN;
      continue;
    }
    const fraction = rightTime > leftTime ? (target - leftTime) / (rightTime - leftTime) : 0;
    output[targetIndex] = leftValue + (rightValue - leftValue) * fraction;
  }
  return output;
}

export function interpolateToTimebase(
  sourceTime: ArrayLike<number>,
  sourceValues: ArrayLike<number>,
  targetTime: ArrayLike<number>,
  sourceTimeOffset = 0
): TimebaseAlignment {
  const length = Math.min(sourceTime.length, sourceValues.length);
  const shiftedTime = Array.from({ length }, (_, index) => Number(sourceTime[index]) + sourceTimeOffset);
  const analysis = analyzeTimebase(shiftedTime);
  if (!analysis.valid) {
    return {
      values: new Array<number>(targetTime.length).fill(Number.NaN),
      warnings: analysis.warnings
    };
  }
  const targetAnalysis = analyzeTimebase(targetTime);
  const warnings = [...analysis.warnings, ...targetAnalysis.warnings];
  let interpolationValues = Array.from(sourceValues).slice(0, length);
  let sourceMinimum = Infinity;
  let sourceMaximum = -Infinity;
  for (const value of interpolationValues) {
    if (!Number.isFinite(value)) continue;
    sourceMinimum = Math.min(sourceMinimum, value);
    sourceMaximum = Math.max(sourceMaximum, value);
  }
  const sourceEndpointTolerance = Math.max(1e-12, (sourceMaximum - sourceMinimum) * 0.01);
  const sourceEndpointsContinuous =
    Math.abs(interpolationValues[0] - interpolationValues[interpolationValues.length - 1]) <= sourceEndpointTolerance;
  const needsDownsampling = targetAnalysis.valid && analysis.sampleRate > targetAnalysis.sampleRate;
  if (needsDownsampling && length < 64) {
    return {
      values: new Array<number>(targetTime.length).fill(Number.NaN),
      warnings: [
        ...warnings,
        `Only ${length} source samples are available; reliable IIR anti-alias filtering requires at least 64.`
      ]
    };
  }
  const usesAntiAlias = needsDownsampling;
  if (usesAntiAlias) {
    const cutoffHz = targetAnalysis.sampleRate * 0.475;
    const sections = designButterworth('lowpass', analysis.sampleRate, cutoffHz, ALIGNMENT_FILTER_ORDER);
    const padding = finiteRunPaddingPlan(interpolationValues, sections);
    const firstValue = interpolationValues[0];
    const lastValue = interpolationValues[interpolationValues.length - 1];
    const timeSpan = shiftedTime[shiftedTime.length - 1] - shiftedTime[0];
    if (Number.isFinite(firstValue) && Number.isFinite(lastValue) && timeSpan > 0) {
      const trend = shiftedTime.map(
        (time) => firstValue + (lastValue - firstValue) * ((time - shiftedTime[0]) / timeSpan)
      );
      const residual = interpolationValues.map((value, index) => value - trend[index]);
      interpolationValues = filterFiniteRuns(residual, analysis.sampleRate, cutoffHz, ALIGNMENT_FILTER_ORDER).map(
        (value, index) => value + trend[index]
      );
    } else {
      interpolationValues = filterFiniteRuns(
        interpolationValues,
        analysis.sampleRate,
        cutoffHz,
        ALIGNMENT_FILTER_ORDER
      );
    }
    warnings.push(
      `Applied 16th-order zero-phase IIR anti-alias filtering at ${cutoffHz.toPrecision(5)} Hz with minimum per-run padding ${padding.effective}/${padding.required}${padding.truncated ? ' (record-limited)' : ''}${padding.skippedRuns ? `; skipped ${padding.skippedRuns} run(s) shorter than 8 samples` : ''} before timebase alignment.`
    );
  }
  const sourcePeriod = length * analysis.medianDt;
  const targetPeriod = targetTime.length * targetAnalysis.medianDt;
  const sameStart =
    Math.abs(shiftedTime[0] - Number(targetTime[0])) <= Math.min(analysis.medianDt, targetAnalysis.medianDt) * 0.1;
  const canUseFourierInterpolation =
    analysis.uniform &&
    targetAnalysis.uniform &&
    interpolationValues.every(Number.isFinite) &&
    sameStart &&
    Math.abs(sourcePeriod - targetPeriod) <= Math.max(sourcePeriod, targetPeriod) * 1e-6;
  if (canUseFourierInterpolation) {
    warnings.push('Used band-limited Fourier interpolation for the aligned uniform timebase.');
    return { values: fourierResample(interpolationValues, targetTime.length), warnings };
  }
  const sourceSpan = shiftedTime[length - 1] - shiftedTime[0];
  const targetSpan = Number(targetTime[targetTime.length - 1]) - Number(targetTime[0]);
  const canUseEndpointFourierInterpolation =
    length >= 16 &&
    targetTime.length >= 16 &&
    analysis.uniform &&
    targetAnalysis.uniform &&
    interpolationValues.every(Number.isFinite) &&
    sourceEndpointsContinuous &&
    sameStart &&
    Math.abs(sourceSpan - targetSpan) <= Math.max(sourceSpan, targetSpan) * 1e-6;
  if (canUseEndpointFourierInterpolation) {
    const values = fourierResample(interpolationValues.slice(0, -1), targetTime.length - 1);
    values.push(interpolationValues[interpolationValues.length - 1]);
    warnings.push('Used endpoint-inclusive band-limited Fourier interpolation.');
    return { values, warnings };
  }
  const values = new Array<number>(targetTime.length);
  let sourceIndex = 0;
  let outsideCount = 0;
  for (let targetIndex = 0; targetIndex < targetTime.length; targetIndex += 1) {
    const target = Number(targetTime[targetIndex]);
    if (!Number.isFinite(target) || target < shiftedTime[0] || target > shiftedTime[length - 1]) {
      values[targetIndex] = Number.NaN;
      outsideCount += 1;
      continue;
    }
    while (sourceIndex + 1 < length - 1 && shiftedTime[sourceIndex + 1] < target) sourceIndex += 1;
    if (target === shiftedTime[sourceIndex]) {
      values[targetIndex] = interpolationValues[sourceIndex];
      continue;
    }
    values[targetIndex] = interpolateBandlimitedPolynomial(shiftedTime, interpolationValues, sourceIndex, target);
  }
  return {
    values,
    warnings:
      outsideCount > 0
        ? [...warnings, `${outsideCount} target sample(s) fall outside the source channel timebase.`]
        : warnings
  };
}

export function alignQualityToTimebase(
  sourceTime: ArrayLike<number>,
  sourceQuality: ArrayLike<number>,
  targetTime: ArrayLike<number>,
  sourceTimeOffset = 0,
  sourceValues?: ArrayLike<number>
): Uint16Array {
  const length = Math.min(sourceTime.length, sourceQuality.length);
  const shiftedTime = Array.from({ length }, (_, index) => Number(sourceTime[index]) + sourceTimeOffset);
  const aligned = new Uint16Array(targetTime.length);
  const sourceAnalysis = analyzeTimebase(shiftedTime);
  const targetAnalysis = analyzeTimebase(targetTime);
  if (!sourceAnalysis.valid) {
    aligned.fill(QualityFlag.Invalid | QualityFlag.Interpolated);
    return aligned;
  }
  const needsDownsampling = targetAnalysis.valid && sourceAnalysis.sampleRate > targetAnalysis.sampleRate;
  if (needsDownsampling && length < 64) {
    aligned.fill(QualityFlag.Invalid | QualityFlag.Interpolated);
    return aligned;
  }
  const usesAntiAlias = needsDownsampling;
  const sameStart =
    targetTime.length > 0 &&
    Math.abs(shiftedTime[0] - Number(targetTime[0])) <=
      Math.min(sourceAnalysis.medianDt, targetAnalysis.medianDt) * 0.1;
  const sourcePeriod = length * sourceAnalysis.medianDt;
  const targetPeriod = targetTime.length * targetAnalysis.medianDt;
  const sourceSpan = shiftedTime[length - 1] - shiftedTime[0];
  const targetSpan = Number(targetTime[targetTime.length - 1]) - Number(targetTime[0]);
  let endpointsContinuous = false;
  if (sourceValues && sourceValues.length >= length) {
    let minimum = Infinity;
    let maximum = -Infinity;
    for (let index = 0; index < length; index += 1) {
      const value = Number(sourceValues[index]);
      if (!Number.isFinite(value)) continue;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
    endpointsContinuous =
      Math.abs(Number(sourceValues[0]) - Number(sourceValues[length - 1])) <=
      Math.max(1e-12, (maximum - minimum) * 0.01);
  }
  const usesFourierFootprint =
    length !== targetTime.length &&
    sourceAnalysis.uniform &&
    targetAnalysis.uniform &&
    sameStart &&
    (Math.abs(sourcePeriod - targetPeriod) <= Math.max(sourcePeriod, targetPeriod) * 1e-6 ||
      (endpointsContinuous && Math.abs(sourceSpan - targetSpan) <= Math.max(sourceSpan, targetSpan) * 1e-6));
  const contaminationRadius = usesFourierFootprint
    ? length
    : usesAntiAlias
      ? Math.max(1, Math.ceil((sourceAnalysis.sampleRate / targetAnalysis.sampleRate) * 32))
      : 8;
  let sourceIndex = 0;
  for (let targetIndex = 0; targetIndex < targetTime.length; targetIndex += 1) {
    const target = Number(targetTime[targetIndex]);
    if (target < shiftedTime[0] || target > shiftedTime[length - 1]) {
      aligned[targetIndex] = QualityFlag.Missing | QualityFlag.Interpolated;
      continue;
    }
    while (sourceIndex + 1 < length - 1 && shiftedTime[sourceIndex + 1] < target) sourceIndex += 1;
    const exact = target === shiftedTime[sourceIndex];
    const right = exact ? sourceIndex : Math.min(length - 1, sourceIndex + 1);
    const effectiveRadius = exact && !usesAntiAlias && !usesFourierFootprint ? 0 : contaminationRadius;
    let quality = QualityFlag.None;
    for (
      let index = Math.max(0, sourceIndex - effectiveRadius);
      index <= Math.min(length - 1, right + effectiveRadius);
      index += 1
    ) {
      quality |= Number(sourceQuality[index]) || QualityFlag.None;
    }
    aligned[targetIndex] =
      quality | (usesAntiAlias || usesFourierFootprint || !exact ? QualityFlag.Interpolated : QualityFlag.None);
  }
  return aligned;
}

function filterFiniteRuns(values: number[], sampleRate: number, cutoffHz: number, order: number): number[] {
  const output = values.slice();
  const sections = designButterworth('lowpass', sampleRate, cutoffHz, order);
  let start = 0;
  while (start < values.length) {
    while (start < values.length && !Number.isFinite(values[start])) start += 1;
    if (start >= values.length) break;
    let end = start + 1;
    while (end < values.length && Number.isFinite(values[end])) end += 1;
    let run = values.slice(start, end);
    if (run.length >= 8) {
      run = applyIirCascade(run, sections, 'zero-phase');
    }
    for (let index = 0; index < run.length; index += 1) output[start + index] = run[index];
    start = end;
  }
  return output;
}

function finiteRunPaddingPlan(
  values: ArrayLike<number>,
  sections: Biquad[]
): { effective: number; required: number; truncated: boolean; skippedRuns: number } {
  let minimumEffective = Infinity;
  let required = 0;
  let truncated = false;
  let skippedRuns = 0;
  let start = 0;
  while (start < values.length) {
    while (start < values.length && !Number.isFinite(Number(values[start]))) start += 1;
    if (start >= values.length) break;
    let end = start + 1;
    while (end < values.length && Number.isFinite(Number(values[end]))) end += 1;
    const runLength = end - start;
    if (runLength < 8) {
      skippedRuns += 1;
    } else {
      const plan = iirPaddingPlan(sections, runLength);
      minimumEffective = Math.min(minimumEffective, plan.effective);
      required = Math.max(required, plan.required);
      truncated ||= plan.truncated;
    }
    start = end;
  }
  return {
    effective: Number.isFinite(minimumEffective) ? minimumEffective : 0,
    required,
    truncated,
    skippedRuns
  };
}

function interpolateCubic(time: number[], values: number[], leftIndex: number, target: number): number {
  const rightIndex = Math.min(time.length - 1, leftIndex + 1);
  if (!Number.isFinite(values[leftIndex]) || !Number.isFinite(values[rightIndex])) return Number.NaN;
  if (leftIndex < 1 || rightIndex + 1 >= time.length) {
    const interval = time[rightIndex] - time[leftIndex];
    const fraction = interval > 0 ? (target - time[leftIndex]) / interval : 0;
    return values[leftIndex] * (1 - fraction) + values[rightIndex] * fraction;
  }
  const indices = [leftIndex - 1, leftIndex, rightIndex, rightIndex + 1];
  if (indices.some((index) => !Number.isFinite(values[index]))) return Number.NaN;
  let result = 0;
  for (const index of indices) {
    let basis = 1;
    for (const other of indices) {
      if (other === index) continue;
      const denominator = time[index] - time[other];
      if (denominator === 0) return Number.NaN;
      basis *= (target - time[other]) / denominator;
    }
    result += values[index] * basis;
  }
  return result;
}

function interpolateBandlimitedPolynomial(time: number[], values: number[], leftIndex: number, target: number): number {
  const windowSize = Math.min(16, time.length);
  if (windowSize < 6) return interpolateCubic(time, values, leftIndex, target);
  const start = Math.max(0, Math.min(time.length - windowSize, leftIndex - Math.floor(windowSize / 2) + 1));
  const end = start + windowSize;
  for (let index = start; index < end; index += 1) {
    if (!Number.isFinite(values[index])) return interpolateCubic(time, values, leftIndex, target);
    if (target === time[index]) return values[index];
  }
  let numerator = 0;
  let denominator = 0;
  for (let index = start; index < end; index += 1) {
    let weight = 1;
    for (let other = start; other < end; other += 1) {
      if (other !== index) weight /= time[index] - time[other];
    }
    const scaledWeight = weight / (target - time[index]);
    numerator += scaledWeight * values[index];
    denominator += scaledWeight;
  }
  return denominator !== 0 ? numerator / denominator : interpolateCubic(time, values, leftIndex, target);
}

export function antiAliasAndDecimate(
  timeArray: ArrayLike<number>,
  valueArray: ArrayLike<number>,
  requestedFactor: number
): DecimatedSeries {
  const factor = Math.max(1, Math.floor(requestedFactor));
  const length = Math.min(timeArray.length, valueArray.length);
  if (factor === 1 || length < 3) {
    return {
      time: Array.from(timeArray).slice(0, length),
      values: Array.from(valueArray).slice(0, length),
      factor: 1,
      cutoffHz: null,
      filterOrder: null,
      paddingSamples: 0,
      requiredPaddingSamples: 0,
      settlingTruncated: false,
      skippedFilterRuns: 0
    };
  }

  const analysis = analyzeTimebase(timeArray);
  if (!analysis.valid) throw new Error(analysis.warnings[0] || 'Invalid timebase.');
  const uniform = analysis.uniform
    ? {
        time: Array.from(timeArray).slice(0, length),
        values: [Array.from(valueArray).slice(0, length)]
      }
    : resampleLinear(timeArray, [valueArray], analysis.medianDt);
  const cutoffHz = (analysis.sampleRate / factor) * 0.35;
  const filtered = filterFiniteRuns(uniform.values[0], analysis.sampleRate, cutoffHz, DECIMATION_FILTER_ORDER);
  const padding = finiteRunPaddingPlan(
    uniform.values[0],
    designButterworth('lowpass', analysis.sampleRate, cutoffHz, DECIMATION_FILTER_ORDER)
  );

  const time: number[] = [];
  const values: number[] = [];
  for (let i = 0; i < filtered.length; i += factor) {
    time.push(uniform.time[i]);
    values.push(filtered[i]);
  }
  return {
    time,
    values,
    factor,
    cutoffHz,
    filterOrder: DECIMATION_FILTER_ORDER,
    paddingSamples: padding.effective,
    requiredPaddingSamples: padding.required,
    settlingTruncated: padding.truncated,
    skippedFilterRuns: padding.skippedRuns
  };
}

export function frequencyBinCount(fftSize: number): number {
  return Math.floor(fftSize / 2) + 1;
}

export function frequencyBinWidth(fftSize: number, fs: number): number {
  return fftSize > 0 ? fs / fftSize : 0;
}

export function buildFrequencyAxis(fftSize: number, fs: number): FrequencyAxis {
  const nBins = frequencyBinCount(fftSize);
  const binWidth = frequencyBinWidth(fftSize, fs);
  const axis = new Array<number>(nBins);
  for (let i = 0; i < nBins; i++) {
    axis[i] = i * binWidth;
  }
  return { axis, binWidth, nBins };
}
