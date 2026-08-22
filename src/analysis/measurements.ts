import type { AnalysisSelection } from '../types';
import { sliceSeries, toNumberArray } from './analysisUtils';

export interface MeasurementOptions {
  dutyThreshold?: number;
  edgeThresholds?: { lowFraction?: number; highFraction?: number };
}

export interface MeasurementResult {
  metrics: Record<string, number | null>;
  selection: { i0: number | null; i1: number | null };
  warnings: string[];
  meta: { sampleCount: number; duration: number | null };
}

function mean(arr: number[]): number | null {
  if (!arr.length) return null;
  return arr.reduce((sum, v) => sum + v, 0) / arr.length;
}

function rms(arr: number[]): number | null {
  if (!arr.length) return null;
  return Math.sqrt(arr.reduce((sum, v) => sum + v * v, 0) / arr.length);
}

function stddev(arr: number[], arrMean: number | null = null): number | null {
  if (arr.length < 2) return null;
  const m = arrMean === null ? mean(arr) : arrMean;
  if (m === null) return null;
  return Math.sqrt(arr.reduce((sum, v) => sum + ((v - m) ** 2), 0) / (arr.length - 1));
}

function median(arr: number[]): number | null {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(arr: number[], p: number): number | null {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (upper === lower) return sorted[lower];
  return sorted[lower] * (1 - (idx - lower)) + sorted[upper] * (idx - lower);
}

function zeroCrossings(t: number[], y: number[]): Array<{ time: number; direction: 'rising' | 'falling' }> {
  const crossings: Array<{ time: number; direction: 'rising' | 'falling' }> = [];
  for (let i = 0; i < y.length - 1; i += 1) {
    const y0 = y[i];
    const y1 = y[i + 1];
    const t0 = t[i];
    const t1 = t[i + 1];
    if (![y0, y1, t0, t1].every(Number.isFinite)) continue;
    if (y0 === 0) {
      crossings.push({ time: t0, direction: Math.sign(y1) - Math.sign(y0) >= 0 ? 'rising' : 'falling' });
      continue;
    }
    if ((y0 < 0 && y1 > 0) || (y0 > 0 && y1 < 0)) {
      const frac = Math.abs(y0) / (Math.abs(y0) + Math.abs(y1));
      crossings.push({ time: t0 + (t1 - t0) * frac, direction: y0 < y1 ? 'rising' : 'falling' });
    }
  }
  return crossings;
}

function estimateFrequency(crossings: Array<{ time: number; direction: string }>): { frequencyHz: number | null; period: number | null } {
  const rising = crossings.filter((c) => c.direction === 'rising').map((c) => c.time);
  if (rising.length < 2) return { frequencyHz: null, period: null };
  const periods: number[] = [];
  for (let i = 0; i < rising.length - 1; i += 1) {
    const dt = rising[i + 1] - rising[i];
    if (dt > 0) periods.push(dt);
  }
  const avgPeriod = mean(periods);
  if (!avgPeriod) return { frequencyHz: null, period: null };
  return { frequencyHz: 1 / avgPeriod, period: avgPeriod };
}

function findLevelCrossing(t: number[], y: number[], target: number, mode: 'rising' | 'falling'): number | null {
  for (let i = 0; i < y.length - 1; i += 1) {
    const y0 = y[i];
    const y1 = y[i + 1];
    const t0 = t[i];
    const t1 = t[i + 1];
    if (![y0, y1, t0, t1].every(Number.isFinite)) continue;
    if (mode === 'rising' && y0 <= target && y1 >= target) {
      return t0 + (t1 - t0) * ((target - y0) / (y1 - y0 || 1));
    }
    if (mode === 'falling' && y0 >= target && y1 <= target) {
      return t0 + (t1 - t0) * ((y0 - target) / (y0 - y1 || 1));
    }
  }
  return null;
}

function integrate(t: number[], y: number[], absolute = false): number | null {
  if (t.length < 2 || y.length < 2) return null;
  let area = 0;
  for (let i = 0; i < t.length - 1; i += 1) {
    const y0 = absolute ? Math.abs(y[i]) : y[i];
    const y1 = absolute ? Math.abs(y[i + 1]) : y[i + 1];
    area += (y0 + y1) * 0.5 * (t[i + 1] - t[i]);
  }
  return area;
}

function dutyCycle(t: number[], y: number[], threshold: number): number | null {
  if (t.length < 2 || y.length < 2) return null;
  let highTime = 0;
  let total = 0;
  for (let i = 0; i < y.length - 1; i += 1) {
    const dt = t[i + 1] - t[i];
    total += dt;
    const above0 = y[i] >= threshold;
    const above1 = y[i + 1] >= threshold;
    if (above0 && above1) highTime += dt;
    else if (above0 !== above1) {
      const frac = Math.abs(threshold - y[i]) / (Math.abs(y[i + 1] - y[i]) || 1);
      const crossTime = t[i] + dt * frac;
      highTime += above0 ? crossTime - t[i] : t[i + 1] - crossTime;
    }
  }
  return total <= 0 ? null : highTime / total;
}

function riseFallMetrics(t: number[], y: number[], { lowFraction = 0.1, highFraction = 0.9 } = {}) {
  if (!y.length) return { riseTime: null, fallTime: null, overshootPct: null, undershootPct: null };
  const yMin = Math.min(...y);
  const yMax = Math.max(...y);
  const span = yMax - yMin;
  if (!Number.isFinite(span) || span === 0) {
    return { riseTime: null, fallTime: null, overshootPct: null, undershootPct: null };
  }
  const lowLevel = yMin + span * lowFraction;
  const highLevel = yMin + span * highFraction;
  const riseStart = findLevelCrossing(t, y, lowLevel, 'rising');
  const riseEnd = findLevelCrossing(t, y, highLevel, 'rising');
  const fallStart = findLevelCrossing(t, y, highLevel, 'falling');
  const fallEnd = findLevelCrossing(t, y, lowLevel, 'falling');
  const upperSteady = percentile(y, 0.98) ?? yMax;
  const lowerSteady = percentile(y, 0.02) ?? yMin;
  return {
    riseTime: riseStart !== null && riseEnd !== null ? riseEnd - riseStart : null,
    fallTime: fallStart !== null && fallEnd !== null ? fallEnd - fallStart : null,
    overshootPct: Math.max(0, ((yMax - upperSteady) / span) * 100),
    undershootPct: Math.max(0, ((lowerSteady - yMin) / span) * 100)
  };
}

function detectTimeVariance(t: number[]): { average: number; deviation: number; relative: number } | null {
  if (t.length < 2) return null;
  const deltas: number[] = [];
  for (let i = 0; i < t.length - 1; i += 1) {
    const dt = t[i + 1] - t[i];
    if (Number.isFinite(dt) && dt > 0) deltas.push(dt);
  }
  if (!deltas.length) return null;
  const avg = mean(deltas);
  const dev = stddev(deltas, avg) || 0;
  if (!avg) return null;
  return { average: avg, deviation: dev, relative: dev / avg };
}

export const Measurements = {
  compute(params: { t?: ArrayLike<number>; y?: ArrayLike<number>; selection?: AnalysisSelection | null } = {}, options: MeasurementOptions = {}): MeasurementResult {
    const tArray = toNumberArray(params.t || []);
    const yArray = toNumberArray(params.y || []);
    const { t, y, selection } = sliceSeries(tArray, yArray, params.selection || null);

    if (!t.length || !y.length) {
      return { metrics: {}, selection, warnings: ['No data in selection'], meta: { sampleCount: 0, duration: null } };
    }

    const yMin = Math.min(...y);
    const yMax = Math.max(...y);
    const avg = mean(y);
    const crossingInfo = zeroCrossings(t, y);
    const { frequencyHz, period } = estimateFrequency(crossingInfo);
    const dutyLevel = options.dutyThreshold !== undefined ? options.dutyThreshold : (yMin + yMax) / 2;
    const edges = riseFallMetrics(t, y, options.edgeThresholds || {});
    const timeVariance = detectTimeVariance(t);
    const warnings: string[] = [];
    if (timeVariance && timeVariance.relative > 0.05) {
      warnings.push('Timebase is non-uniform (>5% variation)');
    }

    const peakIndex = y.indexOf(yMax);
    const valleyIndex = y.indexOf(yMin);

    return {
      metrics: {
        min: yMin,
        max: yMax,
        mean: avg,
        rms: rms(y),
        peakToPeak: Number.isFinite(yMax - yMin) ? yMax - yMin : null,
        stddev: stddev(y, avg),
        median: median(y),
        zeroCrossings: crossingInfo.length,
        frequencyHz,
        period,
        dutyCycle: dutyCycle(t, y, dutyLevel),
        riseTime: edges.riseTime,
        fallTime: edges.fallTime,
        overshootPct: edges.overshootPct,
        undershootPct: edges.undershootPct,
        area: integrate(t, y, false),
        absArea: integrate(t, y, true),
        peakTime: peakIndex >= 0 ? t[peakIndex] : null,
        valleyTime: valleyIndex >= 0 ? t[valleyIndex] : null
      },
      selection,
      warnings,
      meta: {
        sampleCount: y.length,
        duration: t.length > 1 ? t[t.length - 1] - t[0] : null
      }
    };
  }
};
