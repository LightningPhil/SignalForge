import { State } from '../state.js';

/**
 * Typed-ish schema helpers for analysis objects.
 */
export const AnalysisTypes = {
    /**
     * @param {object} params
     * @returns {{columnId: string|null, source: 'raw'|'filtered'|'math', viewKey: string|null, xOffset: number}}
     */
    createTraceRef(params = {}) {
        return {
            columnId: params.columnId || null,
            source: params.source || 'raw',
            viewKey: params.viewKey || State.getActiveViewKey() || null,
            xOffset: Number.isFinite(params.xOffset) ? params.xOffset : 0
        };
    },

    /**
     * @param {object} params
     * @returns {{xMin: number|null, xMax: number|null, i0: number|null, i1: number|null}}
     */
    createSelection(params = {}) {
        const xMin = Number.isFinite(params.xMin) ? params.xMin : null;
        const xMax = Number.isFinite(params.xMax) ? params.xMax : null;
        const normalizedMin = xMin !== null && xMax !== null ? Math.min(xMin, xMax) : xMin;
        const normalizedMax = xMin !== null && xMax !== null ? Math.max(xMin, xMax) : xMax;
        return {
            xMin: normalizedMin,
            xMax: normalizedMax,
            i0: Number.isInteger(params.i0) ? params.i0 : null,
            i1: Number.isInteger(params.i1) ? params.i1 : null
        };
    },

    /**
     * @param {object} params
     * @returns {{index: number|null, time: number|null, type: string, metadata: object}}
     */
    createEvent(params = {}) {
        return {
            index: Number.isInteger(params.index) ? params.index : null,
            time: Number.isFinite(params.time) ? params.time : null,
            type: params.type || 'unknown',
            metadata: params.metadata || {}
        };
    }
};

function normalizeRange(range) {
    if (!range || range.length < 2) return null;
    const [r0, r1] = range;
    if (!Number.isFinite(r0) || !Number.isFinite(r1)) return null;
    return [Math.min(r0, r1), Math.max(r0, r1)];
}

function isSameSelection(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return a.xMin === b.xMin && a.xMax === b.xMax && a.i0 === b.i0 && a.i1 === b.i1;
}

export function getSelectionIndices(xRange, tArray = []) {
    if (!xRange || !Array.isArray(tArray) || tArray.length === 0) return { i0: null, i1: null };

    const normalizedRange = Array.isArray(xRange) ? normalizeRange(xRange) : normalizeRange([xRange.xMin, xRange.xMax]);
    if (!normalizedRange) return { i0: null, i1: null };
    const [xMin, xMax] = normalizedRange;

    let startIndex = null;
    let endIndex = null;

    for (let i = 0; i < tArray.length; i += 1) {
        const tVal = tArray[i];
        if (!Number.isFinite(tVal)) continue;
        if (startIndex === null && tVal >= xMin) {
            startIndex = i;
        }
        if (tVal <= xMax) {
            endIndex = i;
        }
        if (tVal > xMax && startIndex !== null) break;
    }

    return { i0: startIndex, i1: endIndex };
}

const selectionListeners = new Set();

export const AnalysisEngine = {
    onSelectionChange(callback) {
        if (typeof callback !== 'function') return () => {};
        selectionListeners.add(callback);
        return () => selectionListeners.delete(callback);
    },

    notifySelection(selection) {
        selectionListeners.forEach((cb) => {
            try {
                cb(selection);
            } catch (e) {
                // Swallow listener errors to avoid blocking others
                console.error('AnalysisEngine listener error', e);
            }
        });
    },

    setSelection(selection) {
        const current = State.getAnalysisSelection();
        if (isSameSelection(current, selection)) return current;
        State.setAnalysisSelection(selection);
        this.notifySelection(selection);
        return selection;
    },

    clearSelection() {
        return this.setSelection(null);
    },

    updateSelectionFromRange(range, timeArray = []) {
        const normalizedRange = normalizeRange(range);
        if (!normalizedRange) {
            return this.clearSelection();
        }
        const [xMin, xMax] = normalizedRange;
        const indices = getSelectionIndices(normalizedRange, timeArray);
        const selection = AnalysisTypes.createSelection({ xMin, xMax, ...indices });
        return this.setSelection(selection);
    },

    run(selectionOverride = null) {
        const selection = selectionOverride || State.getAnalysisSelection();
        const analysisConfig = State.ensureAnalysisConfig();
        return {
            selection,
            config: { ...analysisConfig }
        };
    }
};
