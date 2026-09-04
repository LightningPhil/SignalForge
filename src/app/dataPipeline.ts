import { Filter } from '../processing/filter';
import { FIR_UNIFORM_TOLERANCE } from '../processing/fir';
import { analyzeTimebase } from '../processing/sampling';
import { combineQualityMasks } from '../data/quality';
import { State } from '../state';
import type { AnalysisSeries, ColumnSeries, ViewRange } from '../types';
import { EventPanel } from '../ui/eventPanel';
import { Graph } from '../ui/graph';
import { MeasurementPanel } from '../ui/measurementPanel';
import { SpectralPanel } from '../ui/spectralPanel';
import { SystemPanel } from '../ui/systemPanel';
import { AnalysisWorkerTaskError, analysisWorkerClient } from '../workers/client';
import type { FilterWorkerResult } from '../workers/protocol';
import { getRawSeries, getSeriesForColumn } from './traceData';

let activePipelineTask: AbortController | null = null;
let pipelineGeneration = 0;

function notifyPipelineReport(): void {
  document.dispatchEvent(new CustomEvent('signalforge:pipeline-report'));
}

export function hasData(alertUser = true): boolean {
  if (!State.data.raw.length) {
    if (alertUser) alert('Please load a CSV file first.');
    return false;
  }
  return true;
}

function toAnalysisSeries(
  rawX: number[],
  rawY: number[],
  rawQuality: Uint16Array,
  filteredY: number[] | null,
  filteredQuality: Uint16Array | null,
  seriesName: string,
  isMath: boolean
): AnalysisSeries {
  return { rawX, rawY, rawQuality, filteredY, filteredQuality, seriesName, columnId: seriesName, isMath };
}

function qualityForColumn(columnId: string, length: number): Uint16Array {
  return combineQualityMasks(
    length,
    State.data.quality[columnId],
    State.data.timeColumn ? State.data.quality[State.data.timeColumn] : null
  );
}

function firDesignsForCurrentTimebase(pipeline: ReturnType<typeof State.getPipeline>, time: number[]) {
  const analysis = analyzeTimebase(time, FIR_UNIFORM_TOLERANCE);
  return analysis.valid && analysis.uniform ? Filter.serializeFirDesigns(pipeline, analysis.sampleRate) : [];
}

function pushSeriesToPanels(series: AnalysisSeries | null): void {
  if (!series) {
    MeasurementPanel.clear();
    EventPanel.clear();
    SpectralPanel.clear();
    SystemPanel.refreshFromState();
    return;
  }
  MeasurementPanel.setSeries(series);
  EventPanel.setSeries(series);
  SpectralPanel.setSeries(series);
  SystemPanel.refreshFromState();
}

async function runMultiViewWithWorkers(
  viewId: string,
  columnIds: string[],
  range: ViewRange | null,
  generation: number,
  controller: AbortController
): Promise<void> {
  const seriesList: ColumnSeries[] = [];
  for (let columnIndex = 0; columnIndex < columnIds.length; columnIndex += 1) {
    if (controller.signal.aborted || generation !== pipelineGeneration) return;
    const columnId = columnIds[columnIndex];
    const { rawX, rawY } = getRawSeries(columnId);
    const isMath = !!State.getMathDefinition(columnId);
    if (isMath) {
      const series = getSeriesForColumn(columnId, rawX);
      if (series) seriesList.push(series);
      continue;
    }

    const inputQuality = qualityForColumn(columnId, rawY.length);
    const pipeline = State.getPipelineForColumn(columnId);
    Graph.setStatus(`Filtering ${columnId} · ${columnIndex + 1}/${columnIds.length}`);
    try {
      const result = await analysisWorkerClient.run<FilterWorkerResult>(
        {
          kind: 'filter',
          signal: Float64Array.from(rawY),
          time: Float64Array.from(rawX),
          quality: inputQuality.slice(),
          pipeline: State.clonePipeline(pipeline)
        },
        {
          signal: controller.signal,
          transferOwnership: true,
          onProgress: (progress, stage) =>
            Graph.setStatus(
              `${columnId} · ${stage} · ${Math.round(progress * 100)}% · ${columnIndex + 1}/${columnIds.length}`
            )
        }
      );
      seriesList.push({
        columnId,
        rawY,
        rawQuality: inputQuality,
        filteredY: result.values,
        filteredQuality: result.quality,
        time: rawX,
        isMath: false
      });
      if (columnIndex === 0) {
        State.data.processed = result.values;
        State.data.processedQuality = result.quality;
        State.data.pipelineReport = result.steps;
        State.data.firDesigns = result.firDesigns;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Background pipeline failed for ${columnId}.`, error);
      document.dispatchEvent(new CustomEvent('signalforge:data-warning', { detail: `${columnId}: ${message}` }));
      seriesList.push({
        columnId,
        rawY,
        rawQuality: inputQuality,
        filteredY: null,
        filteredQuality: null,
        time: rawX,
        isMath: false
      });
    }
  }
  if (controller.signal.aborted || generation !== pipelineGeneration || State.ui.activeMultiViewId !== viewId) return;
  notifyPipelineReport();
  const primary = seriesList[0];
  pushSeriesToPanels(
    primary
      ? toAnalysisSeries(
          primary.time,
          primary.rawY,
          primary.rawQuality,
          primary.filteredY,
          primary.filteredQuality,
          primary.columnId,
          primary.isMath
        )
      : null
  );
  Graph.renderPreparedMultiView(seriesList, range, viewId);
}

export function runPipelineAndRender(range: ViewRange | null = null): void {
  activePipelineTask?.abort();
  activePipelineTask = null;
  const generation = ++pipelineGeneration;
  if (!hasData(false)) return;

  if (State.ui.activeMultiViewId) {
    const activeView = State.multiViews.find((v) => v.id === State.ui.activeMultiViewId);
    const viewId = activeView?.id;
    const requiresWorker =
      !!activeView &&
      typeof Worker !== 'undefined' &&
      activeView.activeColumnIds.some((columnId) => {
        if (State.getMathDefinition(columnId)) return false;
        const source = getRawSeries(columnId);
        const pipeline = State.getPipelineForColumn(columnId);
        return source.rawY.length >= 100_000 || Filter.shouldRunFirInWorker(pipeline, source.rawX, source.rawY.length);
      });
    if (requiresWorker && activeView && viewId) {
      State.data.firDesigns = [];
      const controller = new AbortController();
      activePipelineTask = controller;
      void runMultiViewWithWorkers(viewId, activeView.activeColumnIds, range, generation, controller);
      return;
    }
    const targetCol = activeView?.activeColumnIds?.[0] || null;
    if (targetCol) {
      const { rawX } = getRawSeries(targetCol);
      const series = getSeriesForColumn(targetCol, rawX);
      if (!series) return;
      pushSeriesToPanels(
        toAnalysisSeries(
          series.time,
          series.rawY,
          series.rawQuality,
          series.filteredY,
          series.filteredQuality,
          targetCol,
          series.isMath
        )
      );
    } else {
      pushSeriesToPanels(null);
    }
    Graph.renderMultiViewFromState(range);
    return;
  }

  const { rawX, rawY } = getRawSeries();
  if (!rawX.length || !rawY.length) return;

  const isMath = !!State.getMathDefinition(State.data.dataColumn);
  const seriesName = State.data.dataColumn || 'Series';
  const inputQuality = qualityForColumn(seriesName, rawY.length);
  if (isMath) {
    State.data.processed = [];
    State.data.processedQuality = new Uint16Array(0);
    State.data.pipelineReport = [];
    State.data.firDesigns = [];
    notifyPipelineReport();
    pushSeriesToPanels(toAnalysisSeries(rawX, rawY, inputQuality, null, null, seriesName, true));
    Graph.render(rawX, rawY, null, range, { isMath: true, seriesName, rawQuality: inputQuality });
    return;
  }

  const pipeline = State.getPipeline();
  if (
    (rawY.length >= 100_000 || Filter.shouldRunFirInWorker(pipeline, rawX, rawY.length)) &&
    typeof Worker !== 'undefined'
  ) {
    State.data.firDesigns = [];
    const controller = new AbortController();
    activePipelineTask = controller;
    void analysisWorkerClient
      .run<FilterWorkerResult>(
        {
          kind: 'filter',
          signal: Float64Array.from(rawY),
          time: Float64Array.from(rawX),
          quality: inputQuality.slice(),
          pipeline: State.clonePipeline(pipeline)
        },
        {
          signal: controller.signal,
          transferOwnership: true,
          onProgress: (progress, stage) => Graph.setStatus(`${stage} · ${Math.round(progress * 100)}%`)
        }
      )
      .then((result) => {
        if (generation !== pipelineGeneration || controller.signal.aborted) return;
        State.data.processed = result.values;
        State.data.processedQuality = result.quality;
        State.data.pipelineReport = result.steps;
        State.data.firDesigns = result.firDesigns;
        notifyPipelineReport();
        pushSeriesToPanels(
          toAnalysisSeries(rawX, rawY, inputQuality, result.values, result.quality, seriesName, false)
        );
        Graph.render(rawX, rawY, result.values, range, {
          rawQuality: inputQuality,
          filteredQuality: result.quality
        });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (generation !== pipelineGeneration) return;
        if (error instanceof AnalysisWorkerTaskError) {
          console.error('Background pipeline task failed.', error);
          State.data.processed = [];
          State.data.processedQuality = new Uint16Array(0);
          State.data.pipelineReport = [];
          State.data.firDesigns = [];
          notifyPipelineReport();
          pushSeriesToPanels(toAnalysisSeries(rawX, rawY, inputQuality, null, null, seriesName, false));
          Graph.render(rawX, rawY, null, range, { rawQuality: inputQuality, filteredQuality: null });
          Graph.setStatus(`Pipeline failed: ${error.message}`);
          document.dispatchEvent(new CustomEvent('signalforge:data-warning', { detail: error.message }));
          return;
        }
        console.error('Background pipeline failed; using the synchronous path.', error);
        try {
          const filtered = Filter.applyPipelineWithReport(rawY, rawX, pipeline, inputQuality);
          State.data.processed = filtered.values;
          State.data.processedQuality = filtered.quality;
          State.data.pipelineReport = filtered.steps;
          State.data.firDesigns = firDesignsForCurrentTimebase(pipeline, rawX);
          notifyPipelineReport();
          pushSeriesToPanels(
            toAnalysisSeries(rawX, rawY, inputQuality, filtered.values, filtered.quality, seriesName, false)
          );
          Graph.render(rawX, rawY, filtered.values, range, {
            rawQuality: inputQuality,
            filteredQuality: filtered.quality
          });
        } catch (fallbackError) {
          const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          console.error('Synchronous pipeline fallback failed.', fallbackError);
          State.data.processed = [];
          State.data.processedQuality = new Uint16Array(0);
          State.data.pipelineReport = [];
          State.data.firDesigns = [];
          notifyPipelineReport();
          pushSeriesToPanels(toAnalysisSeries(rawX, rawY, inputQuality, null, null, seriesName, false));
          Graph.render(rawX, rawY, null, range, { rawQuality: inputQuality, filteredQuality: null });
          Graph.setStatus(`Pipeline failed: ${message}`);
          document.dispatchEvent(new CustomEvent('signalforge:data-warning', { detail: message }));
        }
      });
    return;
  }

  try {
    const filtered = Filter.applyPipelineWithReport(rawY, rawX, pipeline, inputQuality);
    State.data.processed = filtered.values;
    State.data.processedQuality = filtered.quality;
    State.data.pipelineReport = filtered.steps;
    State.data.firDesigns = firDesignsForCurrentTimebase(pipeline, rawX);
    notifyPipelineReport();
    pushSeriesToPanels(
      toAnalysisSeries(rawX, rawY, inputQuality, filtered.values, filtered.quality, seriesName, false)
    );
    Graph.render(rawX, rawY, filtered.values, range, {
      rawQuality: inputQuality,
      filteredQuality: filtered.quality
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    State.data.processed = [];
    State.data.processedQuality = new Uint16Array(0);
    State.data.pipelineReport = [];
    State.data.firDesigns = [];
    notifyPipelineReport();
    pushSeriesToPanels(toAnalysisSeries(rawX, rawY, inputQuality, null, null, seriesName, false));
    Graph.render(rawX, rawY, null, range, { rawQuality: inputQuality, filteredQuality: null });
    Graph.setStatus(`Pipeline failed: ${message}`);
    document.dispatchEvent(new CustomEvent('signalforge:data-warning', { detail: message }));
  }
}

export function triggerGraphUpdateOnly(): void {
  if (!hasData(false)) return;
  const range = Graph.lastRanges.x || Graph.lastRanges.y ? Graph.lastRanges : null;

  if (State.ui.activeMultiViewId) {
    Graph.renderMultiViewFromState(range);
    return;
  }

  const { rawX, rawY } = getRawSeries();
  const isMath = !!State.getMathDefinition(State.data.dataColumn);
  const filteredY = State.data.processed.length > 0 ? State.data.processed : null;
  const seriesName = State.data.dataColumn || 'Series';
  const rawQuality = qualityForColumn(seriesName, rawY.length);
  Graph.render(rawX, rawY, isMath ? null : filteredY, range, {
    isMath,
    seriesName,
    rawQuality,
    filteredQuality: isMath ? null : State.data.processedQuality
  });
}

if (typeof document !== 'undefined') {
  document.addEventListener('signalforge:request-pipeline-render', (event) => {
    const range = (event as CustomEvent<ViewRange | null>).detail;
    runPipelineAndRender(range || null);
  });
}

export { getRawSeries };
