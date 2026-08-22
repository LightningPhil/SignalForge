import { Exporter } from '../io/exporter';
import { SettingsManager } from '../io/settingsManager';
import { State } from '../state';
import type { ThemeName } from '../types';
import { ui } from '../ui/classes';
import { DEFAULT_PIXELS_PER_CM, getPixelsPerCm, openCalibrationModal, resetCalibration } from '../ui/displayCalibration';
import { Theme } from '../ui/theme';
import { createModal } from '../ui/uiHelpers';
import { hasData, runPipelineAndRender } from './dataPipeline';
import { elements } from './domElements';
import { renderPipelineList, updateParamEditor } from './pipelineUi';
import { renderColumnTabs } from './tabs';
import { updateToolbarUIFromState } from './toolbar';

function applySettingsAndRefreshUI(): void {
  const pipeline = State.getPipeline();
  State.ui.selectedStepId = pipeline[0]?.id || null;
  renderPipelineList();
  updateParamEditor();
  if (elements.chkSyncTabs) elements.chkSyncTabs.checked = State.isGlobalScope();
  updateToolbarUIFromState();
  renderColumnTabs();
  if (hasData(false)) runPipelineAndRender();
}

export function showExportModal(): void {
  const currentTheme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  const html = `
    <h3 class="${ui.modalTitle}">Export & Settings</h3>

    <section class="${ui.modalPanel}">
      <h4 class="mb-2 font-semibold">Data Exports</h4>
      <p class="mb-3 text-sm text-muted">Download filtered data or include the original raw columns.</p>
      <div class="flex flex-wrap gap-2.5">
        <button class="sf-btn" id="btn-export-filtered" type="button">Filtered CSV</button>
        <button class="sf-btn" id="btn-export-full" type="button">Raw + Filtered CSV</button>
      </div>
    </section>

    <section class="${ui.modalPanel}">
      <h4 class="mb-2 font-semibold">Graph Image</h4>
      <p class="mb-3 text-sm text-muted">Save the current graph view as an image.</p>
      <div class="mb-3 flex flex-wrap items-center gap-2.5">
        <label for="export-theme" class="min-w-30 text-sm">Image Theme</label>
        <select id="export-theme" class="sf-field max-w-xs">
          <option value="current" selected>Match App (${currentTheme.charAt(0).toUpperCase() + currentTheme.slice(1)})</option>
          <option value="light">Light Mode</option>
          <option value="dark">Dark Mode</option>
        </select>
      </div>
      <label class="${ui.toggleLabel} mb-3">
        <input type="checkbox" id="export-transparent" class="h-4 w-4 accent-accent">
        Transparent background
      </label>
      <div class="mb-3 grid gap-2">
        <label class="${ui.toggleLabel}">
          <input type="checkbox" id="export-use-window" class="h-4 w-4 accent-accent" checked>
          Use Window Size
        </label>
        <small id="export-window-size" class="sf-hint"></small>
        <div class="flex flex-wrap items-center gap-2.5">
          <label for="export-width-cm" class="min-w-24 text-sm">Width (cm)</label>
          <input type="number" id="export-width-cm" class="sf-field w-28" min="1" step="0.1">
          <label for="export-height-cm" class="min-w-24 text-sm">Height (cm)</label>
          <input type="number" id="export-height-cm" class="sf-field w-28" min="1" step="0.1">
        </div>
      </div>
      <div class="flex flex-wrap gap-2.5">
        <button class="sf-btn" id="btn-export-png" type="button">Download PNG</button>
        <button class="sf-btn" id="btn-export-svg" type="button">Download SVG</button>
      </div>
    </section>

    <section class="${ui.modalPanel}">
      <h4 class="mb-2 font-semibold">Display Calibration</h4>
      <p class="mb-3 text-sm text-muted">Improve physical size accuracy for centimeter-based exports.</p>
      <div id="calibration-status" class="mb-3 text-sm text-muted"></div>
      <div class="flex flex-wrap gap-2.5">
        <button class="sf-btn" id="btn-open-calibration" type="button">Calibrate Display</button>
        <button class="sf-btn" id="btn-reset-calibration" type="button">Use Default Scale</button>
      </div>
    </section>

    <section class="${ui.modalPanel}">
      <h4 class="mb-2 font-semibold">Settings</h4>
      <p class="mb-3 text-sm text-muted">Save or restore configuration from your browser or a JSON file.</p>
      <div class="grid gap-2">
        <button class="sf-btn" id="btn-save-browser" type="button">Save to Browser Memory</button>
        <button class="sf-btn" id="btn-load-browser" type="button">Load from Browser Memory</button>
        <button class="sf-btn" id="btn-download-settings" type="button">Download Settings (.json)</button>
        <button class="sf-btn" id="btn-upload-settings" type="button">Load Settings from File</button>
      </div>
      <input type="file" id="input-settings-file" accept="application/json" class="hidden">
    </section>
  `;

  const modal = createModal(html);
  const fileInput = modal.querySelector<HTMLInputElement>('#input-settings-file');
  const themeSelect = modal.querySelector<HTMLSelectElement>('#export-theme');
  const transparentToggle = modal.querySelector<HTMLInputElement>('#export-transparent');
  const widthCmInput = modal.querySelector<HTMLInputElement>('#export-width-cm');
  const heightCmInput = modal.querySelector<HTMLInputElement>('#export-height-cm');
  const useWindowToggle = modal.querySelector<HTMLInputElement>('#export-use-window');
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
    if (widthCmInput) widthCmInput.disabled = !!disabled;
    if (heightCmInput) heightCmInput.disabled = !!disabled;
  };

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

  updateSizeLabel();
  syncSizeInputs();
  refreshCalibrationStatus();
  useWindowToggle?.addEventListener('change', syncSizeInputs);

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
  modal.querySelector('#btn-export-filtered')?.addEventListener('click', () => Exporter.downloadCSV(false));
  modal.querySelector('#btn-export-full')?.addEventListener('click', () => Exporter.downloadCSV(true));

  const exportImage = (format: 'png' | 'svg') => {
    if (!hasData()) return;
    const selected = themeSelect?.value;
    const selectedTheme: ThemeName | 'current' = selected === 'light' || selected === 'dark' ? selected : Theme.current;
    Exporter.downloadImage(format, {
      theme: selectedTheme,
      transparent: transparentToggle?.checked,
      widthCm: parseFloat(widthCmInput?.value || '0'),
      heightCm: parseFloat(heightCmInput?.value || '0'),
      useWindowSize: useWindowToggle?.checked !== false
    });
  };

  modal.querySelector('#btn-export-png')?.addEventListener('click', () => exportImage('png'));
  modal.querySelector('#btn-export-svg')?.addEventListener('click', () => exportImage('svg'));
  modal.querySelector('#btn-save-browser')?.addEventListener('click', () => SettingsManager.saveToBrowser());
  modal.querySelector('#btn-load-browser')?.addEventListener('click', () => {
    if (SettingsManager.loadFromBrowser()) {
      applySettingsAndRefreshUI();
      alert('Settings restored from browser memory.');
    } else {
      alert('No saved settings found in browser memory.');
    }
  });
  modal.querySelector('#btn-download-settings')?.addEventListener('click', () => SettingsManager.downloadSettings());
  modal.querySelector('#btn-upload-settings')?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    SettingsManager.uploadSettings(file, () => {
      applySettingsAndRefreshUI();
      alert('Settings loaded from file.');
    });
    fileInput.value = '';
  });
}
