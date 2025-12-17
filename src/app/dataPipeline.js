import { State } from '../state.js';
import { Filter } from '../processing/filter.js';
import { MathEngine } from '../processing/math.js';
import { Graph } from '../ui/graph.js';
import { MeasurementPanel } from '../ui/measurementPanel.js';
import { EventPanel } from '../ui/eventPanel.js';
import { SpectralPanel } from '../ui/spectralPanel.js';
import { SystemPanel } from '../ui/systemPanel.js';

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
        const activeView = State.multiViews.find((v) => v.id === State.ui.activeMultiViewId);
        const targetCol = activeView?.activeColumnIds?.[0] || null;
        if (targetCol) {
            const { rawX, rawY } = getRawSeries(targetCol);
            const isMath = !!State.getMathDefinition(targetCol);
            const filteredCandidate = isMath ? null : Filter.applyPipeline(rawY, rawX, State.getPipelineForColumn(targetCol));
            const seriesPayload = { rawX, rawY, filteredY: isMath ? null : filteredCandidate, seriesName: targetCol, isMath };
            MeasurementPanel.setSeries(seriesPayload);
            EventPanel.setSeries(seriesPayload);
            SpectralPanel.setSeries(seriesPayload);
            SystemPanel.refreshFromState();
        } else {
            MeasurementPanel.clear();
            EventPanel.clear();
            SpectralPanel.clear();
            SystemPanel.refreshFromState();
        }
        return;
    }

    const { rawX, rawY } = getRawSeries();
    if (!rawX.length || !rawY.length) return;

    const isMath = !!State.getMathDefinition(State.data.dataColumn);
    if (isMath) {
        State.data.processed = [];
        const payload = { rawX, rawY, filteredY: null, seriesName: State.data.dataColumn, isMath: true };
        Graph.render(rawX, rawY, null, range, { isMath: true, seriesName: State.data.dataColumn });
        MeasurementPanel.setSeries(payload);
        EventPanel.setSeries(payload);
        SpectralPanel.setSeries(payload);
        SystemPanel.refreshFromState();
        return;
    }

    const filteredY = Filter.applyPipeline(rawY, rawX, State.getPipeline());
    State.data.processed = filteredY;

    const payload = { rawX, rawY, filteredY, seriesName: State.data.dataColumn, isMath: false };
    Graph.render(rawX, rawY, filteredY, range);
    MeasurementPanel.setSeries(payload);
    EventPanel.setSeries(payload);
    SpectralPanel.setSeries(payload);
    SystemPanel.refreshFromState();
}

function triggerGraphUpdateOnly() {
    if (!hasData(false)) return;

    if (State.ui.activeMultiViewId) {
        Graph.renderMultiViewFromState();
        return;
    }

    const { rawX, rawY } = getRawSeries();
    const isMath = !!State.getMathDefinition(State.data.dataColumn);
    const filteredY = State.data.processed.length > 0 ? State.data.processed : null;
    Graph.render(rawX, rawY, isMath ? null : filteredY, null, { isMath, seriesName: State.data.dataColumn });
}

export { hasData, runPipelineAndRender, triggerGraphUpdateOnly, getRawSeries };
