import { applyXOffset, Filter } from '../processing/filter';
import { MathEngine } from '../processing/math';
import { combineQualityMasks } from '../data/quality';
import { State } from '../state';
import type { ColumnSeries, SeriesPair } from '../types';
import { timeScaleToSeconds } from '../units/units';
import { toNumber } from './utils';

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
      State.data.timeColumn ? State.data.quality[State.data.timeColumn] : null
    );
    return { columnId, rawY, rawQuality, filteredY: null, filteredQuality: null, time, isMath: true };
  }

  if (!State.data.headers.includes(columnId)) return null;
  const rawY = State.data.columns[columnId]
    ? Array.from(State.data.columns[columnId])
    : State.data.raw.map((row) => toNumber(row[columnId]));
  const time = rawX.slice(0, rawY.length);
  const rawQuality = combineQualityMasks(
    rawY.length,
    State.data.quality[columnId],
    State.data.timeColumn ? State.data.quality[State.data.timeColumn] : null
  );
  const filtered = Filter.applyPipelineWithReport(rawY, time, State.getPipelineForColumn(columnId), rawQuality);
  return {
    columnId,
    rawY,
    rawQuality,
    filteredY: filtered.values,
    filteredQuality: filtered.quality,
    time,
    isMath: false
  };
}

export function getAlignedSeriesForColumn(columnId: string | null, rawX: number[]): ColumnSeries | null {
  const series = getSeriesForColumn(columnId, rawX);
  if (!series) return null;
  const offset = State.getTraceConfig(columnId).xOffset || 0;
  if (!offset) return series;
  return {
    ...series,
    rawY: applyXOffset(series.rawY, offset),
    filteredY: series.filteredY ? applyXOffset(series.filteredY, offset) : null
  };
}
