import { applyXOffset, Filter, shiftQualityMask } from '../processing/filter';
import { MathEngine } from '../processing/math';
import { combineQualityMasks } from '../data/quality';
import { State } from '../state';
import type { ColumnSeries, SeriesPair } from '../types';
import { timeScaleToSeconds } from '../units/units';
import { toNumber } from './utils';
import { buildFilterExecutionContext, filterExecutionContextKey } from './filterContext';

export function getTimeArray(): number[] {
  const xCol = State.data.timeColumn;
  if (!xCol || !State.data.raw.length) return [];
  const values = State.data.columns[xCol]
    ? Array.from(State.data.columns[xCol])
    : State.data.raw.map((row) => toNumber(row[xCol]));
  const scale = timeScaleToSeconds(xCol);
  return scale === 1 ? values : values.map((value) => value * scale);
}

export function getRawSeries(columnId: string | null = null): SeriesPair {
  const yCol = columnId || State.data.dataColumn;
  const xCol = State.data.timeColumn;
  if (!yCol || !xCol || !State.data.raw.length) return { rawX: [], rawY: [] };

  const mathDef = State.getMathDefinition(yCol);
  let rawX = getTimeArray();
  let rawY: number[] = [];

  if (mathDef) {
    const mathResult = MathEngine.calculateVirtualColumn(mathDef, rawX);
    rawY = mathResult.values || [];
    rawX = mathResult.time.length ? mathResult.time : rawX.slice(0, rawY.length);
  } else if (State.data.headers.includes(yCol)) {
    rawY = State.data.columns[yCol]
      ? Array.from(State.data.columns[yCol])
      : State.data.raw.map((row) => toNumber(row[yCol]));
    rawX = rawX.slice(0, rawY.length);
  }

  return { rawX, rawY };
}

export function getSeriesForColumn(columnId: string | null, rawX: number[]): ColumnSeries | null {
  if (!columnId) return null;
  const mathDef = State.getMathDefinition(columnId);

  if (mathDef) {
    const result = MathEngine.calculateVirtualColumn(mathDef, rawX);
    const rawY = result.values || [];
    const time = result.time.length ? result.time : rawX.slice(0, rawY.length);
    const rawQuality = combineQualityMasks(
      rawY.length,
      result.quality,
      State.data.timeColumn ? State.data.quality[State.data.timeColumn] : null
    );
    return { columnId, rawY, rawQuality, filteredY: null, filteredQuality: null, time, isMath: true };
  }

  if (!State.data.headers.includes(columnId)) return null;
  if (columnSeriesGeneration !== State.data.generation) {
    // Any grid change (load, append, repair, undo/redo) releases every memoised series at once.
    columnSeriesMemo.clear();
    columnSeriesGeneration = State.data.generation;
  }
  const memoKey = columnSeriesKey(columnId, rawX);
  const memo = columnSeriesMemo.get(columnId);
  if (memo && memo.key === memoKey) return memo.series;

  const rawY = State.data.columns[columnId]
    ? Array.from(State.data.columns[columnId])
    : State.data.raw.map((row) => toNumber(row[columnId]));
  const time = rawX.slice(0, rawY.length);
  const rawQuality = combineQualityMasks(
    rawY.length,
    State.data.quality[columnId],
    State.data.timeColumn ? State.data.quality[State.data.timeColumn] : null
  );
  const filtered = Filter.applyPipelineWithReport(
    rawY,
    time,
    State.getPipelineForColumn(columnId),
    rawQuality,
    buildFilterExecutionContext(columnId, time)
  );
  const series: ColumnSeries = {
    columnId,
    rawY,
    rawQuality,
    filteredY: filtered.values,
    filteredQuality: filtered.quality,
    time,
    isMath: false
  };
  rememberColumnSeries(columnId, memoKey, series);
  return series;
}

/**
 * Synchronous per-column pipeline results are memoised so that side panels (System, exports) that
 * re-read the same column after a pipeline run do not re-filter the full record on the main thread.
 * The key covers the same inputs as the Multi View preparation key plus the timebase actually passed in.
 * Consumers treat the returned arrays as read-only; nothing in the app mutates a ColumnSeries in place.
 */
const MAX_COLUMN_SERIES_MEMO = 16;
const columnSeriesMemo = new Map<string, { key: string; series: ColumnSeries }>();
let columnSeriesGeneration = -1;

function columnSeriesKey(columnId: string, rawX: number[]): string {
  return `${multiViewPreparationKey([columnId])}|${filterExecutionContextKey(columnId)}|${rawX.length}|${rawX[0]}|${rawX[rawX.length - 1]}`;
}

function rememberColumnSeries(columnId: string, key: string, series: ColumnSeries): void {
  columnSeriesMemo.delete(columnId);
  columnSeriesMemo.set(columnId, { key, series });
  while (columnSeriesMemo.size > MAX_COLUMN_SERIES_MEMO) {
    const oldest = columnSeriesMemo.keys().next().value;
    if (oldest === undefined) break;
    columnSeriesMemo.delete(oldest);
  }
}

export function forgetColumnSeries(): void {
  columnSeriesMemo.clear();
}

// Replacing the data set (new file, shot switch, session load) drops every memoised series so stale
// arrays are released immediately rather than lingering until their key happens to be missed.
State.onDataReplace(() => {
  forgetColumnSeries();
  forgetPreparedMultiViews();
});

/**
 * Worker-prepared Multi View series are remembered so that zooming or panning re-renders the plot
 * instead of re-running every column's pipeline. The key captures everything the prepared series
 * depend on: the column set, each column's pipeline, and the working data grid (length + repair cursor).
 */
const preparedMultiViews = new Map<string, { key: string; seriesList: ColumnSeries[] }>();

export function multiViewPreparationKey(columnIds: string[]): string {
  const pipelines = columnIds.map((columnId) =>
    State.getMathDefinition(columnId)
      ? { math: State.getMathDefinition(columnId) }
      : State.getPipelineForColumn(columnId)
  );
  return JSON.stringify({
    columnIds,
    pipelines,
    rows: State.data.raw.length,
    repairCursor: State.data.repairCursor,
    generation: State.data.generation,
    executionContexts: columnIds.map((columnId) => filterExecutionContextKey(columnId)),
    timeColumn: State.data.timeColumn,
    source: State.data.source ? [State.data.source.name, State.data.source.size, State.data.source.lastModified] : null
  });
}

export function rememberPreparedMultiView(viewId: string, columnIds: string[], seriesList: ColumnSeries[]): void {
  preparedMultiViews.set(viewId, { key: multiViewPreparationKey(columnIds), seriesList });
}

export function recallPreparedMultiView(viewId: string, columnIds: string[]): ColumnSeries[] | null {
  const cached = preparedMultiViews.get(viewId);
  if (!cached || cached.key !== multiViewPreparationKey(columnIds)) return null;
  return cached.seriesList;
}

export function forgetPreparedMultiViews(): void {
  preparedMultiViews.clear();
}

export function getAlignedSeriesForColumn(columnId: string | null, rawX: number[]): ColumnSeries | null {
  const series = getSeriesForColumn(columnId, rawX);
  if (!series) return null;
  const offset = State.getTraceConfig(columnId).xOffset || 0;
  if (!offset) return series;
  return {
    ...series,
    rawY: applyXOffset(series.rawY, offset),
    rawQuality: shiftQualityMask(series.rawQuality, offset, series.rawY),
    filteredY: series.filteredY ? applyXOffset(series.filteredY, offset) : null,
    filteredQuality:
      series.filteredY && series.filteredQuality
        ? shiftQualityMask(series.filteredQuality, offset, series.filteredY)
        : series.filteredQuality
  };
}
