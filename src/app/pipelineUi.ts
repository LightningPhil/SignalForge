import { State } from '../state';
import type { FilterStep, FilterType } from '../types';
import { cx, ui } from '../ui/classes';
import { closeModal, createModal, escapeHtml } from '../ui/uiHelpers';
import { runPipelineAndRender } from './dataPipeline';
import { elements } from './domElements';

const {
  pipelineList,
  btnUndoPipeline,
  btnRedoPipeline,
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
  inputSlope,
  sliderSlope,
  inputBW,
  selBWUnit,
  inputFilterOrder,
  selProcessingMode,
  inputFirTransition,
  selFirTransitionUnit,
  inputFirRipple,
  inputFirAttenuation,
  firDesignSummary,
  inputHarmonicCount,
  grpWindow,
  grpPoly,
  grpAlpha,
  grpSigma,
  grpIters,
  grpDecay,
  grpRegionReference,
  grpFreq,
  grpSlope,
  grpBW,
  grpIirAdvanced,
  grpIirOrder,
  grpFirAdvanced,
  grpHarmonicCount,
  chkSyncTabs
} = elements;

const FILTER_NAMES: Record<FilterType, string> = {
  movingAverage: 'Moving Average',
  savitzkyGolay: 'Savitzky-Golay',
  median: 'Median',
  iir: 'One-Pole IIR Smoother',
  gaussian: 'Gaussian',
  startStopNorm: 'Start/Stop Normalisation',
  lowPassFFT: 'FFT Low Pass',
  highPassFFT: 'FFT High Pass',
  notchFFT: 'FFT Notch',
  firLowPass: 'Kaiser FIR Low Pass',
  firHighPass: 'Kaiser FIR High Pass',
  firBandPass: 'Kaiser FIR Band Pass',
  firBandStop: 'Kaiser FIR Band Stop',
  butterworthLowPass: 'Butterworth IIR Low Pass',
  butterworthHighPass: 'Butterworth IIR High Pass',
  butterworthBandPass: 'Butterworth IIR Band Pass',
  iirNotch: 'IIR Notch',
  iirComb: 'IIR Comb Notch',
  hampel: 'Hampel Deglitch',
  waveletDenoise: 'Wavelet Denoise',
  baselineSubtract: 'Marker/Region Baseline Subtract',
  timeGate: 'Marker/Region Time Gate',
  artifactBlank: 'Marker/Region Artifact Blank',
  referenceSubtract: 'Reference/Common-Mode Subtract',
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

/**
 * Clamps an integer-valued control and rounds it to the nearest multiple of `multiple` (1 for plain
 * integers). The coerced value is written back so the user sees exactly what will be applied and
 * the core validator (which rejects non-integers and off-grid values) is never handed a rejected
 * value from the UI.
 */
function clampInteger(inputEl: HTMLInputElement | null, min: number, max: number, multiple = 1): number | null {
  const rawVal = getNumericValue(inputEl);
  if (rawVal === null || !inputEl) return null;
  let val = Math.round(rawVal / multiple) * multiple;
  if (val < min) val = min;
  if (val > max) val = max;
  if (String(val) !== inputEl.value.trim()) inputEl.value = String(val);
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
  const isWindowed = ['movingAverage', 'savitzkyGolay', 'median', 'gaussian', 'hampel'].includes(type);
  const isFir = ['firLowPass', 'firHighPass', 'firBandPass', 'firBandStop'].includes(type);
  const isFreq = [
    'lowPassFFT',
    'highPassFFT',
    'firLowPass',
    'firHighPass',
    'butterworthLowPass',
    'butterworthHighPass'
  ].includes(type);
  const isFftShape = ['lowPassFFT', 'highPassFFT'].includes(type);
  const isCenterBandwidth = [
    'notchFFT',
    'firBandPass',
    'firBandStop',
    'butterworthBandPass',
    'iirNotch',
    'iirComb'
  ].includes(type);
  const isDesignedIir = [
    'butterworthLowPass',
    'butterworthHighPass',
    'butterworthBandPass',
    'iirNotch',
    'iirComb'
  ].includes(type);
  if (isWindowed) {
    const maximumWindow =
      type === 'median' || type === 'hampel' ? 501 : type === 'savitzkyGolay' || type === 'gaussian' ? 1001 : 9999;
    const minimumWindow = type === 'savitzkyGolay' || type === 'gaussian' || type === 'hampel' ? 3 : 1;
    const windowVal = clampInteger(inputWindow, minimumWindow, maximumWindow);
    if (windowVal !== null) {
      if (type === 'gaussian') params.kernelSize = windowVal;
      else params.windowSize = windowVal;
    }
  }
  if (type === 'savitzkyGolay') {
    // The core requires polyOrder < windowSize (using the effective odd window).
    const windowSize = params.windowSize ?? step.windowSize ?? 21;
    const polyVal = clampInteger(inputPoly, 1, Math.min(10, Math.max(1, windowSize - 1)));
    if (polyVal !== null) params.polyOrder = polyVal;
    const iterVal = clampInteger(inputIters, 1, 16);
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
  if (type === 'hampel') {
    const threshold = clamp(inputSigma, 0.1, 20);
    if (threshold !== null) params.thresholdSigma = threshold;
  }
  if (type === 'waveletDenoise') {
    const levels = clampInteger(inputIters, 1, 20);
    if (levels !== null) params.waveletLevels = levels;
    const threshold = getNumericValue(inputSigma);
    params.waveletThreshold = threshold !== null && threshold >= 0 ? threshold : undefined;
  }
  if (type === 'startStopNorm') {
    const startDecayVal = clampInteger(inputStartDecay, 0, 10000);
    if (startDecayVal !== null) params.startLength = startDecayVal;
    const endDecayVal = clampInteger(inputEndDecay, 0, 10000);
    if (endDecayVal !== null) params.endLength = endDecayVal;
    if (chkApplyStart) params.applyStart = !!chkApplyStart.checked;
    if (chkApplyEnd) params.applyEnd = !!chkApplyEnd.checked;
    const startOffsetVal = getNumericValue(inputStartOffset);
    if (startOffsetVal !== null) params.startOffset = startOffsetVal;
    if (chkAutoOffset) params.autoOffset = !!chkAutoOffset.checked;
    const autoOffsetPointsVal = clampInteger(inputAutoOffsetPoints, 1, 100000);
    if (autoOffsetPointsVal !== null) params.autoOffsetPoints = autoOffsetPointsVal;
  }
  if (['baselineSubtract', 'timeGate', 'artifactBlank'].includes(type)) {
    params.regionMode = (selRegionMode?.value || 'selection') as FilterStep['regionMode'];
    params.regionMarker = inputRegionMarker?.value.trim() || '';
    params.startMarker = inputRegionStartMarker?.value.trim() || '';
    params.endMarker = inputRegionEndMarker?.value.trim() || '';
    const startTime = getNumericValue(inputRegionStartTime);
    const endTime = getNumericValue(inputRegionEndTime);
    const startIndex = clampInteger(inputRegionStartIndex, 0, 100_000_000);
    const endIndex = clampInteger(inputRegionEndIndex, 0, 100_000_000);
    if (startTime !== null) params.regionStartTime = startTime;
    if (endTime !== null) params.regionEndTime = endTime;
    if (startIndex !== null) params.regionStartIndex = startIndex;
    if (endIndex !== null) params.regionEndIndex = endIndex;
  }
  if (type === 'baselineSubtract') {
    params.baselineEstimator = (selBaselineEstimator?.value || 'median') as FilterStep['baselineEstimator'];
  }
  if (type === 'artifactBlank') {
    params.artifactMode = (selArtifactMode?.value || 'missing') as FilterStep['artifactMode'];
  }
  if (type === 'referenceSubtract') {
    params.referenceColumnId = selReferenceColumn?.value || '';
    const scale = getNumericValue(inputReferenceScale);
    if (scale !== null) params.referenceScale = scale;
  }

  if ((isFreq || isCenterBandwidth) && selFreqUnit) {
    const fMult = parseFloat(selFreqUnit.value);
    const rawFreq = getNumericValue(inputFreq);
    const fallbackHz = step.centerFreq || step.cutoffFreq || 0;
    const baseFreq = rawFreq !== null ? rawFreq : fallbackHz / fMult;
    const hz = baseFreq * fMult;
    if (isCenterBandwidth) params.centerFreq = hz;
    else params.cutoffFreq = hz;
  }

  if (isCenterBandwidth && selBWUnit) {
    const bMult = parseFloat(selBWUnit.value);
    const rawBW = getNumericValue(inputBW);
    const bw = rawBW !== null ? rawBW : (step.bandwidth || 0) / bMult;
    params.bandwidth = bw * bMult;
  }

  if (isFftShape) {
    // The core accepts only multiples of 6 dB/octave (whole Butterworth-shaped orders).
    const slopeVal = clampInteger(inputSlope, 6, 96, 6);
    if (slopeVal !== null) params.slope = slopeVal;
  }
  if (isFir) {
    const transitionMultiplier = parseFloat(selFirTransitionUnit?.value || '1');
    const transition = getNumericValue(inputFirTransition);
    if (transition !== null) params.transitionWidth = transition * transitionMultiplier;
    const ripple = clamp(inputFirRipple, 0.001, 6);
    if (ripple !== null) params.passbandRippleDb = ripple;
    const attenuation = clamp(inputFirAttenuation, 20, 160);
    if (attenuation !== null) params.stopbandAttenuationDb = attenuation;
  }
  if (isDesignedIir) {
    // Only the band-pass transformation doubles the prototype order, so only it requires an even
    // final order; low/high-pass Butterworth designs accept odd orders (a first-order section is added).
    const order = clampInteger(inputFilterOrder, 2, 12, type === 'butterworthBandPass' ? 2 : 1);
    if (order !== null) params.order = order;
  }
  if (isDesignedIir || isFir) {
    if (selProcessingMode) {
      params.processingMode = selProcessingMode.value === 'causal' ? 'causal' : 'zero-phase';
    }
  }
  if (type === 'iirComb') {
    const harmonicCount = clampInteger(inputHarmonicCount, 1, 100);
    if (harmonicCount !== null) params.harmonicCount = harmonicCount;
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
  if (step.type === 'iir') return `One-Pole IIR (smoothing α: ${step.alpha})`;
  if (step.type === 'gaussian') {
    return `Gaussian (σ: ${step.sigma}, kernel: ${step.kernelSize || 5})`;
  }
  if (step.type === 'startStopNorm') {
    const startLabel = step.applyStart === false ? 'Off' : (step.startLength ?? 0);
    const endLabel = step.applyEnd === false ? 'Off' : (step.endLength ?? 0);
    const autoLabel = step.autoOffset ? 'Auto' : `Offset ${step.startOffset ?? 0}`;
    return `Norm (${autoLabel}, Start: ${startLabel}, End: ${endLabel})`;
  }
  if (step.type === 'baselineSubtract') {
    return `Baseline (${step.regionMode}, ${step.baselineEstimator || 'median'})`;
  }
  if (step.type === 'timeGate') return `Time Gate (${step.regionMode})`;
  if (step.type === 'artifactBlank') {
    return `Artifact Blank (${step.regionMode}, ${step.artifactMode || 'missing'})`;
  }
  if (step.type === 'referenceSubtract') {
    return `Reference (${step.referenceColumnId || 'not selected'} × ${step.referenceScale ?? 1})`;
  }
  if (step.type === 'lowPassFFT') return `Low Pass (${fmtHz(step.cutoffFreq ?? 0)}Hz)`;
  if (step.type === 'highPassFFT') return `High Pass (${fmtHz(step.cutoffFreq ?? 0)}Hz)`;
  if (step.type === 'notchFFT') return `Notch (${fmtHz(step.centerFreq ?? 0)}Hz)`;
  if (step.type === 'firLowPass') {
    return `FIR LP (pass ${fmtHz(step.cutoffFreq ?? 0)}Hz, Δ ${fmtHz(step.transitionWidth ?? 0)}Hz)`;
  }
  if (step.type === 'firHighPass') {
    return `FIR HP (pass ${fmtHz(step.cutoffFreq ?? 0)}Hz, Δ ${fmtHz(step.transitionWidth ?? 0)}Hz)`;
  }
  if (step.type === 'firBandPass') {
    return `FIR BP (${fmtHz(step.centerFreq ?? 0)}Hz ± ${fmtHz((step.bandwidth ?? 0) / 2)}Hz)`;
  }
  if (step.type === 'firBandStop') {
    return `FIR BS (${fmtHz(step.centerFreq ?? 0)}Hz ± ${fmtHz((step.bandwidth ?? 0) / 2)}Hz)`;
  }
  if (step.type === 'butterworthLowPass') {
    return `Butterworth LP (${fmtHz(step.cutoffFreq ?? 0)}Hz, order ${step.order || 4})`;
  }
  if (step.type === 'butterworthHighPass') {
    return `Butterworth HP (${fmtHz(step.cutoffFreq ?? 0)}Hz, order ${step.order || 4})`;
  }
  if (step.type === 'butterworthBandPass') {
    return `Butterworth BP (${fmtHz(step.centerFreq ?? 0)}Hz ± ${fmtHz((step.bandwidth ?? 0) / 2)}Hz)`;
  }
  if (step.type === 'iirNotch') return `IIR Notch (${fmtHz(step.centerFreq ?? 0)}Hz)`;
  if (step.type === 'iirComb') return `IIR Comb (${fmtHz(step.centerFreq ?? 0)}Hz × ${step.harmonicCount || 10})`;
  if (step.type === 'hampel') return `Hampel (Win: ${step.windowSize}, ${step.thresholdSigma || 3}σ)`;
  if (step.type === 'waveletDenoise') return `Wavelet (${step.waveletLevels || 4} levels)`;
  return step.type;
}

export function renderPipelineList(): void {
  if (!pipelineList) return;
  if (btnUndoPipeline) btnUndoPipeline.disabled = State.pipelineUndoStack.length === 0;
  if (btnRedoPipeline) btnRedoPipeline.disabled = State.pipelineRedoStack.length === 0;
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
    const report = State.data.pipelineReport.find((entry) => entry.stepId === step.id);
    label.textContent = report
      ? `${describeStep(step)} · changed ${report.changedSamples}/${report.totalSamples}`
      : describeStep(step);
    if (report?.effectiveParameters) {
      label.title = [
        `Effective parameters: ${JSON.stringify(report.effectiveParameters)}`,
        ...(report.warnings || [])
      ].join('\n');
    }

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
  const isTime = ['movingAverage', 'savitzkyGolay', 'median', 'gaussian', 'hampel'].includes(type);
  const isFir = ['firLowPass', 'firHighPass', 'firBandPass', 'firBandStop'].includes(type);
  const isFreq = [
    'lowPassFFT',
    'highPassFFT',
    'firLowPass',
    'firHighPass',
    'butterworthLowPass',
    'butterworthHighPass'
  ].includes(type);
  const isFftShape = ['lowPassFFT', 'highPassFFT'].includes(type);
  const isCenterBandwidth = [
    'notchFFT',
    'firBandPass',
    'firBandStop',
    'butterworthBandPass',
    'iirNotch',
    'iirComb'
  ].includes(type);
  const isDesignedIir = [
    'butterworthLowPass',
    'butterworthHighPass',
    'butterworthBandPass',
    'iirNotch',
    'iirComb'
  ].includes(type);
  const isContextual = ['baselineSubtract', 'timeGate', 'artifactBlank', 'referenceSubtract'].includes(type);

  if (type === 'nullFilter') {
    [
      grpWindow,
      grpPoly,
      grpIters,
      grpAlpha,
      grpSigma,
      grpDecay,
      grpRegionReference,
      grpFreq,
      grpSlope,
      grpBW,
      grpIirAdvanced,
      grpFirAdvanced,
      grpHarmonicCount
    ].forEach((group) => setVisible(group, false));
    paramPanel.classList.add('pointer-events-none', 'opacity-30');
    return;
  }

  setVisible(grpWindow, isTime);
  setVisible(grpPoly, type === 'savitzkyGolay');
  setVisible(grpIters, type === 'savitzkyGolay' || type === 'waveletDenoise');
  setVisible(grpAlpha, type === 'iir');
  setVisible(grpSigma, type === 'gaussian' || type === 'hampel' || type === 'waveletDenoise');
  setVisible(grpDecay, type === 'startStopNorm');
  setVisible(grpRegionReference, isContextual);
  setVisible(grpFreq, isFreq || isCenterBandwidth);
  setVisible(grpSlope, isFftShape);
  setVisible(grpBW, isCenterBandwidth);
  setVisible(grpIirAdvanced, isDesignedIir || isFir);
  setVisible(grpIirOrder, isDesignedIir);
  setVisible(grpFirAdvanced, isFir);
  setVisible(grpHarmonicCount, type === 'iirComb');

  const lblFreq = document.querySelector('label[for="param-freq"]');
  if (lblFreq) {
    lblFreq.textContent = isCenterBandwidth
      ? 'Center / Fundamental Frequency'
      : isFir
        ? 'Passband Edge'
        : 'Cutoff Frequency';
  }
  const lblBandwidth = document.querySelector('label[for="param-bw"]');
  if (lblBandwidth) {
    lblBandwidth.textContent =
      type === 'firBandPass' ? 'Passband Width' : type === 'firBandStop' ? 'Stopband Width' : 'Bandwidth';
  }
  const lblWindow = document.querySelector('label[for="param-window"]');
  if (lblWindow) lblWindow.textContent = type === 'hampel' ? 'Hampel Window' : 'Window / Kernel';
  const lblSigma = document.querySelector('label[for="param-sigma"]');
  if (lblSigma) {
    lblSigma.textContent =
      type === 'hampel'
        ? 'Outlier Threshold (σ)'
        : type === 'waveletDenoise'
          ? 'Wavelet Threshold (blank = auto)'
          : 'Sigma';
  }
  const lblIters = document.querySelector('label[for="param-iters"]');
  if (lblIters) lblIters.textContent = type === 'waveletDenoise' ? 'Wavelet Levels' : 'Iterations';

  const setVal = (inp: HTMLInputElement | null, slider: HTMLInputElement | null, val: number | string) => {
    const text = String(val);
    if (inp) inp.value = text;
    if (slider) slider.value = text;
  };

  const minimumWindow = type === 'savitzkyGolay' || type === 'gaussian' || type === 'hampel' ? 3 : 1;
  if (inputWindow) inputWindow.min = String(minimumWindow);
  if (sliderWindow) sliderWindow.min = String(minimumWindow);
  if (type === 'gaussian' && step.kernelSize != null) {
    setVal(inputWindow, sliderWindow, step.kernelSize);
  } else if (step.windowSize != null) {
    setVal(inputWindow, sliderWindow, step.windowSize);
  }
  if (step.polyOrder != null) setVal(inputPoly, sliderPoly, step.polyOrder);
  if (step.alpha != null) setVal(inputAlpha, sliderAlpha, step.alpha);
  if (step.sigma != null) setVal(inputSigma, sliderSigma, step.sigma);
  if (step.iterations != null) setVal(inputIters, sliderIters, step.iterations);
  if (step.thresholdSigma != null) setVal(inputSigma, sliderSigma, step.thresholdSigma);
  if (step.waveletLevels != null) setVal(inputIters, sliderIters, step.waveletLevels);
  if (type === 'waveletDenoise') {
    const value = step.waveletThreshold == null ? '' : String(step.waveletThreshold);
    if (inputSigma) inputSigma.value = value;
    if (sliderSigma && value) sliderSigma.value = value;
  }
  if (selRegionMode) selRegionMode.value = step.regionMode || 'selection';
  if (inputRegionMarker) inputRegionMarker.value = step.regionMarker || '';
  if (inputRegionStartMarker) inputRegionStartMarker.value = step.startMarker || '';
  if (inputRegionEndMarker) inputRegionEndMarker.value = step.endMarker || '';
  if (inputRegionStartTime) inputRegionStartTime.value = String(step.regionStartTime ?? 0);
  if (inputRegionEndTime) inputRegionEndTime.value = String(step.regionEndTime ?? 1);
  if (inputRegionStartIndex) inputRegionStartIndex.value = String(step.regionStartIndex ?? 0);
  if (inputRegionEndIndex) inputRegionEndIndex.value = String(step.regionEndIndex ?? 1);
  if (selBaselineEstimator) {
    selBaselineEstimator.value = step.baselineEstimator || 'median';
    selBaselineEstimator.disabled = type !== 'baselineSubtract';
  }
  if (selArtifactMode) {
    selArtifactMode.value = step.artifactMode || 'missing';
    selArtifactMode.disabled = type !== 'artifactBlank';
  }
  if (selRegionMode) selRegionMode.disabled = type === 'referenceSubtract';
  [
    inputRegionMarker,
    inputRegionStartMarker,
    inputRegionEndMarker,
    inputRegionStartTime,
    inputRegionEndTime,
    inputRegionStartIndex,
    inputRegionEndIndex
  ].forEach((control) => {
    if (control) control.disabled = type === 'referenceSubtract';
  });
  if (selReferenceColumn) {
    const activeColumn = State.getActiveColumnId();
    const candidates = State.data.headers.filter(
      (header) => header !== State.data.timeColumn && header !== activeColumn
    );
    selReferenceColumn.innerHTML = [
      '<option value="">Select reference…</option>',
      ...candidates.map((header) => `<option value="${escapeHtml(header)}">${escapeHtml(header)}</option>`)
    ].join('');
    selReferenceColumn.value = step.referenceColumnId || '';
    selReferenceColumn.disabled = type !== 'referenceSubtract';
  }
  if (inputReferenceScale) {
    inputReferenceScale.value = String(step.referenceScale ?? 1);
    inputReferenceScale.disabled = type !== 'referenceSubtract';
  }
  if (inputFilterOrder) {
    inputFilterOrder.value = String(step.order || 4);
    inputFilterOrder.step = type === 'butterworthBandPass' ? '2' : '1';
  }
  if (selProcessingMode) {
    selProcessingMode.value = step.processingMode || 'zero-phase';
    const zeroPhaseOption = selProcessingMode.querySelector<HTMLOptionElement>('option[value="zero-phase"]');
    if (zeroPhaseOption) {
      zeroPhaseOption.textContent = isFir ? 'Centered zero-phase (one pass)' : 'Zero-phase (forward/backward)';
    }
  }
  if (inputFirRipple) inputFirRipple.value = String(step.passbandRippleDb ?? 0.1);
  if (inputFirAttenuation) inputFirAttenuation.value = String(step.stopbandAttenuationDb ?? 80);
  if (firDesignSummary) {
    const report = State.data.pipelineReport.find((entry) => entry.stepId === step.id);
    const effective = report?.effectiveParameters;
    firDesignSummary.textContent =
      isFir && effective?.tapCountMin
        ? `${effective.tapCountMin}${effective.tapCountMax !== effective.tapCountMin ? `–${effective.tapCountMax}` : ''} taps · Kaiser β ${Number(effective.kaiserBetaMax).toPrecision(5)} · achieved ripple ≤ ${Number(effective.achievedPassbandRippleDbMax).toPrecision(4)} dB · stopband ≥ ${Number(effective.achievedStopbandAttenuationDbMin).toPrecision(4)} dB`
        : 'Tap count and Kaiser beta are derived, bounded, and numerically verified against these specifications.';
  }
  if (inputHarmonicCount) inputHarmonicCount.value = String(step.harmonicCount || 10);

  const startLen = step.startLength;
  const endLen = step.endLength;
  if (startLen !== undefined) setVal(inputStartDecay, sliderStartDecay, startLen);
  if (endLen !== undefined) setVal(inputEndDecay, sliderEndDecay, endLen);
  if (chkApplyStart) chkApplyStart.checked = step.applyStart !== false;
  if (chkApplyEnd) chkApplyEnd.checked = step.applyEnd !== false;
  if (chkAutoOffset) chkAutoOffset.checked = step.autoOffset ?? false;
  if (inputStartOffset) inputStartOffset.value = String(step.startOffset ?? 0);
  if (inputStartOffset && chkAutoOffset) inputStartOffset.disabled = chkAutoOffset.checked;
  if (inputAutoOffsetPoints) inputAutoOffsetPoints.value = String(step.autoOffsetPoints ?? 200);
  if (step.slope != null) setVal(inputSlope, sliderSlope, step.slope);

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
  if (step.transitionWidth) {
    setUnitInput(step.transitionWidth, inputFirTransition, selFirTransitionUnit);
  }
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
        <button type="button" class="${ui.addOpt}" data-type="gaussian">Gaussian</button>
        <button type="button" class="${ui.addOpt}" data-type="hampel">Hampel Deglitch</button>
        <button type="button" class="${ui.addOpt}" data-type="waveletDenoise">Wavelet Denoise</button>
        <button type="button" class="${ui.addOpt}" data-type="startStopNorm">Start/Stop Norm</button>
      </div>
      <div class="mb-1 border-b border-line pb-2.5">
        <small class="mb-2 block text-muted">Frequency Domain (FFT)</small>
        <button type="button" class="${ui.addOpt}" data-type="lowPassFFT">Low Pass</button>
        <button type="button" class="${ui.addOpt}" data-type="highPassFFT">High Pass</button>
        <button type="button" class="${ui.addOpt}" data-type="notchFFT">Notch Filter</button>
      </div>
      <div class="mb-1 border-b border-line pb-2.5">
        <small class="mb-2 block text-muted">Marker / Region / Reference</small>
        <button type="button" class="${ui.addOpt}" data-type="baselineSubtract">Baseline Subtract</button>
        <button type="button" class="${ui.addOpt}" data-type="timeGate">Time Gate</button>
        <button type="button" class="${ui.addOpt}" data-type="artifactBlank">Artifact Blank / Interpolate</button>
        <button type="button" class="${ui.addOpt}" data-type="referenceSubtract">Reference/Common-Mode Subtract</button>
      </div>
      <div>
        <div class="mb-1 border-b border-line pb-2.5">
          <small class="mb-2 block text-muted">Designed FIR Filters</small>
          <button type="button" class="${ui.addOpt}" data-type="firLowPass">Kaiser FIR Low Pass</button>
          <button type="button" class="${ui.addOpt}" data-type="firHighPass">Kaiser FIR High Pass</button>
          <button type="button" class="${ui.addOpt}" data-type="firBandPass">Kaiser FIR Band Pass</button>
          <button type="button" class="${ui.addOpt}" data-type="firBandStop">Kaiser FIR Band Stop</button>
        </div>
        <small class="mb-2 block text-muted">IIR Filters</small>
        <button type="button" class="${ui.addOpt}" data-type="iir">One-Pole IIR Low Pass</button>
        <button type="button" class="${ui.addOpt}" data-type="butterworthLowPass">Butterworth Low Pass</button>
        <button type="button" class="${ui.addOpt}" data-type="butterworthHighPass">Butterworth High Pass</button>
        <button type="button" class="${ui.addOpt}" data-type="butterworthBandPass">Butterworth Band Pass</button>
        <button type="button" class="${ui.addOpt}" data-type="iirNotch">IIR Notch</button>
        <button type="button" class="${ui.addOpt}" data-type="iirComb">IIR Comb Notch</button>
      </div>
    </div>
  `;
  const modal = createModal(html);
  modal.querySelectorAll<HTMLButtonElement>('[data-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const type = btn.getAttribute('data-type') as FilterType | null;
      if (!type) return;
      State.addStep(type);
      closeModal(modal);
      renderPipelineList();
      updateParamEditor();
      runPipelineAndRender();
    });
  });
}

document.addEventListener('signalforge:pipeline-report', () => {
  renderPipelineList();
  updateParamEditor();
});
