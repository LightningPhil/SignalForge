import { State } from '../state';
import { GraphConfig } from '../ui/graphConfig';
import { GridView } from '../ui/gridView';
import { HelpSystem } from '../ui/helpSystem';
import { bindComposerEvents } from './composerUi';
import { handleFileSelection } from './dataImport';
import { hasData, runPipelineAndRender } from './dataPipeline';
import { elements } from './domElements';
import { showExportModal } from './exportModal';
import { renderPipelineList, showAddStepMenu, updateParamEditor, updateParamsFromUI } from './pipelineUi';
import { EventPanel } from '../ui/eventPanel';
import { MeasurementPanel } from '../ui/measurementPanel';
import { SpectralPanel } from '../ui/spectralPanel';
import { SystemPanel } from '../ui/systemPanel';
import { bindToolbarEvents } from './toolbar';

export function setupEventListeners(): void {
  const {
    fileInput,
    btnLoad,
    btnMultiImport,
    btnSessionReview,
    btnViewGrid,
    btnGraphConfig,
    btnExport,
    btnHelp,
    btnAddStep,
    btnUndoPipeline,
    btnRedoPipeline,
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
    selRegionMode,
    inputRegionMarker,
    inputRegionStartMarker,
    inputRegionEndMarker,
    inputRegionStartTime,
    inputRegionEndTime,
    inputRegionStartIndex,
    inputRegionEndIndex,
    selBaselineEstimator,
    selArtifactMode,
    selReferenceColumn,
    inputReferenceScale,
    sliderStartDecay,
    sliderEndDecay,
    inputFreq,
    selFreqUnit,
    inputBW,
    selBWUnit,
    inputSlope,
    sliderSlope,
    inputFilterOrder,
    selProcessingMode,
    inputFirTransition,
    selFirTransitionUnit,
    inputFirRipple,
    inputFirAttenuation,
    inputHarmonicCount,
    liveStatus,
    chkSyncTabs
  } = elements;

  if (chkSyncTabs) chkSyncTabs.checked = State.isGlobalScope();
  window.addEventListener('signalforge:persistence-error', (event) => {
    const message = (event as CustomEvent<string>).detail;
    if (liveStatus) liveStatus.textContent = `Save failed: ${message}`;
  });
  window.addEventListener('signalforge:data-warning', (event) => {
    const message = (event as CustomEvent<string>).detail;
    if (liveStatus) liveStatus.textContent = message;
  });

  btnLoad?.addEventListener('click', () => fileInput?.click());
  btnMultiImport?.addEventListener('click', () => {
    void import('../ui/multiFileImport').then(({ MultiFileImport }) => MultiFileImport.show());
  });
  btnSessionReview?.addEventListener('click', () => {
    void import('../ui/reviewWorkspace').then(({ ReviewWorkspace }) => ReviewWorkspace.show());
  });

  fileInput?.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    handleFileSelection(file, (status) => {
      if (liveStatus) liveStatus.textContent = status;
    });
    fileInput.value = '';
  });

  btnViewGrid?.addEventListener('click', () => GridView.show());
  btnGraphConfig?.addEventListener('click', () => {
    if (hasData()) GraphConfig.show();
  });
  btnExport?.addEventListener('click', showExportModal);
  btnHelp?.addEventListener('click', () => HelpSystem.show());
  btnAddStep?.addEventListener('click', showAddStepMenu);
  btnUndoPipeline?.addEventListener('click', () => {
    if (!State.undoPipelineChange()) return;
    renderPipelineList();
    updateParamEditor();
    runPipelineAndRender();
  });
  btnRedoPipeline?.addEventListener('click', () => {
    if (!State.redoPipelineChange()) return;
    renderPipelineList();
    updateParamEditor();
    runPipelineAndRender();
  });

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

  const scheduleParamUpdate = (() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return () => {
      const stepId = State.ui.selectedStepId;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (State.ui.selectedStepId !== stepId) return;
        updateParamsFromUI();
      }, 300);
    };
  })();

  const bindInput = (numInput: HTMLInputElement | null, sliderInput: HTMLInputElement | null) => {
    numInput?.addEventListener('input', () => {
      if (sliderInput) sliderInput.value = numInput.value;
      scheduleParamUpdate();
    });
    sliderInput?.addEventListener('input', () => {
      if (numInput) numInput.value = sliderInput.value;
      scheduleParamUpdate();
    });
  };

  bindInput(inputWindow, sliderWindow);
  bindInput(inputPoly, sliderPoly);
  bindInput(inputAlpha, sliderAlpha);
  bindInput(inputSigma, sliderSigma);
  bindInput(inputIters, sliderIters);
  bindInput(inputStartDecay, sliderStartDecay);
  bindInput(inputEndDecay, sliderEndDecay);
  bindInput(inputSlope, sliderSlope);

  [
    inputFreq,
    selFreqUnit,
    inputBW,
    selBWUnit,
    inputFilterOrder,
    selProcessingMode,
    inputFirTransition,
    selFirTransitionUnit,
    inputFirRipple,
    inputFirAttenuation,
    inputHarmonicCount,
    inputStartOffset,
    inputAutoOffsetPoints,
    chkApplyStart,
    chkApplyEnd,
    chkAutoOffset,
    selRegionMode,
    inputRegionMarker,
    inputRegionStartMarker,
    inputRegionEndMarker,
    inputRegionStartTime,
    inputRegionEndTime,
    inputRegionStartIndex,
    inputRegionEndIndex,
    selBaselineEstimator,
    selArtifactMode,
    selReferenceColumn,
    inputReferenceScale
  ].forEach((el) => el?.addEventListener('input', scheduleParamUpdate));

  const updateAutoOffsetInputs = () => {
    if (inputStartOffset) inputStartOffset.disabled = !!chkAutoOffset?.checked;
  };

  chkAutoOffset?.addEventListener('change', () => {
    scheduleParamUpdate();
    updateAutoOffsetInputs();
  });

  updateAutoOffsetInputs();

  chkSyncTabs?.addEventListener('change', () => {
    const wantsSync = !!chkSyncTabs.checked;
    const headers = State.data.headers || [];
    const xCol = State.data.timeColumn;
    const allColumns = [...new Set(headers.filter((h) => h !== xCol))];

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

    chkSyncTabs.checked = State.isGlobalScope();
    const activePipeline = State.getPipeline();
    State.ui.selectedStepId = activePipeline[0]?.id || null;
    renderPipelineList();
    updateParamEditor();
    runPipelineAndRender();
  });

  bindToolbarEvents();
  bindComposerEvents();
  setupSidebarTabs();
  MeasurementPanel.init();
  EventPanel.init();
  SpectralPanel.init();
  SystemPanel.init();
}

function setupSidebarTabs(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>('.sidebar-tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const targetId = `tab-${tab.dataset.tab}`;
      tabs.forEach((t) => t.classList.toggle('is-active', t === tab));
      document.querySelectorAll<HTMLElement>('.sidebar-tab-content').forEach((panel) => {
        panel.classList.toggle('hidden', panel.id !== targetId);
      });
    });
  });
}
