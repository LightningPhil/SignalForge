import { AnalysisTypes } from './analysisEngine.js';
import { computeDerivative } from './derivedSignals.js';

const DEFAULT_TRIGGER = {
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

const derivativeCache = new Map();

function keyFor(traceId, selection, baseSource) {
    const selKey = selection && selection.i0 !== null && selection.i1 !== null
        ? `${selection.i0}-${selection.i1}`
        : 'full';
    return `${traceId || 'anon'}|${selKey}|${baseSource}`;
}

function toNumberArray(arr = []) {
    const out = [];
    for (let i = 0; i < arr.length; i += 1) {
        const v = Number(arr[i]);
        if (Number.isFinite(v)) out.push(v);
    }
    return out;
}

function toFinitePairs(tArr = [], yArr = []) {
    const t = [];
    const y = [];
    const limit = Math.min(tArr?.length || 0, yArr?.length || 0);
    for (let i = 0; i < limit; i += 1) {
        const ti = Number(tArr[i]);
        const yi = Number(yArr[i]);
        if (Number.isFinite(ti) && Number.isFinite(yi)) {
            t.push(ti);
            y.push(yi);
        }
    }
    return { t, y };
}

function clampIndices(i0, i1, maxLen) {
    const start = Math.max(0, Math.min(Number.isInteger(i0) ? i0 : 0, maxLen - 1));
    const end = Math.max(start, Math.min(Number.isInteger(i1) ? i1 : maxLen - 1));
    return [start, end];
}

function sliceSeries(t, y, selection) {
    const maxLen = Math.min(t.length, y.length);
    if (maxLen === 0) return { t: [], y: [], selection: { i0: null, i1: null } };

    if (!selection || selection.i0 === null || selection.i1 === null) {
        return { t: t.slice(0, maxLen), y: y.slice(0, maxLen), selection: { i0: 0, i1: maxLen - 1 } };
    }

    const [start, end] = clampIndices(selection.i0, selection.i1, maxLen);
    return { t: t.slice(start, end + 1), y: y.slice(start, end + 1), selection: { i0: start, i1: end } };
}

function resolveTriggerSignal(trace = null, sourceType = 'raw', selection = null) {
    if (!trace) return { t: [], y: [], sourceType, units: 'units' };

    const baseSource = sourceType === 'auto'
        ? (!trace.isMath && trace.filteredY?.length ? 'filtered' : 'raw')
        : sourceType;

    const baseY = (() => {
        if (baseSource === 'filtered' && !trace.isMath && trace.filteredY?.length) return trace.filteredY;
        if (baseSource === 'math' && trace.isMath) return trace.rawY;
        return trace.rawY;
    })();

    const { t, y, selection: appliedSel } = sliceSeries(trace.rawX || [], baseY || [], selection && sourceType !== 'derivative' ? selection : null);

    if (sourceType === 'derivative') {
        const cacheKey = keyFor(trace.seriesName || trace.columnId, selection, baseSource);
        if (derivativeCache.has(cacheKey)) {
            const cached = derivativeCache.get(cacheKey);
            return { ...cached, selection: appliedSel };
        }
        const dy = computeDerivative(t, y);
        const payload = { t, y: Array.from(dy), sourceType: 'derivative', units: 'units/s' };
        derivativeCache.set(cacheKey, payload);
        return { ...payload, selection: appliedSel };
    }

    return { t, y, sourceType: baseSource, units: 'units' };
}

function detectLevelCrossings(t, y, cfg) {
    const events = [];
    if (t.length < 2) return events;

    const hysteresis = Math.max(0, Number(cfg.hysteresis) || 0);
    const upper = cfg.threshold + hysteresis;
    const lower = cfg.threshold - hysteresis;
    let state = y[0] >= upper ? 'above' : 'below';

    for (let i = 1; i < y.length; i += 1) {
        const current = y[i];
        const prev = y[i - 1];
        if (!Number.isFinite(current) || !Number.isFinite(prev)) continue;
        const tCurr = t[i];

        if (state === 'below' && current >= upper) {
            if (cfg.direction === 'rising' || cfg.direction === 'either') {
                events.push(AnalysisTypes.createEvent({
                    index: i,
                    time: tCurr,
                    type: 'level',
                    metadata: { direction: 'rising', threshold: cfg.threshold, amplitude: current, sourceType: cfg.sourceType, units: cfg.units }
                }));
            }
            state = 'above';
        } else if (state === 'above' && current <= lower) {
            if (cfg.direction === 'falling' || cfg.direction === 'either') {
                events.push(AnalysisTypes.createEvent({
                    index: i,
                    time: tCurr,
                    type: 'level',
                    metadata: { direction: 'falling', threshold: cfg.threshold, amplitude: current, sourceType: cfg.sourceType, units: cfg.units }
                }));
            }
            state = 'below';
        }
    }

    return events;
}

function detectEdges(t, y, cfg) {
    const events = [];
    if (t.length < 2) return events;

    for (let i = 0; i < y.length - 1; i += 1) {
        const y0 = y[i];
        const y1 = y[i + 1];
        const t0 = t[i];
        const t1 = t[i + 1];
        const dt = t1 - t0;
        if (!Number.isFinite(dt) || dt <= 0) continue;
        if (!Number.isFinite(y0) || !Number.isFinite(y1)) continue;

        const slope = (y1 - y0) / dt;
        const passesRising = cfg.direction !== 'falling' && slope >= cfg.slopeThreshold;
        const passesFalling = cfg.direction !== 'rising' && slope <= -cfg.slopeThreshold;

        if (passesRising || passesFalling) {
            events.push(AnalysisTypes.createEvent({
                index: i,
                time: t0,
                type: 'edge',
                metadata: { slope, direction: passesRising ? 'rising' : 'falling', amplitude: y0, sourceType: cfg.sourceType, units: cfg.units }
            }));
        }
    }
    return events;
}

function detectPulseWidths(t, y, cfg) {
    const events = [];
    if (t.length < 2) return events;

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
        } else if (isHigh && val < cfg.threshold) {
            const endIndex = i;
            const width = t[endIndex] - t[startIndex];
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

function detectRunts(t, y, cfg) {
    const events = [];
    if (t.length < 2) return events;

    let isPotential = false;
    let startIndex = null;
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
        } else if (isPotential && val <= cfg.lowThreshold) {
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

function detectNonUniformTimebase(t) {
    if (t.length < 3) return false;
    const deltas = [];
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

    normalizeConfig(config = {}) {
        return { ...DEFAULT_TRIGGER, ...config };
    },

    resolveTriggerSignal,

    detect({ t = [], y = [], selection = null, config = {}, trace = null }) {
        const triggerCfg = this.normalizeConfig(config);
        const resolved = trace
            ? resolveTriggerSignal(trace, triggerCfg.source, triggerCfg.selectionOnly ? selection : null)
            : { t, y, sourceType: triggerCfg.source, units: 'units' };
        const { t: time, y: values } = toFinitePairs(resolved.t, resolved.y);
        const { t: sliceT, y: sliceY, selection: effectiveSel } = sliceSeries(time, values, triggerCfg.selectionOnly ? selection : null);

        triggerCfg.sourceType = resolved.sourceType;
        triggerCfg.units = resolved.units;

        if (!triggerCfg.enabled) {
            return { events: [], selection: effectiveSel, warnings: [] };
        }

        if (sliceT.length < 2 || sliceY.length < 2) {
            return { events: [], selection: effectiveSel, warnings: [], signal: sliceY, sourceType: triggerCfg.sourceType };
        }

        let events = [];
        if (triggerCfg.type === 'level') {
            events = detectLevelCrossings(sliceT, sliceY, triggerCfg);
        } else if (triggerCfg.type === 'edge') {
            events = detectEdges(sliceT, sliceY, triggerCfg);
        } else if (triggerCfg.type === 'pulse') {
            events = detectPulseWidths(sliceT, sliceY, triggerCfg);
        } else if (triggerCfg.type === 'runt') {
            events = detectRunts(sliceT, sliceY, triggerCfg);
        }

        const warnings = [];
        if (detectNonUniformTimebase(sliceT)) {
            warnings.push('Timebase is non-uniform; event timing may be approximate.');
        }

        return { events, selection: effectiveSel, warnings, signal: sliceY, sourceType: triggerCfg.sourceType };
    }
};
