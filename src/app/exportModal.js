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
import { DEFAULT_PIXELS_PER_CM, getPixelsPerCm, openCalibrationModal, resetCalibration } from '../ui/displayCalibration.js';

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
            <div style="display:grid; gap:8px; margin-bottom:10px;">
                <label class="toggle-label" style="margin:0; align-items:center; gap:10px;">
                    <input type="checkbox" id="export-use-window" checked style="width:auto;">
                    Use Window Size
                </label>
                <small id="export-window-size" style="color:var(--text-muted);"></small>
                <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
                    <label for="export-width-cm" style="min-width:120px;">Width (cm)</label>
                    <input type="number" id="export-width-cm" min="1" step="0.1" style="width:120px;">
                    <label for="export-height-cm" style="min-width:120px;">Height (cm)</label>
                    <input type="number" id="export-height-cm" min="1" step="0.1" style="width:120px;">
                </div>
            </div>
            <div style="display:flex; gap:10px; flex-wrap:wrap;">
                <button id="btn-export-png">Download PNG</button>
                <button id="btn-export-svg">Download SVG</button>
            </div>
        </div>

        <div class="panel">
            <h4>Display Calibration</h4>
            <p>Improve physical size accuracy for centimeter-based exports.</p>
            <div id="calibration-status" class="calibration-status"></div>
            <div style="display:flex; gap:10px; flex-wrap:wrap;">
                <button id="btn-open-calibration">Calibrate Display</button>
                <button id="btn-reset-calibration">Use Default Scale</button>
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
    const widthCmInput = modal.querySelector('#export-width-cm');
    const heightCmInput = modal.querySelector('#export-height-cm');
    const useWindowToggle = modal.querySelector('#export-use-window');
    const sizeLabel = modal.querySelector('#export-window-size');
    const calibrationStatus = modal.querySelector('#calibration-status');

    const updateSizeLabel = () => {
        const graphDiv = document.getElementById('main-plot');
        if (graphDiv && sizeLabel) {
            const pixelsPerCm = getPixelsPerCm();
            const widthCm = (graphDiv.clientWidth / pixelsPerCm).toFixed(1);
            const heightCm = (graphDiv.clientHeight / pixelsPerCm).toFixed(1);
            sizeLabel.textContent = `Current window: ${widthCm} cm x ${heightCm} cm (calibrated)`;
            if (widthCmInput && !widthCmInput.value) widthCmInput.value = widthCm;
            if (heightCmInput && !heightCmInput.value) heightCmInput.value = heightCm;
        }
    };

    const syncSizeInputs = () => {
        const disabled = useWindowToggle?.checked;
        if (widthCmInput) widthCmInput.disabled = disabled;
        if (heightCmInput) heightCmInput.disabled = disabled;
    };

    updateSizeLabel();
    syncSizeInputs();
    useWindowToggle?.addEventListener('change', syncSizeInputs);
    const refreshCalibrationStatus = () => {
        const pixelsPerCm = getPixelsPerCm();
        const ppi = (pixelsPerCm * 2.54).toFixed(1);
        const isDefault = !State.config.displayCalibration
            || !State.config.displayCalibration.pixelsPerCm
            || Math.abs(pixelsPerCm - DEFAULT_PIXELS_PER_CM) < 0.01;
        const note = isDefault ? 'Using default browser scale.' : 'Calibrated for this display.';
        if (calibrationStatus) {
            calibrationStatus.textContent = `${pixelsPerCm.toFixed(2)} px/cm (${ppi} PPI) — ${note}`;
        }
    };

    refreshCalibrationStatus();

    modal.querySelector('#btn-open-calibration')?.addEventListener('click', () => {
        openCalibrationModal(() => {
            refreshCalibrationStatus();
            updateSizeLabel();
        });
    });

    modal.querySelector('#btn-reset-calibration')?.addEventListener('click', () => {
        resetCalibration();
        refreshCalibrationStatus();
        updateSizeLabel();
    });

    modal.querySelector('#btn-export-filtered')?.addEventListener('click', () => {
        Exporter.downloadCSV(false);
    });

    modal.querySelector('#btn-export-full')?.addEventListener('click', () => {
        Exporter.downloadCSV(true);
    });

    modal.querySelector('#btn-export-png')?.addEventListener('click', () => {
        if (!hasData()) return;
        const selectedTheme = themeSelect?.value === 'current' ? Theme.current : themeSelect?.value;
        Exporter.downloadImage('png', {
            theme: selectedTheme,
            transparent: transparentToggle?.checked,
            widthCm: parseFloat(widthCmInput?.value || '0'),
            heightCm: parseFloat(heightCmInput?.value || '0'),
            useWindowSize: useWindowToggle?.checked !== false
        });
    });

    modal.querySelector('#btn-export-svg')?.addEventListener('click', () => {
        if (!hasData()) return;
        const selectedTheme = themeSelect?.value === 'current' ? Theme.current : themeSelect?.value;
        Exporter.downloadImage('svg', {
            theme: selectedTheme,
            transparent: transparentToggle?.checked,
            widthCm: parseFloat(widthCmInput?.value || '0'),
            heightCm: parseFloat(heightCmInput?.value || '0'),
            useWindowSize: useWindowToggle?.checked !== false
        });
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
