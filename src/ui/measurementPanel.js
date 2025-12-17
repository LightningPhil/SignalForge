import { Measurements } from '../analysis/measurements.js';
import { State } from '../state.js';
import { AnalysisEngine } from '../analysis/analysisEngine.js';
import { debounce, formatSeconds, selectionKey, seriesSignature } from '../app/utils.js';

const PRESETS = {
    general: {
        label: 'General',
        metrics: ['mean', 'rms', 'peakToPeak', 'frequencyHz', 'period', 'min', 'max']
    },
    power: {
        label: 'Power Electronics',
        metrics: ['riseTime', 'fallTime', 'overshootPct', 'undershootPct', 'dutyCycle', 'peakToPeak', 'frequencyHz']
    },
    pulsed: {
        label: 'Pulsed',
        metrics: ['area', 'absArea', 'peakTime', 'valleyTime', 'rms', 'mean']
    }
};

const LABELS = {
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

const UNITS = {
    frequencyHz: 'Hz',
    period: 's',
    dutyCycle: '%',
    riseTime: 's',
    fallTime: 's',
    overshootPct: '%',
    undershootPct: '%',
    area: 'y·s',
    absArea: 'y·s',
    peakTime: 's',
    valleyTime: 's'
};

function formatNumber(value, key) {
    if (value === null || value === undefined || Number.isNaN(value)) return '—';
    if (key === 'dutyCycle') return `${(value * 100).toFixed(2)} %`;
    if (key === 'overshootPct' || key === 'undershootPct') return `${value.toFixed(2)} %`;
    if (['riseTime', 'fallTime', 'peakTime', 'valleyTime', 'period'].includes(key)) return formatSeconds(value);

    const abs = Math.abs(value);
    if (abs !== 0 && (abs < 0.001 || abs >= 100000)) {
        return value.toExponential(3);
    }
    return Number(value).toFixed(4).replace(/\.0+$/, '').replace(/\.([0-9]*?)0+$/, '.$1');
}

function formatSelection(selection) {
    if (!selection || selection.i0 === null || selection.i1 === null) return 'Full record';
    const rangeLabel = `Indices ${selection.i0}–${selection.i1}`;
    const timeLabel = (selection.xMin !== null && selection.xMax !== null)
        ? ` (${formatSeconds(selection.xMin)} → ${formatSeconds(selection.xMax)})`
        : '';
    return `${rangeLabel}${timeLabel}`;
}

function renderWarnings(listEl, warnings = []) {
    if (!listEl) return;
    if (!warnings.length) {
        listEl.innerHTML = '';
        listEl.style.display = 'none';
        return;
    }
    listEl.style.display = 'block';
    listEl.innerHTML = warnings.map((w) => `<li>${w}</li>`).join('');
}

export const MeasurementPanel = {
    currentPreset: 'general',
    lastSeries: null,
    cache: new Map(),
    lastSignature: null,

    init() {
        const cfg = State.ensureAnalysisConfig();
        this.currentPreset = cfg.measurementPreset || this.currentPreset;
        this.panelEl = document.getElementById('measurement-panel');
        this.rowsEl = document.getElementById('measurement-rows');
        this.selectionEl = document.getElementById('measurement-selection');
        this.traceLabelEl = document.getElementById('measurement-trace');
        this.presetSelect = document.getElementById('measurement-preset');
        this.summaryEl = document.getElementById('measurement-summary');
        this.warningList = document.getElementById('measurement-warnings');

        this.triggerRefresh = debounce(() => this.refresh(), 80);

        if (this.presetSelect) {
            this.presetSelect.innerHTML = Object.keys(PRESETS)
                .map((k) => `<option value="${k}">${PRESETS[k].label}</option>`)
                .join('');
            this.presetSelect.value = this.currentPreset;
            this.presetSelect.addEventListener('change', (e) => {
                this.currentPreset = e.target.value;
                State.ensureAnalysisConfig().measurementPreset = this.currentPreset;
                this.refresh();
            });
        }

        AnalysisEngine.onSelectionChange(debounce(() => this.triggerRefresh(), 50));
    },

    setSeries(series) {
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

    clear() {
        this.lastSeries = null;
        this.cache.clear();
        this.lastSignature = null;
        this.renderEmpty();
    },

    refresh() {
        if (!this.panelEl) return;
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
            this.render(cached, this.lastSeries.seriesName || State.data.dataColumn || 'Trace');
            return;
        }

        const results = Measurements.compute({
            t: this.lastSeries.rawX,
            y: ySource,
            selection,
            edgeThresholds: { lowFraction: 0.1, highFraction: 0.9 }
        });

        this.cache.set(cacheKey, results);
        this.render(results, this.lastSeries.seriesName || State.data.dataColumn || 'Trace');
    },

    renderEmpty() {
        if (this.traceLabelEl) this.traceLabelEl.textContent = 'No trace selected';
        if (this.selectionEl) this.selectionEl.textContent = 'Load data to view measurements';
        if (this.rowsEl) this.rowsEl.innerHTML = '';
        if (this.summaryEl) this.summaryEl.textContent = '';
        renderWarnings(this.warningList, []);
    },

    render(results, traceLabel) {
        if (this.traceLabelEl) this.traceLabelEl.textContent = traceLabel;
        if (this.selectionEl) this.selectionEl.textContent = formatSelection(results.selection);

        const preset = PRESETS[this.currentPreset] || PRESETS.general;
        const rows = preset.metrics.map((key) => {
            const label = LABELS[key] || key;
            const unit = UNITS[key] || '';
            const value = results.metrics[key];
            return `<tr><td>${label}</td><td class="value">${formatNumber(value, key)}</td><td class="unit">${unit}</td></tr>`;
        }).join('');

        if (this.rowsEl) this.rowsEl.innerHTML = rows;

        if (this.summaryEl) {
            const count = results.meta.sampleCount || 0;
            const duration = results.meta.duration;
            const durationLabel = duration !== null ? `${formatSeconds(duration)}` : 'n/a';
            this.summaryEl.textContent = `${count} samples, span ${durationLabel}`;
        }

        renderWarnings(this.warningList, results.warnings);
    }
};
