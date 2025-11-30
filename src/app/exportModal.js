import { createModal } from '../ui/uiHelpers.js';
import { Exporter } from '../io/exporter.js';
import { SettingsManager } from '../io/settingsManager.js';
import { renderPipelineList, updateParamEditor } from './pipelineUi.js';
import { renderColumnTabs } from './tabs.js';
import { runPipelineAndRender, hasData } from './dataPipeline.js';
import { updateToolbarUIFromState } from './toolbar.js';
import { State } from '../state.js';

function applySettingsAndRefreshUI() {
    if (State.config.pipeline.length > 0) {
        State.ui.selectedStepId = State.config.pipeline[0].id;
    } else {
        State.ui.selectedStepId = null;
    }

    renderPipelineList();
    updateParamEditor();
    updateToolbarUIFromState();
    renderColumnTabs();

    if (hasData(false)) {
        runPipelineAndRender();
    }
}

function showExportModal() {
    const html = `
        <h3>Export & Settings</h3>

        <div class="panel">
            <h4>Data Exports</h4>
            <p>Download filtered data or include the original raw columns.</p>
            <div style="display:flex; gap:10px; flex-wrap:wrap;">
                <button id="btn-export-filtered">Filtered CSV</button>
                <button id="btn-export-full">Raw + Filtered CSV</button>
            </div>
        </div>

        <div class="panel">
            <h4>Graph Image</h4>
            <p>Save the current graph view as an image.</p>
            <div style="display:flex; gap:10px; flex-wrap:wrap;">
                <button id="btn-export-png">Download PNG</button>
                <button id="btn-export-svg">Download SVG</button>
            </div>
        </div>

        <div class="panel">
            <h4>Settings</h4>
            <p>Save or restore configuration from your browser or a JSON file.</p>
            <div style="display:grid; gap:8px;">
                <button id="btn-save-browser">Save to Browser Memory</button>
                <button id="btn-load-browser">Load from Browser Memory</button>
                <button id="btn-download-settings">Download Settings (.json)</button>
                <button id="btn-upload-settings">Load Settings from File</button>
            </div>
            <input type="file" id="input-settings-file" accept="application/json" style="display:none;">
        </div>
    `;

    const modal = createModal(html);

    const fileInput = modal.querySelector('#input-settings-file');

    modal.querySelector('#btn-export-filtered')?.addEventListener('click', () => {
        Exporter.downloadCSV(false);
    });

    modal.querySelector('#btn-export-full')?.addEventListener('click', () => {
        Exporter.downloadCSV(true);
    });

    modal.querySelector('#btn-export-png')?.addEventListener('click', () => {
        if (!hasData()) return;
        Exporter.downloadImage('png');
    });

    modal.querySelector('#btn-export-svg')?.addEventListener('click', () => {
        if (!hasData()) return;
        Exporter.downloadImage('svg');
    });

    modal.querySelector('#btn-save-browser')?.addEventListener('click', () => {
        SettingsManager.saveToBrowser();
    });

    modal.querySelector('#btn-load-browser')?.addEventListener('click', () => {
        const loaded = SettingsManager.loadFromBrowser();
        if (loaded) {
            applySettingsAndRefreshUI();
            alert('Settings restored from browser memory.');
        } else {
            alert('No saved settings found in browser memory.');
        }
    });

    modal.querySelector('#btn-download-settings')?.addEventListener('click', () => {
        SettingsManager.downloadSettings();
    });

    modal.querySelector('#btn-upload-settings')?.addEventListener('click', () => {
        fileInput?.click();
    });

    fileInput?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        SettingsManager.uploadSettings(file, () => {
            applySettingsAndRefreshUI();
            alert('Settings loaded from file.');
        });

        fileInput.value = '';
    });
}

export { showExportModal };
