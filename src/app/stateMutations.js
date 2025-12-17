import { State } from '../state.js';

function pushUndo(undoEntry) {
    if (!State.ui.history) {
        State.ui.history = { undo: [], redo: [] };
    }
    State.ui.history.undo.push(undoEntry);
    State.ui.history.redo = [];
}

export function applyTraceTimeOffset(traceId, offsetSeconds = 0) {
    if (!traceId || !Number.isFinite(offsetSeconds)) return null;
    const currentCfg = State.getTraceConfig(traceId);
    const previous = Number.isFinite(currentCfg.xOffset) ? currentCfg.xOffset : 0;
    const next = previous + offsetSeconds;
    State.updateTraceConfig(traceId, { xOffset: next });

    pushUndo({
        label: `Offset ${traceId}`,
        undo: () => State.updateTraceConfig(traceId, { xOffset: previous }),
        redo: () => State.updateTraceConfig(traceId, { xOffset: next })
    });

    import('./dataPipeline.js').then((mod) => {
        if (typeof mod.triggerGraphUpdateOnly === 'function') {
            mod.triggerGraphUpdateOnly();
        }
    }).catch(() => {});
    return next;
}
