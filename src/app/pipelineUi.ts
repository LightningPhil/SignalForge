import { State } from '../state';
import type { FilterStep, FilterType } from '../types';
import { cx, ui } from '../ui/classes';
import { createModal } from '../ui/uiHelpers';
import { runPipelineAndRender } from './dataPipeline';
import { elements } from './domElements';

const {
  pipelineList,
  paramPanel,
  filterTypeDisplay,
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
  inputSlope,
  sliderSlope,
  inputQ,
  sliderQ,
  inputBW,
  selBWUnit,
  grpWindow,
  grpPoly,
  grpAlpha,
  grpSigma,
  grpIters,
  grpDecay,
  grpFreq,
  grpSlope,
  grpQ,
  grpBW,
  chkSyncTabs
} = elements;

const FILTER_NAMES: Record<FilterType, string> = {
  movingAverage: 'Moving Average',
  savitzkyGolay: 'Savitzky-Golay',
  median: 'Median',
  iir: 'IIR Low Pass',
  gaussian: 'Gaussian',
  startStopNorm: 'Start/Stop Normalisation',
  lowPassFFT: 'FFT Low Pass',
  highPassFFT: 'FFT High Pass',
  notchFFT: 'FFT Notch',
  nullFilter: 'Null Filter (Pass-through)'
};

function getNumericValue(inputEl: HTMLInputElement | null): number | null {
  if (!inputEl) return null;
  const raw = (inputEl.value || '').trim();
  if (raw === '' || raw === '-' || raw === '-.' || raw === '.') return null;
  const val = parseFloat(raw);
  return Number.isNaN(val) ? null : val;
}

function clamp(inputEl: HTMLInputElement | null, min: number, max: number): number | null {
  const rawVal = getNumericValue(inputEl);
  if (rawVal === null || !inputEl) return null;
  let val = rawVal;
  if (val < min) {
    val = min;
    inputEl.value = String(min);
  }
  if (val > max) {
    val = max;
    inputEl.value = String(max);
  }
  return val;
}

function setVisible(el: HTMLElement | null, visible: boolean): void {
  el?.classList.toggle('hidden', !visible);
}

export function updateParamsFromUI(): void {
  const id = State.ui.selectedStepId;
  if (!id) return;

  const step = State.getSelectedStep();
  if (!step) return;

  const params: Partial<FilterStep> = {};
  const type = step.type;
  const isWindowed = ['movingAverage', 'savitzkyGolay', 'median', 'gaussian'].includes(type);
  const isFreq = ['lowPassFFT', 'highPassFFT'].includes(type);
  const isNotch = type === 'notchFFT';

  if (isWindowed) {
    const windowVal = clamp(inputWindow, 1, 9999);
    if (windowVal !== null) params.windowSize = windowVal;
  }
  if (type === 'savitzkyGolay') {
    const polyVal = clamp(inputPoly, 1, 10);
    if (polyVal !== null) params.polyOrder = polyVal;
    const iterVal = clamp(inputIters, 1, 16);
    if (iterVal !== null) params.iterations = iterVal;
  }
  if (type === 'iir') {
    const alphaVal = clamp(inputAlpha, 0.001, 1.0);
    if (alphaVal !== null) params.alpha = alphaVal;
  }
  if (type === 'gaussian') {
    const sigmaVal = clamp(inputSigma, 0.1, 100.0);
    if (sigmaVal !== null) params.sigma = sigmaVal;
  }
  if (type === 'startStopNorm') {
    const startDecayVal = clamp(inputStartDecay, 0, 10000);
    if (startDecayVal !== null) params.startLength = startDecayVal;
    const endDecayVal = clamp(inputEndDecay, 0, 10000);
    if (endDecayVal !== null) params.endLength = endDecayVal;
    if (chkApplyStart) params.applyStart = !!chkApplyStart.checked;
    if (chkApplyEnd) params.applyEnd = !!chkApplyEnd.checked;
    const startOffsetVal = getNumericValue(inputStartOffset);
    if (startOffsetVal !== null) params.startOffset = startOffsetVal;
    if (chkAutoOffset) params.autoOffset = !!chkAutoOffset.checked;
    const autoOffsetPointsVal = clamp(inputAutoOffsetPoints, 1, 100000);
    if (autoOffsetPointsVal !== null) params.autoOffsetPoints = autoOffsetPointsVal;
  }

  if ((isFreq || isNotch) && selFreqUnit) {
    const fMult = parseFloat(selFreqUnit.value);
    const rawFreq = getNumericValue(inputFreq);
    const fallbackHz = step.centerFreq || step.cutoffFreq || 0;
    const baseFreq = rawFreq !== null ? rawFreq : (fallbackHz / fMult);
    const hz = baseFreq * fMult;
    if (isNotch) params.centerFreq = hz;
    else params.cutoffFreq = hz;
  }

  if (isNotch && selBWUnit) {
    const bMult = parseFloat(selBWUnit.value);
    const rawBW = getNumericValue(inputBW);
    const bw = rawBW !== null ? rawBW : ((step.bandwidth || 0) / bMult);
    params.bandwidth = bw * bMult;
  }

  if (isFreq) {
    const slopeVal = clamp(inputSlope, 6, 96);
    if (slopeVal !== null) params.slope = slopeVal;
    const qVal = clamp(inputQ, 0.1, 20.0);
    if (qVal !== null) params.qFactor = qVal;
  }

  State.updateStepParams(id, params);
  renderPipelineList();
  runPipelineAndRender();
}

function fmtHz(hz: number): string {
  if (hz >= 1e9) return `${(hz / 1e9).toFixed(1)}G`;
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(1)}M`;
  if (hz >= 1e3) return `${(hz / 1e3).toFixed(1)}k`;
  return hz.toFixed(0);
}

function describeStep(step: FilterStep): string {
  if (step.type === 'nullFilter') return 'Pass-through (Raw)';
  if (step.type === 'movingAverage') return `Mov. Avg (Win: ${step.windowSize})`;
  if (step.type === 'savitzkyGolay') return `Sav-Gol (Win: ${step.windowSize}, x${step.iterations || 1})`;
  if (step.type === 'median') return `Median (Win: ${step.windowSize})`;
  if (step.type === 'iir') return `IIR (Alpha: ${step.alpha})`;
  if (step.type === 'gaussian') return `Gaussian (Sig: ${step.sigma})`;
  if (step.type === 'startStopNorm') {
    const startLabel = step.applyStart === false ? 'Off' : (step.startLength ?? 0);
    const endLabel = step.applyEnd === false ? 'Off' : (step.endLength ?? 0);
    const autoLabel = step.autoOffset ? 'Auto' : `Offset ${step.startOffset ?? 0}`;
    return `Norm (${autoLabel}, Start: ${startLabel}, End: ${endLabel})`;
  }
  if (step.type === 'lowPassFFT') return `Low Pass (${fmtHz(step.cutoffFreq ?? 0)}Hz)`;
  if (step.type === 'highPassFFT') return `High Pass (${fmtHz(step.cutoffFreq ?? 0)}Hz)`;
  if (step.type === 'notchFFT') return `Notch (${fmtHz(step.centerFreq ?? 0)}Hz)`;
  return step.type;
}

export function renderPipelineList(): void {
  if (!pipelineList) return;
  pipelineList.replaceChildren();

  if (chkSyncTabs) chkSyncTabs.checked = State.isGlobalScope();

  const pipeline = State.getPipeline();
  if (pipeline.length > 0 && !pipeline.some((p) => p.id === State.ui.selectedStepId)) {
    State.ui.selectedStepId = pipeline[0].id;
  }

  pipeline.forEach((step, index) => {
    const el = document.createElement('div');
    el.className = cx(
      ui.pipelineStep,
      step.id === State.ui.selectedStepId && ui.pipelineStepSelected,
      step.enabled === false && ui.pipelineStepDisabled
    );
    el.setAttribute('role', 'option');
    el.tabIndex = 0;
    el.setAttribute('aria-selected', step.id === State.ui.selectedStepId ? 'true' : 'false');

    const enable = document.createElement('input');
    enable.type = 'checkbox';
    enable.className = 'mr-2 h-4 w-4 accent-accent';
    enable.title = 'Enable or bypass this step';
    enable.setAttribute('aria-label', `Enable ${describeStep(step)}`);
    enable.checked = step.enabled !== false;
    enable.addEventListener('click', (event) => event.stopPropagation());
    enable.addEventListener('change', (event) => {
      event.stopPropagation();
      State.updateStepParams(step.id, { enabled: enable.checked });
      renderPipelineList();
      updateParamEditor();
      runPipelineAndRender();
    });

    const num = document.createElement('span');
    num.className = ui.stepNum;
    num.textContent = String(index + 1);

    const label = document.createElement('span');
    label.className = ui.stepDesc;
    label.textContent = describeStep(step);

    el.append(enable, num, label);

    const select = () => {
      State.ui.selectedStepId = step.id;
      renderPipelineList();
      updateParamEditor();
    };

    el.addEventListener('click', select);
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        select();
      }
    });

    pipelineList.appendChild(el);
  });
}

export function updateParamEditor(): void {
  if (!paramPanel) return;
  const step = State.getSelectedStep();
  if (!step) {
    paramPanel.classList.add('pointer-events-none', 'opacity-30');
    if (filterTypeDisplay) filterTypeDisplay.textContent = 'No Filter Selected';
    return;
  }

  paramPanel.classList.remove('pointer-events-none', 'opacity-30');
  if (filterTypeDisplay) filterTypeDisplay.textContent = FILTER_NAMES[step.type];

  const type = step.type;
  const isTime = ['movingAverage', 'savitzkyGolay', 'median', 'gaussian'].includes(type);
  const isFreq = ['lowPassFFT', 'highPassFFT'].includes(type);
  const isNotch = type === 'notchFFT';

  if (type === 'nullFilter') {
    [grpWindow, grpPoly, grpIters, grpAlpha, grpSigma, grpDecay, grpFreq, grpSlope, grpQ, grpBW]
      .forEach((group) => setVisible(group, false));
    paramPanel.classList.add('pointer-events-none', 'opacity-30');
    return;
  }

  setVisible(grpWindow, isTime);
  setVisible(grpPoly, type === 'savitzkyGolay');
  setVisible(grpIters, type === 'savitzkyGolay');
  setVisible(grpAlpha, type === 'iir');
  setVisible(grpSigma, type === 'gaussian');
  setVisible(grpDecay, type === 'startStopNorm');
  setVisible(grpFreq, isFreq || isNotch);
  setVisible(grpSlope, isFreq);
  setVisible(grpQ, isFreq);
  setVisible(grpBW, isNotch);

  const lblFreq = document.querySelector('label[for="param-freq"]');
  if (lblFreq) lblFreq.textContent = isNotch ? 'Center Frequency' : 'Cutoff Frequency';

  const setVal = (inp: HTMLInputElement | null, slider: HTMLInputElement | null, val: number | string) => {
    const text = String(val);
    if (inp) inp.value = text;
    if (slider) slider.value = text;
  };

  if (step.windowSize != null) setVal(inputWindow, sliderWindow, step.windowSize);
  if (step.polyOrder != null) setVal(inputPoly, sliderPoly, step.polyOrder);
  if (step.alpha != null) setVal(inputAlpha, sliderAlpha, step.alpha);
  if (step.sigma != null) setVal(inputSigma, sliderSigma, step.sigma);
  if (step.iterations != null) setVal(inputIters, sliderIters, step.iterations);

  const startLen = step.startLength ?? step.decayLength;
  const endLen = step.endLength ?? step.decayLength;
  if (startLen !== undefined) setVal(inputStartDecay, sliderStartDecay, startLen);
  if (endLen !== undefined) setVal(inputEndDecay, sliderEndDecay, endLen);
  if (chkApplyStart) chkApplyStart.checked = step.applyStart !== false;
  if (chkApplyEnd) chkApplyEnd.checked = step.applyEnd !== false;
  if (chkAutoOffset) chkAutoOffset.checked = step.autoOffset ?? false;
  if (inputStartOffset) inputStartOffset.value = String(step.startOffset ?? 0);
  if (inputStartOffset && chkAutoOffset) inputStartOffset.disabled = chkAutoOffset.checked;
  if (inputAutoOffsetPoints) inputAutoOffsetPoints.value = String(step.autoOffsetPoints ?? 200);
  if (step.slope != null) setVal(inputSlope, sliderSlope, step.slope);
  if (step.qFactor != null) setVal(inputQ, sliderQ, step.qFactor);

  const setUnitInput = (hzValue: number, inputEl: HTMLInputElement | null, unitEl: HTMLSelectElement | null) => {
    if (!inputEl || !unitEl) return;
    if (hzValue >= 1e9) {
      inputEl.value = String(hzValue / 1e9);
      unitEl.value = '1000000000';
    } else if (hzValue >= 1e6) {
      inputEl.value = String(hzValue / 1e6);
      unitEl.value = '1000000';
    } else if (hzValue >= 1e3) {
      inputEl.value = String(hzValue / 1e3);
      unitEl.value = '1000';
    } else {
      inputEl.value = String(hzValue);
      unitEl.value = '1';
    }
  };

  if (step.cutoffFreq) setUnitInput(step.cutoffFreq, inputFreq, selFreqUnit);
  if (step.centerFreq) setUnitInput(step.centerFreq, inputFreq, selFreqUnit);
  if (step.bandwidth) setUnitInput(step.bandwidth, inputBW, selBWUnit);
}

export function showAddStepMenu(): void {
  const html = `
    <h3 class="${ui.modalTitle}">Add Filter Step</h3>
    <div class="grid gap-2.5">
      <div class="mb-1 border-b border-line pb-2.5">
        <small class="mb-2 block text-muted">Time Domain</small>
        <button type="button" class="${ui.addOpt}" data-type="movingAverage">Moving Average</button>
        <button type="button" class="${ui.addOpt}" data-type="savitzkyGolay">Savitzky-Golay</button>
        <button type="button" class="${ui.addOpt}" data-type="median">Median (Despeckle)</button>
        <button type="button" class="${ui.addOpt}" data-type="iir">IIR Low Pass</button>
        <button type="button" class="${ui.addOpt}" data-type="gaussian">Gaussian</button>
        <button type="button" class="${ui.addOpt}" data-type="startStopNorm">Start/Stop Norm</button>
      </div>
      <div>
        <small class="mb-2 block text-muted">Frequency Domain (FFT)</small>
        <button type="button" class="${ui.addOpt}" data-type="lowPassFFT">Low Pass</button>
        <button type="button" class="${ui.addOpt}" data-type="highPassFFT">High Pass</button>
        <button type="button" class="${ui.addOpt}" data-type="notchFFT">Notch Filter</button>
      </div>
    </div>
  `;
  const modal = createModal(html);
  modal.querySelectorAll<HTMLButtonElement>('[data-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const type = btn.getAttribute('data-type') as FilterType | null;
      if (!type) return;
      State.addStep(type);
      modal.parentElement?.remove();
      renderPipelineList();
      updateParamEditor();
      runPipelineAndRender();
    });
  });
}
