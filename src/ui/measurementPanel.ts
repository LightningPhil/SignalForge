import { AnalysisEngine } from '../analysis/analysisEngine';
import { Measurements, type MeasurementResult } from '../analysis/measurements';
import { debounce, formatSeconds, selectionKey, seriesSignature } from '../app/utils';
import { State } from '../state';
import type { AnalysisSeries, MeasurementPreset } from '../types';
import { ui } from './classes';

const PRESETS: Record<MeasurementPreset, { label: string; metrics: string[] }> = {
  general: { label: 'General', metrics: ['mean', 'rms', 'peakToPeak', 'frequencyHz', 'period', 'min', 'max'] },
  power: { label: 'Power Electronics', metrics: ['riseTime', 'fallTime', 'overshootPct', 'undershootPct', 'dutyCycle', 'peakToPeak', 'frequencyHz'] },
  pulsed: { label: 'Pulsed', metrics: ['area', 'absArea', 'peakTime', 'valleyTime', 'rms', 'mean'] }
};

const LABELS: Record<string, string> = {
  mean: 'Mean',
  rms: 'RMS',
  peakToPeak: 'Peak-to-Peak',
  frequencyHz: 'Frequency',
  period: 'Period',
  min: 'Minimum',
  max: 'Maximum',
  stddev: 'Std Dev',
  median: 'Median',
  dutyCycle: 'Duty Cycle',
  riseTime: 'Rise Time',
  fallTime: 'Fall Time',
  overshootPct: 'Overshoot',
  undershootPct: 'Undershoot',
  area: 'Area (∫y·dt)',
  absArea: 'Abs Area (∫|y|·dt)',
  peakTime: 'Peak Time',
  valleyTime: 'Valley Time'
};

function formatNumber(value: number | null | undefined, key: string): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (key === 'dutyCycle') return `${(value * 100).toFixed(2)} %`;
  if (key === 'overshootPct' || key === 'undershootPct') return `${value.toFixed(2)} %`;
  if (['riseTime', 'fallTime', 'peakTime', 'valleyTime', 'period'].includes(key)) return formatSeconds(value);
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 0.001 || abs >= 100000)) return value.toExponential(3);
  return Number(value).toFixed(4).replace(/\.0+$/, '').replace(/\.([0-9]*?)0+$/, '.$1');
}

function formatSelection(selection: MeasurementResult['selection'] & { xMin?: number | null; xMax?: number | null }): string {
  if (!selection || selection.i0 === null || selection.i1 === null) return 'Full record';
  const timeLabel = (selection.xMin != null && selection.xMax != null)
    ? ` (${formatSeconds(selection.xMin)} → ${formatSeconds(selection.xMax)})`
    : '';
  return `Indices ${selection.i0}–${selection.i1}${timeLabel}`;
}

function renderWarnings(listEl: HTMLElement | null, warnings: string[] = []): void {
  if (!listEl) return;
  if (!warnings.length) {
    listEl.innerHTML = '';
    listEl.classList.add('hidden');
    return;
  }
  listEl.classList.remove('hidden');
  listEl.innerHTML = warnings.map((w) => `<li>${w}</li>`).join('');
}

export const MeasurementPanel = {
  currentPreset: 'general' as MeasurementPreset,
  lastSeries: null as AnalysisSeries | null,
  cache: new Map<string, MeasurementResult>(),
  lastSignature: null as string | null,
  rowsEl: null as HTMLElement | null,
  selectionEl: null as HTMLElement | null,
  traceLabelEl: null as HTMLElement | null,
  presetSelect: null as HTMLSelectElement | null,
  summaryEl: null as HTMLElement | null,
  warningList: null as HTMLElement | null,
  triggerRefresh: (() => {}) as () => void,

  init(): void {
    const cfg = State.ensureAnalysisConfig();
    this.currentPreset = cfg.measurementPreset || 'general';
    this.rowsEl = document.getElementById('measurement-rows');
    this.selectionEl = document.getElementById('measurement-selection');
    this.traceLabelEl = document.getElementById('measurement-trace');
    this.presetSelect = document.getElementById('measurement-preset') as HTMLSelectElement | null;
    this.summaryEl = document.getElementById('measurement-summary');
    this.warningList = document.getElementById('measurement-warnings');
    this.triggerRefresh = debounce(() => this.refresh(), 80);

    if (this.presetSelect) {
      this.presetSelect.innerHTML = Object.entries(PRESETS)
        .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
        .join('');
      this.presetSelect.value = this.currentPreset;
      this.presetSelect.addEventListener('change', () => {
        this.currentPreset = this.presetSelect?.value as MeasurementPreset;
        State.ensureAnalysisConfig().measurementPreset = this.currentPreset;
        this.refresh();
      });
    }

    AnalysisEngine.onSelectionChange(debounce(() => this.triggerRefresh(), 50));
  },

  setSeries(series: AnalysisSeries | null): void {
    if (!series) {
      this.clear();
      return;
    }
    const sourceLabel = (!series.isMath && series.filteredY?.length) ? 'filtered' : 'raw';
    const signature = seriesSignature(series, sourceLabel);
    if (signature !== this.lastSignature) {
      this.cache.clear();
      this.lastSignature = signature;
    }
    this.lastSeries = series;
    this.triggerRefresh();
  },

  clear(): void {
    this.lastSeries = null;
    this.cache.clear();
    this.lastSignature = null;
    this.renderEmpty();
  },

  refresh(): void {
    const cfgPreset = State.ensureAnalysisConfig().measurementPreset;
    if (cfgPreset && cfgPreset !== this.currentPreset) {
      this.currentPreset = cfgPreset;
      if (this.presetSelect) this.presetSelect.value = cfgPreset;
    }
    if (!this.lastSeries) {
      this.renderEmpty();
      return;
    }

    const selection = State.getAnalysisSelection();
    const ySource = (!this.lastSeries.isMath && this.lastSeries.filteredY?.length)
      ? this.lastSeries.filteredY
      : this.lastSeries.rawY;
    const cacheKey = `${seriesSignature(this.lastSeries, ySource === this.lastSeries.filteredY ? 'filtered' : 'raw')}|${selectionKey(selection)}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.render(cached, this.lastSeries.seriesName);
      return;
    }

    const results = Measurements.compute(
      { t: this.lastSeries.rawX, y: ySource, selection },
      { edgeThresholds: { lowFraction: 0.1, highFraction: 0.9 } }
    );
    this.cache.set(cacheKey, results);
    this.render(results, this.lastSeries.seriesName);
  },

  renderEmpty(): void {
    if (this.traceLabelEl) this.traceLabelEl.textContent = 'No trace selected';
    if (this.selectionEl) this.selectionEl.textContent = 'Load data to view measurements';
    if (this.rowsEl) this.rowsEl.innerHTML = '';
    if (this.summaryEl) this.summaryEl.textContent = '';
    renderWarnings(this.warningList, []);
  },

  render(results: MeasurementResult, traceLabel: string): void {
    if (this.traceLabelEl) this.traceLabelEl.textContent = traceLabel;
    if (this.selectionEl) {
      this.selectionEl.textContent = formatSelection({
        ...results.selection,
        xMin: State.getAnalysisSelection()?.xMin,
        xMax: State.getAnalysisSelection()?.xMax
      });
    }

    const preset = PRESETS[this.currentPreset] || PRESETS.general;
    if (this.rowsEl) {
      this.rowsEl.innerHTML = preset.metrics.map((key) => `
        <tr>
          <td class="${ui.analysisTableCell}">${LABELS[key] || key}</td>
          <td class="${ui.analysisTableCell} text-right font-mono">${formatNumber(results.metrics[key], key)}</td>
        </tr>
      `).join('');
    }

    if (this.summaryEl) {
      const duration = results.meta.duration !== null ? formatSeconds(results.meta.duration) : 'n/a';
      this.summaryEl.textContent = `${results.meta.sampleCount || 0} samples, span ${duration}`;
    }
    renderWarnings(this.warningList, results.warnings);
  }
};
