import type { AnalysisSelection, AnalysisSeries, CsvValue } from '../types';

export function toNumber(value: CsvValue): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value == null || value === '') return Number.NaN;
  return parseFloat(String(value));
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function debounce<T extends (...args: never[]) => void>(fn: T, delay = 300): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function formatSeconds(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return 'n/a';
  const numeric = value as number;
  const abs = Math.abs(numeric);
  if (abs < 1e-6) return `${(numeric * 1e9).toFixed(3)} ns`;
  if (abs < 1e-3) return `${(numeric * 1e6).toFixed(3)} µs`;
  if (abs < 1) return `${(numeric * 1e3).toFixed(3)} ms`;
  if (abs >= 1000) return `${numeric.toExponential(3)} s`;
  return `${numeric.toFixed(6).replace(/\.0+$/, '').replace(/\.([0-9]*?)0+$/, '.$1')} s`;
}

export function selectionKey(selection: AnalysisSelection | null | undefined): string {
  if (!selection || selection.i0 === null || selection.i1 === null) return 'full';
  return `${selection.i0}-${selection.i1}`;
}

export function seriesSignature(series: Partial<AnalysisSeries> = {}, sourceLabel = 'raw'): string {
  const { rawX = [], rawY = [], filteredY = [], seriesName = 'series', isMath = false } = series;
  const y = sourceLabel === 'filtered' && filteredY?.length ? filteredY : rawY;
  return [
    seriesName,
    isMath ? 'math' : 'raw',
    sourceLabel,
    rawX.length,
    y.length,
    rawX[0] ?? 0,
    rawX[rawX.length - 1] ?? 0,
    y[0] ?? 0,
    y[y.length - 1] ?? 0
  ].join('|');
}
