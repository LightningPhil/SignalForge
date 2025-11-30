import { State } from '../state.js';
import { GraphConfig } from '../ui/graphConfig.js';
import { GridView } from '../ui/gridView.js';
import { HelpSystem } from '../ui/helpSystem.js';
import { elements } from './domElements.js';
import { handleFileSelection } from './dataImport.js';
import { renderPipelineList, updateParamEditor, showAddStepMenu, updateParamsFromUI } from './pipelineUi.js';
import { runPipelineAndRender, hasData, getRawSeries } from './dataPipeline.js';
import { showMathModal } from './mathModal.js';
import { showExportModal } from './exportModal.js';
import { bindToolbarEvents } from './toolbar.js';

function setupEventListeners() {
    const {
        fileInput,
        btnLoad,
        btnViewGrid,
        btnGraphConfig,
        btnExport,
        btnHelp,
        btnMath,
        btnAddStep,
        btnRemoveStep,
        btnMoveUp,
        btnMoveDown,
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
        chkApplyStart,
        chkApplyEnd,
        inputStartOffset,
        inputAutoOffsetPoints,
        btnAutoOffset,
        sliderStartDecay,
        sliderEndDecay,
        inputFreq,
        selFreqUnit,
        inputBW,
        selBWUnit,
        inputSlope,
        sliderSlope,
        inputQ,
        sliderQ,
        liveStatus
    } = elements;

    btnLoad?.addEventListener('click', () => fileInput?.click());

    fileInput?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        handleFileSelection(file, (status) => { if (liveStatus) liveStatus.textContent = status; });
        fileInput.value = '';
    });

    btnViewGrid?.addEventListener('click', () => GridView.show());
    btnGraphConfig?.addEventListener('click', () => { if (hasData()) GraphConfig.show(); });
    btnMath?.addEventListener('click', () => { if (hasData()) showMathModal(); });
    btnExport?.addEventListener('click', showExportModal);
    btnHelp?.addEventListener('click', () => HelpSystem.show());

    btnAddStep?.addEventListener('click', showAddStepMenu);

    btnRemoveStep?.addEventListener('click', () => {
        if (!State.ui.selectedStepId) return;
        State.removeStep(State.ui.selectedStepId);
        renderPipelineList();
        updateParamEditor();
        runPipelineAndRender();
    });

    btnMoveUp?.addEventListener('click', () => {
        if (!State.ui.selectedStepId) return;
        State.moveStep(State.ui.selectedStepId, -1);
        renderPipelineList();
        runPipelineAndRender();
    });

    btnMoveDown?.addEventListener('click', () => {
        if (!State.ui.selectedStepId) return;
        State.moveStep(State.ui.selectedStepId, 1);
        renderPipelineList();
        runPipelineAndRender();
    });

    const bindInput = (numInput, sliderInput) => {
        if (numInput) {
            numInput.addEventListener('input', () => {
                if (sliderInput) sliderInput.value = numInput.value;
                updateParamsFromUI();
            });
        }
        if (sliderInput) {
            sliderInput.addEventListener('input', () => {
                if (numInput) numInput.value = sliderInput.value;
                updateParamsFromUI();
            });
        }
    };

    bindInput(inputWindow, sliderWindow);
    bindInput(inputPoly, sliderPoly);
    bindInput(inputAlpha, sliderAlpha);
    bindInput(inputSigma, sliderSigma);
    bindInput(inputIters, sliderIters);
    bindInput(inputStartDecay, sliderStartDecay);
    bindInput(inputEndDecay, sliderEndDecay);
    bindInput(inputSlope, sliderSlope);
    bindInput(inputQ, sliderQ);

    [inputFreq, selFreqUnit, inputBW, selBWUnit, inputStartOffset, inputAutoOffsetPoints, chkApplyStart, chkApplyEnd].forEach((el) => {
        el?.addEventListener('input', updateParamsFromUI);
    });

    const clampVal = (val, min, max) => Math.min(max, Math.max(min, val));

    btnAutoOffset?.addEventListener('click', () => {
        const step = State.getSelectedStep();
        if (!step || step.type !== 'startStopNorm') return;
        if (!hasData()) return;

        const { rawY } = getRawSeries();
        if (!rawY || rawY.length === 0) return;

        const desiredCount = clampVal(parseInt(inputAutoOffsetPoints?.value || '0', 10), 1, rawY.length);
        if (inputAutoOffsetPoints) inputAutoOffsetPoints.value = desiredCount;

        let sum = 0;
        for (let i = 0; i < desiredCount; i++) sum += rawY[i];
        const avg = sum / desiredCount;

        State.updateStepParams(step.id, { startOffset: avg, autoOffsetPoints: desiredCount });
        if (inputStartOffset) inputStartOffset.value = avg;

        renderPipelineList();
        updateParamEditor();
        runPipelineAndRender();
    });

    bindToolbarEvents();
}

export { setupEventListeners };
