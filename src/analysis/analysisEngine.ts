import { State } from '../state';
import type { AnalysisEvent, AnalysisSelection } from '../types';

export const AnalysisTypes = {
  createSelection(params: Partial<AnalysisSelection> = {}): AnalysisSelection {
    const xMin = Number.isFinite(params.xMin) ? (params.xMin as number) : null;
    const xMax = Number.isFinite(params.xMax) ? (params.xMax as number) : null;
    return {
      xMin: xMin !== null && xMax !== null ? Math.min(xMin, xMax) : xMin,
      xMax: xMin !== null && xMax !== null ? Math.max(xMin, xMax) : xMax,
      i0: Number.isInteger(params.i0) ? (params.i0 as number) : null,
      i1: Number.isInteger(params.i1) ? (params.i1 as number) : null
    };
  },

  createEvent(params: Partial<AnalysisEvent> = {}): AnalysisEvent {
    return {
      index: Number.isInteger(params.index) ? (params.index as number) : null,
      time: Number.isFinite(params.time) ? (params.time as number) : null,
      type: params.type || 'unknown',
      metadata: params.metadata || {}
    };
  }
};

function normalizeRange(range: ArrayLike<number> | null | undefined): [number, number] | null {
  if (!range || range.length < 2) return null;
  const r0 = range[0];
  const r1 = range[1];
  if (!Number.isFinite(r0) || !Number.isFinite(r1)) return null;
  return [Math.min(r0, r1), Math.max(r0, r1)];
}

function isSameSelection(a: AnalysisSelection | null, b: AnalysisSelection | null): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.xMin === b.xMin && a.xMax === b.xMax && a.i0 === b.i0 && a.i1 === b.i1;
}

export function getSelectionIndices(
  xRange: ArrayLike<number> | Pick<AnalysisSelection, 'xMin' | 'xMax'> | null,
  tArray: ArrayLike<number> = []
): { i0: number | null; i1: number | null } {
  if (!xRange || tArray.length === 0) return { i0: null, i1: null };

  const normalizedRange =
    Array.isArray(xRange) ||
    (typeof (xRange as ArrayLike<number>).length === 'number' && !('xMin' in (xRange as object)))
      ? normalizeRange(xRange as ArrayLike<number>)
      : normalizeRange([(xRange as AnalysisSelection).xMin as number, (xRange as AnalysisSelection).xMax as number]);
  if (!normalizedRange) return { i0: null, i1: null };
  const [xMin, xMax] = normalizedRange;

  let startIndex: number | null = null;
  let endIndex: number | null = null;
  for (let i = 0; i < tArray.length; i += 1) {
    const tVal = tArray[i];
    if (!Number.isFinite(tVal)) continue;
    if (startIndex === null && tVal >= xMin) startIndex = i;
    if (tVal <= xMax) endIndex = i;
    if (tVal > xMax && startIndex !== null) break;
  }
  return { i0: startIndex, i1: endIndex };
}

const selectionListeners = new Set<(selection: AnalysisSelection | null) => void>();

export const AnalysisEngine = {
  onSelectionChange(callback: (selection: AnalysisSelection | null) => void): () => void {
    selectionListeners.add(callback);
    return () => selectionListeners.delete(callback);
  },

  notifySelection(selection: AnalysisSelection | null): void {
    selectionListeners.forEach((cb) => {
      try {
        cb(selection);
      } catch (e) {
        console.error('AnalysisEngine listener error', e);
      }
    });
  },

  setSelection(selection: AnalysisSelection | null): AnalysisSelection | null {
    const current = State.getAnalysisSelection();
    if (isSameSelection(current, selection)) return current;
    State.setAnalysisSelection(selection);
    this.notifySelection(selection);
    return selection;
  },

  clearSelection(): AnalysisSelection | null {
    return this.setSelection(null);
  },

  updateSelectionFromRange(
    range: ArrayLike<number> | null | undefined,
    timeArray: ArrayLike<number> = []
  ): AnalysisSelection | null {
    const normalizedRange = normalizeRange(range);
    if (!normalizedRange) return this.clearSelection();
    const [xMin, xMax] = normalizedRange;
    const indices = getSelectionIndices(normalizedRange, timeArray);
    return this.setSelection(AnalysisTypes.createSelection({ xMin, xMax, ...indices }));
  }
};
