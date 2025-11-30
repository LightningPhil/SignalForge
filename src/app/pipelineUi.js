import { State } from '../state.js';
import { createModal } from '../ui/uiHelpers.js';
import { elements } from './domElements.js';
import { runPipelineAndRender } from './dataPipeline.js';

const {
    pipelineList,
    paramPanel,
    filterTypeDisplay,
    inputWindow,
    sliderWindow,
    inputPoly,
    sliderPoly,
    inputAlpha,
    sliderAlpha,
    inputSigma,
    sliderSigma,
    inputIters,
    sliderIters,
    inputStartDecay,
    inputEndDecay,
    inputStartOffset,
    inputAutoOffsetPoints,
    sliderStartDecay,
    sliderEndDecay,
    inputFreq,
    selFreqUnit,
    inputSlope,
    sliderSlope,
    inputQ,
    sliderQ,
    inputBW,
    selBWUnit,
    grpWindow,
    grpPoly,
    grpAlpha,
    grpSigma,
    grpIters,
    grpDecay,
    grpFreq,
    grpSlope,
    grpQ,
    grpBW
} = elements;

function clamp(inputEl, min, max) {
    let val = parseFloat(inputEl.value);
    if (isNaN(val)) return min;
    if (val < min) { val = min; inputEl.value = min; }
    if (val > max) { val = max; inputEl.value = max; }
    return val;
}

function updateParamsFromUI() {
    const id = State.ui.selectedStepId;
    if (!id) return;

    const params = {};
    const step = State.getSelectedStep();

    if (inputWindow) params.windowSize = clamp(inputWindow, 1, 9999);
    if (inputPoly) params.polyOrder = clamp(inputPoly, 1, 10);
    if (inputAlpha) params.alpha = clamp(inputAlpha, 0.001, 1.0);
    if (inputSigma) params.sigma = clamp(inputSigma, 0.1, 100.0);
    if (inputIters) params.iterations = clamp(inputIters, 1, 16);
    if (inputStartDecay) params.startLength = clamp(inputStartDecay, 0, 10000);
    if (inputEndDecay) params.endLength = clamp(inputEndDecay, 0, 10000);
    if (inputStartOffset) params.startOffset = parseFloat(inputStartOffset.value) || 0;
    if (inputAutoOffsetPoints) params.autoOffsetPoints = clamp(inputAutoOffsetPoints, 1, 100000);

    const fMult = parseFloat(selFreqUnit.value);
    const rawFreq = parseFloat(inputFreq.value) || 0;
    const hz = rawFreq * fMult;

    if (step.type === 'notchFFT') params.centerFreq = hz;
    else params.cutoffFreq = hz;

    const bMult = parseFloat(selBWUnit.value);
    const rawBW = parseFloat(inputBW.value) || 0;
    params.bandwidth = rawBW * bMult;

    if (inputSlope) params.slope = clamp(inputSlope, 6, 96);
    if (inputQ) params.qFactor = clamp(inputQ, 0.1, 20.0);

    State.updateStepParams(id, params);

    renderPipelineList();
    runPipelineAndRender();
}

function renderPipelineList() {
    if (!pipelineList) return;
    pipelineList.innerHTML = '';

    State.config.pipeline.forEach((step, index) => {
        const el = document.createElement('div');
        el.className = 'pipeline-step';
        if (step.id === State.ui.selectedStepId) el.classList.add('selected');

        let desc = step.type;
        const fmtHz = (hz) => {
            if (hz >= 1e9) return (hz / 1e9).toFixed(1) + 'G';
            if (hz >= 1e6) return (hz / 1e6).toFixed(1) + 'M';
            if (hz >= 1e3) return (hz / 1e3).toFixed(1) + 'k';
            return hz.toFixed(0);
        };

        if (step.type === 'movingAverage') desc = `Mov. Avg (Win: ${step.windowSize})`;
        if (step.type === 'savitzkyGolay') desc = `Sav-Gol (Win: ${step.windowSize}, x${step.iterations || 1})`;
        if (step.type === 'median') desc = `Median (Win: ${step.windowSize})`;
        if (step.type === 'iir') desc = `IIR (Alpha: ${step.alpha})`;
        if (step.type === 'gaussian') desc = `Gaussian (Sig: ${step.sigma})`;
        if (step.type === 'startStopNorm') desc = `Norm (Start: ${step.startLength ?? 0}, End: ${step.endLength ?? 0})`;

        if (step.type === 'lowPassFFT') desc = `Low Pass (${fmtHz(step.cutoffFreq)}Hz)`;
        if (step.type === 'highPassFFT') desc = `High Pass (${fmtHz(step.cutoffFreq)}Hz)`;
        if (step.type === 'notchFFT') desc = `Notch (${fmtHz(step.centerFreq)}Hz)`;

        el.innerHTML = `
            <span class="step-num">${index + 1}</span>
            <span class="step-desc">${desc}</span>
        `;

        el.addEventListener('click', () => {
            State.ui.selectedStepId = step.id;
            renderPipelineList();
            updateParamEditor();
        });

        pipelineList.appendChild(el);
    });
}

function updateParamEditor() {
    if (!paramPanel) return;
    const step = State.getSelectedStep();
    if (!step) {
        paramPanel.style.opacity = '0.3';
        paramPanel.style.pointerEvents = 'none';
        if (filterTypeDisplay) filterTypeDisplay.textContent = 'No Filter Selected';
        return;
    }

    paramPanel.style.opacity = '1';
    paramPanel.style.pointerEvents = 'auto';

    const niceNames = {
        movingAverage: 'Moving Average',
        savitzkyGolay: 'Savitzky-Golay',
        median: 'Median',
        iir: 'IIR Low Pass',
        gaussian: 'Gaussian',
        startStopNorm: 'Start/Stop Normalisation',
        lowPassFFT: 'FFT Low Pass',
        highPassFFT: 'FFT High Pass',
        notchFFT: 'FFT Notch'
    };
    if (filterTypeDisplay) filterTypeDisplay.textContent = niceNames[step.type];

    const type = step.type;
    const isTime = ['movingAverage', 'savitzkyGolay', 'median', 'gaussian'].includes(type);
    const isFreq = ['lowPassFFT', 'highPassFFT'].includes(type);
    const isNotch = type === 'notchFFT';

    if (grpWindow) grpWindow.style.display = isTime ? 'block' : 'none';
    if (grpPoly) grpPoly.style.display = type === 'savitzkyGolay' ? 'block' : 'none';
    if (grpIters) grpIters.style.display = type === 'savitzkyGolay' ? 'block' : 'none';
    if (grpAlpha) grpAlpha.style.display = type === 'iir' ? 'block' : 'none';
    if (grpSigma) grpSigma.style.display = type === 'gaussian' ? 'block' : 'none';
    if (grpDecay) grpDecay.style.display = type === 'startStopNorm' ? 'block' : 'none';

    if (grpFreq) grpFreq.style.display = isFreq || isNotch ? 'block' : 'none';
    const lblFreq = document.querySelector('label[for="param-freq"]');
    if (lblFreq) lblFreq.textContent = isNotch ? 'Center Frequency' : 'Cutoff Frequency';

    if (grpSlope) grpSlope.style.display = isFreq ? 'block' : 'none';
    if (grpQ) grpQ.style.display = isFreq ? 'block' : 'none';
    if (grpBW) grpBW.style.display = isNotch ? 'block' : 'none';

    const setVal = (inp, slider, val) => {
        if (inp) inp.value = val;
        if (slider) slider.value = val;
    };

    if (step.windowSize) setVal(inputWindow, sliderWindow, step.windowSize);
    if (step.polyOrder) setVal(inputPoly, sliderPoly, step.polyOrder);
    if (step.alpha) setVal(inputAlpha, sliderAlpha, step.alpha);
    if (step.sigma) setVal(inputSigma, sliderSigma, step.sigma);
    if (step.iterations) setVal(inputIters, sliderIters, step.iterations);
    const startLen = step.startLength ?? step.decayLength;
    const endLen = step.endLength ?? step.decayLength;

    if (startLen !== undefined) setVal(inputStartDecay, sliderStartDecay, startLen);
    if (endLen !== undefined) setVal(inputEndDecay, sliderEndDecay, endLen);
    if (inputStartOffset) inputStartOffset.value = step.startOffset ?? 0;
    if (inputAutoOffsetPoints) inputAutoOffsetPoints.value = step.autoOffsetPoints ?? 100;
    if (step.slope) setVal(inputSlope, sliderSlope, step.slope);
    if (step.qFactor) setVal(inputQ, sliderQ, step.qFactor);

    const setUnitInput = (hzValue, inputEl, unitEl) => {
        if (hzValue >= 1e9) { inputEl.value = hzValue / 1e9; unitEl.value = 1e9; }
        else if (hzValue >= 1e6) { inputEl.value = hzValue / 1e6; unitEl.value = 1e6; }
        else if (hzValue >= 1e3) { inputEl.value = hzValue / 1e3; unitEl.value = 1e3; }
        else { inputEl.value = hzValue; unitEl.value = 1; }
    };

    if (step.cutoffFreq) setUnitInput(step.cutoffFreq, inputFreq, selFreqUnit);
    if (step.centerFreq) setUnitInput(step.centerFreq, inputFreq, selFreqUnit);
    if (step.bandwidth) setUnitInput(step.bandwidth, inputBW, selBWUnit);
}

function showAddStepMenu() {
    const html = `
        <h3>Add Filter Step</h3>
        <div style="display:grid; gap:10px;">
            <div style="border-bottom:1px solid #444; padding-bottom:10px; margin-bottom:5px;">
                <small style="color:#888">Time Domain</small>
                <button class="add-opt" data-type="movingAverage">Moving Average</button>
                <button class="add-opt" data-type="savitzkyGolay">Savitzky-Golay</button>
                <button class="add-opt" data-type="median">Median (Despeckle)</button>
                <button class="add-opt" data-type="iir">IIR Low Pass</button>
                <button class="add-opt" data-type="gaussian">Gaussian</button>
                <button class="add-opt" data-type="startStopNorm">Start/Stop Norm</button>
            </div>
            <div>
                <small style="color:#888">Frequency Domain (FFT)</small>
                <button class="add-opt" data-type="lowPassFFT">Low Pass</button>
                <button class="add-opt" data-type="highPassFFT">High Pass</button>
                <button class="add-opt" data-type="notchFFT">Notch Filter</button>
            </div>
        </div>
    `;
    const modal = createModal(html);
    modal.querySelectorAll('.add-opt').forEach((btn) => {
        btn.addEventListener('click', () => {
            const type = btn.getAttribute('data-type');
            State.addStep(type);
            document.body.removeChild(modal.parentElement);
            renderPipelineList();
            updateParamEditor();
            runPipelineAndRender();
        });
    });
}

export { renderPipelineList, showAddStepMenu, updateParamEditor, updateParamsFromUI };
