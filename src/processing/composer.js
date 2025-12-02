import { State } from '../state.js';

function computeTimeStep(rawX = []) {
    if (!Array.isArray(rawX) || rawX.length < 2) return 0;
    const deltas = [];
    for (let i = 0; i < rawX.length - 1; i++) {
        const diff = rawX[i + 1] - rawX[i];
        if (Number.isFinite(diff) && diff > 0) deltas.push(diff);
    }
    if (deltas.length === 0) return 0;
    deltas.sort((a, b) => a - b);
    const mid = Math.floor(deltas.length / 2);
    return deltas.length % 2 === 0
        ? (deltas[mid - 1] + deltas[mid]) / 2
        : deltas[mid];
}

function quantizeTimeOffset(offset = 0, step = 0) {
    if (!Number.isFinite(offset) || !Number.isFinite(step) || step <= 0) return offset || 0;
    const steps = Math.round(offset / step);
    return steps * step;
}

function shiftSeries(values = [], stepCount = 0) {
    if (!Array.isArray(values) || values.length === 0 || stepCount === 0) {
        return Array.isArray(values) ? [...values] : [];
    }

    const len = values.length;
    const shifted = new Array(len);

    if (stepCount >= len) {
        return new Array(len).fill(values[0]);
    }
    if (stepCount <= -len) {
        return new Array(len).fill(values[len - 1]);
    }

    if (stepCount > 0) {
        const padValue = values[0];
        const shift = Math.min(stepCount, len);
        for (let i = 0; i < shift; i++) shifted[i] = padValue;
        for (let i = 0; i < len - shift; i++) shifted[i + shift] = values[i];
        for (let i = len - shift; i < len; i++) shifted[i] = values[len - 1];
    } else {
        const steps = Math.min(Math.abs(stepCount), len);
        for (let i = steps; i < len; i++) shifted[i - steps] = values[i];
        for (let i = len - steps; i < len; i++) shifted[i] = values[len - 1];
    }

    return shifted;
}

function applyComposerOffsets(rawX = [], rawY = [], filteredY = [], composerTrace = {}) {
    const { timeOffset = 0, yOffset = 0 } = composerTrace || {};
    const step = computeTimeStep(rawX);
    const quantizedOffset = quantizeTimeOffset(timeOffset, step);
    const stepCount = step > 0 ? Math.round(quantizedOffset / step) : 0;

    const shiftedRaw = shiftSeries(rawY, stepCount);
    const shiftedFiltered = Array.isArray(filteredY) && filteredY.length > 0
        ? shiftSeries(filteredY, stepCount)
        : [];

    const appliedRaw = yOffset ? shiftedRaw.map((v) => v + yOffset) : shiftedRaw;
    const appliedFiltered = yOffset && shiftedFiltered.length > 0
        ? shiftedFiltered.map((v) => v + yOffset)
        : shiftedFiltered;

    return {
        adjustedRawY: appliedRaw,
        adjustedFilteredY: appliedFiltered,
        quantizedOffset,
        stepSize: step
    };
}

function getComposerTrace(viewId, columnId) {
    const composer = State.getComposer(viewId || null);
    return composer?.traces?.find((t) => t.columnId === columnId) || { timeOffset: 0, yOffset: 0 };
}

export { applyComposerOffsets, computeTimeStep, getComposerTrace, quantizeTimeOffset, shiftSeries };
