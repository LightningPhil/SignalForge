import { State } from '../state.js';
import { Filter } from '../processing/filter.js';
import { MathEngine } from '../processing/math.js';
import { Graph } from '../ui/graph.js';

function hasData(alertUser = true) {
    if (!State.data.raw || State.data.raw.length === 0) {
        if(alertUser) alert('Please load a CSV file first.');
        return false;
    }
    return true;
}

function getRawSeries(columnId = null) {
    if (!hasData(false)) return { rawX: [], rawY: [] };

    const yCol = columnId || State.data.dataColumn;
    const xCol = State.data.timeColumn;
    if (!yCol || !xCol) return { rawX: [], rawY: [] };

    const mathDef = State.getMathDefinition(yCol);
    let rawX = State.data.raw.map((r) => parseFloat(r[xCol]));
    let rawY = [];

    if (mathDef) {
        const mathResult = MathEngine.calculateVirtualColumn(mathDef, rawX);
        rawY = mathResult.values;
        rawX = mathResult.time.length ? mathResult.time : rawX.slice(0, rawY.length);
    } else {
        rawY = State.data.raw.map((r) => parseFloat(r[yCol]));
        rawX = rawX.slice(0, rawY.length);
    }

    return { rawX, rawY };
}

function runPipelineAndRender(range = null) {
    if (!hasData(false)) return;

    if (State.ui.activeMultiViewId) {
        Graph.renderMultiViewFromState(range);
        return;
    }

    const { rawX, rawY } = getRawSeries();
    if (!rawX.length || !rawY.length) return;

    const filteredY = Filter.applyPipeline(rawY, rawX, State.getPipeline());
    State.data.processed = filteredY;

    Graph.render(rawX, rawY, filteredY, range);
}

function triggerGraphUpdateOnly() {
    if (!hasData(false)) return;

    if (State.ui.activeMultiViewId) {
        Graph.renderMultiViewFromState();
        return;
    }

    const { rawX, rawY } = getRawSeries();
    const filteredY = State.data.processed.length > 0 ? State.data.processed : null;
    Graph.render(rawX, rawY, filteredY, null);
}

export { hasData, runPipelineAndRender, triggerGraphUpdateOnly, getRawSeries };
