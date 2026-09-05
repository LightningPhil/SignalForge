import { describe, expect, it } from 'vitest';
import { resolveRegionBinding } from '../../src/analysis/regionBinding';
import { createAnnotation } from '../../src/domain/session';

describe('region binding resolution', () => {
  it('resolves a reversed region marker on an offset time axis', () => {
    const region = createAnnotation('pulse', 12.6, { kind: 'region', endTime: 10.4 });

    const result = resolveRegionBinding(
      { kind: 'region-marker', markerName: 'pulse' },
      new Float64Array([0, 1, 2, 3]),
      { annotations: [region], timingOffsetSeconds: 10 }
    );

    expect(result).toMatchObject({
      resolved: true,
      startTime: 10,
      endTime: 13,
      startIndex: 0,
      endIndex: 3,
      annotationIds: [region.id]
    });
    expect(result.warnings).toContain('Region bounds were reversed and have been ordered by time.');
  });

  it('uses nearest samples for reversed explicit times', () => {
    const result = resolveRegionBinding({ kind: 'times', startTime: 8, endTime: 3.2 }, [0, 1, 4, 10]);

    expect(result).toMatchObject({
      resolved: true,
      startTime: 4,
      endTime: 10,
      startIndex: 2,
      endIndex: 3
    });
    expect(result.warnings).toContain('Region bounds were reversed and have been ordered by time.');
  });

  it('orders and clamps explicit indices', () => {
    const result = resolveRegionBinding({ kind: 'indices', startIndex: 5, endIndex: -2 }, [2, 3, 4]);

    expect(result).toMatchObject({
      resolved: true,
      startTime: 2,
      endTime: 4,
      startIndex: 0,
      endIndex: 2
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        'Region bounds were reversed and have been ordered by time.',
        'Region indices outside the time array were clamped.'
      ])
    );
  });

  it('prefers manual markers over accepted suggestions', () => {
    const suggestedStart = createAnnotation('start', 0, {
      source: 'suggested',
      suggestionState: 'accepted'
    });
    const manualStart = createAnnotation('start', 2);
    const end = createAnnotation('end', 3, {
      source: 'suggested',
      suggestionState: 'accepted'
    });

    const result = resolveRegionBinding({ kind: 'marker-pair', startMarker: 'start', endMarker: 'end' }, [0, 1, 2, 3], {
      annotations: [suggestedStart, manualStart, end]
    });

    expect(result).toMatchObject({
      resolved: true,
      startIndex: 2,
      endIndex: 3,
      annotationIds: [manualStart.id, end.id]
    });
  });

  it('does not resolve rejected or pending suggestions without a manual annotation', () => {
    const rejected = createAnnotation('window', 0, {
      kind: 'region',
      endTime: 1,
      source: 'suggested',
      suggestionState: 'rejected'
    });
    const pending = createAnnotation('window', 1, {
      kind: 'region',
      endTime: 2,
      source: 'suggested',
      suggestionState: 'pending'
    });
    const binding = { kind: 'region-marker', markerName: 'window' } as const;

    expect(resolveRegionBinding(binding, [0, 1, 2], { annotations: [rejected, pending] })).toMatchObject({
      resolved: false,
      reason: 'missing-annotation',
      annotationIds: []
    });

    const manual = createAnnotation('window', 0, { kind: 'region', endTime: 2 });
    expect(resolveRegionBinding(binding, [0, 1, 2], { annotations: [rejected, pending, manual] })).toMatchObject({
      resolved: true,
      annotationIds: [manual.id],
      startIndex: 0,
      endIndex: 2
    });
  });

  it('returns explicit failures for invalid and nonmonotonic time arrays', () => {
    const binding = { kind: 'times', startTime: 0, endTime: 2 } as const;

    expect(resolveRegionBinding(binding, [0, Number.NaN, 2])).toMatchObject({
      resolved: false,
      reason: 'invalid-time-array'
    });
    expect(resolveRegionBinding(binding, [0, 1, 1])).toMatchObject({
      resolved: false,
      reason: 'non-monotonic-time-array'
    });
    expect(resolveRegionBinding(binding, [0, 2, 1])).toMatchObject({
      resolved: false,
      reason: 'non-monotonic-time-array'
    });
  });

  it('resolves plot times, falls back to indices, and bypasses an absent selection', () => {
    const fromTimes = resolveRegionBinding({ kind: 'selection' }, [0, 1, 2, 3], {
      selection: { xMin: 2.6, xMax: 0.6, i0: 1, i1: 2 }
    });
    expect(fromTimes).toMatchObject({ resolved: true, startIndex: 1, endIndex: 3 });

    const fromIndices = resolveRegionBinding({ kind: 'selection' }, [0, 1, 2, 3], {
      selection: { xMin: null, xMax: null, i0: 3, i1: 1 }
    });
    expect(fromIndices).toMatchObject({ resolved: true, startIndex: 1, endIndex: 3 });
    expect(fromIndices.warnings).toContain('Selection times were unavailable; selection indices were used.');

    const missing = resolveRegionBinding({ kind: 'selection' }, [0, 1, 2, 3], { selection: null });
    expect(missing).toMatchObject({ resolved: false, reason: 'missing-selection' });
  });
});
