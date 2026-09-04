import Plotly from 'plotly.js-dist-min';
import type { Data, Layout, PlotlyHTMLElement } from 'plotly.js';
import { CrossChannel } from '../analysis/crossChannel';
import { EventDetector } from '../analysis/eventDetector';
import { Measurements } from '../analysis/measurements';
import { SpectralMetrics } from '../analysis/spectralMetrics';
import { combineQualityMasks, qualityFlagNames } from '../data/quality';
import { Filter } from '../processing/filter';
import { MathEngine } from '../processing/math';
import { State } from '../state';
import type { AnalysisSeries, ImageExportOptions, ThemeName } from '../types';
import { getAlignedSeriesForColumn, getRawSeries, getSeriesForColumn, getTimeArray } from '../app/traceData';
import { toNumber } from '../app/utils';
import { getColorsForTheme, hexToRgba } from '../ui/colors';
import { getPixelsPerCm } from '../ui/displayCalibration';
import { downloadText } from './download';

const THEME_STYLES: Record<ThemeName, { paperBg: string; plotBg: string; fontColor: string; gridColor: string }> = {
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

interface ProcessedColumn {
  raw: number[];
  filtered: number[];
  quality?: Uint16Array;
  isMath?: boolean;
}

export const Exporter = {
  downloadCSV(includeOriginal: boolean): void {
    const rawData = State.data.raw;
    const headers = State.data.headers;
    const xCol = State.data.timeColumn;

    if (!rawData.length || !xCol) {
      alert('No data to export.');
      return;
    }

    const numericCols = headers.filter((h) => {
      if (h === xCol) return false;
      return rawData.some((row) => {
        const val = row[h];
        if (val === undefined || val === null) return false;
        return Number.isFinite(toNumber(val));
      });
    });

    const rawTime = getTimeArray();
    const processedDataMap: Record<string, ProcessedColumn> = {};
    const mathCols = (State.config.mathDefinitions || []).map((def) => def.name);

    numericCols.forEach((col) => {
      const rawCol = State.data.columns[col]
        ? Array.from(State.data.columns[col])
        : rawData.map((r) => toNumber(r[col]));
      const pipeline = State.getPipelineForColumn(col);
      const filtered = Filter.applyPipelineWithReport(rawCol, rawTime, pipeline, State.data.quality[col]);
      processedDataMap[col] = {
        raw: rawCol,
        filtered: filtered.values,
        quality: filtered.quality
      };
    });

    mathCols.forEach((name) => {
      const def = State.getMathDefinition(name);
      if (!def) return;
      const result = MathEngine.calculateVirtualColumn(def, rawTime);
      processedDataMap[name] = { raw: result.values || [], filtered: result.values || [], isMath: true };
    });

    const outputHeaders = [`${xCol} (Working)`];
    if (includeOriginal) {
      outputHeaders.push(`${xCol} (Original)`, `${xCol} (Original Quality)`, `${xCol} (Working Quality)`);
      numericCols.forEach((h) =>
        outputHeaders.push(`${h} (Original)`, `${h} (Working)`, `${h} (Original Quality)`, `${h} (Working Quality)`)
      );
    }
    numericCols.forEach((h) => outputHeaders.push(`${h} (Filtered)`, `${h} (Filtered Quality)`));
    mathCols.forEach((name) => outputHeaders.push(name));

    const quoteCsv = (val: unknown): string => {
      if (val === undefined || val === null) return '';
      const text = String(val);
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const lines = [outputHeaders.map(quoteCsv).join(',')];
    for (let i = 0; i < rawData.length; i++) {
      const originalRow = State.data.original[i];
      const rowData = [quoteCsv(rawData[i][xCol])];
      if (includeOriginal) {
        rowData.push(quoteCsv(originalRow?.[xCol]));
        rowData.push(quoteCsv(qualityFlagNames(State.data.originalQuality[xCol]?.[i] || 0).join('|')));
        rowData.push(quoteCsv(qualityFlagNames(State.data.quality[xCol]?.[i] || 0).join('|')));
        numericCols.forEach((col) => {
          rowData.push(quoteCsv(originalRow?.[col]));
          rowData.push(quoteCsv(rawData[i][col]));
          rowData.push(quoteCsv(qualityFlagNames(State.data.originalQuality[col]?.[i] || 0).join('|')));
          rowData.push(quoteCsv(qualityFlagNames(State.data.quality[col]?.[i] || 0).join('|')));
        });
      }
      numericCols.forEach((col) => {
        rowData.push(quoteCsv(processedDataMap[col].filtered[i]));
        rowData.push(quoteCsv(qualityFlagNames(processedDataMap[col].quality?.[i] || 0).join('|')));
      });
      mathCols.forEach((name) => rowData.push(quoteCsv(processedDataMap[name]?.raw[i])));
      lines.push(rowData.join(','));
    }

    downloadText(
      lines.join('\r\n'),
      includeOriginal ? 'data_export_pipeline_full.csv' : 'data_export_pipeline.csv',
      'text/csv;charset=utf-8'
    );
  },

  hexToRgba,
  getColorsForTheme,

  downloadImage(format: 'png' | 'svg' | 'jpeg' | 'webp', options: ImageExportOptions = {}): void {
    const { theme, transparent = false, widthCm, heightCm, useWindowSize = true } = options;
    const graphDiv = document.getElementById('main-plot') as PlotlyHTMLElement | null;

    if (!graphDiv || !graphDiv.layout) {
      alert('Graph not initialized.');
      return;
    }

    const selectedTheme: ThemeName =
      theme === 'light' || theme === 'dark'
        ? theme
        : document.documentElement.getAttribute('data-theme') === 'light'
          ? 'light'
          : 'dark';

    const themeStyles = THEME_STYLES[selectedTheme] || THEME_STYLES.dark;
    const colors = this.getColorsForTheme(selectedTheme);
    const config = State.config.graph;

    const rawLineColor = this.hexToRgba(colors.raw || '#888888', config.rawOpacity || 0.5);
    const filteredLineColor = colors.filtered || '#ff9800';
    const diffRawColor = this.hexToRgba(colors.diffRaw || colors.raw || '#888888', config.rawOpacity || 0.5);
    const diffFiltColor = colors.diffFilt || colors.filtered || '#ff9800';
    const transferColor = colors.transfer || '#00bcd4';

    const themedData = (graphDiv.data || []).map((trace) => {
      const clonedTrace: Data = { ...trace };
      const name = ('name' in trace && typeof trace.name === 'string' ? trace.name : '').toLowerCase();
      const existingLine =
        'line' in trace && trace.line && typeof trace.line === 'object'
          ? (trace.line as { color?: string; width?: number })
          : {};
      const line: { color?: string; width?: number } = { ...existingLine };

      if (name.includes('transfer')) line.color = transferColor;
      else if (name.includes('deriv') && name.includes('raw')) line.color = diffRawColor;
      else if (name.includes('deriv') && name.includes('filt')) line.color = diffFiltColor;
      else if (name.includes('raw')) line.color = rawLineColor;
      else if (name.includes('filt')) line.color = filteredLineColor;

      if (Object.keys(line).length > 0 && 'line' in clonedTrace) {
        clonedTrace.line = line;
      }
      return clonedTrace;
    });

    const layout = JSON.parse(JSON.stringify(graphDiv.layout || {})) as Partial<Layout>;
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
      if (widthCm && !Number.isNaN(widthCm)) targetWidth = Math.max(1, widthCm * pixelsPerCm);
      if (heightCm && !Number.isNaN(heightCm)) targetHeight = Math.max(1, heightCm * pixelsPerCm);
    }

    Plotly.toImage({ data: themedData, layout }, { format, height: targetHeight, width: targetWidth })
      .then((url) => {
        const link = document.createElement('a');
        link.setAttribute('href', url);
        link.setAttribute('download', `signal_graph_export.${format}`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      })
      .catch((err: unknown) => {
        console.error('Error exporting image', err);
        alert('Failed to export graph image.');
      });
  },

  getActiveAnalysisSeries(): AnalysisSeries | null {
    const columnId = State.ui.activeMultiViewId
      ? State.multiViews.find((v) => v.id === State.ui.activeMultiViewId)?.activeColumnIds[0] || null
      : State.data.dataColumn;
    if (!columnId) return null;
    const { rawX } = getRawSeries(columnId);
    const series = getSeriesForColumn(columnId, rawX);
    if (!series) return null;
    const rawQuality = combineQualityMasks(
      series.rawY.length,
      State.data.quality[columnId],
      State.data.timeColumn ? State.data.quality[State.data.timeColumn] : null
    );
    const filtered = series.isMath
      ? null
      : Filter.applyPipelineWithReport(series.rawY, series.time, State.getPipelineForColumn(columnId), rawQuality);
    return {
      rawX: series.time,
      rawY: series.rawY,
      rawQuality,
      filteredY: filtered?.values || null,
      filteredQuality: filtered?.quality || null,
      seriesName: columnId,
      columnId,
      isMath: series.isMath
    };
  },

  buildAnalysisSnapshot() {
    const series = this.getActiveAnalysisSeries();
    if (!series) {
      alert('No active trace to analyze.');
      return null;
    }
    const analysisCfg = State.ensureAnalysisConfig();
    const selection = State.getAnalysisSelection();
    const preferredY = !series.isMath && series.filteredY?.length ? series.filteredY : series.rawY;
    const preferredQuality = preferredY === series.filteredY ? series.filteredQuality : series.rawQuality;
    const measurements = Measurements.compute(
      { t: series.rawX, y: preferredY, quality: preferredQuality, selection },
      { edgeThresholds: { lowFraction: 0.1, highFraction: 0.9 } }
    );
    const events = EventDetector.detect({
      trace: series,
      selection,
      config: analysisCfg.trigger
    });
    const spectralY =
      analysisCfg.fftSource === 'raw'
        ? series.rawY
        : analysisCfg.fftSource === 'filtered' && series.filteredY?.length
          ? series.filteredY
          : preferredY;
    const spectralQuality = spectralY === series.filteredY ? series.filteredQuality : series.rawQuality;
    const spectral = SpectralMetrics.summarize(spectralY, series.rawX, {
      selection: analysisCfg.selectionOnly === false ? null : selection,
      windowType: analysisCfg.fftWindow,
      detrend: analysisCfg.fftDetrend,
      zeroPadMode: analysisCfg.fftZeroPad,
      zeroPadFactor: analysisCfg.fftZeroPadFactor,
      quality: spectralQuality,
      maxPeaks: analysisCfg.fftPeakCount,
      prominence: analysisCfg.fftPeakProminence,
      harmonicCount: analysisCfg.fftHarmonicCount,
      fundamentalHz: analysisCfg.fftHarmonicFundamental || undefined
    });
    return {
      series: { name: series.columnId, isMath: series.isMath },
      timestamp: new Date().toISOString(),
      selection,
      analysisConfig: analysisCfg,
      measurements,
      events,
      spectral,
      system: this.buildSystemSnapshot(analysisCfg, selection)
    };
  },

  buildSystemSnapshot(analysisCfg = State.ensureAnalysisConfig(), selection = State.getAnalysisSelection()) {
    const headers = (State.data.headers || []).filter((h) => h && h !== State.data.timeColumn);
    const inputId =
      !analysisCfg.systemInput || analysisCfg.systemInput === 'auto' ? headers[0] : analysisCfg.systemInput;
    const outputId =
      !analysisCfg.systemOutput || analysisCfg.systemOutput === 'auto'
        ? headers[1] || headers[0]
        : analysisCfg.systemOutput;
    if (!inputId || !outputId || inputId === outputId) return null;
    const rawX = getRawSeries(inputId).rawX;
    const inputSeries = getAlignedSeriesForColumn(inputId, rawX);
    const outputSeries = getAlignedSeriesForColumn(outputId, rawX);
    if (!inputSeries || !outputSeries) return null;
    const systemSelection = analysisCfg.systemSelectionOnly === false ? null : selection;
    const inputY = inputSeries.isMath ? inputSeries.rawY : inputSeries.filteredY || inputSeries.rawY;
    const outputY = outputSeries.isMath ? outputSeries.rawY : outputSeries.filteredY || outputSeries.rawY;
    const time = inputSeries.time.length <= outputSeries.time.length ? inputSeries.time : outputSeries.time;
    const delay = CrossChannel.estimateDelay(time, inputY, outputY, {
      selection: systemSelection,
      maxLagSeconds: analysisCfg.systemMaxLagSeconds
    });
    const frf = CrossChannel.computeTransferFunction(inputY, outputY, time, {
      selection: systemSelection,
      windowType: analysisCfg.fftWindow,
      detrend: analysisCfg.fftDetrend,
      zeroPadMode: analysisCfg.fftZeroPad,
      zeroPadFactor: analysisCfg.fftZeroPadFactor
    });
    return {
      input: inputId,
      output: outputId,
      delay,
      frf: {
        freq: frf.freq,
        magnitudeDb: frf.magnitudeDb,
        phaseDeg: frf.phaseDeg,
        coherence: frf.coherence,
        warnings: frf.warnings,
        meta: frf.meta
      }
    };
  },

  downloadMeasurementsCSV(): void {
    const snapshot = this.buildAnalysisSnapshot();
    if (!snapshot) return;
    const lines = ['Metric,Value'];
    Object.entries(snapshot.measurements.metrics || {}).forEach(([key, value]) => {
      lines.push(`${key},${value ?? ''}`);
    });
    downloadText(lines.join('\n'), 'measurements.csv', 'text/csv;charset=utf-8');
  },

  downloadMeasurementsJSON(): void {
    const snapshot = this.buildAnalysisSnapshot();
    if (!snapshot) return;
    downloadText(
      JSON.stringify(
        {
          generatedAt: snapshot.timestamp,
          trace: snapshot.series,
          selection: snapshot.selection,
          measurements: snapshot.measurements,
          analysis: snapshot.analysisConfig
        },
        null,
        2
      ),
      'measurements.json',
      'application/json'
    );
  },

  downloadEventsCSV(): void {
    const snapshot = this.buildAnalysisSnapshot();
    if (!snapshot) return;
    const rows = ['index,time,type,metadata'];
    snapshot.events.events.forEach((evt) => {
      rows.push([evt.index ?? '', evt.time ?? '', evt.type || '', JSON.stringify(evt.metadata || {})].join(','));
    });
    downloadText(rows.join('\n'), 'events.csv', 'text/csv;charset=utf-8');
  },

  downloadSystemJSON(): void {
    const snapshot = this.buildAnalysisSnapshot();
    if (!snapshot) return;
    if (!snapshot.system) {
      alert('Select two different input/output channels in the System panel first.');
      return;
    }
    downloadText(
      JSON.stringify(
        {
          generatedAt: snapshot.timestamp,
          selection: snapshot.selection,
          analysis: snapshot.analysisConfig,
          system: snapshot.system
        },
        null,
        2
      ),
      'system_frf.json',
      'application/json'
    );
  },

  downloadSpectralSummaryJSON(): void {
    const snapshot = this.buildAnalysisSnapshot();
    if (!snapshot) return;
    downloadText(
      JSON.stringify(
        {
          generatedAt: snapshot.timestamp,
          trace: snapshot.series,
          selection: snapshot.selection,
          analysis: snapshot.analysisConfig,
          spectral: {
            meta: snapshot.spectral.spectrum?.meta,
            peaks: snapshot.spectral.peaks,
            harmonics: snapshot.spectral.harmonics,
            thd: snapshot.spectral.thd,
            snr: snapshot.spectral.snr,
            spur: snapshot.spectral.spur,
            bandpower: snapshot.spectral.bandpower,
            fundamentalHz: snapshot.spectral.fundamentalHz,
            warnings: snapshot.spectral.warnings
          }
        },
        null,
        2
      ),
      'spectral_summary.json',
      'application/json'
    );
  },

  async downloadReport(): Promise<void> {
    const snapshot = this.buildAnalysisSnapshot();
    if (!snapshot) return;
    const graphDiv = document.getElementById('main-plot') as PlotlyHTMLElement | null;
    let imageData: string | null = null;
    if (graphDiv?.layout) {
      try {
        imageData = await Plotly.toImage(graphDiv, { format: 'png', width: 1280, height: 720 });
      } catch {
        imageData = null;
      }
    }
    const measurements = snapshot.measurements.metrics || {};
    const events = snapshot.events.events || [];
    const spectral = snapshot.spectral;
    const system = snapshot.system;
    const formatNumber = (value: unknown): string => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      const abs = Math.abs(value);
      return abs !== 0 && (abs < 0.001 || abs >= 1e6) ? value.toExponential(3) : value.toFixed(4);
    };
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>SignalForge Analysis Report</title>
<style>
  body { font-family: Segoe UI, Arial, sans-serif; background:#f7f9fc; color:#102a43; margin:20px; }
  h1, h2 { color:#0b2545; }
  .card { background:#fff; border:1px solid #d7deea; border-radius:8px; padding:16px; margin-bottom:16px; }
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
    <p><strong>Trace:</strong> ${snapshot.series.name || 'n/a'} ${snapshot.series.isMath ? '(math)' : ''}</p>
    <p><strong>Selection:</strong> ${snapshot.selection ? `${snapshot.selection.i0}–${snapshot.selection.i1}` : 'Full record'}</p>
    ${imageData ? `<img src="${imageData}" alt="Plot snapshot" style="max-width:100%;"/>` : '<p class="muted">Plot snapshot unavailable.</p>'}
  </div>
  <div class="card">
    <h2>Measurements</h2>
    <table><tr><th>Metric</th><th>Value</th></tr>${Object.entries(measurements)
      .map(([k, v]) => `<tr><td>${k}</td><td>${formatNumber(v)}</td></tr>`)
      .join('')}</table>
  </div>
  <div class="card">
    <h2>Events</h2>
    <p>${events.length} events detected.</p>
    <table><tr><th>#</th><th>Time</th><th>Type</th></tr>${events.map((evt) => `<tr><td>${evt.index ?? ''}</td><td>${formatNumber(evt.time)}</td><td>${evt.type}</td></tr>`).join('') || '<tr><td colspan="3">None</td></tr>'}</table>
  </div>
  <div class="card">
    <h2>Spectral Metrics</h2>
    <p>Fundamental ${formatNumber(spectral.fundamentalHz)} Hz · THD ${spectral.thd != null ? formatNumber(spectral.thd * 100) + ' %' : '—'} · SNR ${spectral.snr != null ? formatNumber(10 * Math.log10(Math.max(spectral.snr, 1e-12))) + ' dB' : '—'}</p>
  </div>
  <div class="card">
    <h2>System / FRF</h2>
    ${system ? `<p>${system.input} → ${system.output}: delay ${formatNumber(system.delay.delaySeconds)} s (${system.delay.delaySamples} samples), corr ${formatNumber(system.delay.correlationPeak)}</p>` : '<p class="muted">Need two channels to compute FRF.</p>'}
  </div>
</body>
</html>`;
    downloadText(html, 'analysis_report.html', 'text/html;charset=utf-8');
  }
};
