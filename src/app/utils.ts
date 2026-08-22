import type { CsvValue } from '../types';

export function toNumber(value: CsvValue): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value == null || value === '') return Number.NaN;
  return parseFloat(String(value));
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
