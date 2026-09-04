import { classifyQuality, parseNumericValue, QualityFlag } from './quality';
import type { CsvRow, CsvValue } from '../types';

export interface DataRepairUpdate {
  rowIndex: number;
  columnId: string;
  value: CsvValue;
  quality: number;
}

function numeric(value: CsvValue): number | null {
  return parseNumericValue(value);
}

export function buildForwardFillUpdates(rows: CsvRow[], columnId: string): DataRepairUpdate[] {
  const updates: DataRepairUpdate[] = [];
  let previous: number | null = null;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const value = rows[rowIndex]?.[columnId];
    const parsed = numeric(value);
    if (parsed !== null) {
      previous = parsed;
    } else if (previous !== null) {
      updates.push({
        rowIndex,
        columnId,
        value: previous,
        quality: classifyQuality(value) | QualityFlag.ForwardFilled
      });
    }
  }
  return updates;
}

export function buildLinearInterpolationUpdates(
  rows: CsvRow[],
  timeColumn: string,
  columnId: string
): DataRepairUpdate[] {
  const updates: DataRepairUpdate[] = [];
  let left = -1;

  for (let index = 0; index < rows.length; index += 1) {
    if (numeric(rows[index]?.[columnId]) !== null && numeric(rows[index]?.[timeColumn]) !== null) {
      if (left >= 0 && index - left > 1) {
        const leftTime = numeric(rows[left][timeColumn]);
        const rightTime = numeric(rows[index][timeColumn]);
        const leftValue = numeric(rows[left][columnId]);
        const rightValue = numeric(rows[index][columnId]);
        if (
          leftTime !== null &&
          rightTime !== null &&
          rightTime > leftTime &&
          leftValue !== null &&
          rightValue !== null
        ) {
          for (let rowIndex = left + 1; rowIndex < index; rowIndex += 1) {
            const time = numeric(rows[rowIndex]?.[timeColumn]);
            if (time === null || time < leftTime || time > rightTime) continue;
            const fraction = (time - leftTime) / (rightTime - leftTime);
            updates.push({
              rowIndex,
              columnId,
              value: leftValue + (rightValue - leftValue) * fraction,
              quality: classifyQuality(rows[rowIndex]?.[columnId]) | QualityFlag.Interpolated
            });
          }
        }
      }
      left = index;
    }
  }

  return updates;
}
