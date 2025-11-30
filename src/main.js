import { State } from './state.js';
import { Graph } from './ui/graph.js';
import { Theme } from './ui/theme.js';
import { SettingsManager } from './io/settingsManager.js';
import { setupEventListeners } from './app/eventSetup.js';
import { renderPipelineList, updateParamEditor } from './app/pipelineUi.js';
import { updateToolbarUIFromState } from './app/toolbar.js';
import { elements } from './app/domElements.js';

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    Theme.init(elements.btnThemeToggle);
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
