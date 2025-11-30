import { createModal } from '../ui/uiHelpers.js';
import { Exporter } from '../io/exporter.js';
import { SettingsManager } from '../io/settingsManager.js';
import { renderPipelineList, updateParamEditor } from './pipelineUi.js';
import { renderColumnTabs } from './tabs.js';
import { runPipelineAndRender, hasData } from './dataPipeline.js';
import { updateToolbarUIFromState } from './toolbar.js';
import { State } from '../state.js';
import { Theme } from '../ui/theme.js';
import { elements } from './domElements.js';

function applySettingsAndRefreshUI() {
    const pipeline = State.getPipeline();
    if (pipeline.length > 0) {
        State.ui.selectedStepId = pipeline[0].id;
    } else {
        State.ui.selectedStepId = null;
    }

    renderPipelineList();
    updateParamEditor();
    if (elements.chkSyncTabs) elements.chkSyncTabs.checked = State.isGlobalScope();
    updateToolbarUIFromState();
    renderColumnTabs();

    if (hasData(false)) {
        runPipelineAndRender();
    }
}

function showExportModal() {
    const currentTheme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
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
            <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
                <label for="export-theme" style="margin:0; min-width:120px;">Image Theme</label>
                <select id="export-theme">
                    <option value="current" selected>Match App (${currentTheme.charAt(0).toUpperCase() + currentTheme.slice(1)})</option>
                    <option value="light">Light Mode</option>
                    <option value="dark">Dark Mode</option>
                </select>
            </div>
            <label style="display:flex; align-items:center; gap:10px; margin:10px 0;">
                <input type="checkbox" id="export-transparent" style="width:auto;">
                Transparent background
            </label>
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
    const themeSelect = modal.querySelector('#export-theme');
    const transparentToggle = modal.querySelector('#export-transparent');

    modal.querySelector('#btn-export-filtered')?.addEventListener('click', () => {
        Exporter.downloadCSV(false);
    });

    modal.querySelector('#btn-export-full')?.addEventListener('click', () => {
        Exporter.downloadCSV(true);
    });

    modal.querySelector('#btn-export-png')?.addEventListener('click', () => {
        if (!hasData()) return;
        const selectedTheme = themeSelect?.value === 'current' ? Theme.current : themeSelect?.value;
        Exporter.downloadImage('png', { theme: selectedTheme, transparent: transparentToggle?.checked });
    });

    modal.querySelector('#btn-export-svg')?.addEventListener('click', () => {
        if (!hasData()) return;
        const selectedTheme = themeSelect?.value === 'current' ? Theme.current : themeSelect?.value;
        Exporter.downloadImage('svg', { theme: selectedTheme, transparent: transparentToggle?.checked });
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
