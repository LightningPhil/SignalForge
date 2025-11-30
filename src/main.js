import { State } from './state.js';
import { Graph } from './ui/graph.js';
import { SettingsManager } from './io/settingsManager.js';
import { setupEventListeners } from './app/eventSetup.js';
import { renderPipelineList, updateParamEditor } from './app/pipelineUi.js';
import { updateToolbarUIFromState } from './app/toolbar.js';

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    Graph.init();

    if (State.config.pipeline.length > 0) {
        State.ui.selectedStepId = State.config.pipeline[0].id;
    }

    const settingsLoaded = SettingsManager.loadFromBrowser();
    if (settingsLoaded) {
        console.log('Settings restored.');
        updateToolbarUIFromState();
    }

    setupEventListeners();
    renderPipelineList();
    updateParamEditor();
});
