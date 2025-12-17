import { elements } from '../app/domElements.js';
import { State } from '../state.js';
import { CrossChannel } from '../analysis/crossChannel.js';
import { Filter } from '../processing/filter.js';
import { MathEngine } from '../processing/math.js';
import { AnalysisEngine } from '../analysis/analysisEngine.js';
import { applyTraceTimeOffset } from '../app/stateMutations.js';

const fallbackSummary = 'Select input/output channels to compute FRF.';
let latestResult = null;
let applyBtn = null;

function getColumnData(columnId) {
    if (!columnId || !State.data.timeColumn) return { x: [], y: [], isMath: false };
    const rawX = State.data.raw.map((r) => parseFloat(r[State.data.timeColumn]));
    const mathDef = State.getMathDefinition(columnId);
    if (mathDef) {
        const result = MathEngine.calculateVirtualColumn(mathDef, rawX);
        return { x: result.time.length ? result.time : rawX.slice(0, result.values.length), y: result.values, isMath: true };
    }
    const y = State.data.raw.map((r) => parseFloat(r[columnId]));
    return { x: rawX.slice(0, y.length), y, isMath: false };
}

function populateSelectOptions() {
    const { systemInput, systemOutput } = elements;
    if (!systemInput || !systemOutput) return;
    const headers = (State.data.headers || []).filter((h) => h && h !== State.data.timeColumn);
    const opts = headers.map((h) => `<option value="${h}">${h}</option>`).join('');
    systemInput.innerHTML = `<option value="auto">Auto</option>${opts}`;
    systemOutput.innerHTML = `<option value="auto">Auto</option>${opts}`;

    const analysis = State.ensureAnalysisConfig();
    systemInput.value = analysis.systemInput || 'auto';
    systemOutput.value = analysis.systemOutput || 'auto';
}

function renderWarnings(list = []) {
    const { systemWarnings } = elements;
    if (!systemWarnings) return;
    systemWarnings.innerHTML = '';
    list.forEach((w) => {
        const li = document.createElement('li');
        li.textContent = w;
        systemWarnings.appendChild(li);
    });
}

function renderSummary(payload) {
    const { systemSummary } = elements;
    if (!systemSummary) return;
    if (!payload) {
        systemSummary.textContent = fallbackSummary;
        renderWarnings([]);
        return;
    }

    const { delaySeconds, correlationPeak, confidence, input, output, warnings = [] } = payload;
    const delayText = Number.isFinite(delaySeconds) ? `${delaySeconds.toExponential(3)} s` : 'N/A';
    const corrText = Number.isFinite(correlationPeak) ? correlationPeak.toFixed(3) : 'N/A';
    const confText = Number.isFinite(confidence) ? `, conf ${confidence.toFixed(2)}` : '';
    systemSummary.textContent = `${input} → ${output}: delay ${delayText}, corr ${corrText}${confText}`;
    renderWarnings(warnings);
}

function computeSystem() {
    const analysis = State.ensureAnalysisConfig();
    const inputCol = elements.systemInput?.value || 'auto';
    const outputCol = elements.systemOutput?.value || 'auto';

    const headers = (State.data.headers || []).filter((h) => h && h !== State.data.timeColumn);
    const selectedInput = inputCol === 'auto' ? headers[0] : inputCol;
    const selectedOutput = outputCol === 'auto' ? headers[1] || headers[0] : outputCol;
    if (!selectedInput || !selectedOutput || selectedInput === selectedOutput) {
        renderSummary(null);
        latestResult = null;
        return;
    }

    const inputData = getColumnData(selectedInput);
    const outputData = getColumnData(selectedOutput);
    if (!inputData.x.length || !outputData.x.length) {
        renderSummary(null);
        latestResult = null;
        return;
    }

    const selection = analysis.systemSelectionOnly === false ? null : State.getAnalysisSelection();
    const delay = CrossChannel.estimateDelay(outputData.x, inputData.y, outputData.y, {
        selection,
        maxLagSeconds: analysis.systemMaxLagSeconds
    });

    const inputFiltered = inputData.isMath ? inputData.y : Filter.applyPipeline(inputData.y, inputData.x, State.getPipelineForColumn(selectedInput));
    const outputFiltered = outputData.isMath ? outputData.y : Filter.applyPipeline(outputData.y, outputData.x, State.getPipelineForColumn(selectedOutput));

    const frf = CrossChannel.computeTransferFunction(
        inputFiltered,
        outputFiltered,
        inputData.x.length <= outputData.x.length ? inputData.x : outputData.x,
        {
            selection,
            windowType: analysis.fftWindow,
            detrend: analysis.fftDetrend,
            zeroPadMode: analysis.fftZeroPad,
            zeroPadFactor: analysis.fftZeroPadFactor
        }
    );

    latestResult = {
        input: selectedInput,
        output: selectedOutput,
        delaySeconds: delay.delaySeconds,
        delaySamples: delay.delaySamples,
        correlationPeak: delay.correlationPeak,
        confidence: delay.confidence,
        frf
    };

    renderSummary({
        input: selectedInput,
        output: selectedOutput,
        delaySeconds: delay.delaySeconds,
        correlationPeak: delay.correlationPeak,
        confidence: delay.confidence,
        warnings: [...(delay.warnings || []), ...(frf.warnings || [])]
    });

    if (applyBtn) {
        applyBtn.disabled = !latestResult || !Number.isFinite(latestResult.confidence) || latestResult.confidence < 0.6;
        applyBtn.title = 'Applies +Δt offset to selected trace. Does not modify data samples.';
    }
}

export const SystemPanel = {
    init() {
        applyBtn = document.getElementById('system-apply-alignment');
        populateSelectOptions();
        const analysis = State.ensureAnalysisConfig();
        if (elements.systemUseSelection) {
            elements.systemUseSelection.checked = analysis.systemSelectionOnly !== false;
            elements.systemUseSelection.addEventListener('change', (e) => {
                State.ensureAnalysisConfig().systemSelectionOnly = e.target.checked;
                computeSystem();
            });
        }
        if (elements.systemMaxLag) {
            elements.systemMaxLag.value = analysis.systemMaxLagSeconds || '';
            elements.systemMaxLag.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                State.ensureAnalysisConfig().systemMaxLagSeconds = Number.isFinite(val) ? val : null;
                computeSystem();
            });
        }
        if (elements.systemInput) {
            elements.systemInput.addEventListener('change', (e) => {
                State.ensureAnalysisConfig().systemInput = e.target.value || 'auto';
                computeSystem();
            });
        }
        if (elements.systemOutput) {
            elements.systemOutput.addEventListener('change', (e) => {
                State.ensureAnalysisConfig().systemOutput = e.target.value || 'auto';
                computeSystem();
            });
        }

        if (applyBtn) {
            applyBtn.addEventListener('click', () => {
                if (!latestResult || latestResult.confidence < 0.6) return;
                applyTraceTimeOffset(latestResult.output, latestResult.delaySeconds || 0);
                AnalysisEngine.notifySelection(State.getAnalysisSelection());
                computeSystem();
            });
        }

        AnalysisEngine.onSelectionChange(() => computeSystem());
    },

    refreshFromState() {
        populateSelectOptions();
        computeSystem();
    },

    getResult() {
        return latestResult;
    }
};
