import { describe, expect, it } from 'vitest';
import { snapMarker } from '../../src/analysis/markerSnap';

describe('manual marker snapping', () => {
  it('snaps to the strongest slope near the requested time', () => {
    const time = Array.from({ length: 101 }, (_, index) => index / 100);
    const values = time.map((value) => (value < 0.55 ? 0 : 1));
    const marker = snapMarker(time, values, 0.5, 'slope', 20);

    expect(marker?.time).toBeGreaterThanOrEqual(0.54);
    expect(marker?.time).toBeLessThanOrEqual(0.55);
    expect(marker?.confidence).toBeGreaterThan(0.5);
  });

  it('returns the nearest real sample for sample snapping', () => {
    const marker = snapMarker([0, 0.1, 0.2], [1, 2, 3], 0.16, 'sample');

    expect(marker).toMatchObject({ index: 2, time: 0.2, confidence: 1 });
  });

  it('preserves the requested time when snapping is disabled', () => {
    const marker = snapMarker([0, 0.1, 0.2], [1, 2, 3], 0.16, 'none');

    expect(marker).toMatchObject({ index: 2, time: 0.16, confidence: 1 });
  });
});
