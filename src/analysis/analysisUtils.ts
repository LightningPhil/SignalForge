import type { AnalysisSelection } from '../types';

export function toNumberArray(arr: ArrayLike<number> = []): number[] {
  const out: number[] = [];
  for (let i = 0; i < arr.length; i += 1) {
    const v = Number(arr[i]);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

export function toFinitePairs(
  tArr: ArrayLike<number> = [],
  yArr: ArrayLike<number> = []
): { t: number[]; y: number[]; indices: number[] } {
  const t: number[] = [];
  const y: number[] = [];
  const indices: number[] = [];
  const limit = Math.min(tArr.length || 0, yArr.length || 0);
  for (let i = 0; i < limit; i += 1) {
    const ti = Number(tArr[i]);
    const yi = Number(yArr[i]);
    if (Number.isFinite(ti) && Number.isFinite(yi)) {
      t.push(ti);
      y.push(yi);
      indices.push(i);
    }
  }
  return { t, y, indices };
}

export function clampIndices(
  i0: number | null | undefined,
  i1: number | null | undefined,
  maxLen: number
): [number, number] {
  const start = Math.max(0, Math.min(Number.isInteger(i0) ? (i0 as number) : 0, maxLen - 1));
  const end = Math.max(start, Math.min(Number.isInteger(i1) ? (i1 as number) : maxLen - 1, maxLen - 1));
  return [start, end];
}

export function sliceSeries(
  t: number[],
  y: number[],
  selection?: Pick<AnalysisSelection, 'i0' | 'i1'> | null,
  sourceIndices: number[] = Array.from({ length: Math.min(t.length, y.length) }, (_, index) => index)
): { t: number[]; y: number[]; indices: number[]; selection: { i0: number | null; i1: number | null } } {
  const maxLen = Math.min(t.length, y.length);
  if (maxLen === 0) return { t: [], y: [], indices: [], selection: { i0: null, i1: null } };

  if (!selection || selection.i0 === null || selection.i1 === null) {
    return {
      t: t.slice(0, maxLen),
      y: y.slice(0, maxLen),
      indices: sourceIndices.slice(0, maxLen),
      selection: { i0: sourceIndices[0] ?? 0, i1: sourceIndices[maxLen - 1] ?? maxLen - 1 }
    };
  }

  const selectedPositions: number[] = [];
  for (let position = 0; position < maxLen; position += 1) {
    const sourceIndex = sourceIndices[position] ?? position;
    if (sourceIndex >= Math.min(selection.i0, selection.i1) && sourceIndex <= Math.max(selection.i0, selection.i1)) {
      selectedPositions.push(position);
    }
  }
  if (selectedPositions.length === 0) {
    return { t: [], y: [], indices: [], selection: { i0: null, i1: null } };
  }
  const start = selectedPositions[0];
  const end = selectedPositions[selectedPositions.length - 1];
  return {
    t: t.slice(start, end + 1),
    y: y.slice(start, end + 1),
    indices: sourceIndices.slice(start, end + 1),
    selection: { i0: sourceIndices[start] ?? start, i1: sourceIndices[end] ?? end }
  };
}
