import { State } from '../state.js';
import { GraphConfig } from '../ui/graphConfig.js';
import { GridView } from '../ui/gridView.js';
import { HelpSystem } from '../ui/helpSystem.js';
import { elements } from './domElements.js';
import { handleFileSelection } from './dataImport.js';
import { renderPipelineList, updateParamEditor, showAddStepMenu, updateParamsFromUI } from './pipelineUi.js';
import { runPipelineAndRender, hasData } from './dataPipeline.js';
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
        inputDecay,
        sliderDecay,
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
    bindInput(inputDecay, sliderDecay);
    bindInput(inputSlope, sliderSlope);
    bindInput(inputQ, sliderQ);

    [inputFreq, selFreqUnit, inputBW, selBWUnit].forEach((el) => {
        el?.addEventListener('input', updateParamsFromUI);
    });

    bindToolbarEvents();
}

export { setupEventListeners };
