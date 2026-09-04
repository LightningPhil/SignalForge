import { State } from '../state';
import type { ComposerAlignment, ComposerTrace } from '../types';
import { applyXOffset } from './filter';

export function applyComposerOffsets(
  rawY: ArrayLike<number> = [],
  filteredY: ArrayLike<number> | null = [],
  composerTrace: Partial<ComposerTrace> = {}
): ComposerAlignment {
  const { columnId, yOffset = 0 } = composerTrace;
  const { xOffset = 0 } = State.getTraceConfig(columnId || null);

  const shiftedRaw = applyXOffset(rawY, xOffset);
  const filtered = filteredY ? Array.from(filteredY) : [];
  const shiftedFiltered = filtered.length > 0 ? applyXOffset(filtered, xOffset) : [];

  return {
    adjustedRawY: yOffset ? shiftedRaw.map((v) => v + yOffset) : shiftedRaw,
    adjustedFilteredY:
      yOffset && shiftedFiltered.length > 0 ? shiftedFiltered.map((v) => v + yOffset) : shiftedFiltered,
    xOffset,
    yOffset
  };
}

export function getComposerTrace(viewId: string | null, columnId: string | null): ComposerTrace & { xOffset: number } {
  const composer = State.getComposer(viewId || null);
  const trace = composer.traces.find((t) => t.columnId === columnId);
  const config = State.getTraceConfig(columnId);
  return {
    columnId: columnId || '',
    xOffset: config.xOffset || 0,
    yOffset: trace?.yOffset || 0
  };
}
