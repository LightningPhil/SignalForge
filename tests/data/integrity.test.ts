import { beforeEach, describe, expect, it } from 'vitest';
import { QualityFlag } from '../../src/data/quality';
import { State } from '../../src/state';
import type { CsvRow } from '../../src/types';
import { getTimeArray } from '../../src/app/traceData';
import { buildForwardFillUpdates, buildLinearInterpolationUpdates } from '../../src/data/repairs';

const rows = (): CsvRow[] => [
  { Time: 0, Voltage: 1 },
  { Time: 1, Voltage: 'CLIPPED' },
  { Time: 1, Voltage: '' },
  { Time: 3, Voltage: 'not-a-number' }
];

describe('immutable imported data and quality history', () => {
  beforeEach(() => {
    State.setData(rows(), ['Time', 'Voltage'], {
      name: 'fixture.csv',
      text: 'Time,Voltage\n0,1\n1,CLIPPED\n1,\n3,not-a-number\n',
      bytes: new TextEncoder().encode('Time,Voltage\n0,1\n1,CLIPPED\n1,\n3,not-a-number\n'),
      size: 50,
      lastModified: null
    });
  });

  it('preserves immutable originals and source text', () => {
    expect(Object.isFrozen(State.data.original)).toBe(true);
    expect(Object.isFrozen(State.data.original[0])).toBe(true);
    expect(State.data.source?.text).toContain('CLIPPED');

    State.applyDataChanges('Edit sample', [{ rowIndex: 0, columnId: 'Voltage', value: 9 }]);

    expect(State.data.raw[0].Voltage).toBe(9);
    expect(State.data.original[0].Voltage).toBe(1);
    expect(State.data.columns.Voltage[0]).toBe(9);
    expect(State.data.originalColumns.Voltage[0]).toBe(1);
  });

  it('classifies missing, clipped, invalid and non-monotonic samples', () => {
    expect(State.data.quality.Voltage[1] & QualityFlag.Clipped).toBeTruthy();
    expect(State.data.quality.Voltage[2] & QualityFlag.Missing).toBeTruthy();
    expect(State.data.quality.Voltage[3] & QualityFlag.Invalid).toBeTruthy();
    expect(State.data.quality.Time[2] & QualityFlag.NonMonotonicTime).toBeTruthy();
  });

  it('undoes and redoes repairs without touching originals', () => {
    State.applyDataChanges('Repair clipped sample', [
      {
        rowIndex: 1,
        columnId: 'Voltage',
        value: 1.5,
        quality: QualityFlag.Interpolated
      }
    ]);
    expect(State.data.raw[1].Voltage).toBe(1.5);

    State.undoDataRepair();
    expect(State.data.raw[1].Voltage).toBe('CLIPPED');
    expect(State.data.quality.Voltage[1] & QualityFlag.Clipped).toBeTruthy();

    State.redoDataRepair();
    expect(State.data.raw[1].Voltage).toBe(1.5);
    expect(State.data.quality.Voltage[1]).toBe(QualityFlag.Interpolated);
    expect(State.data.original[1].Voltage).toBe('CLIPPED');
  });

  it('lifts analysis-blocking flags when the real repair builders fill or interpolate a sample', () => {
    State.setData(
      [
        { Time: 0, Voltage: 1 },
        { Time: 1, Voltage: 'CLIPPED' },
        { Time: 2, Voltage: '' },
        { Time: 3, Voltage: 4 }
      ],
      ['Time', 'Voltage']
    );
    const blocking = QualityFlag.Missing | QualityFlag.Invalid | QualityFlag.Clipped | QualityFlag.Saturated;

    const interpolation = buildLinearInterpolationUpdates(State.data.raw, 'Time', 'Voltage');
    expect(interpolation.map((update) => update.rowIndex)).toEqual([1, 2]);
    State.applyDataChanges('Interpolate', interpolation);
    expect(State.data.raw[1].Voltage).toBe(2);
    expect(State.data.raw[2].Voltage).toBe(3);
    expect(State.data.quality.Voltage[1] & QualityFlag.Interpolated).toBeTruthy();
    expect(State.data.quality.Voltage[1] & blocking).toBe(0);
    expect(State.data.quality.Voltage[2] & blocking).toBe(0);
    // Originals and their quality are untouched, and undo restores the blocking state.
    expect(State.data.original[1].Voltage).toBe('CLIPPED');
    expect(State.data.originalQuality.Voltage[1] & QualityFlag.Clipped).toBeTruthy();
    State.undoDataRepair();
    expect(State.data.quality.Voltage[1] & QualityFlag.Clipped).toBeTruthy();

    const fill = buildForwardFillUpdates(State.data.raw, 'Voltage');
    State.applyDataChanges('Forward fill', fill);
    expect(State.data.raw[1].Voltage).toBe(1);
    expect(State.data.raw[2].Voltage).toBe(1);
    expect(State.data.quality.Voltage[2] & QualityFlag.ForwardFilled).toBeTruthy();
    expect(State.data.quality.Voltage[2] & blocking).toBe(0);
  });

  it('normalizes a legacy CSV time-column unit for analysis without changing originals', () => {
    State.setData(
      [
        { 'Time (ms)': 0, Voltage: 0 },
        { 'Time (ms)': 2, Voltage: 1 }
      ],
      ['Time (ms)', 'Voltage']
    );

    expect(getTimeArray()).toEqual([0, 0.002]);
    expect(State.data.original[1]['Time (ms)']).toBe(2);
  });

  it('never converts missing, boolean, whitespace, or partially numeric cells to finite samples', () => {
    State.setData(
      [
        { Time: 0, Value: null },
        { Time: 1, Value: '' },
        { Time: 2, Value: '   ' },
        { Time: 3, Value: true },
        { Time: 4, Value: '12junk' },
        { Time: 5, Value: '12.5' }
      ],
      ['Time', 'Value']
    );

    expect(Array.from(State.data.columns.Value).slice(0, 5).every(Number.isNaN)).toBe(true);
    expect(State.data.columns.Value[5]).toBe(12.5);
  });

  it('recomputes neighboring non-monotonic flags after timestamp edits and undo', () => {
    State.setData(
      [
        { Time: 0, Value: 1 },
        { Time: 1, Value: 2 },
        { Time: 2, Value: 3 }
      ],
      ['Time', 'Value']
    );
    State.applyDataChanges('Edit time', [{ rowIndex: 1, columnId: 'Time', value: 3 }]);

    expect(State.data.quality.Time[2] & QualityFlag.NonMonotonicTime).toBeTruthy();
    State.undoDataRepair();
    expect(State.data.quality.Time[2] & QualityFlag.NonMonotonicTime).toBeFalsy();
  });

  it('does not label a missing timestamp as non-monotonic', () => {
    State.setData(
      [
        { Time: 0, Value: 1 },
        { Time: '', Value: 2 },
        { Time: 1, Value: 3 }
      ],
      ['Time', 'Value']
    );

    expect(State.data.quality.Time[1]).toBe(QualityFlag.Missing);
    expect(State.data.quality.Time[2] & QualityFlag.NonMonotonicTime).toBeFalsy();
  });
});
