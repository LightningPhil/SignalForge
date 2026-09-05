import { AnalysisEngine } from '../analysis/analysisEngine';
import { CrossChannel, type DelayEstimate, type TransferFunctionResult } from '../analysis/crossChannel';
import { applyTraceSampleOffset } from '../app/traceOffset';
import { triggerGraphUpdateOnly } from '../app/dataPipeline';
import { getAlignedSeriesForColumn, getRawSeries } from '../app/traceData';
import { State } from '../state';
import { escapeHtml, renderWarningList } from './uiHelpers';

export interface SystemResult {
  input: string;
  output: string;
  delaySeconds: number;
  delaySamples: number;
  correlationPeak: number;
  confidence: number;
  frf: TransferFunctionResult;
}

let latestResult: SystemResult | null = null;
let applyBtn: HTMLButtonElement | null = null;

function populateSelectOptions(): void {
  const input = document.getElementById('system-input') as HTMLSelectElement | null;
  const output = document.getElementById('system-output') as HTMLSelectElement | null;
  if (!input || !output) return;
  const headers = (State.data.headers || []).filter((h) => h && h !== State.data.timeColumn);
  const mathNames = (State.config.mathDefinitions || []).map((d) => d.name);
  const opts = [...headers, ...mathNames]
    .map((h) => `<option value="${escapeHtml(h)}">${escapeHtml(h)}</option>`)
    .join('');
  input.innerHTML = `<option value="auto">Auto</option>${opts}`;
  output.innerHTML = `<option value="auto">Auto</option>${opts}`;
  const analysis = State.ensureAnalysisConfig();
  input.value = analysis.systemInput || 'auto';
  output.value = analysis.systemOutput || 'auto';
}

function renderWarnings(list: string[] = []): void {
  renderWarningList(document.getElementById('system-warnings'), list);
}

function formatNumber(value: number | null | undefined, digits = 3): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 0.001 || abs >= 1e6)) return value.toExponential(3);
  return value.toFixed(digits);
}

function renderFrfTable(frf: TransferFunctionResult | null): void {
  const el = document.getElementById('system-frf-table');
  if (!el) return;
  if (!frf?.freq?.length) {
    el.innerHTML = '';
    return;
  }
  let peakIdx = 0;
  let peakMag = -Infinity;
  let coherenceSum = 0;
  let coherenceCount = 0;
  for (let i = 1; i < frf.magnitudeDb.length; i += 1) {
    const mag = frf.magnitudeDb[i];
    if (Number.isFinite(mag) && mag > peakMag) {
      peakMag = mag;
      peakIdx = i;
    }
    const coh = frf.coherence[i];
    if (Number.isFinite(coh)) {
      coherenceSum += coh;
      coherenceCount += 1;
    }
  }
  const meanCoh = coherenceCount ? coherenceSum / coherenceCount : null;
  el.innerHTML = `
    <tr><td class="border-b border-line px-1.5 py-1">Peak |H(f)|</td><td class="border-b border-line px-1.5 py-1">${formatNumber(peakMag, 2)} dB @ ${formatNumber(frf.freq[peakIdx])} Hz</td></tr>
    <tr><td class="border-b border-line px-1.5 py-1">Phase at peak</td><td class="border-b border-line px-1.5 py-1">${formatNumber(frf.phaseDeg[peakIdx], 1)}°</td></tr>
    <tr><td class="border-b border-line px-1.5 py-1">Coherence at peak</td><td class="border-b border-line px-1.5 py-1">${formatNumber(frf.coherence[peakIdx], 3)}</td></tr>
    <tr><td class="border-b border-line px-1.5 py-1">Mean coherence</td><td class="border-b border-line px-1.5 py-1">${formatNumber(meanCoh, 3)}</td></tr>
  `;
}

function renderSummary(
  payload: {
    delaySeconds?: number;
    correlationPeak?: number;
    confidence?: number;
    input?: string;
    output?: string;
    warnings?: string[];
    frf?: TransferFunctionResult | null;
  } | null
): void {
  const el = document.getElementById('system-summary');
  if (!el) return;
  if (!payload) {
    el.textContent = 'Select input/output channels to compute FRF.';
    renderFrfTable(null);
    renderWarnings([]);
    return;
  }
  const delayText = Number.isFinite(payload.delaySeconds)
    ? `${(payload.delaySeconds as number).toExponential(3)} s`
    : 'N/A';
  const corrText = Number.isFinite(payload.correlationPeak) ? (payload.correlationPeak as number).toFixed(3) : 'N/A';
  const confText = Number.isFinite(payload.confidence) ? `, conf ${(payload.confidence as number).toFixed(2)}` : '';
  el.textContent = `${payload.input} → ${payload.output}: delay ${delayText}, corr ${corrText}${confText}`;
  renderFrfTable(payload.frf || null);
  renderWarnings(payload.warnings || []);
}

let pendingCompute = false;

function panelVisible(): boolean {
  const tab = document.getElementById('tab-spectral');
  return !tab || !tab.classList.contains('hidden');
}

/**
 * The System/Bode estimate re-reads two full columns (memoised per pipeline run) and runs a
 * cross-correlation plus Welch FRF on the main thread. While its sidebar tab is hidden the work is
 * deferred and performed once when the tab is shown, so pipeline runs and selection changes on other
 * tabs do not pay for it.
 */
function computeSystem(): void {
  if (!panelVisible()) {
    pendingCompute = true;
    return;
  }
  pendingCompute = false;
  const analysis = State.ensureAnalysisConfig();
  const headers = (State.data.headers || []).filter((h) => h && h !== State.data.timeColumn);
  const selectedInput =
    (document.getElementById('system-input') as HTMLSelectElement | null)?.value === 'auto'
      ? headers[0]
      : (document.getElementById('system-input') as HTMLSelectElement | null)?.value;
  const selectedOutput =
    (document.getElementById('system-output') as HTMLSelectElement | null)?.value === 'auto'
      ? headers[1] || headers[0]
      : (document.getElementById('system-output') as HTMLSelectElement | null)?.value;

  if (!selectedInput || !selectedOutput || selectedInput === selectedOutput) {
    latestResult = null;
    renderSummary(null);
    if (applyBtn) applyBtn.disabled = true;
    return;
  }

  const rawX = getRawSeries(selectedInput).rawX;
  const inputSeries = getAlignedSeriesForColumn(selectedInput, rawX);
  const outputSeries = getAlignedSeriesForColumn(selectedOutput, rawX);
  if (!inputSeries || !outputSeries) {
    latestResult = null;
    renderSummary(null);
    return;
  }

  const selection = analysis.systemSelectionOnly === false ? null : State.getAnalysisSelection();
  const inputY = inputSeries.isMath ? inputSeries.rawY : inputSeries.filteredY || inputSeries.rawY;
  const outputY = outputSeries.isMath ? outputSeries.rawY : outputSeries.filteredY || outputSeries.rawY;
  const inputQuality = inputSeries.isMath
    ? inputSeries.rawQuality
    : inputSeries.filteredQuality || inputSeries.rawQuality;
  const outputQuality = outputSeries.isMath
    ? outputSeries.rawQuality
    : outputSeries.filteredQuality || outputSeries.rawQuality;
  const delay: DelayEstimate = CrossChannel.estimateDelay(outputSeries.time, inputY, outputY, {
    selection,
    maxLagSeconds: analysis.systemMaxLagSeconds,
    inputQuality,
    outputQuality
  });
  const time = inputSeries.time.length <= outputSeries.time.length ? inputSeries.time : outputSeries.time;
  const frf = CrossChannel.computeTransferFunction(inputY, outputY, time, {
    selection,
    windowType: analysis.fftWindow,
    detrend: analysis.fftDetrend,
    zeroPadMode: analysis.fftZeroPad,
    zeroPadFactor: analysis.fftZeroPadFactor,
    inputQuality,
    outputQuality
  });

  latestResult = {
    input: selectedInput,
    output: selectedOutput,
    delaySeconds: delay.delaySeconds,
    delaySamples: delay.delaySamples,
    correlationPeak: delay.correlationPeak,
    confidence: delay.confidence,
    frf
  };

  renderSummary({
    input: selectedInput,
    output: selectedOutput,
    delaySeconds: delay.delaySeconds,
    correlationPeak: delay.correlationPeak,
    confidence: delay.confidence,
    warnings: [...(delay.warnings || []), ...(frf.warnings || [])],
    frf
  });

  if (applyBtn) applyBtn.disabled = !Number.isFinite(latestResult.confidence) || latestResult.confidence < 0.6;
}

export const SystemPanel = {
  init(): void {
    applyBtn = document.getElementById('system-apply-alignment') as HTMLButtonElement | null;
    populateSelectOptions();
    const analysis = State.ensureAnalysisConfig();
    const useSelection = document.getElementById('system-use-selection') as HTMLInputElement | null;
    const maxLag = document.getElementById('system-max-lag') as HTMLInputElement | null;
    const input = document.getElementById('system-input') as HTMLSelectElement | null;
    const output = document.getElementById('system-output') as HTMLSelectElement | null;

    if (useSelection) {
      useSelection.checked = analysis.systemSelectionOnly !== false;
      useSelection.addEventListener('change', () => {
        State.ensureAnalysisConfig().systemSelectionOnly = useSelection.checked;
        computeSystem();
      });
    }
    if (maxLag) {
      maxLag.value = analysis.systemMaxLagSeconds != null ? String(analysis.systemMaxLagSeconds) : '';
      maxLag.addEventListener('input', () => {
        const val = parseFloat(maxLag.value);
        State.ensureAnalysisConfig().systemMaxLagSeconds = Number.isFinite(val) ? val : null;
        computeSystem();
      });
    }
    input?.addEventListener('change', () => {
      State.ensureAnalysisConfig().systemInput = input.value || 'auto';
      computeSystem();
    });
    output?.addEventListener('change', () => {
      State.ensureAnalysisConfig().systemOutput = output.value || 'auto';
      computeSystem();
    });
    applyBtn?.addEventListener('click', () => {
      if (!latestResult || latestResult.confidence < 0.6) return;
      applyTraceSampleOffset(latestResult.output, -(latestResult.delaySamples || 0));
      AnalysisEngine.notifySelection(State.getAnalysisSelection());
      triggerGraphUpdateOnly();
      computeSystem();
    });
    AnalysisEngine.onSelectionChange(() => computeSystem());
    document.querySelector<HTMLButtonElement>('.sidebar-tab[data-tab="spectral"]')?.addEventListener('click', () => {
      if (pendingCompute) computeSystem();
    });
  },

  refreshFromState(): void {
    populateSelectOptions();
    computeSystem();
  },

  getResult(): SystemResult | null {
    return latestResult;
  }
};
