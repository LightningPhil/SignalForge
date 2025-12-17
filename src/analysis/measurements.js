function toNumberArray(arr = []) {
    const out = [];
    for (let i = 0; i < arr.length; i += 1) {
        const v = Number(arr[i]);
        if (Number.isFinite(v)) out.push(v);
    }
    return out;
}

function clampIndices(i0, i1, maxLen) {
    const start = Math.max(0, Math.min(Number.isInteger(i0) ? i0 : 0, maxLen - 1));
    const end = Math.max(start, Math.min(Number.isInteger(i1) ? i1 : maxLen - 1));
    return [start, end];
}

const measurementCache = new WeakMap();

function cacheKey(t = [], y = [], selection = null, options = {}) {
    const selKey = selection && selection.i0 !== null && selection.i1 !== null
        ? `${selection.i0}-${selection.i1}`
        : 'full';
    const edge = options.edgeThresholds || {};
    const spanKey = `${t.length}:${y.length}:${t[0] ?? 0}:${t[t.length - 1] ?? 0}:${y[0] ?? 0}:${y[y.length - 1] ?? 0}`;
    return `${selKey}|${edge.lowFraction ?? 'd'}|${edge.highFraction ?? 'd'}|${spanKey}`;
}

function getCachedResult(yRef, key) {
    const root = measurementCache.get(yRef);
    if (!root) return null;
    const cached = root.get(key);
    if (!cached) return null;
    return {
        metrics: { ...cached.metrics },
        selection: cached.selection ? { ...cached.selection } : cached.selection,
        warnings: [...cached.warnings],
        meta: { ...cached.meta }
    };
}

function storeCachedResult(yRef, key, result) {
    let root = measurementCache.get(yRef);
    if (!root) {
        root = new Map();
        measurementCache.set(yRef, root);
    }
    root.set(key, result);
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

function mean(arr) {
    if (!arr.length) return null;
    return arr.reduce((sum, v) => sum + v, 0) / arr.length;
}

function rms(arr) {
    if (!arr.length) return null;
    const sumSq = arr.reduce((sum, v) => sum + (v * v), 0);
    return Math.sqrt(sumSq / arr.length);
}

function stddev(arr, arrMean = null) {
    if (arr.length < 2) return null;
    const m = arrMean === null ? mean(arr) : arrMean;
    const variance = arr.reduce((sum, v) => sum + ((v - m) ** 2), 0) / (arr.length - 1);
    return Math.sqrt(variance);
}

function median(arr) {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
    return sorted[mid];
}

function percentile(arr, p) {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = (sorted.length - 1) * p;
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);
    if (upper === lower) return sorted[lower];
    const weight = idx - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function zeroCrossings(t, y) {
    const crossings = [];
    for (let i = 0; i < y.length - 1; i += 1) {
        const y0 = y[i];
        const y1 = y[i + 1];
        const t0 = t[i];
        const t1 = t[i + 1];

        if (!Number.isFinite(y0) || !Number.isFinite(y1) || !Number.isFinite(t0) || !Number.isFinite(t1)) continue;

        if (y0 === 0) {
            crossings.push({ time: t0, direction: Math.sign(y1) - Math.sign(y0) >= 0 ? 'rising' : 'falling' });
            continue;
        }

        if ((y0 < 0 && y1 > 0) || (y0 > 0 && y1 < 0)) {
            const frac = Math.abs(y0) / (Math.abs(y0) + Math.abs(y1));
            const tCross = t0 + (t1 - t0) * frac;
            const direction = y0 < y1 ? 'rising' : 'falling';
            crossings.push({ time: tCross, direction });
        }
    }
    return crossings;
}

function estimateFrequency(crossings) {
    const rising = crossings.filter((c) => c.direction === 'rising').map((c) => c.time);
    if (rising.length < 2) return { frequencyHz: null, period: null };
    const periods = [];
    for (let i = 0; i < rising.length - 1; i += 1) {
        const dt = rising[i + 1] - rising[i];
        if (dt > 0) periods.push(dt);
    }
    if (!periods.length) return { frequencyHz: null, period: null };
    const avgPeriod = mean(periods);
    return { frequencyHz: 1 / avgPeriod, period: avgPeriod };
}

function findLevelCrossing(t, y, target, mode = 'rising') {
    for (let i = 0; i < y.length - 1; i += 1) {
        const y0 = y[i];
        const y1 = y[i + 1];
        const t0 = t[i];
        const t1 = t[i + 1];
        if (!Number.isFinite(y0) || !Number.isFinite(y1) || !Number.isFinite(t0) || !Number.isFinite(t1)) continue;

        if (mode === 'rising') {
            if (y0 <= target && y1 >= target) {
                const frac = (target - y0) / (y1 - y0 || 1);
                return t0 + (t1 - t0) * frac;
            }
        } else if (mode === 'falling') {
            if (y0 >= target && y1 <= target) {
                const frac = (y0 - target) / (y0 - y1 || 1);
                return t0 + (t1 - t0) * frac;
            }
        }
    }
    return null;
}

function integrate(t, y, absolute = false) {
    if (t.length < 2 || y.length < 2) return null;
    let area = 0;
    for (let i = 0; i < t.length - 1; i += 1) {
        const y0 = absolute ? Math.abs(y[i]) : y[i];
        const y1 = absolute ? Math.abs(y[i + 1]) : y[i + 1];
        area += (y0 + y1) * 0.5 * (t[i + 1] - t[i]);
    }
    return area;
}

function dutyCycle(t, y, threshold) {
    if (t.length < 2 || y.length < 2) return null;
    let highTime = 0;
    let total = 0;
    for (let i = 0; i < y.length - 1; i += 1) {
        const t0 = t[i];
        const t1 = t[i + 1];
        const dt = t1 - t0;
        total += dt;
        const y0 = y[i];
        const y1 = y[i + 1];
        const above0 = y0 >= threshold;
        const above1 = y1 >= threshold;
        if (above0 && above1) {
            highTime += dt;
        } else if (above0 !== above1) {
            const frac = Math.abs(threshold - y0) / (Math.abs(y1 - y0) || 1);
            const crossTime = t0 + dt * frac;
            if (above0) {
                highTime += crossTime - t0;
            } else {
                highTime += t1 - crossTime;
            }
        }
    }
    if (total <= 0) return null;
    return highTime / total;
}

function riseFallMetrics(t, y, { lowFraction = 0.1, highFraction = 0.9 } = {}) {
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

    const riseTime = riseStart !== null && riseEnd !== null ? riseEnd - riseStart : null;
    const fallTime = fallStart !== null && fallEnd !== null ? fallEnd - fallStart : null;

    const upperSteady = percentile(y, 0.98);
    const lowerSteady = percentile(y, 0.02);
    const overshoot = yMax - upperSteady;
    const undershoot = lowerSteady - yMin;
    const denom = span || 1;

    const overshootPct = overshoot > 0 ? (overshoot / denom) * 100 : 0;
    const undershootPct = undershoot > 0 ? (undershoot / denom) * 100 : 0;

    return { riseTime, fallTime, overshootPct, undershootPct };
}

function detectTimeVariance(t) {
    if (t.length < 2) return null;
    const deltas = [];
    for (let i = 0; i < t.length - 1; i += 1) {
        const dt = t[i + 1] - t[i];
        if (Number.isFinite(dt) && dt > 0) deltas.push(dt);
    }
    if (!deltas.length) return null;
    const avg = mean(deltas);
    const dev = stddev(deltas, avg) || 0;
    if (!avg) return null;
    const relative = dev / avg;
    return { average: avg, deviation: dev, relative };
}

export const Measurements = {
    /**
     * Compute scope-style time-domain measurements.
     * @param {object} params
     * @param {Array|Float64Array} params.t - time array
     * @param {Array|Float64Array} params.y - value array
     * @param {{i0?:number,i1?:number}} [params.selection]
     * @param {object} [options]
     * @returns {{
     *  metrics: Record<string, number|null>,
     *  selection: {i0:number|null,i1:number|null},
     *  warnings: string[],
     *  meta: { sampleCount:number, duration:number|null }
     * }}
     */
    compute(params = {}, options = {}) {
        const tArray = toNumberArray(params.t || []);
        const yArray = toNumberArray(params.y || []);
        const { t, y, selection } = sliceSeries(tArray, yArray, params.selection || {});

        const key = cacheKey(t, y, selection, options);
        const cached = getCachedResult(y, key);
        if (cached) return cached;

        const warnings = [];
        if (!t.length || !y.length) {
            return { metrics: {}, selection, warnings: ['No data in selection'], meta: { sampleCount: 0, duration: null } };
        }

        const yMin = Math.min(...y);
        const yMax = Math.max(...y);
        const span = yMax - yMin;
        const avg = mean(y);
        const rmsVal = rms(y);
        const std = stddev(y, avg);
        const med = median(y);
        const p2p = Number.isFinite(span) ? span : null;

        const crossingInfo = zeroCrossings(t, y);
        const { frequencyHz, period } = estimateFrequency(crossingInfo);
        const dutyLevel = options.dutyThreshold !== undefined ? options.dutyThreshold : (yMin + yMax) / 2;
        const dc = dutyCycle(t, y, dutyLevel);
        const { riseTime, fallTime, overshootPct, undershootPct } = riseFallMetrics(t, y, options.edgeThresholds || {});

        const area = integrate(t, y, false);
        const absArea = integrate(t, y, true);

        const timeVariance = detectTimeVariance(t);
        if (timeVariance && timeVariance.relative > 0.05) {
            warnings.push('Timebase is non-uniform (>5% variation)');
        }

        const peakIndex = y.indexOf(yMax);
        const valleyIndex = y.indexOf(yMin);
        const peakTime = peakIndex >= 0 ? t[peakIndex] : null;
        const valleyTime = valleyIndex >= 0 ? t[valleyIndex] : null;

        const duration = t.length > 1 ? t[t.length - 1] - t[0] : null;

        return {
            metrics: {
                min: yMin,
                max: yMax,
                mean: avg,
                rms: rmsVal,
                peakToPeak: p2p,
                stddev: std,
                median: med,
                zeroCrossings: crossingInfo.length,
                frequencyHz,
                period,
                dutyCycle: dc,
                riseTime,
                fallTime,
                overshootPct,
                undershootPct,
                area,
                absArea,
                peakTime,
                valleyTime
            },
            selection,
            warnings,
            meta: {
                sampleCount: y.length,
                duration
            }
        };

        storeCachedResult(y, key, result);
        return getCachedResult(y, key) || result;
    }
};
