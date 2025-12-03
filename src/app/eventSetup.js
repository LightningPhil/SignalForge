import { State } from '../state.js';
import { GraphConfig } from '../ui/graphConfig.js';
import { GridView } from '../ui/gridView.js';
import { ReferenceGrid } from '../ui/referenceGrid.js';
import { HelpSystem } from '../ui/helpSystem.js';
import { elements } from './domElements.js';
import { handleFileSelection } from './dataImport.js';
import { renderPipelineList, updateParamEditor, showAddStepMenu, updateParamsFromUI } from './pipelineUi.js';
import { runPipelineAndRender, hasData } from './dataPipeline.js';
import { showExportModal } from './exportModal.js';
import { bindToolbarEvents } from './toolbar.js';
import { MathEngine } from '../processing/math.js';
import { debounce } from './utils.js';
import { bindComposerEvents } from './composerUi.js';

function setupEventListeners() {
    const {
        fileInput,
        btnLoad,
        btnViewGrid,
        btnReferenceGrid,
        btnGraphConfig,
        btnExport,
        btnHelp,
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
        chkAutoOffset,
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
        liveStatus,
        chkSyncTabs
    } = elements;

    if (chkSyncTabs) chkSyncTabs.checked = State.isGlobalScope();

    btnLoad?.addEventListener('click', () => fileInput?.click());

    fileInput?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        handleFileSelection(file, (status) => { if (liveStatus) liveStatus.textContent = status; });
        fileInput.value = '';
    });

    btnViewGrid?.addEventListener('click', () => GridView.show());
    btnGraphConfig?.addEventListener('click', () => { if (hasData()) GraphConfig.show(); });
    btnReferenceGrid?.addEventListener('click', () => { if (hasData()) ReferenceGrid.show(); });
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

    const debouncedUpdateParams = debounce(updateParamsFromUI, 300);

    const bindInput = (numInput, sliderInput) => {
        if (numInput) {
            numInput.addEventListener('input', () => {
                if (sliderInput) sliderInput.value = numInput.value;
                debouncedUpdateParams();
            });
        }
        if (sliderInput) {
            sliderInput.addEventListener('input', () => {
                if (numInput) numInput.value = sliderInput.value;
                debouncedUpdateParams();
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

    [inputFreq, selFreqUnit, inputBW, selBWUnit, inputStartOffset, inputAutoOffsetPoints, chkApplyStart, chkApplyEnd, chkAutoOffset].forEach((el) => {
        el?.addEventListener('input', debouncedUpdateParams);
    });

    const updateAutoOffsetInputs = () => {
        const isAuto = chkAutoOffset?.checked;
        if (inputStartOffset) inputStartOffset.disabled = isAuto;
    };

    chkAutoOffset?.addEventListener('change', () => {
        debouncedUpdateParams();
        updateAutoOffsetInputs();
    });

    updateAutoOffsetInputs();

    chkSyncTabs?.addEventListener('change', () => {
        const wantsSync = !!chkSyncTabs.checked;
        const allColumns = (() => {
            const headers = State.data.headers || [];
            const xCol = State.data.timeColumn;
            const yCols = headers.filter((h) => h !== xCol);
            const mathCols = MathEngine.getAvailableMathColumns();
            return [...new Set([...yCols, ...mathCols])];
        })();

        if (wantsSync) {
            const ok = confirm('Enable Sync All Tabs? This will overwrite individual tab settings with the current view.');
            if (!ok) {
                chkSyncTabs.checked = false;
                return;
            }
            State.setPipelineScope(true, allColumns);
        } else {
            State.setPipelineScope(false, allColumns);
        }

        const activePipeline = State.getPipeline();
        State.ui.selectedStepId = activePipeline[0]?.id || null;

        renderPipelineList();
        updateParamEditor();
        runPipelineAndRender();
    });

    bindToolbarEvents();
    bindComposerEvents();
}

export { setupEventListeners };
