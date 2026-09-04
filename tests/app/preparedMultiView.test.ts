import { beforeEach, describe, expect, it } from 'vitest';
import {
  forgetColumnSeries,
  forgetPreparedMultiViews,
  getRawSeries,
  getSeriesForColumn,
  recallPreparedMultiView,
  rememberPreparedMultiView
} from '../../src/app/traceData';
import { State } from '../../src/state';
import type { ColumnSeries, CsvRow } from '../../src/types';

const rows = (): CsvRow[] => [
  { Time: 0, Voltage: 1, Current: 2 },
  { Time: 1, Voltage: 2, Current: 3 },
  { Time: 2, Voltage: 3, Current: 4 }
];

function prepared(columnId: string): ColumnSeries {
  return {
    columnId,
    rawY: [1, 2, 3],
    rawQuality: new Uint16Array(3),
    filteredY: [1, 2, 3],
    filteredQuality: new Uint16Array(3),
    time: [0, 1, 2],
    isMath: false
  };
}

describe('worker-prepared Multi View cache', () => {
  beforeEach(() => {
    forgetPreparedMultiViews();
    State.setData(rows(), ['Time', 'Voltage', 'Current'], null);
  });

  it('re-uses prepared series for a pure viewport change', () => {
    const seriesList = [prepared('Voltage'), prepared('Current')];
    rememberPreparedMultiView('view-1', ['Voltage', 'Current'], seriesList);
    expect(recallPreparedMultiView('view-1', ['Voltage', 'Current'])).toBe(seriesList);
    expect(recallPreparedMultiView('view-2', ['Voltage', 'Current'])).toBeNull();
  });

  it('invalidates when the column set, a pipeline, or the working data changes', () => {
    rememberPreparedMultiView('view-1', ['Voltage', 'Current'], [prepared('Voltage'), prepared('Current')]);
    expect(recallPreparedMultiView('view-1', ['Voltage'])).toBeNull();

    rememberPreparedMultiView('view-1', ['Voltage'], [prepared('Voltage')]);
    State.setPipelineForColumn('Voltage', [
      { id: 'step-1', type: 'movingAverage', enabled: true, windowSize: 3 } as never
    ]);
    expect(recallPreparedMultiView('view-1', ['Voltage'])).toBeNull();

    rememberPreparedMultiView('view-1', ['Voltage'], [prepared('Voltage')]);
    State.applyDataChanges('Repair', [{ rowIndex: 0, columnId: 'Voltage', value: 5 }]);
    expect(recallPreparedMultiView('view-1', ['Voltage'])).toBeNull();

    rememberPreparedMultiView('view-1', ['Voltage'], [prepared('Voltage')]);
    State.appendDataRows([{ Time: 3, Voltage: 4, Current: 5 }]);
    expect(recallPreparedMultiView('view-1', ['Voltage'])).toBeNull();
  });

  it('invalidates when the same-shaped grid is replaced by a different data set', () => {
    rememberPreparedMultiView('view-1', ['Voltage'], [prepared('Voltage')]);
    // Same headers, same row count, no source record: only the generation counter distinguishes them.
    State.setData(rows(), ['Time', 'Voltage', 'Current'], null, false);
    expect(recallPreparedMultiView('view-1', ['Voltage'])).toBeNull();
  });
});

describe('synchronous column series memo', () => {
  beforeEach(() => {
    forgetColumnSeries();
    State.setData(rows(), ['Time', 'Voltage', 'Current'], null);
    // setData deliberately keeps the filter pipeline; start each case from an empty one.
    State.setPipelineForColumn('Voltage', []);
  });

  it('returns the identical series for a repeated read of an unchanged column', () => {
    const rawX = getRawSeries('Voltage').rawX;
    const first = getSeriesForColumn('Voltage', rawX);
    const second = getSeriesForColumn('Voltage', rawX);
    expect(second).toBe(first);
    expect(getSeriesForColumn('Current', rawX)).not.toBe(first);
  });

  it('recomputes after a pipeline change, a repair, an append, and a data replacement', () => {
    const read = () => getSeriesForColumn('Voltage', getRawSeries('Voltage').rawX)!;
    let previous = read();

    State.setPipelineForColumn('Voltage', [
      { id: 'step-1', type: 'movingAverage', enabled: true, windowSize: 3 } as never
    ]);
    let next = read();
    expect(next).not.toBe(previous);
    expect(next.filteredY).not.toEqual(previous.filteredY);
    previous = next;

    State.applyDataChanges('Repair', [{ rowIndex: 0, columnId: 'Voltage', value: 5 }]);
    next = read();
    expect(next).not.toBe(previous);
    expect(next.rawY[0]).toBe(5);
    previous = next;

    State.appendDataRows([{ Time: 3, Voltage: 4, Current: 5 }]);
    next = read();
    expect(next).not.toBe(previous);
    expect(next.rawY).toHaveLength(4);
    previous = next;

    State.setData(rows(), ['Time', 'Voltage', 'Current'], null, false);
    next = read();
    expect(next).not.toBe(previous);
    expect(next.rawY).toEqual([1, 2, 3]);
  });

  it('does not serve a series prepared against a different timebase', () => {
    const rawX = getRawSeries('Voltage').rawX;
    const first = getSeriesForColumn('Voltage', rawX)!;
    const shifted = rawX.map((value) => value + 1);
    const second = getSeriesForColumn('Voltage', shifted)!;
    expect(second).not.toBe(first);
    expect(second.time).toEqual(shifted);
  });
});
