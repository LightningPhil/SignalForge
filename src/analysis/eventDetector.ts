import { analyzeTimebase } from '../processing/sampling';
import { maskValuesForAnalysis } from '../data/quality';
import type { AnalysisEvent, AnalysisSelection, AnalysisSeries, AnalysisTrigger, TriggerSource } from '../types';
import { AnalysisTypes } from './analysisEngine';
import { sliceSeries, toFinitePairs } from './analysisUtils';
import { computeDerivative } from './derivedSignals';
import { interpolateCrossing } from './pulse';

const DEFAULT_TRIGGER: AnalysisTrigger = {
  enabled: true,
  type: 'level',
  direction: 'rising',
  threshold: 0,
  hysteresis: 0,
  slopeThreshold: 0,
  minWidth: 0,
  maxWidth: Infinity,
  minSeparation: 0,
  highThreshold: 1,
  lowThreshold: 0,
  source: 'raw',
  selectionOnly: true
};

type TriggerCfg = AnalysisTrigger & { sourceType?: string; units?: string };

export interface DetectedEvents {
  events: AnalysisEvent[];
  selection: { i0: number | null; i1: number | null };
  warnings: string[];
  signal?: number[];
  sourceType?: string;
}

function resolveTriggerSignal(
  trace: AnalysisSeries | null,
  sourceType: TriggerSource | 'auto'
): { t: number[]; y: number[]; sourceType: string; units: string; qualityExcluded: number } {
  if (!trace) return { t: [], y: [], sourceType, units: 'units', qualityExcluded: 0 };
  const requestedSource =
    sourceType === 'auto' ? (!trace.isMath && trace.filteredY?.length ? 'filtered' : 'raw') : sourceType;
  const usesFiltered = requestedSource === 'filtered' && !trace.isMath && !!trace.filteredY?.length;
  const baseSource = usesFiltered ? 'filtered' : requestedSource === 'filtered' ? 'raw' : requestedSource;
  const baseY = usesFiltered ? (trace.filteredY as number[]) : trace.rawY;
  const quality = usesFiltered ? trace.filteredQuality : trace.rawQuality;
  const masked = maskValuesForAnalysis(baseY, quality);
  const t = Array.from(trace.rawX || []);
  const y = masked.values;
  if (sourceType === 'derivative') {
    return {
      t,
      y: Array.from(computeDerivative(t, y)),
      sourceType: 'derivative',
      units: 'units/s',
      qualityExcluded: masked.excluded
    };
  }
  return { t, y, sourceType: baseSource, units: 'units', qualityExcluded: masked.excluded };
}

function event(index: number, time: number, type: string, metadata: Record<string, unknown>): AnalysisEvent {
  return AnalysisTypes.createEvent({ index, time, type, metadata });
}

function areAdjacent(indices: number[], index: number): boolean {
  return index > 0 && indices[index] === indices[index - 1] + 1;
}

/**
 * Robust estimate of the additive white-noise standard deviation: 1.4826·MAD of the second
 * differences divided by √6. Second differences cancel linear trends, so a clean slowly varying
 * signal yields ≈0 while noise on a flat or sloping baseline is measured faithfully.
 */
function noiseSigma(values: number[], indices: number[]): number {
  const seconds: number[] = [];
  for (let index = 2; index < values.length; index += 1) {
    if (areAdjacent(indices, index) && areAdjacent(indices, index - 1)) {
      seconds.push(values[index] - 2 * values[index - 1] + values[index - 2]);
    }
  }
  if (seconds.length === 0) return 0;
  const center = median(seconds);
  return (median(seconds.map((value) => Math.abs(value - center))) * 1.4826) / Math.sqrt(6);
}

/**
 * Walks back from an arming sample to the most recent adjacent pair that straddles the threshold
 * itself, so automatic-hysteresis events are still timestamped at the configured level.
 */
function thresholdCrossingBefore(
  time: number[],
  values: number[],
  indices: number[],
  armedIndex: number,
  threshold: number,
  rising: boolean
): { index: number; time: number } {
  for (let index = armedIndex; index >= 1; index -= 1) {
    if (!areAdjacent(indices, index)) break;
    const previous = values[index - 1];
    const current = values[index];
    const straddles = rising
      ? previous < threshold && current >= threshold
      : previous > threshold && current <= threshold;
    if (straddles) {
      return { index, time: interpolateCrossing(time[index - 1], previous, time[index], current, threshold) };
    }
  }
  return {
    index: armedIndex,
    time: interpolateCrossing(
      time[armedIndex - 1],
      values[armedIndex - 1],
      time[armedIndex],
      values[armedIndex],
      threshold
    )
  };
}

function detectLevelCrossings(
  time: number[],
  values: number[],
  indices: number[],
  config: TriggerCfg
): { events: AnalysisEvent[]; hysteresis: number; automaticHysteresis: boolean } {
  const events: AnalysisEvent[] = [];
  const configuredHysteresis = Math.max(0, Number(config.hysteresis) || 0);
  // With zero hysteresis a threshold sitting in the noise chatters on every sample; derive a band
  // from the measured noise so that only genuine level changes register, and disclose it.
  const automatic = configuredHysteresis === 0;
  const hysteresis = automatic ? noiseSigma(values, indices) * 3 : configuredHysteresis;
  const upper = config.threshold + hysteresis;
  const lower = config.threshold - hysteresis;
  // Initial state is judged against the threshold itself, not the upper band edge, so an opening
  // excursion that starts inside the band and dives below `lower` is still a falling crossing.
  let state: 'above' | 'below' = values[0] >= config.threshold ? 'above' : 'below';

  // User-configured hysteresis timestamps the event at the band edge that armed it (Schmitt
  // semantics); the automatic noise band only suppresses chatter and keeps the threshold timestamp.
  const locate = (index: number, band: number, rising: boolean): { index: number; time: number } =>
    automatic
      ? thresholdCrossingBefore(time, values, indices, index, config.threshold, rising)
      : { index, time: interpolateCrossing(time[index - 1], values[index - 1], time[index], values[index], band) };

  for (let index = 1; index < values.length; index += 1) {
    if (!areAdjacent(indices, index)) {
      state = values[index] >= config.threshold ? 'above' : 'below';
      continue;
    }
    const current = values[index];
    if (state === 'below' && current >= upper) {
      if (config.direction === 'rising' || config.direction === 'either') {
        const crossing = locate(index, upper, true);
        events.push(
          event(indices[crossing.index], crossing.time, 'level', {
            direction: 'rising',
            threshold: config.threshold,
            triggerLevel: automatic ? config.threshold : upper,
            armingLevel: upper,
            amplitude: automatic ? config.threshold : upper,
            sourceType: config.sourceType,
            units: config.units,
            interpolated: true
          })
        );
      }
      state = 'above';
    } else if (state === 'above' && current <= lower) {
      if (config.direction === 'falling' || config.direction === 'either') {
        const crossing = locate(index, lower, false);
        events.push(
          event(indices[crossing.index], crossing.time, 'level', {
            direction: 'falling',
            threshold: config.threshold,
            triggerLevel: automatic ? config.threshold : lower,
            armingLevel: lower,
            amplitude: automatic ? config.threshold : lower,
            sourceType: config.sourceType,
            units: config.units,
            interpolated: true
          })
        );
      }
      state = 'below';
    }
  }
  return { events, hysteresis, automaticHysteresis: automatic && hysteresis > 0 };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Automatic slope threshold: the robust slope noise σ (1.4826·MAD) scaled by a factor that grows
 * with the record length, so the expected number of noise-only excursions stays well below one
 * (the largest of N Gaussian samples sits near σ·√(2·ln N)). A fixed 6·MAD (≈4σ) produced several
 * false edges per 100k noise samples.
 */
function automaticSlopeThreshold(slopes: number[]): number {
  const finite = slopes.filter(Number.isFinite);
  if (finite.length === 0) return Number.EPSILON;
  const center = median(finite);
  const sigma = median(finite.map((value) => Math.abs(value - center))) * 1.4826;
  const factor = Math.max(6, Math.sqrt(2 * Math.log(Math.max(2, finite.length))) + 1.5);
  return Math.max(Number.EPSILON, sigma * factor);
}

function detectEdges(
  time: number[],
  values: number[],
  indices: number[],
  config: TriggerCfg
): { events: AnalysisEvent[]; threshold: number; automatic: boolean } {
  const slopes = Array.from(computeDerivative(time, values));
  const configured = Math.abs(Number(config.slopeThreshold) || 0);
  const threshold = configured > 0 ? configured : automaticSlopeThreshold(slopes);
  const events: AnalysisEvent[] = [];

  for (let index = 1; index < slopes.length; index += 1) {
    if (!areAdjacent(indices, index)) continue;
    const rising = slopes[index - 1] < threshold && slopes[index] >= threshold;
    const falling = slopes[index - 1] > -threshold && slopes[index] <= -threshold;
    if (rising && config.direction !== 'falling') {
      events.push(
        event(indices[index], time[index], 'edge', {
          slope: slopes[index],
          direction: 'rising',
          amplitude: values[index],
          threshold,
          sourceType: config.sourceType,
          units: config.units
        })
      );
    } else if (falling && config.direction !== 'rising') {
      events.push(
        event(indices[index], time[index], 'edge', {
          slope: slopes[index],
          direction: 'falling',
          amplitude: values[index],
          threshold,
          sourceType: config.sourceType,
          units: config.units
        })
      );
    }
  }
  return { events, threshold, automatic: configured === 0 };
}

function detectPositivePulseWidths(
  time: number[],
  values: number[],
  indices: number[],
  config: TriggerCfg,
  direction: 'rising' | 'falling'
): AnalysisEvent[] {
  const events: AnalysisEvent[] = [];
  // A record that opens above the threshold is a truncated pulse without a start crossing; it is
  // not reported as a measured width.
  let startIndex: number | null = null;
  let startTime = 0;
  let peak = -Infinity;

  for (let index = 1; index < values.length; index += 1) {
    if (!areAdjacent(indices, index)) {
      startIndex = null;
      peak = -Infinity;
      continue;
    }
    const previous = values[index - 1];
    const current = values[index];
    if (startIndex === null && previous < config.threshold && current >= config.threshold) {
      startIndex = index;
      startTime = interpolateCrossing(time[index - 1], previous, time[index], current, config.threshold);
      peak = current;
    } else if (startIndex !== null) {
      peak = Math.max(peak, current);
      if (previous >= config.threshold && current < config.threshold) {
        const endTime = interpolateCrossing(time[index - 1], previous, time[index], current, config.threshold);
        const width = endTime - startTime;
        if (width >= config.minWidth && width <= config.maxWidth) {
          events.push(
            event(indices[startIndex], startTime, 'pulse', {
              width,
              peak: direction === 'rising' ? peak : -peak,
              amplitude: direction === 'rising' ? peak : -peak,
              threshold: direction === 'rising' ? config.threshold : -config.threshold,
              direction,
              sourceType: config.sourceType,
              units: config.units,
              interpolated: true
            })
          );
        }
        startIndex = null;
        peak = -Infinity;
      }
    }
  }
  return events;
}

function detectPulseWidths(time: number[], values: number[], indices: number[], config: TriggerCfg): AnalysisEvent[] {
  const positive =
    config.direction === 'falling' ? [] : detectPositivePulseWidths(time, values, indices, config, 'rising');
  if (config.direction === 'rising') return positive;
  // 'either' treats the threshold as a magnitude applied symmetrically (±|threshold|) so that a
  // baseline at 0 is never "inside" the negative pulse; 'falling' keeps the threshold as the actual
  // level the signal must fall below (a negative value for a negative-going pulse from 0).
  const negativeLevel = config.direction === 'either' ? -Math.abs(config.threshold) : config.threshold;
  const invertedConfig = { ...config, threshold: -negativeLevel };
  const negative = detectPositivePulseWidths(
    time,
    values.map((value) => -value),
    indices,
    invertedConfig,
    'falling'
  );
  return [...positive, ...negative].sort((left, right) => (left.time || 0) - (right.time || 0));
}

function detectRisingRunts(
  time: number[],
  values: number[],
  indices: number[],
  config: TriggerCfg,
  low: number,
  high: number
): AnalysisEvent[] {
  const events: AnalysisEvent[] = [];
  let startIndex: number | null = null;
  let startTime = 0;
  let reachedHigh = false;
  let peak = -Infinity;
  for (let index = 1; index < values.length; index += 1) {
    if (!areAdjacent(indices, index)) {
      startIndex = null;
      reachedHigh = false;
      continue;
    }
    const previous = values[index - 1];
    const current = values[index];
    if (startIndex === null && previous < low && current >= low) {
      startIndex = index;
      startTime = interpolateCrossing(time[index - 1], previous, time[index], current, low);
      peak = current;
      reachedHigh = current >= high;
    } else if (startIndex !== null) {
      peak = Math.max(peak, current);
      reachedHigh ||= current >= high;
      if (previous >= low && current < low) {
        const endTime = interpolateCrossing(time[index - 1], previous, time[index], current, low);
        const width = endTime - startTime;
        if (!reachedHigh && width >= config.minWidth && width <= config.maxWidth) {
          events.push(
            event(indices[startIndex], startTime, 'runt', {
              direction: 'rising',
              width,
              peak,
              crossedThreshold: low,
              missedThreshold: high,
              amplitude: peak,
              sourceType: config.sourceType,
              units: config.units,
              interpolated: true
            })
          );
        }
        startIndex = null;
        reachedHigh = false;
        peak = -Infinity;
      }
    }
  }
  return events;
}

function detectRunts(time: number[], values: number[], indices: number[], config: TriggerCfg): AnalysisEvent[] {
  const low = Math.min(config.lowThreshold, config.highThreshold);
  const high = Math.max(config.lowThreshold, config.highThreshold);
  const events = config.direction === 'falling' ? [] : detectRisingRunts(time, values, indices, config, low, high);
  if (config.direction === 'rising') return events;
  const inverted = values.map((value) => -value);
  const falling = detectRisingRunts(time, inverted, indices, config, -high, -low).map((detected) => ({
    ...detected,
    metadata: {
      ...detected.metadata,
      direction: 'falling',
      amplitude: -(detected.metadata.amplitude as number),
      peak: -(detected.metadata.peak as number),
      crossedThreshold: high,
      missedThreshold: low
    }
  }));
  return [...events, ...falling].sort((leftEvent, rightEvent) => (leftEvent.time || 0) - (rightEvent.time || 0));
}

function applyMinimumSeparation(events: AnalysisEvent[], minimumSeconds: number): AnalysisEvent[] {
  if (!(minimumSeconds > 0)) return events;
  const retained: AnalysisEvent[] = [];
  for (const detected of events) {
    const previous = retained[retained.length - 1];
    if (!previous || !Number.isFinite(previous.time) || !Number.isFinite(detected.time)) {
      retained.push(detected);
    } else if ((detected.time as number) - (previous.time as number) >= minimumSeconds) {
      retained.push(detected);
    }
  }
  return retained;
}

export const EventDetector = {
  defaults: DEFAULT_TRIGGER,

  normalizeConfig(config: Partial<AnalysisTrigger> = {}): AnalysisTrigger {
    return { ...DEFAULT_TRIGGER, ...config };
  },

  resolveTriggerSignal,

  detect({
    t = [],
    y = [],
    quality = null,
    selection = null,
    config = {},
    trace = null
  }: {
    t?: ArrayLike<number>;
    y?: ArrayLike<number>;
    quality?: ArrayLike<number> | null;
    selection?: AnalysisSelection | null;
    config?: Partial<AnalysisTrigger>;
    trace?: AnalysisSeries | null;
  }): DetectedEvents {
    const triggerConfig: TriggerCfg = this.normalizeConfig(config);
    const resolved = trace
      ? resolveTriggerSignal(trace, triggerConfig.source)
      : (() => {
          const masked = maskValuesForAnalysis(y, quality);
          return {
            t: Array.from(t),
            y: masked.values,
            sourceType: triggerConfig.source,
            units: 'units',
            qualityExcluded: masked.excluded
          };
        })();
    const paired = toFinitePairs(resolved.t, resolved.y);
    const sliced = sliceSeries(paired.t, paired.y, triggerConfig.selectionOnly ? selection : null, paired.indices);
    triggerConfig.sourceType = resolved.sourceType;
    triggerConfig.units = resolved.units;

    if (!triggerConfig.enabled || sliced.t.length < 2) {
      return {
        events: [],
        selection: sliced.selection,
        warnings: [],
        signal: resolved.y,
        sourceType: triggerConfig.sourceType
      };
    }

    const warnings: string[] = [];
    const omitted = Math.min(resolved.t.length, resolved.y.length) - paired.t.length;
    if (omitted > 0) warnings.push(`Excluded ${omitted} invalid aligned pair(s); source indices were preserved.`);
    if (resolved.qualityExcluded > 0) {
      warnings.push(`Excluded ${resolved.qualityExcluded} sample(s) carrying analysis-blocking quality flags.`);
    }
    let events: AnalysisEvent[] = [];
    if (triggerConfig.type === 'level') {
      const levelResult = detectLevelCrossings(sliced.t, sliced.y, sliced.indices, triggerConfig);
      events = levelResult.events;
      if (levelResult.automaticHysteresis) {
        warnings.push(
          `Hysteresis was 0; applied an automatic noise-derived band of ±${levelResult.hysteresis.toPrecision(3)} to suppress chatter.`
        );
      }
    } else if (triggerConfig.type === 'edge') {
      const edgeResult = detectEdges(sliced.t, sliced.y, sliced.indices, triggerConfig);
      events = edgeResult.events;
      if (edgeResult.automatic) {
        warnings.push(`Used an automatic robust slope threshold of ${edgeResult.threshold.toPrecision(4)}.`);
      }
    } else if (triggerConfig.type === 'pulse') {
      events = detectPulseWidths(sliced.t, sliced.y, sliced.indices, triggerConfig);
    } else if (triggerConfig.type === 'runt') {
      events = detectRunts(sliced.t, sliced.y, sliced.indices, triggerConfig);
    }
    events = applyMinimumSeparation(events, Math.max(0, triggerConfig.minSeparation || 0));

    warnings.push(...analyzeTimebase(sliced.t).warnings);
    return {
      events,
      selection: sliced.selection,
      warnings,
      signal: resolved.y,
      sourceType: triggerConfig.sourceType
    };
  }
};
