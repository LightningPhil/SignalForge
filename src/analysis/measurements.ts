import { analyzeTimebase } from '../processing/sampling';
import { maskValuesForAnalysis } from '../data/quality';
import type { AnalysisSelection } from '../types';
import { sliceSeries, toFinitePairs } from './analysisUtils';
import { estimatePulseLevels, findCrossingAfterPeak, findCrossingBeforePeak, type PulseLevels } from './pulse';

export interface MeasurementOptions {
  dutyThreshold?: number;
  edgeThresholds?: { lowFraction?: number; highFraction?: number };
}

export interface MeasurementResult {
  metrics: Record<string, number | null>;
  selection: { i0: number | null; i1: number | null };
  warnings: string[];
  meta: { sampleCount: number; duration: number | null; invalidPairCount: number; qualityExcludedCount: number };
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

function rms(values: number[]): number | null {
  if (values.length === 0) return null;
  let sumSquares = 0;
  for (const value of values) sumSquares += value * value;
  return Math.sqrt(sumSquares / values.length);
}

function stddev(values: number[], valuesMean: number | null = null): number | null {
  if (values.length < 2) return null;
  const average = valuesMean ?? mean(values);
  if (average === null) return null;
  let sumSquares = 0;
  for (const value of values) sumSquares += (value - average) ** 2;
  return Math.sqrt(sumSquares / (values.length - 1));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function minMax(values: number[]): { min: number; max: number; minIndex: number; maxIndex: number } | null {
  if (values.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  let minIndex = -1;
  let maxIndex = -1;
  values.forEach((value, index) => {
    if (value < min) {
      min = value;
      minIndex = index;
    }
    if (value > max) {
      max = value;
      maxIndex = index;
    }
  });
  return minIndex >= 0 ? { min, max, minIndex, maxIndex } : null;
}

function zeroCrossings(
  time: number[],
  values: number[],
  sourceIndices: number[]
): Array<{ time: number; direction: 'rising' | 'falling' }> {
  const crossings: Array<{ time: number; direction: 'rising' | 'falling' }> = [];
  for (let index = 0; index < values.length - 1; index += 1) {
    if (sourceIndices[index + 1] !== sourceIndices[index] + 1) continue;
    const first = values[index];
    const second = values[index + 1];
    if ((first < 0 && second >= 0) || (first > 0 && second <= 0)) {
      const fraction = Math.abs(first) / (Math.abs(first) + Math.abs(second) || 1);
      crossings.push({
        time: time[index] + (time[index + 1] - time[index]) * fraction,
        direction: second > first ? 'rising' : 'falling'
      });
    }
  }
  return crossings;
}

function estimateFrequency(crossings: Array<{ time: number; direction: 'rising' | 'falling' }>): {
  frequencyHz: number | null;
  period: number | null;
} {
  const rising = crossings.filter((crossing) => crossing.direction === 'rising').map((crossing) => crossing.time);
  const periods: number[] = [];
  for (let index = 1; index < rising.length; index += 1) {
    const period = rising[index] - rising[index - 1];
    if (period > 0) periods.push(period);
  }
  const representativePeriod = median(periods);
  return representativePeriod && representativePeriod > 0
    ? { frequencyHz: 1 / representativePeriod, period: representativePeriod }
    : { frequencyHz: null, period: null };
}

function integrate(time: number[], values: number[], sourceIndices: number[], absolute = false): number | null {
  if (time.length < 2) return null;
  let area = 0;
  let intervals = 0;
  for (let index = 1; index < time.length; index += 1) {
    if (sourceIndices[index] !== sourceIndices[index - 1] + 1) continue;
    const dt = time[index] - time[index - 1];
    if (!(dt > 0)) continue;
    const first = absolute ? Math.abs(values[index - 1]) : values[index - 1];
    const second = absolute ? Math.abs(values[index]) : values[index];
    area += ((first + second) * dt) / 2;
    intervals += 1;
  }
  return intervals > 0 ? area : null;
}

function dutyCycle(time: number[], values: number[], sourceIndices: number[], threshold: number): number | null {
  let highTime = 0;
  let duration = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (sourceIndices[index] !== sourceIndices[index - 1] + 1) continue;
    const dt = time[index] - time[index - 1];
    if (!(dt > 0)) continue;
    duration += dt;
    const firstHigh = values[index - 1] >= threshold;
    const secondHigh = values[index] >= threshold;
    if (firstHigh && secondHigh) {
      highTime += dt;
    } else if (firstHigh !== secondHigh) {
      const fraction = Math.abs(threshold - values[index - 1]) / (Math.abs(values[index] - values[index - 1]) || 1);
      highTime += firstHigh ? dt * fraction : dt * (1 - fraction);
    }
  }
  return duration > 0 ? highTime / duration : null;
}

function pulseMetrics(time: number[], values: number[], sourceIndices: number[], levels: PulseLevels | null) {
  if (!levels) {
    return {
      baseline: null,
      top: null,
      pulseAmplitude: null,
      riseTime: null,
      fallTime: null,
      pulseWidth: null,
      overshootPct: null,
      undershootPct: null
    };
  }
  const rising = levels.polarity === 1;
  const riseStart = findCrossingBeforePeak(time, values, levels.lowThreshold, levels.peakIndex, rising, sourceIndices);
  const riseEnd = findCrossingBeforePeak(time, values, levels.highThreshold, levels.peakIndex, rising, sourceIndices);
  const fallStart = findCrossingAfterPeak(time, values, levels.highThreshold, levels.peakIndex, rising, sourceIndices);
  const fallEnd = findCrossingAfterPeak(time, values, levels.lowThreshold, levels.peakIndex, rising, sourceIndices);
  const midThreshold = levels.baseline + levels.amplitude * 0.5;
  const widthStart = findCrossingBeforePeak(time, values, midThreshold, levels.peakIndex, rising, sourceIndices);
  const widthEnd = findCrossingAfterPeak(time, values, midThreshold, levels.peakIndex, rising, sourceIndices);
  const extreme = values[levels.peakIndex];
  const amplitude = Math.abs(levels.amplitude);
  const overshoot = amplitude > 0 ? Math.max(0, (levels.polarity * (extreme - levels.top) * 100) / amplitude) : null;
  let oppositeExtreme = levels.baseline;
  for (let index = levels.peakIndex; index < values.length; index += 1) {
    oppositeExtreme =
      levels.polarity === 1 ? Math.min(oppositeExtreme, values[index]) : Math.max(oppositeExtreme, values[index]);
  }
  const undershoot =
    amplitude > 0 ? Math.max(0, (-levels.polarity * (oppositeExtreme - levels.baseline) * 100) / amplitude) : null;
  return {
    baseline: levels.baseline,
    top: levels.top,
    pulseAmplitude: levels.amplitude,
    riseTime: riseStart !== null && riseEnd !== null && riseEnd >= riseStart ? riseEnd - riseStart : null,
    fallTime: fallStart !== null && fallEnd !== null && fallEnd >= fallStart ? fallEnd - fallStart : null,
    pulseWidth: widthStart !== null && widthEnd !== null && widthEnd >= widthStart ? widthEnd - widthStart : null,
    overshootPct: overshoot,
    undershootPct: undershoot
  };
}

export const Measurements = {
  compute(
    params: {
      t?: ArrayLike<number>;
      y?: ArrayLike<number>;
      quality?: ArrayLike<number> | null;
      selection?: AnalysisSelection | null;
    } = {},
    options: MeasurementOptions = {}
  ): MeasurementResult {
    const sourceTime = params.t || [];
    const sourceValues = params.y || [];
    const qualityMasked = maskValuesForAnalysis(sourceValues, params.quality);
    const paired = toFinitePairs(sourceTime, qualityMasked.values);
    const sliced = sliceSeries(paired.t, paired.y, params.selection || null, paired.indices);
    const invalidPairCount = Math.min(sourceTime.length, sourceValues.length) - paired.t.length;

    if (sliced.t.length === 0) {
      return {
        metrics: {},
        selection: sliced.selection,
        warnings: ['No valid aligned data in selection.'],
        meta: { sampleCount: 0, duration: null, invalidPairCount, qualityExcludedCount: qualityMasked.excluded }
      };
    }

    const extrema = minMax(sliced.y);
    if (!extrema) {
      return {
        metrics: {},
        selection: sliced.selection,
        warnings: ['No finite amplitudes in selection.'],
        meta: { sampleCount: 0, duration: null, invalidPairCount, qualityExcludedCount: qualityMasked.excluded }
      };
    }
    const average = mean(sliced.y);
    const crossings = zeroCrossings(sliced.t, sliced.y, sliced.indices);
    const frequency = estimateFrequency(crossings);
    const levels = estimatePulseLevels(sliced.y, {
      lowFraction: options.edgeThresholds?.lowFraction,
      highFraction: options.edgeThresholds?.highFraction
    });
    const pulse = pulseMetrics(sliced.t, sliced.y, sliced.indices, levels);
    const dutyThreshold =
      options.dutyThreshold ?? (levels ? levels.baseline + levels.amplitude * 0.5 : (extrema.min + extrema.max) / 2);
    const timebase = analyzeTimebase(sliced.t);
    const warnings = timebase.warnings.slice();
    if (invalidPairCount > 0) {
      warnings.push(
        `Excluded ${invalidPairCount} invalid time/amplitude pair(s); integrations and crossings do not bridge gaps.`
      );
    }
    if (qualityMasked.excluded > 0) {
      warnings.push(`Excluded ${qualityMasked.excluded} sample(s) carrying analysis-blocking quality flags.`);
    }
    if (levels) warnings.push(...levels.warnings);

    return {
      metrics: {
        min: extrema.min,
        max: extrema.max,
        mean: average,
        rms: rms(sliced.y),
        peakToPeak: extrema.max - extrema.min,
        stddev: stddev(sliced.y, average),
        median: median(sliced.y),
        zeroCrossings: crossings.length,
        frequencyHz: frequency.frequencyHz,
        period: frequency.period,
        dutyCycle: dutyCycle(sliced.t, sliced.y, sliced.indices, dutyThreshold),
        ...pulse,
        area: integrate(sliced.t, sliced.y, sliced.indices),
        absArea: integrate(sliced.t, sliced.y, sliced.indices, true),
        peakTime: sliced.t[extrema.maxIndex] ?? null,
        valleyTime: sliced.t[extrema.minIndex] ?? null
      },
      selection: sliced.selection,
      warnings,
      meta: {
        sampleCount: sliced.y.length,
        duration: sliced.t.length > 1 ? sliced.t[sliced.t.length - 1] - sliced.t[0] : null,
        invalidPairCount,
        qualityExcludedCount: qualityMasked.excluded
      }
    };
  }
};
