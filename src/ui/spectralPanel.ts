import { AnalysisEngine } from '../analysis/analysisEngine';
import { SpectralMetrics, type SpectralSummary } from '../analysis/spectralMetrics';
import { debounce, selectionKey, seriesSignature } from '../app/utils';
import { triggerGraphUpdateOnly } from '../app/dataPipeline';
import { State } from '../state';
import type { AnalysisSeries, SpectrumResult } from '../types';
import { analysisWorkerClient } from '../workers/client';
import { ui } from './classes';

function formatNumber(val: number | null | undefined, digits = 3): string {
  if (val === null || val === undefined || Number.isNaN(val)) return '—';
  const abs = Math.abs(val);
  if (abs !== 0 && (abs < 0.001 || abs >= 1e6)) return val.toExponential(3);
  return Number(val)
    .toFixed(digits)
    .replace(/\.0+$/, '')
    .replace(/\.([0-9]*?)0+$/, '.$1');
}

function renderWarnings(el: HTMLElement | null, warnings: string[] = []): void {
  if (!el) return;
  if (!warnings.length) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML = warnings.map((w) => `<li>${w}</li>`).join('');
}

function autoSelectSource(series: AnalysisSeries): {
  values: number[];
  quality: Uint16Array | null;
  source: 'raw' | 'filtered';
} {
  const choice = State.ensureAnalysisConfig().fftSource || 'auto';
  if ((choice === 'filtered' || choice === 'auto') && series.filteredY?.length) {
    return { values: series.filteredY, quality: series.filteredQuality, source: 'filtered' };
  }
  return { values: series.rawY, quality: series.rawQuality, source: 'raw' };
}

export const SpectralPanel = {
  lastSeries: null as AnalysisSeries | null,
  cache: new Map<string, SpectralSummary>(),
  windowSelect: null as HTMLSelectElement | null,
  detrendSelect: null as HTMLSelectElement | null,
  zeroPadSelect: null as HTMLSelectElement | null,
  zeroPadFactor: null as HTMLInputElement | null,
  viewSelect: null as HTMLSelectElement | null,
  sourceSelect: null as HTMLSelectElement | null,
  peakCountInput: null as HTMLInputElement | null,
  peakProminenceInput: null as HTMLInputElement | null,
  harmonicToggle: null as HTMLInputElement | null,
  harmonicCountInput: null as HTMLInputElement | null,
  fundamentalInput: null as HTMLInputElement | null,
  spectrogramSize: null as HTMLInputElement | null,
  spectrogramOverlap: null as HTMLInputElement | null,
  spectrogramWindow: null as HTMLSelectElement | null,
  metaEl: null as HTMLElement | null,
  warningsEl: null as HTMLElement | null,
  peaksTable: null as HTMLElement | null,
  metricsTable: null as HTMLElement | null,
  triggerRefresh: (() => {}) as () => void,
  workerController: null as AbortController | null,
  workerGeneration: 0,

  init(): void {
    this.metaEl = document.getElementById('fft-meta');
    this.warningsEl = document.getElementById('fft-warnings');
    this.peaksTable = document.getElementById('fft-peaks-table');
    this.metricsTable = document.getElementById('fft-metrics-table');
    this.windowSelect = document.getElementById('fft-window') as HTMLSelectElement | null;
    this.detrendSelect = document.getElementById('fft-detrend') as HTMLSelectElement | null;
    this.zeroPadSelect = document.getElementById('fft-zero-pad') as HTMLSelectElement | null;
    this.zeroPadFactor = document.getElementById('fft-zero-factor') as HTMLInputElement | null;
    this.viewSelect = document.getElementById('fft-view') as HTMLSelectElement | null;
    this.sourceSelect = document.getElementById('fft-source') as HTMLSelectElement | null;
    this.peakCountInput = document.getElementById('fft-peak-count') as HTMLInputElement | null;
    this.peakProminenceInput = document.getElementById('fft-peak-prominence') as HTMLInputElement | null;
    this.harmonicToggle = document.getElementById('fft-show-harmonics') as HTMLInputElement | null;
    this.harmonicCountInput = document.getElementById('fft-harmonic-count') as HTMLInputElement | null;
    this.fundamentalInput = document.getElementById('fft-fundamental') as HTMLInputElement | null;
    this.spectrogramSize = document.getElementById('spectrogram-size') as HTMLInputElement | null;
    this.spectrogramOverlap = document.getElementById('spectrogram-overlap') as HTMLInputElement | null;
    this.spectrogramWindow = document.getElementById('spectrogram-window') as HTMLSelectElement | null;
    this.triggerRefresh = debounce(() => this.refresh(), 90);
    this.bindControls();
    AnalysisEngine.onSelectionChange(debounce(() => this.triggerRefresh(), 50));
  },

  bindControls(): void {
    const cfg = State.ensureAnalysisConfig();
    const bindSelect = (el: HTMLSelectElement | null, key: keyof typeof cfg, updateGraph = false) => {
      if (!el) return;
      el.value = String(cfg[key] ?? '');
      el.addEventListener('change', () => {
        (State.ensureAnalysisConfig() as unknown as Record<string, unknown>)[key] = el.value;
        if (updateGraph) triggerGraphUpdateOnly();
        this.refresh();
      });
    };

    bindSelect(this.windowSelect, 'fftWindow', true);
    bindSelect(this.detrendSelect, 'fftDetrend', true);
    bindSelect(this.zeroPadSelect, 'fftZeroPad', true);
    bindSelect(this.viewSelect, 'fftView', true);
    bindSelect(this.sourceSelect, 'fftSource', true);
    bindSelect(this.spectrogramWindow, 'spectrogramWindow', true);

    if (this.zeroPadFactor) {
      this.zeroPadFactor.value = String(cfg.fftZeroPadFactor);
      this.zeroPadFactor.addEventListener('input', () => {
        State.ensureAnalysisConfig().fftZeroPadFactor = Math.max(1, parseFloat(this.zeroPadFactor?.value || '1') || 1);
        triggerGraphUpdateOnly();
        this.refresh();
      });
    }
    if (this.peakCountInput) {
      this.peakCountInput.value = String(cfg.fftPeakCount);
      this.peakCountInput.addEventListener('input', () => {
        State.ensureAnalysisConfig().fftPeakCount = Math.max(1, parseInt(this.peakCountInput?.value || '1', 10) || 1);
        triggerGraphUpdateOnly();
        this.refresh();
      });
    }
    if (this.peakProminenceInput) {
      this.peakProminenceInput.value = String(cfg.fftPeakProminence);
      this.peakProminenceInput.addEventListener('input', () => {
        State.ensureAnalysisConfig().fftPeakProminence = Math.max(
          0,
          parseFloat(this.peakProminenceInput?.value || '0') || 0
        );
        triggerGraphUpdateOnly();
        this.refresh();
      });
    }
    if (this.harmonicToggle) {
      this.harmonicToggle.checked = cfg.fftShowHarmonics !== false;
      this.harmonicToggle.addEventListener('change', () => {
        State.ensureAnalysisConfig().fftShowHarmonics = !!this.harmonicToggle?.checked;
        triggerGraphUpdateOnly();
        this.refresh();
      });
    }
    if (this.harmonicCountInput) {
      this.harmonicCountInput.value = String(cfg.fftHarmonicCount);
      this.harmonicCountInput.addEventListener('input', () => {
        State.ensureAnalysisConfig().fftHarmonicCount = Math.max(
          1,
          parseInt(this.harmonicCountInput?.value || '1', 10) || 1
        );
        triggerGraphUpdateOnly();
        this.refresh();
      });
    }
    if (this.fundamentalInput) {
      if (cfg.fftHarmonicFundamental) this.fundamentalInput.value = String(cfg.fftHarmonicFundamental);
      this.fundamentalInput.addEventListener('input', () => {
        const val = parseFloat(this.fundamentalInput?.value || '');
        State.ensureAnalysisConfig().fftHarmonicFundamental = Number.isFinite(val) ? val : null;
        triggerGraphUpdateOnly();
        this.refresh();
      });
    }
    if (this.spectrogramSize) {
      this.spectrogramSize.value = String(cfg.spectrogramSize);
      this.spectrogramSize.addEventListener('input', () => {
        State.ensureAnalysisConfig().spectrogramSize = Math.max(
          16,
          parseInt(this.spectrogramSize?.value || '512', 10) || 512
        );
        triggerGraphUpdateOnly();
      });
    }
    if (this.spectrogramOverlap) {
      this.spectrogramOverlap.value = String(cfg.spectrogramOverlap);
      this.spectrogramOverlap.addEventListener('input', () => {
        State.ensureAnalysisConfig().spectrogramOverlap = Math.min(
          0.95,
          Math.max(0, parseFloat(this.spectrogramOverlap?.value || '0.5') || 0.5)
        );
        triggerGraphUpdateOnly();
      });
    }
  },

  setSeries(series: AnalysisSeries | null): void {
    this.workerController?.abort();
    this.lastSeries = series;
    this.cache.clear();
    this.triggerRefresh();
  },

  clear(): void {
    this.workerController?.abort();
    this.workerController = null;
    this.lastSeries = null;
    this.cache.clear();
    if (this.metaEl) this.metaEl.textContent = 'Load data to view spectrum';
    if (this.peaksTable) this.peaksTable.innerHTML = '';
    if (this.metricsTable) this.metricsTable.innerHTML = '';
    renderWarnings(this.warningsEl, []);
  },

  refresh(): void {
    if (!this.lastSeries) {
      this.clear();
      return;
    }
    const analysis = State.ensureAnalysisConfig();
    const selection = analysis.selectionOnly === false ? null : State.getAnalysisSelection();
    const selected = autoSelectSource(this.lastSeries);
    const y = selected.values;
    const cacheKey = [
      seriesSignature(this.lastSeries, selected.source),
      selectionKey(selection),
      analysis.fftWindow,
      analysis.fftDetrend,
      analysis.fftZeroPad,
      analysis.fftZeroPadFactor,
      analysis.fftPeakCount,
      analysis.fftPeakProminence,
      analysis.fftHarmonicCount,
      analysis.fftHarmonicFundamental || 'auto',
      analysis.fftSource
    ].join('|');

    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.render(cached);
      return;
    }

    const spectrumOptions = {
      selection,
      windowType: analysis.fftWindow,
      detrend: analysis.fftDetrend,
      zeroPadMode: analysis.fftZeroPad,
      zeroPadFactor: analysis.fftZeroPadFactor,
      quality: selected.quality
    };
    const summaryOptions = {
      maxPeaks: analysis.fftPeakCount,
      prominence: analysis.fftPeakProminence,
      harmonicCount: analysis.fftHarmonicCount,
      fundamentalHz: analysis.fftHarmonicFundamental || undefined
    };
    if (y.length >= 100_000 && typeof Worker !== 'undefined') {
      this.workerController?.abort();
      const controller = new AbortController();
      const generation = ++this.workerGeneration;
      this.workerController = controller;
      void analysisWorkerClient
        .run<SpectrumResult>(
          {
            kind: 'spectrum',
            signal: Float64Array.from(y),
            time: Float64Array.from(this.lastSeries.rawX),
            options: spectrumOptions
          },
          {
            signal: controller.signal,
            transferOwnership: true,
            onProgress: (progress, stage) => {
              if (this.metaEl) this.metaEl.textContent = `${stage} · ${Math.round(progress * 100)}%`;
            }
          }
        )
        .then((spectrum) => {
          if (controller.signal.aborted || generation !== this.workerGeneration) return;
          const summary = SpectralMetrics.summarizeFromSpectrum(spectrum, summaryOptions);
          this.cache.set(cacheKey, summary);
          this.render(summary);
        })
        .catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === 'AbortError')) {
            renderWarnings(this.warningsEl, [error instanceof Error ? error.message : String(error)]);
          }
        });
      return;
    }

    const summary = SpectralMetrics.summarize(y, this.lastSeries.rawX, {
      ...spectrumOptions,
      ...summaryOptions
    });
    this.cache.set(cacheKey, summary);
    this.render(summary);
  },

  render(summary: SpectralSummary): void {
    const { spectrum, peaks, harmonics, thd, snr, spur, bandpower, fundamentalHz } = summary;
    if (this.metaEl) {
      this.metaEl.textContent = `Fs ≈ ${formatNumber(spectrum.meta.fs)} Hz · Δf ≈ ${formatNumber(spectrum.meta.deltaF)} Hz · Nyquist ${formatNumber(spectrum.meta.nyquist)} Hz`;
    }
    renderWarnings(this.warningsEl, summary.warnings);
    if (this.peaksTable) {
      const rows = peaks.length
        ? peaks
            .map(
              (p, idx) =>
                `<tr><td class="${ui.analysisTableCell}">${idx + 1}</td><td class="${ui.analysisTableCell}">${formatNumber(p.freq)}</td><td class="${ui.analysisTableCell}">${formatNumber(20 * Math.log10(Math.max(p.magnitude, 1e-12)), 2)} dB</td></tr>`
            )
            .join('')
        : `<tr><td class="${ui.analysisTableCell} text-muted" colspan="3">No peaks above prominence</td></tr>`;
      this.peaksTable.innerHTML = `<tr><th class="${ui.analysisTableCell}">#</th><th class="${ui.analysisTableCell}">Freq (Hz)</th><th class="${ui.analysisTableCell}">Mag</th></tr>${rows}`;
    }
    if (this.metricsTable) {
      const harmonicList = harmonics?.length
        ? harmonics
            .map(
              (h) =>
                `${h.order}×: ${formatNumber(h.freq)} Hz (${formatNumber(20 * Math.log10(Math.max(h.magnitude || 0, 1e-12)), 2)} dB)`
            )
            .join('<br>')
        : '—';
      this.metricsTable.innerHTML = `
        <tr><td class="${ui.analysisTableCell}">Fundamental</td><td class="${ui.analysisTableCell}">${fundamentalHz ? `${formatNumber(fundamentalHz)} Hz` : 'Auto'}</td></tr>
        <tr><td class="${ui.analysisTableCell}">Bandpower</td><td class="${ui.analysisTableCell}">${formatNumber(bandpower, 3)}</td></tr>
        <tr><td class="${ui.analysisTableCell}">THD</td><td class="${ui.analysisTableCell}">${thd !== null ? `${formatNumber(thd * 100, 2)} %` : '—'}</td></tr>
        <tr><td class="${ui.analysisTableCell}">SNR</td><td class="${ui.analysisTableCell}">${snr !== null ? `${formatNumber(10 * Math.log10(Math.max(snr, 1e-12)), 2)} dB` : '—'}</td></tr>
        <tr><td class="${ui.analysisTableCell}">Largest Spur</td><td class="${ui.analysisTableCell}">${spur?.freq ? `${formatNumber(spur.freq)} Hz` : '—'}</td></tr>
        <tr><td class="${ui.analysisTableCell}">Harmonics</td><td class="${ui.analysisTableCell}">${harmonicList}</td></tr>
      `;
    }
  }
};
