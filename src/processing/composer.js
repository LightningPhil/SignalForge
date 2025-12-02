import { State } from '../state.js';
import { applyXOffset } from './filter.js';

function applyComposerOffsets(rawY = [], filteredY = [], composerTrace = {}) {
    const { columnId, yOffset = 0 } = composerTrace || {};
    const { xOffset = 0 } = State.getTraceConfig(columnId);

    const shiftedRaw = applyXOffset(rawY, xOffset);
    const shiftedFiltered = Array.isArray(filteredY) && filteredY.length > 0
        ? applyXOffset(filteredY, xOffset)
        : [];

    const appliedRaw = yOffset ? shiftedRaw.map((v) => v + yOffset) : shiftedRaw;
    const appliedFiltered = yOffset && shiftedFiltered.length > 0
        ? shiftedFiltered.map((v) => v + yOffset)
        : shiftedFiltered;

    return {
        adjustedRawY: appliedRaw,
        adjustedFilteredY: appliedFiltered,
        xOffset,
        yOffset
    };
}

function getComposerTrace(viewId, columnId) {
    const composer = State.getComposer(viewId || null);
    const trace = composer?.traces?.find((t) => t.columnId === columnId);
    const config = State.getTraceConfig(columnId);

    return {
        columnId,
        xOffset: config?.xOffset || 0,
        yOffset: trace?.yOffset || 0
    };
}

export { applyComposerOffsets, getComposerTrace };
