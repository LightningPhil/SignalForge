import { State } from '../state.js';
import { Filter } from '../processing/filter.js';
import { applyComposerOffsets, getComposerTrace } from '../processing/composer.js';
import { getPixelsPerCm } from '../ui/displayCalibration.js';
import { Measurements } from '../analysis/measurements.js';
import { EventDetector } from '../analysis/eventDetector.js';
import { SpectralMetrics } from '../analysis/spectralMetrics.js';
import { getRawSeries } from '../app/dataPipeline.js';

const THEME_STYLES = {
    light: {
        paperBg: '#ffffff',
        plotBg: '#ffffff',
        fontColor: '#102a43',
        gridColor: '#d7deea'
    },
    dark: {
        paperBg: '#1e1e1e',
        plotBg: '#1e1e1e',
        fontColor: '#e0e0e0',
        gridColor: '#333333'
    }
};

function preparePlotExport(format, options = {}) {
    const { theme, transparent = false, widthCm, heightCm, useWindowSize = true } = options;
    const graphDiv = document.getElementById('main-plot');

    if (!graphDiv || !graphDiv.layout) {
        return null;
    }

    const selectedTheme = theme === 'light' || theme === 'dark'
        ? theme
        : (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

    const themeStyles = THEME_STYLES[selectedTheme] || THEME_STYLES.dark;
    const colors = Exporter.getColorsForTheme(selectedTheme);
    const config = State.config.graph;

    const rawLineColor = Exporter.hexToRgba(colors.raw || '#888888', config.rawOpacity || 0.5);
    const filteredLineColor = colors.filtered || '#ff9800';
    const diffRawColor = Exporter.hexToRgba(colors.diffRaw || colors.raw || '#888888', config.rawOpacity || 0.5);
    const diffFiltColor = colors.diffFilt || colors.filtered || '#ff9800';
    const transferColor = colors.transfer || '#00bcd4';

    const themedData = (graphDiv.data || []).map(trace => {
        const clonedTrace = { ...trace };
        const name = (trace.name || '').toLowerCase();
        const line = trace.line ? { ...trace.line } : {};

        if (name.includes('transfer')) {
            line.color = transferColor;
        } else if (name.includes('deriv') && name.includes('raw')) {
            line.color = diffRawColor;
        } else if (name.includes('deriv') && name.includes('filt')) {
            line.color = diffFiltColor;
        } else if (name.includes('raw')) {
            line.color = rawLineColor;
        } else if (name.includes('filt')) {
            line.color = filteredLineColor;
        }

        if (Object.keys(line).length > 0) clonedTrace.line = line;
        return clonedTrace;
    });

    const layout = JSON.parse(JSON.stringify(graphDiv.layout || {}));
    layout.paper_bgcolor = transparent ? 'rgba(0,0,0,0)' : themeStyles.paperBg;
    layout.plot_bgcolor = transparent ? 'rgba(0,0,0,0)' : themeStyles.plotBg;
    layout.font = { ...(layout.font || {}), color: themeStyles.fontColor };
    layout.xaxis = { ...(layout.xaxis || {}), gridcolor: themeStyles.gridColor, zerolinecolor: themeStyles.gridColor };
    layout.yaxis = { ...(layout.yaxis || {}), gridcolor: themeStyles.gridColor, zerolinecolor: themeStyles.gridColor };
    if (layout.yaxis2) {
        layout.yaxis2 = { ...layout.yaxis2, gridcolor: themeStyles.gridColor, zerolinecolor: themeStyles.gridColor };
    }

    const pixelsPerCm = getPixelsPerCm();
    let targetWidth = graphDiv.clientWidth || 1000;
    let targetHeight = graphDiv.clientHeight || 600;

    if (!useWindowSize) {
        if (widthCm && !isNaN(widthCm)) targetWidth = Math.max(1, widthCm * pixelsPerCm);
        if (heightCm && !isNaN(heightCm)) targetHeight = Math.max(1, heightCm * pixelsPerCm);
    }

    return { themedData, layout, targetWidth, targetHeight, format: format || 'png' };
}

function activeColumnId() {
    if (State.ui.activeMultiViewId) {
        const view = State.multiViews.find((v) => v.id === State.ui.activeMultiViewId);
        return view?.activeColumnIds?.[0] || null;
    }
    return State.data.dataColumn;
}

function getSeriesForAnalysis() {
    const columnId = activeColumnId();
    if (!columnId) return null;
    const { rawX, rawY } = getRawSeries(columnId);
    if (!rawX.length || !rawY.length) return null;
    const isMath = !!State.getMathDefinition(columnId);
    const filteredY = isMath ? null : Filter.applyPipeline(rawY, rawX, State.getPipelineForColumn(columnId));
    return { columnId, rawX, rawY, filteredY, isMath };
}

function formatNumber(value, digits = 4) {
    if (value === null || value === undefined || Number.isNaN(value)) return '—';
    if (typeof value === 'string') return value;
    const abs = Math.abs(value);
    if (abs !== 0 && (abs < 0.001 || abs >= 1e6)) return Number(value).toExponential(3);
    return Number(value).toFixed(digits).replace(/\.0+$/, '').replace(/\.([0-9]*?)0+$/, '.$1');
}

function describeSelection(selection) {
    if (!selection || selection.i0 === null || selection.i1 === null) return 'Full record';
    const bounds = selection.xMin !== null && selection.xMax !== null
        ? ` (${formatNumber(selection.xMin, 3)} → ${formatNumber(selection.xMax, 3)} s)`
        : '';
    return `Indices ${selection.i0}–${selection.i1}${bounds}`;
}

function downloadBlob(filename, mime, content) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/**
 * Export Module
 */
export const Exporter = {
    
    downloadCSV(includeOriginal) {
        const rawData = State.data.raw;
        const headers = State.data.headers;
        const xCol = State.data.timeColumn;

        if (!rawData.length) {
            alert("No data to export.");
            return;
        }

        // 1. Identify Numeric Columns to Filter
        const numericCols = headers.filter(h => {
            if (h === xCol) return false;

            return rawData.some(row => {
                const val = row[h];
                if (val === undefined || val === null) return false;
                const parsed = parseFloat(val);
                return Number.isFinite(parsed);
            });
        });

        const rawTime = rawData.map((r) => parseFloat(r[xCol]));
        const activeViewId = State.ui.activeMultiViewId || null;
        const activeView = activeViewId ? State.multiViews.find((v) => v.id === activeViewId) : null;
        const activeComposer = State.getComposer(activeViewId);

        // 2. Pre-calculate Pipeline Data for ALL numeric columns
        const processedDataMap = {};

        console.time("Export Pipeline");
        numericCols.forEach(col => {
            const rawCol = rawData.map(r => parseFloat(r[col]));
            // Apply full pipeline
            const pipeline = State.getPipelineForColumn(col);
            const filtered = Filter.applyPipeline(rawCol, rawTime, pipeline);

            let alignedRaw = rawCol;
            let alignedFiltered = filtered;

            if (activeView && activeView.activeColumnIds.includes(col)) {
                const trace = activeComposer?.traces?.find((t) => t.columnId === col) || { columnId: col };
                const aligned = applyComposerOffsets(rawCol, filtered, { columnId: col, yOffset: trace.yOffset || 0 });
                alignedRaw = aligned.adjustedRawY;
                alignedFiltered = aligned.adjustedFilteredY;
            } else if (!activeViewId && State.data.dataColumn === col) {
                const trace = getComposerTrace(null, col);
                const aligned = applyComposerOffsets(rawCol, filtered, trace);
                alignedRaw = aligned.adjustedRawY;
                alignedFiltered = aligned.adjustedFilteredY;
            }

            processedDataMap[col] = { raw: alignedRaw, filtered: alignedFiltered };
        });
        console.timeEnd("Export Pipeline");

        // 3. Construct Headers
        let outputHeaders = [];
        let csvContent = "data:text/csv;charset=utf-8,";

        outputHeaders.push(xCol);

        if (includeOriginal) {
            numericCols.forEach(h => outputHeaders.push(h));
        }

        numericCols.forEach(h => outputHeaders.push(`${h} (Filtered)`));

        csvContent += outputHeaders.join(",") + "\r\n";

        // 4. Construct Rows
        for (let i = 0; i < rawData.length; i++) {
            let rowData = [];

            // Time
            rowData.push(rawData[i][xCol]);

            // Original
            if (includeOriginal) {
                numericCols.forEach(col => {
                    let val = processedDataMap[col].raw[i];
                    if (typeof val === 'string' && val.includes(',')) val = `"${val}"`;
                    rowData.push(val);
                });
            }

            // Filtered
            numericCols.forEach(col => {
                const val = processedDataMap[col].filtered[i];
                rowData.push(val);
            });

            csvContent += rowData.join(",") + "\r\n";
        }

        // 5. Download
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        
        const filename = includeOriginal 
            ? "data_export_pipeline_full.csv" 
            : "data_export_pipeline.csv";
            
        link.setAttribute("download", filename);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    },

    hexToRgba(hex, alpha) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    },

    getColorsForTheme(theme) {
        const configColors = State.config.colors;
        const defaults = (configColors && configColors[theme]) || {};

        if (configColors && configColors[theme]) {
            return { ...defaults, ...configColors[theme] };
        }

        if (configColors && (configColors.raw || configColors.filtered)) {
            return {
                raw: configColors.raw,
                filtered: configColors.filtered,
                diffRaw: configColors.diffRaw || configColors.raw,
                diffFilt: configColors.diffFilt || configColors.filtered,
                transfer: configColors.transfer
            };
        }

        return defaults;
    },

    async captureGraphImage(format = 'png', options = {}) {
        const payload = preparePlotExport(format, options);
        if (!payload) {
            alert("Graph not initialized.");
            return null;
        }
        const url = await Plotly.toImage(
            { data: payload.themedData, layout: payload.layout },
            { format: payload.format, height: payload.targetHeight, width: payload.targetWidth }
        );
        return url;
    },

    async downloadImage(format, options = {}) {
        try {
            const url = await this.captureGraphImage(format, options);
            if (!url) return;
            const link = document.createElement('a');
            link.setAttribute('href', url);
            link.setAttribute('download', 'signal_graph_export.' + (format || 'png'));
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        } catch (err) {
            console.error('Error exporting image', err);
            alert('Failed to export graph image.');
        }
    },

    buildAnalysisSnapshot() {
        const series = getSeriesForAnalysis();
        if (!series) {
            alert('No active trace to analyze.');
            return null;
        }

        const baseCfg = State.ensureAnalysisConfig();
        const analysisCfg = { ...baseCfg, trigger: { ...(baseCfg.trigger || {}) } };
        const selection = State.getAnalysisSelection();
        const preferredY = (!series.isMath && series.filteredY?.length) ? series.filteredY : series.rawY;

        const measurements = Measurements.compute({
            t: series.rawX,
            y: preferredY,
            selection,
            edgeThresholds: { lowFraction: 0.1, highFraction: 0.9 }
        });

        let eventSource = preferredY;
        if (analysisCfg.trigger?.source === 'raw') {
            eventSource = series.rawY;
        } else if (analysisCfg.trigger?.source === 'filtered' && series.filteredY?.length) {
            eventSource = series.filteredY;
        }

        const events = EventDetector.detect({
            t: series.rawX,
            y: eventSource,
            selection,
            config: analysisCfg.trigger || {}
        });

        const spectralSelection = analysisCfg.selectionOnly === false ? null : selection;
        const fftSource = analysisCfg.fftSource || 'auto';
        let spectralY = preferredY;
        if (fftSource === 'raw') spectralY = series.rawY;
        if (fftSource === 'filtered' && series.filteredY?.length) spectralY = series.filteredY;

        const spectral = SpectralMetrics.summarize(spectralY, series.rawX, {
            selection: spectralSelection,
            windowType: analysisCfg.fftWindow,
            detrend: analysisCfg.fftDetrend,
            zeroPadMode: analysisCfg.fftZeroPad,
            zeroPadFactor: analysisCfg.fftZeroPadFactor,
            maxPeaks: analysisCfg.fftPeakCount,
            prominence: analysisCfg.fftPeakProminence,
            harmonicCount: analysisCfg.fftHarmonicCount,
            fundamentalHz: analysisCfg.fftHarmonicFundamental || undefined
        });

        return {
            series: {
                name: series.columnId,
                isMath: series.isMath
            },
            timestamp: new Date().toISOString(),
            selection,
            analysisConfig: analysisCfg,
            measurements,
            events,
            spectral
        };
    },

    downloadMeasurementsCSV() {
        const snapshot = this.buildAnalysisSnapshot();
        if (!snapshot) return;
        const metrics = snapshot.measurements?.metrics || {};
        const lines = ['Metric,Value'];
        Object.keys(metrics).forEach((key) => {
            lines.push(`${key},${metrics[key] ?? ''}`);
        });
        lines.push('Selection,' + describeSelection(snapshot.selection));
        downloadBlob('measurements.csv', 'text/csv', lines.join('\n'));
    },

    downloadMeasurementsJSON() {
        const snapshot = this.buildAnalysisSnapshot();
        if (!snapshot) return;
        const payload = {
            generatedAt: snapshot.timestamp,
            trace: snapshot.series,
            selection: snapshot.selection,
            measurements: snapshot.measurements,
            analysis: snapshot.analysisConfig
        };
        downloadBlob('measurements.json', 'application/json', JSON.stringify(payload, null, 2));
    },

    downloadEventsCSV() {
        const snapshot = this.buildAnalysisSnapshot();
        if (!snapshot) return;
        const events = snapshot.events?.events || [];
        const rows = ['index,time,type,metadata'];
        events.forEach((evt) => {
            const meta = JSON.stringify(evt.metadata || {});
            rows.push([evt.index ?? '', evt.time ?? '', evt.type || '', meta].join(','));
        });
        downloadBlob('events.csv', 'text/csv', rows.join('\n'));
    },

    downloadSpectralSummaryJSON() {
        const snapshot = this.buildAnalysisSnapshot();
        if (!snapshot) return;
        const spectral = snapshot.spectral || {};
        const summary = {
            generatedAt: snapshot.timestamp,
            trace: snapshot.series,
            selection: snapshot.selection,
            analysis: snapshot.analysisConfig,
            spectral: {
                meta: spectral.spectrum?.meta,
                peaks: spectral.peaks,
                harmonics: spectral.harmonics,
                thd: spectral.thd,
                snr: spectral.snr,
                spur: spectral.spur,
                bandpower: spectral.bandpower,
                fundamentalHz: spectral.fundamentalHz,
                warnings: spectral.warnings
            }
        };
        downloadBlob('spectral_summary.json', 'application/json', JSON.stringify(summary, null, 2));
    },

    async downloadReport() {
        const snapshot = this.buildAnalysisSnapshot();
        if (!snapshot) return;
        const imageData = await this.captureGraphImage('png', { useWindowSize: true }).catch(() => null);
        const measurements = snapshot.measurements?.metrics || {};
        const events = snapshot.events?.events || [];
        const spectral = snapshot.spectral || {};
        const peakRows = (spectral.peaks || []).map((p, idx) => `<tr><td>${idx + 1}</td><td>${formatNumber(p.freq)}</td><td>${formatNumber(p.magnitude)}</td></tr>`).join('') || '<tr><td colspan="3">No peaks</td></tr>';
        const eventRows = events.map((evt) => `<tr><td>${evt.index ?? ''}</td><td>${formatNumber(evt.time)}</td><td>${evt.type || ''}</td><td>${JSON.stringify(evt.metadata || {})}</td></tr>`).join('') || '<tr><td colspan="4">No events detected</td></tr>';
        const measurementRows = Object.keys(measurements).map((key) => `<tr><td>${key}</td><td>${formatNumber(measurements[key])}</td></tr>`).join('');
        const settings = snapshot.analysisConfig || {};

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>SignalForge Analysis Report</title>
<style>
    body { font-family: Arial, sans-serif; background:#f7f9fc; color:#102a43; margin:20px; }
    h1, h2 { color:#0b2545; }
    .card { background:#ffffff; border:1px solid #d7deea; border-radius:8px; padding:16px; margin-bottom:16px; box-shadow:0 1px 3px rgba(0,0,0,0.05); }
    table { width:100%; border-collapse: collapse; margin-top:8px; }
    th, td { border:1px solid #d7deea; padding:6px 8px; text-align:left; }
    th { background:#f0f4f8; }
    .muted { color:#627d98; }
</style>
</head>
<body>
    <h1>SignalForge Analysis Report</h1>
    <p class="muted">Generated ${snapshot.timestamp}</p>
    <div class="card">
        <h2>Overview</h2>
        <p><strong>Trace:</strong> ${snapshot.series?.name || 'n/a'} ${snapshot.series?.isMath ? '(math)' : ''}</p>
        <p><strong>Selection:</strong> ${describeSelection(snapshot.selection)}</p>
        ${imageData ? `<img src="${imageData}" alt="Plot snapshot" style="max-width:100%; border:1px solid #d7deea; margin-top:10px;"/>` : '<p class="muted">Plot snapshot unavailable.</p>'}
    </div>
    <div class="card">
        <h2>Measurements</h2>
        <table>
            <tr><th>Metric</th><th>Value</th></tr>
            ${measurementRows || '<tr><td colspan="2">No measurements</td></tr>'}
        </table>
        <p class="muted">Warnings: ${(snapshot.measurements?.warnings || []).join('; ') || 'None'}</p>
    </div>
    <div class="card">
        <h2>Events</h2>
        <p>${events.length} events detected.</p>
        <table>
            <tr><th>#</th><th>Time (s)</th><th>Type</th><th>Metadata</th></tr>
            ${eventRows}
        </table>
        <p class="muted">Warnings: ${(snapshot.events?.warnings || []).join('; ') || 'None'}</p>
    </div>
    <div class="card">
        <h2>Spectral Metrics</h2>
        <p><strong>Fundamental:</strong> ${formatNumber(spectral.fundamentalHz)} Hz · <strong>Bandpower:</strong> ${formatNumber(spectral.bandpower)} </p>
        <p><strong>THD:</strong> ${spectral.thd !== null && spectral.thd !== undefined ? formatNumber(spectral.thd * 100, 2) + ' %' : '—'} · <strong>SNR:</strong> ${spectral.snr ? formatNumber(10 * Math.log10(Math.max(spectral.snr, 1e-12)), 2) + ' dB' : '—'}</p>
        <table>
            <tr><th>#</th><th>Freq (Hz)</th><th>Mag (linear)</th></tr>
            ${peakRows}
        </table>
        <p class="muted">Warnings: ${(spectral.warnings || []).join('; ') || 'None'}</p>
    </div>
    <div class="card">
        <h2>Analysis Settings</h2>
        <ul>
            <li>FFT: window ${settings.fftWindow}, detrend ${settings.fftDetrend}, zero-pad ${settings.fftZeroPad} ×${settings.fftZeroPadFactor}</li>
            <li>FFT source: ${settings.fftSource || 'auto'}, peak count ${settings.fftPeakCount}, prominence ${settings.fftPeakProminence}</li>
            <li>Trigger: ${settings.trigger?.type || 'level'} (${settings.trigger?.direction || 'n/a'}) @ ${settings.trigger?.threshold ?? 0} with hysteresis ${settings.trigger?.hysteresis ?? 0}</li>
            <li>Measurement preset: ${settings.measurementPreset || 'general'}</li>
        </ul>
    </div>
</body>
</html>`;


        downloadBlob('analysis_report.html', 'text/html', html);
    }
};