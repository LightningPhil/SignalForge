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

function runPipelineAndRender() {
    if (!hasData(false)) return;

    const yCol = State.data.dataColumn;
    const xCol = State.data.timeColumn;
    if (!yCol || !xCol) return;

    let rawY = [];
    const mathDef = State.getMathDefinition(yCol);
    const rawX = State.data.raw.map((r) => parseFloat(r[xCol]));

    if (mathDef) {
        rawY = MathEngine.calculateVirtualColumn(mathDef, rawX);
    } else {
        rawY = State.data.raw.map((r) => parseFloat(r[yCol]));
    }

    const filteredY = Filter.applyPipeline(rawY, rawX, State.config.pipeline);
    State.data.processed = filteredY;

    Graph.render(rawX, rawY, filteredY, null);
}

function triggerGraphUpdateOnly() {
    if (!hasData(false)) return;
    const xCol = State.data.timeColumn;
    const yCol = State.data.dataColumn;

    const rawX = State.data.raw.map((r) => parseFloat(r[xCol]));

    let rawY = [];
    const mathDef = State.getMathDefinition(yCol);
    if (mathDef) {
        rawY = MathEngine.calculateVirtualColumn(mathDef, rawX);
    } else {
        rawY = State.data.raw.map((r) => parseFloat(r[yCol]));
    }

    const filteredY = State.data.processed.length > 0 ? State.data.processed : null;
    Graph.render(rawX, rawY, filteredY, null);
}

export { hasData, runPipelineAndRender, triggerGraphUpdateOnly };
