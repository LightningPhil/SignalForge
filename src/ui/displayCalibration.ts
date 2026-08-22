import { Config } from '../config';
import { State } from '../state';
import { createModal } from './uiHelpers';

const STORAGE_KEY = 'filterpro_display_calibration';
const FALLBACK_PPCM = Config.displayCalibration.pixelsPerCm || (96 / 2.54);
const TARGET_CM = 10;

export const DEFAULT_PIXELS_PER_CM = FALLBACK_PPCM;

function sanitizePpcm(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function loadCalibrationFromStorage(): number | null {
  try {
    const payload = localStorage.getItem(STORAGE_KEY);
    if (!payload) return null;
    const parsed = JSON.parse(payload) as { pixelsPerCm?: number };
    return sanitizePpcm(parsed.pixelsPerCm);
  } catch (e) {
    console.warn('Failed to read calibration from storage', e);
    return null;
  }
}

function persistCalibration(ppcm: number): void {
  const valid = sanitizePpcm(ppcm);
  if (!valid) return;
  State.config.displayCalibration = { pixelsPerCm: valid };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ pixelsPerCm: valid }));
  } catch (e) {
    console.warn('Failed to store calibration', e);
  }
}

export function applyStoredCalibration(): number | null {
  const stored = loadCalibrationFromStorage();
  if (stored) State.config.displayCalibration = { pixelsPerCm: stored };
  return stored;
}

export function resetCalibration(): void {
  State.config.displayCalibration = { pixelsPerCm: FALLBACK_PPCM };
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    console.warn('Failed to clear calibration', e);
  }
}

export function getPixelsPerCm(): number {
  const configured = sanitizePpcm(State.config.displayCalibration?.pixelsPerCm);
  if (configured) return configured;
  const stored = loadCalibrationFromStorage();
  if (stored) {
    State.config.displayCalibration = { pixelsPerCm: stored };
    return stored;
  }
  return FALLBACK_PPCM;
}

export function openCalibrationModal(onSave?: (ppcm: number) => void): void {
  const currentPpcm = getPixelsPerCm();
  const initialWidthPx = Math.max(50, Math.min(2000, currentPpcm * TARGET_CM));
  const html = `
    <h3 class="mb-3 border-b border-line pb-2 text-lg font-semibold">Calibrate Display</h3>
    <p class="mb-3 text-sm">Use a ruler and adjust the slider so the bar measures exactly ${TARGET_CM} cm on your screen.</p>
    <div class="grid gap-3">
      <div id="calibration-bar" class="h-6 rounded bg-accent shadow"></div>
      <label class="sf-label" for="calibration-slider">Bar width (pixels)</label>
      <input type="range" id="calibration-slider" min="50" max="2000" value="${initialWidthPx}" step="1" class="w-full">
      <input type="number" id="calibration-input" class="sf-field max-w-40" min="10" max="4000" value="${initialWidthPx}" step="1">
      <div id="calibration-reading" class="text-sm text-muted"></div>
      <div class="flex flex-wrap gap-2">
        <button id="btn-calibration-save" class="sf-btn sf-btn-primary" type="button">Save Calibration</button>
        <button id="btn-calibration-reset" class="sf-btn" type="button">Reset to default</button>
      </div>
    </div>
  `;

  const modal = createModal(html);
  const bar = modal.querySelector<HTMLElement>('#calibration-bar');
  const slider = modal.querySelector<HTMLInputElement>('#calibration-slider');
  const input = modal.querySelector<HTMLInputElement>('#calibration-input');
  const reading = modal.querySelector<HTMLElement>('#calibration-reading');

  const updateUI = (pxWidth: string | number) => {
    const clamped = Math.max(10, Math.min(4000, Number(pxWidth) || initialWidthPx));
    if (bar) bar.style.width = `${clamped}px`;
    if (slider) slider.value = String(clamped);
    if (input) input.value = String(clamped);
    const ppcm = clamped / TARGET_CM;
    if (reading) reading.textContent = `${ppcm.toFixed(2)} px/cm (${(ppcm * 2.54).toFixed(1)} PPI)`;
    return ppcm;
  };

  slider?.addEventListener('input', (e) => updateUI((e.target as HTMLInputElement).value));
  input?.addEventListener('input', (e) => updateUI((e.target as HTMLInputElement).value));
  modal.querySelector('#btn-calibration-save')?.addEventListener('click', () => {
    const ppcm = updateUI(input?.value || slider?.value || initialWidthPx);
    persistCalibration(ppcm);
    onSave?.(ppcm);
    modal.parentElement?.remove();
  });
  modal.querySelector('#btn-calibration-reset')?.addEventListener('click', () => {
    resetCalibration();
    updateUI(FALLBACK_PPCM * TARGET_CM);
    onSave?.(FALLBACK_PPCM);
  });
  updateUI(initialWidthPx);
}
