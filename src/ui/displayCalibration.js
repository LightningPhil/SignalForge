import { Config } from '../config.js';
import { State } from '../state.js';
import { createModal } from './uiHelpers.js';

const STORAGE_KEY = 'filterpro_display_calibration';
const FALLBACK_PPCM = Config.displayCalibration?.pixelsPerCm || (96 / 2.54);
const TARGET_CM = 10;

export const DEFAULT_PIXELS_PER_CM = FALLBACK_PPCM;

function sanitizePpcm(value) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : null;
}

function loadCalibrationFromStorage() {
    try {
        const payload = localStorage.getItem(STORAGE_KEY);
        if (!payload) return null;
        const parsed = JSON.parse(payload);
        return sanitizePpcm(parsed?.pixelsPerCm);
    } catch (e) {
        console.warn('Failed to read calibration from storage', e);
        return null;
    }
}

function persistCalibration(ppcm) {
    const valid = sanitizePpcm(ppcm);
    if (!valid) return;

    State.config.displayCalibration = { pixelsPerCm: valid };
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ pixelsPerCm: valid }));
    } catch (e) {
        console.warn('Failed to store calibration', e);
    }
}

export function applyStoredCalibration() {
    const stored = loadCalibrationFromStorage();
    if (stored) {
        State.config.displayCalibration = { pixelsPerCm: stored };
    }
    return stored;
}

export function resetCalibration() {
    State.config.displayCalibration = { pixelsPerCm: FALLBACK_PPCM };
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
        console.warn('Failed to clear calibration', e);
    }
}

export function getPixelsPerCm() {
    const configured = sanitizePpcm(State.config?.displayCalibration?.pixelsPerCm);
    if (configured) return configured;

    const stored = loadCalibrationFromStorage();
    if (stored) {
        State.config.displayCalibration = { pixelsPerCm: stored };
        return stored;
    }

    return FALLBACK_PPCM;
}

export function openCalibrationModal(onSave) {
    const currentPpcm = getPixelsPerCm();
    const initialWidthPx = Math.max(50, Math.min(2000, currentPpcm * TARGET_CM));

    const html = `
        <h3>Calibrate Display</h3>
        <p>Use a ruler and adjust the slider so the blue bar measures exactly ${TARGET_CM} cm on your screen.</p>
        <div class="calibration-container">
            <div class="calibration-bar" id="calibration-bar"></div>
            <div class="calibration-controls">
                <label>Bar width (pixels)
                    <input type="range" id="calibration-slider" min="50" max="2000" value="${initialWidthPx}" step="1">
                </label>
                <input type="number" id="calibration-input" min="10" max="4000" value="${initialWidthPx}" step="1">
                <div class="calibration-reading" id="calibration-reading"></div>
            </div>
            <div class="calibration-actions">
                <button id="btn-calibration-save" class="primary">Save Calibration</button>
                <button id="btn-calibration-reset">Reset to default</button>
            </div>
        </div>
    `;

    const modal = createModal(html);
    const bar = modal.querySelector('#calibration-bar');
    const slider = modal.querySelector('#calibration-slider');
    const input = modal.querySelector('#calibration-input');
    const reading = modal.querySelector('#calibration-reading');
    const saveBtn = modal.querySelector('#btn-calibration-save');
    const resetBtn = modal.querySelector('#btn-calibration-reset');

    const updateUI = (pxWidth) => {
        const clamped = Math.max(10, Math.min(4000, Number(pxWidth) || initialWidthPx));
        if (bar) bar.style.width = `${clamped}px`;
        if (slider) slider.value = clamped;
        if (input) input.value = clamped;
        const ppcm = clamped / TARGET_CM;
        if (reading) {
            const ppi = ppcm * 2.54;
            reading.textContent = `${ppcm.toFixed(2)} px/cm (${ppi.toFixed(1)} PPI)`;
        }
        return ppcm;
    };

    const persist = () => {
        const ppcm = updateUI(input?.value || slider?.value || initialWidthPx);
        persistCalibration(ppcm);
        if (typeof onSave === 'function') onSave(ppcm);
    };

    slider?.addEventListener('input', (e) => updateUI(e.target.value));
    input?.addEventListener('input', (e) => updateUI(e.target.value));

    saveBtn?.addEventListener('click', () => {
        persist();
        const overlay = modal.parentElement;
        if (overlay && overlay.parentElement) overlay.parentElement.removeChild(overlay);
    });

    resetBtn?.addEventListener('click', () => {
        resetCalibration();
        updateUI(FALLBACK_PPCM * TARGET_CM);
        if (typeof onSave === 'function') onSave(FALLBACK_PPCM);
    });

    updateUI(initialWidthPx);
}
