import type { CsvRow, CsvValue, QualityMasks } from '../types';

export const QualityFlag = {
  None: 0,
  Missing: 1 << 0,
  Invalid: 1 << 1,
  Clipped: 1 << 2,
  Saturated: 1 << 3,
  Interpolated: 1 << 4,
  UserEdited: 1 << 5,
  NonMonotonicTime: 1 << 6,
  ForwardFilled: 1 << 7,
  Processed: 1 << 8
} as const;

export type QualityFlagValue = (typeof QualityFlag)[keyof typeof QualityFlag];

export const AnalysisExclusionMask =
  QualityFlag.Missing |
  QualityFlag.Invalid |
  QualityFlag.Clipped |
  QualityFlag.Saturated |
  QualityFlag.NonMonotonicTime;

export function combineQualityMasks(
  length: number,
  ...masks: Array<ArrayLike<number> | null | undefined>
): Uint16Array {
  const combined = new Uint16Array(Math.max(0, length));
  for (const mask of masks) {
    if (!mask) continue;
    for (let index = 0; index < Math.min(combined.length, mask.length); index += 1) {
      combined[index] |= Number(mask[index]) || QualityFlag.None;
    }
  }
  return combined;
}

export function maskValuesForAnalysis(
  values: ArrayLike<number>,
  quality: ArrayLike<number> | null | undefined
): { values: number[]; excluded: number } {
  const masked = new Array<number>(values.length);
  let excluded = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = Number(values[index]);
    if (((Number(quality?.[index]) || QualityFlag.None) & AnalysisExclusionMask) !== 0) {
      masked[index] = Number.NaN;
      excluded += 1;
    } else {
      masked[index] = value;
    }
  }
  return { values: masked, excluded };
}

const NUMERIC_PATTERN = /^[+-]?(?:\d+\.\d*|\d*\.\d+|\d+)(?:e[+-]?\d+)?$/i;
const CLIPPED_PATTERN = /^(?:clip(?:ped|ping)?|over(?:flow|range)?|under(?:flow|range)?|\*+)$/i;
const SATURATED_PATTERN = /^(?:sat(?:urated|uration)?|high|low)$/i;

export function parseNumericValue(value: CsvValue): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!NUMERIC_PATTERN.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function classifyQuality(value: CsvValue): QualityFlagValue {
  if (value === null || value === undefined) return QualityFlag.Missing;
  if (typeof value === 'number') return Number.isFinite(value) ? QualityFlag.None : QualityFlag.Invalid;
  if (typeof value === 'boolean') return QualityFlag.Invalid;
  const trimmed = value.trim();
  if (trimmed === '') return QualityFlag.Missing;
  if (CLIPPED_PATTERN.test(trimmed)) return QualityFlag.Clipped;
  if (SATURATED_PATTERN.test(trimmed)) return QualityFlag.Saturated;
  if (parseNumericValue(trimmed) === null) return QualityFlag.Invalid;
  return QualityFlag.None;
}

export function buildQualityMasks(rows: CsvRow[], headers: string[], timeColumn: string | null): QualityMasks {
  const masks: QualityMasks = {};
  for (const header of headers) {
    const mask = new Uint16Array(rows.length);
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      mask[rowIndex] = classifyQuality(rows[rowIndex]?.[header]);
    }
    masks[header] = mask;
  }

  if (timeColumn && masks[timeColumn]) {
    let previous = -Infinity;
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const current = parseNumericValue(rows[rowIndex]?.[timeColumn]);
      if (current === null) continue;
      if (!(current > previous)) masks[timeColumn][rowIndex] |= QualityFlag.NonMonotonicTime;
      previous = current;
    }
  }
  return masks;
}

export function qualityFlagNames(mask: number): string[] {
  const names: string[] = [];
  for (const [name, flag] of Object.entries(QualityFlag)) {
    if (flag !== QualityFlag.None && (mask & flag) !== 0) names.push(name);
  }
  return names;
}

export function cloneQualityMasks(masks: QualityMasks): QualityMasks {
  return Object.fromEntries(Object.entries(masks).map(([column, mask]) => [column, mask.slice()]));
}
