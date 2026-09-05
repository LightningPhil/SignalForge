import Plotly from 'plotly.js-dist-min';
import type { Data, Layout, PlotlyHTMLElement } from 'plotly.js';
import { CrossChannel } from '../analysis/crossChannel';
import { EventDetector } from '../analysis/eventDetector';
import { Measurements } from '../analysis/measurements';
import { SpectralMetrics } from '../analysis/spectralMetrics';
import {
  buildAnalysisRecipePayload,
  buildProcessingRecipePayload,
  buildQualitySummary,
  buildSourceFingerprint,
  hashCanonicalJson
} from '../domain/provenance';
import { APP_BUILD_ID, APP_VERSION } from '../domain/version';
import { combineQualityMasks, qualityFlagNames } from '../data/quality';
import { MathEngine } from '../processing/math';
import { SessionWorkspace } from '../session/workspace';
import { State } from '../state';
import type { AnalysisSeries, ImageExportOptions, ThemeName } from '../types';
import { getAlignedSeriesForColumn, getRawSeries, getSeriesForColumn, getTimeArray } from '../app/traceData';
import { toNumber } from '../app/utils';
import { getColorsForTheme, hexToRgba } from '../ui/colors';
import { getPixelsPerCm } from '../ui/displayCalibration';
import { csvCell, csvRow } from './csvFormat';
import { downloadText } from './download';
import {
  buildReport,
  renderReportHtml,
  serializeReportJson,
  type ReportArtifacts,
  type ReportBuilderInput
} from './reportBuilder';

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

const MAX_ENGINEERING_JSON_ESTIMATE = 64 * 1024 * 1024;
const MAX_ENGINEERING_HTML_EVENTS = 1000;

function summarizedSpectral(spectral: Record<string, unknown>): Record<string, unknown> {
  const spectrum =
    spectral.spectrum && typeof spectral.spectrum === 'object' ? (spectral.spectrum as Record<string, unknown>) : null;
  return {
    ...spectral,
    spectrum: spectrum ? { meta: spectrum.meta ?? null, warnings: spectrum.warnings ?? [] } : null
  };
}

function summarizedSystem(system: unknown): unknown {
  if (!system || typeof system !== 'object') return system;
  const record = system as Record<string, unknown>;
  const frf = record.frf && typeof record.frf === 'object' ? (record.frf as Record<string, unknown>) : null;
  return {
    ...record,
    frf: frf ? { meta: frf.meta ?? null, warnings: frf.warnings ?? [] } : null
  };
}

function summarizedEvents(events: Record<string, unknown>): Record<string, unknown> {
  const records = Array.isArray(events.events) ? events.events : [];
  return {
    ...events,
    events: records.slice(0, MAX_ENGINEERING_HTML_EVENTS),
    totalEventCount: records.length,
    omittedEventCount: Math.max(0, records.length - MAX_ENGINEERING_HTML_EVENTS)
  };
}

function estimatedSerializedBytes(value: unknown, budget = MAX_ENGINEERING_JSON_ESTIMATE): number {
  const seen = new Set<object>();
  const visit = (candidate: unknown): number => {
    if (candidate === null || candidate === undefined) return 4;
    if (typeof candidate === 'string') return candidate.length * 2 + 2;
    if (typeof candidate === 'number') return 24;
    if (typeof candidate === 'boolean') return 5;
    if (typeof candidate !== 'object' || seen.has(candidate)) return 0;
    seen.add(candidate);
    if (ArrayBuffer.isView(candidate)) return candidate.byteLength * 3;
    if (candidate instanceof ArrayBuffer) return candidate.byteLength * 3;
    let total = 2;
    if (Array.isArray(candidate) && candidate.every((entry) => typeof entry === 'number')) {
      return Math.min(budget + 1, total + candidate.length * 24);
    }
    for (const [key, entry] of Object.entries(candidate)) {
      total += key.length * 2 + visit(entry);
      if (total > budget) return total;
    }
    return total;
  };
  return visit(value);
}

function reportStateFingerprint(): string {
  return JSON.stringify({
    generation: State.data.generation,
    dataColumn: State.data.dataColumn,
    activeMultiViewId: State.ui.activeMultiViewId,
    activeShotId: SessionWorkspace.activeShotId,
    activeShotUpdatedAt: SessionWorkspace.getActiveShot()?.updatedAt || null,
    selection: State.getAnalysisSelection(),
    analysis: State.ensureAnalysisConfig(),
    pipelineScope: State.config.pipelineScope,
    pipeline: State.config.pipeline,
    columnPipelines: State.config.columnPipelines,
    traceConfigs: State.traceConfigs,
    repairCursor: State.data.repairCursor,
    pipelineReport: State.data.pipelineReport
  });
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
      const series = getSeriesForColumn(col, rawTime);
      processedDataMap[col] = {
        raw: rawCol,
        filtered: series?.filteredY || rawCol,
        quality: series?.filteredQuality || State.data.quality[col]
      };
    });

    mathCols.forEach((name) => {
      const def = State.getMathDefinition(name);
      if (!def) return;
      const result = MathEngine.calculateVirtualColumn(def, rawTime);
      processedDataMap[name] = {
        raw: result.values || [],
        filtered: result.values || [],
        quality: result.quality,
        isMath: true
      };
    });

    const outputHeaders = [`${xCol} (Working)`];
    if (includeOriginal) {
      outputHeaders.push(`${xCol} (Original)`, `${xCol} (Original Quality)`, `${xCol} (Working Quality)`);
      numericCols.forEach((h) =>
        outputHeaders.push(`${h} (Original)`, `${h} (Working)`, `${h} (Original Quality)`, `${h} (Working Quality)`)
      );
    }
    numericCols.forEach((h) => outputHeaders.push(`${h} (Filtered)`, `${h} (Filtered Quality)`));
    mathCols.forEach((name) => outputHeaders.push(name, `${name} (Quality)`));

    const quoteCsv = csvCell;

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
      mathCols.forEach((name) => {
        rowData.push(quoteCsv(processedDataMap[name]?.raw[i]));
        rowData.push(quoteCsv(qualityFlagNames(processedDataMap[name]?.quality?.[i] || 0).join('|')));
      });
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
    return {
      rawX: series.time,
      rawY: series.rawY,
      rawQuality,
      filteredY: series.filteredY,
      filteredQuality: series.filteredQuality,
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

  async buildEngineeringReport(
    plotImageDataUrl: string | null = null,
    options: {
      detail?: 'summary' | 'full';
      expectedGeneration?: number;
      expectedStateFingerprint?: string;
      output?: 'html' | 'json' | 'both';
    } = {}
  ): Promise<ReportArtifacts | null> {
    const generation = State.data.generation;
    const stateFingerprint = reportStateFingerprint();
    if (options.expectedGeneration !== undefined && options.expectedGeneration !== generation) {
      throw new Error('The data changed while the report plot was being captured; export again.');
    }
    if (options.expectedStateFingerprint !== undefined && options.expectedStateFingerprint !== stateFingerprint) {
      throw new Error('The analysis settings changed while the report plot was being captured; export again.');
    }
    const snapshot = this.buildAnalysisSnapshot();
    const series = this.getActiveAnalysisSeries();
    if (!snapshot || !series) return null;
    const detail = options.detail || 'summary';
    const activeShot = SessionWorkspace.getActiveShot();
    const sessionSources = SessionWorkspace.activeSession?.shots.flatMap((candidate) => candidate.sourceFiles) || [];
    const sourceInputs = activeShot?.sourceFiles.length
      ? activeShot.sourceFiles.map((sourceFile) => {
          const sharedSourceId =
            typeof sourceFile.metadata.sharedSourceId === 'string' ? sourceFile.metadata.sharedSourceId : null;
          const byteSource =
            sourceFile.bytes || sessionSources.find((candidate) => candidate.id === sharedSourceId)?.bytes;
          return {
            name: sourceFile.name,
            size: byteSource?.byteLength ?? sourceFile.size,
            lastModified: sourceFile.lastModified,
            sourceFileId: sourceFile.id,
            sharedSourceId,
            adapterId: sourceFile.adapterId,
            bytes: byteSource
          };
        })
      : State.data.source
        ? [
            {
              name: State.data.source.name,
              size: State.data.source.size,
              lastModified: State.data.source.lastModified,
              sourceFileId: null,
              adapterId: 'workspace',
              bytes:
                State.data.source.bytes.byteLength > 0
                  ? State.data.source.bytes
                  : State.data.source.text
                    ? State.data.source.text
                    : null
            }
          ]
        : [];
    const activeRepairs = State.data.repairHistory.slice(0, State.data.repairCursor);
    const reportRepairs =
      detail === 'full'
        ? activeRepairs
        : activeRepairs.map((repair) => ({
            id: repair.id,
            label: repair.label,
            timestamp: repair.timestamp,
            changedCells: repair.changes.length
          }));
    const pipelineReport = structuredClone(State.data.pipelineReport);
    const completeProcessingRecipe = buildProcessingRecipePayload({
      columnId: series.columnId || series.seriesName,
      sourceMode: series.filteredY?.length ? 'filtered' : 'raw',
      isMath: series.isMath,
      pipeline: State.getPipelineForColumn(series.columnId || series.seriesName),
      pipelineReport,
      firDesigns: State.data.firDesigns,
      mathDefinitions: State.config.mathDefinitions,
      repairHistory: activeRepairs,
      repairCursor: State.data.repairCursor,
      traceConfig: State.getTraceConfig(series.columnId || series.seriesName)
    });
    const processingRecipe =
      detail === 'full'
        ? completeProcessingRecipe
        : {
            ...completeProcessingRecipe,
            repairHistory: reportRepairs,
            repairDisplay: 'Summary only; SHA-256 covers the complete active repair records.'
          };
    const analysisRecipe = buildAnalysisRecipePayload({
      config: snapshot.analysisConfig,
      selection: snapshot.selection,
      series: snapshot.series
    });
    const preferredQuality =
      !series.isMath && series.filteredQuality?.length ? series.filteredQuality : series.rawQuality;
    const spectralUsesRaw = snapshot.analysisConfig.fftSource === 'raw';
    const spectralQuality = spectralUsesRaw
      ? series.rawQuality
      : series.filteredQuality?.length
        ? series.filteredQuality
        : series.rawQuality;
    const spectralSelection = snapshot.analysisConfig.selectionOnly === false ? null : snapshot.selection;
    const eventSource = snapshot.analysisConfig.trigger.source;
    const eventQuality = eventSource === 'filtered' ? series.filteredQuality || series.rawQuality : series.rawQuality;
    const eventSelection = snapshot.analysisConfig.trigger.selectionOnly ? snapshot.selection : null;
    const moduleQuality: Record<string, unknown> = {
      measurements: {
        source: series.filteredY?.length ? 'filtered' : 'raw',
        summary: buildQualitySummary(preferredQuality, snapshot.selection)
      },
      events: {
        source: eventSource,
        summary: buildQualitySummary(eventQuality, eventSelection)
      },
      spectral: {
        source: spectralUsesRaw ? 'raw' : series.filteredY?.length ? 'filtered' : 'raw',
        summary: buildQualitySummary(spectralQuality, spectralSelection)
      }
    };
    if (snapshot.system) {
      const systemTime = getRawSeries(snapshot.system.input).rawX;
      const input = getAlignedSeriesForColumn(snapshot.system.input, systemTime);
      const output = getAlignedSeriesForColumn(snapshot.system.output, systemTime);
      const systemSelection = snapshot.analysisConfig.systemSelectionOnly === false ? null : snapshot.selection;
      moduleQuality.system = {
        input: snapshot.system.input,
        inputSummary: input ? buildQualitySummary(input.filteredQuality || input.rawQuality, systemSelection) : null,
        output: snapshot.system.output,
        outputSummary: output ? buildQualitySummary(output.filteredQuality || output.rawQuality, systemSelection) : null
      };
    }
    const reportSpectral =
      detail === 'full'
        ? snapshot.spectral
        : summarizedSpectral(snapshot.spectral as unknown as Record<string, unknown>);
    const reportSystem = detail === 'full' ? snapshot.system : summarizedSystem(snapshot.system);
    const reportEvents =
      detail === 'full' ? snapshot.events : summarizedEvents(snapshot.events as unknown as Record<string, unknown>);
    if (
      detail === 'full' &&
      estimatedSerializedBytes({
        source: sourceInputs.map((entry) => ({
          name: entry.name,
          size: entry.size,
          lastModified: entry.lastModified,
          sourceFileId: entry.sourceFileId,
          adapterId: entry.adapterId
        })),
        processingRecipe,
        analysisRecipe,
        quality: moduleQuality,
        measurements: snapshot.measurements,
        events: reportEvents,
        spectral: reportSpectral,
        system: reportSystem,
        pipelineReport
      }) > MAX_ENGINEERING_JSON_ESTIMATE
    ) {
      throw new Error(
        'The full engineering JSON report exceeds the 64 MiB export budget. Narrow the analysis selection or use the summary HTML report.'
      );
    }
    const [source, processingRecipeHash, analysisRecipeHash] = await Promise.all([
      Promise.all(
        sourceInputs.map(async ({ bytes, ...metadata }) => ({
          ...metadata,
          ...((typeof bytes === 'string' ? bytes.length > 0 : (bytes?.byteLength || 0) > 0)
            ? await buildSourceFingerprint({
                bytes: bytes as string | Uint8Array,
                name: metadata.name,
                size: metadata.size,
                lastModified: metadata.lastModified
              })
            : {
                sha256: null,
                note: 'Original source bytes are unavailable; no source hash is claimed.'
              })
        }))
      ),
      hashCanonicalJson(completeProcessingRecipe),
      hashCanonicalJson(analysisRecipe)
    ]);
    if (State.data.generation !== generation || reportStateFingerprint() !== stateFingerprint) {
      throw new Error(
        'The data or analysis settings changed while the engineering report was generated; export again.'
      );
    }
    const reportInput: ReportBuilderInput = {
      generatedAt: snapshot.timestamp,
      applicationVersion: APP_VERSION,
      buildId: APP_BUILD_ID,
      trace: snapshot.series,
      selection: snapshot.selection,
      source,
      processingRecipe,
      processingRecipeHash,
      analysisRecipe,
      analysisRecipeHash,
      quality: buildQualitySummary(preferredQuality, snapshot.selection),
      moduleQuality,
      measurements: snapshot.measurements,
      events: reportEvents,
      spectral: reportSpectral,
      system: reportSystem,
      pipeline: pipelineReport,
      confidence: snapshot.system
        ? {
            delayCorrelation: snapshot.system.delay.confidence,
            interpretation:
              'Dimensionless delay-correlation confidence; this is not a calibrated probability or uncertainty interval.'
          }
        : null,
      uncertainty: {
        status: 'not-quantified',
        intervals: null,
        note: 'No calibrated measurement uncertainty interval is available. Review source calibration, quality exclusions, numerical resolution and all listed warnings before engineering use.'
      },
      plotImageDataUrl
    };
    const report = buildReport(reportInput);
    return {
      report,
      html: options.output === 'json' ? '' : renderReportHtml(report),
      json: options.output === 'html' ? '' : serializeReportJson(report)
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
    const inputQuality = inputSeries.isMath
      ? inputSeries.rawQuality
      : inputSeries.filteredQuality || inputSeries.rawQuality;
    const outputQuality = outputSeries.isMath
      ? outputSeries.rawQuality
      : outputSeries.filteredQuality || outputSeries.rawQuality;
    const time = inputSeries.time.length <= outputSeries.time.length ? inputSeries.time : outputSeries.time;
    const delay = CrossChannel.estimateDelay(time, inputY, outputY, {
      selection: systemSelection,
      maxLagSeconds: analysisCfg.systemMaxLagSeconds,
      inputQuality,
      outputQuality
    });
    const frf = CrossChannel.computeTransferFunction(inputY, outputY, time, {
      selection: systemSelection,
      windowType: analysisCfg.fftWindow,
      detrend: analysisCfg.fftDetrend,
      zeroPadMode: analysisCfg.fftZeroPad,
      zeroPadFactor: analysisCfg.fftZeroPadFactor,
      inputQuality,
      outputQuality
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
      lines.push(csvRow([key, value]));
    });
    downloadText(lines.join('\r\n'), 'measurements.csv', 'text/csv;charset=utf-8');
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
      // The metadata JSON contains commas and quotes, so every cell goes through the RFC 4180 quoter.
      rows.push(csvRow([evt.index, evt.time, evt.type || '', JSON.stringify(evt.metadata || {})]));
    });
    downloadText(rows.join('\r\n'), 'events.csv', 'text/csv;charset=utf-8');
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
    if (!this.getActiveAnalysisSeries()) {
      alert('No active trace to analyze.');
      return;
    }
    const generation = State.data.generation;
    const stateFingerprint = reportStateFingerprint();
    const graphDiv = document.getElementById('main-plot') as PlotlyHTMLElement | null;
    let imageData: string | null = null;
    if (graphDiv?.layout) {
      try {
        imageData = await Plotly.toImage(graphDiv, { format: 'png', width: 1280, height: 720 });
      } catch {
        imageData = null;
      }
    }
    try {
      const artifacts = await this.buildEngineeringReport(imageData, {
        expectedGeneration: generation,
        expectedStateFingerprint: stateFingerprint,
        output: 'html'
      });
      if (artifacts) downloadText(artifacts.html, 'engineering_report.html', 'text/html;charset=utf-8');
    } catch (error) {
      alert(`Engineering report export failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },

  async downloadEngineeringReportJSON(): Promise<void> {
    try {
      const artifacts = await this.buildEngineeringReport(null, { detail: 'full', output: 'json' });
      if (artifacts) downloadText(artifacts.json, 'engineering_report.json', 'application/json');
    } catch (error) {
      alert(`Engineering report export failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
};
