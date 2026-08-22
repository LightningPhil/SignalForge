import type { AnalysisEvent, AnalysisSelection, AnalysisSeries, AnalysisTrigger, TriggerSource } from '../types';
import { AnalysisTypes } from './analysisEngine';
import { sliceSeries, toFinitePairs } from './analysisUtils';
import { computeDerivative } from './derivedSignals';

const DEFAULT_TRIGGER: AnalysisTrigger = {
  enabled: true,
  type: 'level',
  direction: 'rising',
  threshold: 0,
  hysteresis: 0,
  slopeThreshold: 0,
  minWidth: 0,
  maxWidth: Infinity,
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
): { t: number[]; y: number[]; sourceType: string; units: string } {
  if (!trace) return { t: [], y: [], sourceType, units: 'units' };

  const baseSource = sourceType === 'auto'
    ? (!trace.isMath && trace.filteredY?.length ? 'filtered' : 'raw')
    : sourceType;

  const baseY = (() => {
    if (baseSource === 'filtered' && !trace.isMath && trace.filteredY?.length) return trace.filteredY;
    return trace.rawY;
  })();

  const t = trace.rawX || [];
  const y = baseY || [];

  if (sourceType === 'derivative') {
    return { t: Array.from(t), y: Array.from(computeDerivative(t, y)), sourceType: 'derivative', units: 'units/s' };
  }
  return { t: Array.from(t), y: Array.from(y), sourceType: baseSource, units: 'units' };
}

function detectLevelCrossings(t: number[], y: number[], cfg: TriggerCfg): AnalysisEvent[] {
  const events: AnalysisEvent[] = [];
  if (t.length < 2) return events;
  const hysteresis = Math.max(0, Number(cfg.hysteresis) || 0);
  const upper = cfg.threshold + hysteresis;
  const lower = cfg.threshold - hysteresis;
  let state: 'above' | 'below' = y[0] >= upper ? 'above' : 'below';

  for (let i = 1; i < y.length; i += 1) {
    const current = y[i];
    if (!Number.isFinite(current)) continue;
    if (state === 'below' && current >= upper) {
      if (cfg.direction === 'rising' || cfg.direction === 'either') {
        events.push(AnalysisTypes.createEvent({
          index: i,
          time: t[i],
          type: 'level',
          metadata: { direction: 'rising', threshold: cfg.threshold, amplitude: current, sourceType: cfg.sourceType, units: cfg.units }
        }));
      }
      state = 'above';
    } else if (state === 'above' && current <= lower) {
      if (cfg.direction === 'falling' || cfg.direction === 'either') {
        events.push(AnalysisTypes.createEvent({
          index: i,
          time: t[i],
          type: 'level',
          metadata: { direction: 'falling', threshold: cfg.threshold, amplitude: current, sourceType: cfg.sourceType, units: cfg.units }
        }));
      }
      state = 'below';
    }
  }
  return events;
}

function detectEdges(t: number[], y: number[], cfg: TriggerCfg): AnalysisEvent[] {
  const events: AnalysisEvent[] = [];
  for (let i = 0; i < y.length - 1; i += 1) {
    const dt = t[i + 1] - t[i];
    if (!Number.isFinite(dt) || dt <= 0 || !Number.isFinite(y[i]) || !Number.isFinite(y[i + 1])) continue;
    const slope = (y[i + 1] - y[i]) / dt;
    const rising = cfg.direction !== 'falling' && slope >= cfg.slopeThreshold;
    const falling = cfg.direction !== 'rising' && slope <= -cfg.slopeThreshold;
    if (rising || falling) {
      events.push(AnalysisTypes.createEvent({
        index: i,
        time: t[i],
        type: 'edge',
        metadata: { slope, direction: rising ? 'rising' : 'falling', amplitude: y[i], sourceType: cfg.sourceType, units: cfg.units }
      }));
    }
  }
  return events;
}

function detectPulseWidths(t: number[], y: number[], cfg: TriggerCfg): AnalysisEvent[] {
  const events: AnalysisEvent[] = [];
  let isHigh = y[0] >= cfg.threshold;
  let startIndex = isHigh ? 0 : null;
  let peak = isHigh ? y[0] : -Infinity;

  for (let i = 1; i < y.length; i += 1) {
    const val = y[i];
    if (!Number.isFinite(val)) continue;
    peak = Math.max(peak, val);
    if (!isHigh && val >= cfg.threshold) {
      isHigh = true;
      startIndex = i;
      peak = val;
    } else if (isHigh && val < cfg.threshold && startIndex !== null) {
      const width = t[i] - t[startIndex];
      if (width >= cfg.minWidth && width <= cfg.maxWidth) {
        events.push(AnalysisTypes.createEvent({
          index: startIndex,
          time: t[startIndex],
          type: 'pulse',
          metadata: { width, peak, amplitude: peak, sourceType: cfg.sourceType, units: cfg.units }
        }));
      }
      isHigh = false;
      startIndex = null;
      peak = -Infinity;
    }
  }
  return events;
}

function detectRunts(t: number[], y: number[], cfg: TriggerCfg): AnalysisEvent[] {
  const events: AnalysisEvent[] = [];
  let isPotential = false;
  let startIndex: number | null = null;
  let maxVal = -Infinity;

  for (let i = 0; i < y.length; i += 1) {
    const val = y[i];
    if (!Number.isFinite(val)) continue;
    if (val >= cfg.highThreshold) {
      if (!isPotential) {
        startIndex = i;
        isPotential = true;
        maxVal = val;
      } else {
        maxVal = Math.max(maxVal, val);
      }
    } else if (isPotential && val <= cfg.lowThreshold && startIndex !== null) {
      const width = t[i] - t[startIndex];
      if (width < cfg.minWidth) {
        events.push(AnalysisTypes.createEvent({
          index: startIndex,
          time: t[startIndex],
          type: 'runt',
          metadata: { width, peak: maxVal, amplitude: maxVal, sourceType: cfg.sourceType, units: cfg.units }
        }));
      }
      isPotential = false;
      startIndex = null;
      maxVal = -Infinity;
    }
  }
  return events;
}

function detectNonUniformTimebase(t: number[]): boolean {
  if (t.length < 3) return false;
  const deltas: number[] = [];
  for (let i = 0; i < t.length - 1; i += 1) {
    const dt = t[i + 1] - t[i];
    if (Number.isFinite(dt)) deltas.push(dt);
  }
  if (deltas.length < 2) return false;
  const mean = deltas.reduce((sum, v) => sum + v, 0) / deltas.length;
  const maxDev = Math.max(...deltas.map((v) => Math.abs(v - mean)));
  return mean > 0 && (maxDev / mean) > 0.01;
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
    selection = null,
    config = {},
    trace = null
  }: {
    t?: ArrayLike<number>;
    y?: ArrayLike<number>;
    selection?: AnalysisSelection | null;
    config?: Partial<AnalysisTrigger>;
    trace?: AnalysisSeries | null;
  }): DetectedEvents {
    const triggerCfg: TriggerCfg = this.normalizeConfig(config);
    const resolved = trace
      ? resolveTriggerSignal(trace, triggerCfg.source)
      : { t: Array.from(t), y: Array.from(y), sourceType: triggerCfg.source, units: 'units' };
    const pairs = toFinitePairs(resolved.t, resolved.y);
    const sliced = sliceSeries(pairs.t, pairs.y, triggerCfg.selectionOnly ? selection : null);
    triggerCfg.sourceType = resolved.sourceType;
    triggerCfg.units = resolved.units;

    if (!triggerCfg.enabled) {
      return { events: [], selection: sliced.selection, warnings: [], signal: sliced.y, sourceType: triggerCfg.sourceType };
    }
    if (sliced.t.length < 2 || sliced.y.length < 2) {
      return { events: [], selection: sliced.selection, warnings: [], signal: sliced.y, sourceType: triggerCfg.sourceType };
    }

    let events: AnalysisEvent[] = [];
    if (triggerCfg.type === 'level') events = detectLevelCrossings(sliced.t, sliced.y, triggerCfg);
    else if (triggerCfg.type === 'edge') events = detectEdges(sliced.t, sliced.y, triggerCfg);
    else if (triggerCfg.type === 'pulse') events = detectPulseWidths(sliced.t, sliced.y, triggerCfg);
    else if (triggerCfg.type === 'runt') events = detectRunts(sliced.t, sliced.y, triggerCfg);

    const indexOffset = sliced.selection.i0 ?? 0;
    events = events.map((event) => ({
      ...event,
      index: Number.isInteger(event.index) ? (event.index as number) + indexOffset : event.index
    }));

    const warnings: string[] = [];
    if (detectNonUniformTimebase(sliced.t)) {
      warnings.push('Timebase is non-uniform; event timing may be approximate.');
    }
    return { events, selection: sliced.selection, warnings, signal: pairs.y, sourceType: triggerCfg.sourceType };
  }
};
