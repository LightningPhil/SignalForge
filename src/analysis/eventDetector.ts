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

function detectLevelCrossings(
  time: number[],
  values: number[],
  indices: number[],
  config: TriggerCfg
): AnalysisEvent[] {
  const events: AnalysisEvent[] = [];
  const hysteresis = Math.max(0, Number(config.hysteresis) || 0);
  const upper = config.threshold + hysteresis;
  const lower = config.threshold - hysteresis;
  let state: 'above' | 'below' = values[0] >= upper ? 'above' : 'below';

  for (let index = 1; index < values.length; index += 1) {
    if (!areAdjacent(indices, index)) {
      state = values[index] >= upper ? 'above' : 'below';
      continue;
    }
    const current = values[index];
    if (state === 'below' && current >= upper) {
      if (config.direction === 'rising' || config.direction === 'either') {
        const crossingTime = interpolateCrossing(time[index - 1], values[index - 1], time[index], current, upper);
        events.push(
          event(indices[index], crossingTime, 'level', {
            direction: 'rising',
            threshold: config.threshold,
            triggerLevel: upper,
            amplitude: upper,
            sourceType: config.sourceType,
            units: config.units,
            interpolated: true
          })
        );
      }
      state = 'above';
    } else if (state === 'above' && current <= lower) {
      if (config.direction === 'falling' || config.direction === 'either') {
        const crossingTime = interpolateCrossing(time[index - 1], values[index - 1], time[index], current, lower);
        events.push(
          event(indices[index], crossingTime, 'level', {
            direction: 'falling',
            threshold: config.threshold,
            triggerLevel: lower,
            amplitude: lower,
            sourceType: config.sourceType,
            units: config.units,
            interpolated: true
          })
        );
      }
      state = 'below';
    }
  }
  return events;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function automaticSlopeThreshold(slopes: number[]): number {
  const center = median(slopes);
  const deviation = median(slopes.map((value) => Math.abs(value - center)));
  return Math.max(Number.EPSILON, deviation * 6);
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
  let startIndex: number | null = values[0] >= config.threshold ? 0 : null;
  let startTime = startIndex === null ? 0 : time[0];
  let peak = startIndex === null ? -Infinity : values[0];

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
  const invertedConfig = { ...config, threshold: -config.threshold };
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
      events = detectLevelCrossings(sliced.t, sliced.y, sliced.indices, triggerConfig);
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
