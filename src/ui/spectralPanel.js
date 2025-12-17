import { AnalysisEngine } from '../analysis/analysisEngine.js';
import { SpectralMetrics } from '../analysis/spectralMetrics.js';
import { State } from '../state.js';
import { debounce, selectionKey, seriesSignature } from '../app/utils.js';
import { triggerGraphUpdateOnly } from '../app/dataPipeline.js';

function formatNumber(val, digits = 3) {
    if (val === null || val === undefined || Number.isNaN(val)) return '—';
    const abs = Math.abs(val);
    if (abs !== 0 && (abs < 0.001 || abs >= 1e6)) return val.toExponential(3);
    return Number(val).toFixed(digits).replace(/\.0+$/, '').replace(/\.([0-9]*?)0+$/, '.$1');
}

function renderWarnings(el, warnings = []) {
    if (!el) return;
    if (!warnings.length) {
        el.style.display = 'none';
        el.innerHTML = '';
        return;
    }
    el.style.display = 'block';
    el.innerHTML = warnings.map((w) => `<li>${w}</li>`).join('');
}

function autoSelectSource(series) {
    const cfg = State.ensureAnalysisConfig();
    const choice = cfg.fftSource || 'auto';
    if (choice === 'filtered' && series.filteredY?.length) return series.filteredY;
    if (choice === 'raw') return series.rawY;
    if (choice === 'auto' && series.filteredY?.length) return series.filteredY;
    return series.rawY;
}

function peakRows(peaks = []) {
    if (!peaks.length) return '<tr><td colspan="3" class="muted">No peaks above prominence</td></tr>';
    return peaks.map((p, idx) => `<tr><td>${idx + 1}</td><td>${formatNumber(p.freq)}</td><td>${formatNumber(20 * Math.log10(Math.max(p.magnitude, 1e-12)), 2)} dB</td></tr>`).join('');
}

export const SpectralPanel = {
    lastSeries: null,
    cache: new Map(),

    init() {
        this.panelEl = document.getElementById('spectral-panel');
        if (!this.panelEl) return;

        this.triggerRefresh = debounce(() => this.refresh(), 90);

        this.windowSelect = document.getElementById('fft-window');
        this.detrendSelect = document.getElementById('fft-detrend');
        this.zeroPadSelect = document.getElementById('fft-zero-pad');
        this.zeroPadFactor = document.getElementById('fft-zero-factor');
        this.viewSelect = document.getElementById('fft-view');
        this.sourceSelect = document.getElementById('fft-source');
        this.peakCountInput = document.getElementById('fft-peak-count');
        this.peakProminenceInput = document.getElementById('fft-peak-prominence');
        this.harmonicToggle = document.getElementById('fft-show-harmonics');
        this.harmonicCountInput = document.getElementById('fft-harmonic-count');
        this.fundamentalInput = document.getElementById('fft-fundamental');
        this.metaEl = document.getElementById('fft-meta');
        this.warningsEl = document.getElementById('fft-warnings');
        this.peaksTable = document.getElementById('fft-peaks-table');
        this.metricsTable = document.getElementById('fft-metrics-table');

        this.bindControls();
        AnalysisEngine.onSelectionChange(debounce(() => this.triggerRefresh(), 50));
    },

    bindControls() {
        const cfg = State.ensureAnalysisConfig();
        const bindSelect = (el, key, updateGraph = false) => {
            if (!el) return;
            el.value = cfg[key];
            el.addEventListener('change', () => {
                const analysis = State.ensureAnalysisConfig();
                analysis[key] = el.value;
                if (updateGraph) triggerGraphUpdateOnly();
                this.refresh();
            });
        };

        bindSelect(this.windowSelect, 'fftWindow', true);
        bindSelect(this.detrendSelect, 'fftDetrend', true);
        bindSelect(this.zeroPadSelect, 'fftZeroPad', true);
        bindSelect(this.viewSelect, 'fftView', true);
        bindSelect(this.sourceSelect, 'fftSource', true);

        if (this.zeroPadFactor) {
            this.zeroPadFactor.value = cfg.fftZeroPadFactor;
            this.zeroPadFactor.addEventListener('input', () => {
                const analysis = State.ensureAnalysisConfig();
                analysis.fftZeroPadFactor = Math.max(1, parseFloat(this.zeroPadFactor.value) || 1);
                triggerGraphUpdateOnly();
                this.refresh();
            });
        }

        if (this.peakCountInput) {
            this.peakCountInput.value = cfg.fftPeakCount;
            this.peakCountInput.addEventListener('input', () => {
                const analysis = State.ensureAnalysisConfig();
                analysis.fftPeakCount = Math.max(1, parseInt(this.peakCountInput.value, 10) || 1);
                triggerGraphUpdateOnly();
                this.refresh();
            });
        }

        if (this.peakProminenceInput) {
            this.peakProminenceInput.value = cfg.fftPeakProminence;
            this.peakProminenceInput.addEventListener('input', () => {
                const analysis = State.ensureAnalysisConfig();
                analysis.fftPeakProminence = Math.max(0, parseFloat(this.peakProminenceInput.value) || 0);
                triggerGraphUpdateOnly();
                this.refresh();
            });
        }

        if (this.harmonicToggle) {
            this.harmonicToggle.checked = cfg.fftShowHarmonics !== false;
            this.harmonicToggle.addEventListener('change', () => {
                State.ensureAnalysisConfig().fftShowHarmonics = this.harmonicToggle.checked;
                triggerGraphUpdateOnly();
                this.refresh();
            });
        }

        if (this.harmonicCountInput) {
            this.harmonicCountInput.value = cfg.fftHarmonicCount;
            this.harmonicCountInput.addEventListener('input', () => {
                const analysis = State.ensureAnalysisConfig();
                analysis.fftHarmonicCount = Math.max(1, parseInt(this.harmonicCountInput.value, 10) || 1);
                triggerGraphUpdateOnly();
                this.refresh();
            });
        }

        if (this.fundamentalInput) {
            if (cfg.fftHarmonicFundamental) this.fundamentalInput.value = cfg.fftHarmonicFundamental;
            this.fundamentalInput.addEventListener('input', () => {
                const val = parseFloat(this.fundamentalInput.value);
                State.ensureAnalysisConfig().fftHarmonicFundamental = Number.isFinite(val) ? val : null;
                triggerGraphUpdateOnly();
                this.refresh();
            });
        }
    },

    setSeries(series) {
        this.lastSeries = series;
        this.cache.clear();
        this.triggerRefresh();
    },

    clear() {
        this.lastSeries = null;
        this.cache.clear();
        if (this.metaEl) this.metaEl.textContent = 'Load data to view spectrum';
        if (this.peaksTable) this.peaksTable.innerHTML = '';
        if (this.metricsTable) this.metricsTable.innerHTML = '';
        renderWarnings(this.warningsEl, []);
    },

    refresh() {
        if (!this.panelEl) return;
        if (!this.lastSeries) {
            this.clear();
            return;
        }

        const analysis = State.ensureAnalysisConfig();
        const selection = analysis.selectionOnly === false ? null : State.getAnalysisSelection();
        const y = autoSelectSource(this.lastSeries);
        const x = this.lastSeries.rawX;

        const cacheKey = [
            seriesSignature(this.lastSeries, y === this.lastSeries.filteredY ? 'filtered' : 'raw'),
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

        const summary = SpectralMetrics.summarize(y, x, {
            selection,
            windowType: analysis.fftWindow,
            detrend: analysis.fftDetrend,
            zeroPadMode: analysis.fftZeroPad,
            zeroPadFactor: analysis.fftZeroPadFactor,
            maxPeaks: analysis.fftPeakCount,
            prominence: analysis.fftPeakProminence,
            harmonicCount: analysis.fftHarmonicCount,
            fundamentalHz: analysis.fftHarmonicFundamental || undefined,
            cacheKey
        });

        this.cache.set(cacheKey, summary);
        this.render(summary);
    },

    render(summary) {
        const { spectrum, peaks, harmonics, thd, snr, spur, bandpower, fundamentalHz } = summary;
        if (this.metaEl) {
            const fsLabel = `Fs ≈ ${formatNumber(spectrum.meta.fs)} Hz`;
            const dfLabel = `Δf ≈ ${formatNumber(spectrum.meta.deltaF)} Hz`;
            const nyLabel = `Nyquist ${formatNumber(spectrum.meta.nyquist)} Hz`;
            this.metaEl.textContent = `${fsLabel} · ${dfLabel} · ${nyLabel}`;
        }

        renderWarnings(this.warningsEl, summary.warnings);

        if (this.peaksTable) {
            this.peaksTable.innerHTML = `<tr><th>#</th><th>Freq (Hz)</th><th>Mag (dB)</th></tr>${peakRows(peaks)}`;
        }

        if (this.metricsTable) {
            const rows = [];
            rows.push(`<tr><td>Fundamental</td><td>${fundamentalHz ? `${formatNumber(fundamentalHz)} Hz` : 'Auto'}</td></tr>`);
            rows.push(`<tr><td>Bandpower</td><td>${formatNumber(bandpower, 3)} (a.u.)</td></tr>`);
            rows.push(`<tr><td>THD</td><td>${thd !== null ? `${formatNumber(thd * 100, 2)} %` : '—'}</td></tr>`);
            rows.push(`<tr><td>SNR</td><td>${snr !== null ? `${formatNumber(10 * Math.log10(Math.max(snr, 1e-12)), 2)} dB` : '—'}</td></tr>`);
            rows.push(`<tr><td>Largest Spur</td><td>${spur?.freq ? `${formatNumber(spur.freq)} Hz @ ${formatNumber(20 * Math.log10(Math.max(spur.magnitude || 0, 1e-12)), 2)} dB` : '—'}</td></tr>`);
            if (harmonics?.length) {
                const harmonicList = harmonics
                    .map((h) => `${h.order}×: ${formatNumber(h.freq)} Hz (${formatNumber(20 * Math.log10(Math.max(h.magnitude || 0, 1e-12)), 2)} dB)`) 
                    .join('<br>');
                rows.push(`<tr><td>Harmonics</td><td>${harmonicList}</td></tr>`);
            }
            this.metricsTable.innerHTML = `<tr><th colspan="2">Spectral Metrics</th></tr>${rows.join('')}`;
        }
    }
};
