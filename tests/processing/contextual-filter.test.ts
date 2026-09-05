import { describe, expect, it } from 'vitest';
import { QualityFlag } from '../../src/data/quality';
import { createAnnotation } from '../../src/domain/session';
import { Filter } from '../../src/processing/filter';

const time = [0, 1, 2, 3, 4];

describe('marker-aware contextual pipeline steps', () => {
  it('subtracts a robust baseline resolved from an authoritative region', () => {
    const source = [5, 5, 7, 9, 11];
    const baseline = createAnnotation('pretrigger', 0, { kind: 'region', endTime: 1 });
    const quality = new Uint16Array(source.length);
    quality[0] = QualityFlag.Clipped;
    const result = Filter.applyPipelineWithReport(
      source,
      time,
      [
        {
          id: 'baseline',
          type: 'baselineSubtract',
          enabled: true,
          regionMode: 'region-marker',
          regionMarker: 'pretrigger',
          startMarker: '',
          endMarker: '',
          regionStartTime: 0,
          regionEndTime: 1,
          regionStartIndex: 0,
          regionEndIndex: 1,
          baselineEstimator: 'median'
        }
      ],
      quality,
      { annotations: [baseline] }
    );

    expect(result.values).toEqual([0, 0, 2, 4, 6]);
    expect(result.steps[0].effectiveParameters).toMatchObject({ baseline: 5, startIndex: 0, endIndex: 1 });
    result.quality.forEach((mask) => expect(mask & QualityFlag.Clipped).toBeTruthy());
    expect(source).toEqual([5, 5, 7, 9, 11]);
  });

  it('gates outside a plot selection without changing working input', () => {
    const source = [1, 2, 3, 4, 5];
    const result = Filter.applyPipelineWithReport(
      source,
      time,
      [
        {
          id: 'gate',
          type: 'timeGate',
          enabled: true,
          regionMode: 'selection',
          regionMarker: '',
          startMarker: '',
          endMarker: '',
          regionStartTime: 0,
          regionEndTime: 1,
          regionStartIndex: 0,
          regionEndIndex: 1
        }
      ],
      new Uint16Array(source.length),
      { selection: { i0: 1, i1: 3, xMin: 1, xMax: 3 } }
    );

    expect(result.values).toEqual([0, 2, 3, 4, 0]);
    expect(result.quality[0] & QualityFlag.Processed).toBeTruthy();
    expect(result.quality[2] & QualityFlag.Processed).toBeFalsy();
    expect(source).toEqual([1, 2, 3, 4, 5]);
  });

  it('marks or interpolates an artifact only in processed quality', () => {
    const baseStep = {
      id: 'blank',
      type: 'artifactBlank' as const,
      enabled: true,
      regionMode: 'times' as const,
      regionMarker: '',
      startMarker: '',
      endMarker: '',
      regionStartTime: 2,
      regionEndTime: 2,
      regionStartIndex: 2,
      regionEndIndex: 2
    };
    const missing = Filter.applyPipelineWithReport(
      [0, 1, 100, 3, 4],
      time,
      [{ ...baseStep, artifactMode: 'missing' }],
      new Uint16Array(5)
    );
    const interpolated = Filter.applyPipelineWithReport(
      [0, 1, 100, 3, 4],
      time,
      [{ ...baseStep, artifactMode: 'interpolate' }],
      new Uint16Array(5)
    );

    expect(missing.values[2]).toBeNaN();
    expect(missing.quality[2] & QualityFlag.Missing).toBeTruthy();
    expect(interpolated.values[2]).toBe(2);
    expect(interpolated.quality[2] & QualityFlag.Interpolated).toBeTruthy();
  });

  it('subtracts an aligned reference and propagates both quality masks', () => {
    const referenceQuality = new Uint16Array(3);
    referenceQuality[1] = QualityFlag.Saturated;
    const result = Filter.applyPipelineWithReport(
      [10, 20, 30],
      [0, 1, 2],
      [{ id: 'reference', type: 'referenceSubtract', enabled: true, referenceColumnId: 'Noise', referenceScale: 2 }],
      new Uint16Array(3),
      { references: { Noise: { values: [1, 2, 3], quality: referenceQuality } } }
    );

    expect(result.values).toEqual([8, 16, 24]);
    expect(result.quality[1] & QualityFlag.Saturated).toBeTruthy();
    expect(result.steps[0].effectiveParameters).toMatchObject({ referenceColumnId: 'Noise', scale: 2 });
  });

  it('passes through with an explicit warning when a marker binding cannot resolve', () => {
    const result = Filter.applyPipelineWithReport(
      [1, 2, 3],
      [0, 1, 2],
      [
        {
          id: 'missing',
          type: 'timeGate',
          enabled: true,
          regionMode: 'marker-pair',
          regionMarker: '',
          startMarker: 'start',
          endMarker: 'end',
          regionStartTime: 0,
          regionEndTime: 1,
          regionStartIndex: 0,
          regionEndIndex: 1
        }
      ]
    );
    expect(result.values).toEqual([1, 2, 3]);
    expect(result.steps[0].warnings.join(' ')).toContain('No authoritative annotation');
  });

  it('applies resolved gate and artifact bounds correctly with a channel timing offset', () => {
    const marker = createAnnotation('window', 10, { kind: 'region', endTime: 11 });
    const common = {
      enabled: true,
      regionMode: 'region-marker' as const,
      regionMarker: 'window',
      startMarker: '',
      endMarker: '',
      regionStartTime: 0,
      regionEndTime: 1,
      regionStartIndex: 0,
      regionEndIndex: 1
    };
    const gate = Filter.applyPipelineWithReport(
      [1, 2, 3],
      [0, 1, 2],
      [{ id: 'offset-gate', type: 'timeGate', ...common }],
      undefined,
      { annotations: [marker], timingOffsetSeconds: 10 }
    );
    expect(gate.values).toEqual([1, 2, 0]);

    marker.startTime = 11;
    marker.endTime = 11;
    const blank = Filter.applyPipelineWithReport(
      [0, 100, 2],
      [0, 1, 2],
      [{ id: 'offset-blank', type: 'artifactBlank', artifactMode: 'interpolate', ...common }],
      undefined,
      { annotations: [marker], timingOffsetSeconds: 10 }
    );
    expect(blank.values).toEqual([0, 1, 2]);
  });

  it('aligns reference channels by their timebases and timing offsets before subtraction', () => {
    const result = Filter.applyPipelineWithReport(
      [10, 20, 30],
      [0, 1, 2],
      [
        {
          id: 'aligned-reference',
          type: 'referenceSubtract',
          enabled: true,
          referenceColumnId: 'Ref',
          referenceScale: 1
        }
      ],
      undefined,
      {
        timingOffsetSeconds: 1,
        references: {
          Ref: {
            time: [0, 1, 2, 3],
            values: [0, 10, 20, 30],
            quality: new Uint16Array(4),
            timingOffsetSeconds: 0
          }
        }
      }
    );
    expect(result.values).toEqual([0, 0, 0]);
    expect(result.steps[0].effectiveParameters).toMatchObject({ alignment: 'timebase-interpolated' });
  });

  it('marks failed boundary interpolation as missing rather than interpolated', () => {
    const result = Filter.applyPipelineWithReport(
      [100, 1, 2],
      [0, 1, 2],
      [
        {
          id: 'boundary',
          type: 'artifactBlank',
          enabled: true,
          regionMode: 'indices',
          regionMarker: '',
          startMarker: '',
          endMarker: '',
          regionStartTime: 0,
          regionEndTime: 0,
          regionStartIndex: 0,
          regionEndIndex: 0,
          artifactMode: 'interpolate'
        }
      ]
    );
    expect(result.values[0]).toBeNaN();
    expect(result.quality[0] & QualityFlag.Missing).toBeTruthy();
    expect(result.quality[0] & QualityFlag.Interpolated).toBeFalsy();
  });
});
