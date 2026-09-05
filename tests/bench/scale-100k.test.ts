import { describe, expect, it } from 'vitest';
import { EventDetector } from '../../src/analysis/eventDetector';
import { QualityFlag } from '../../src/data/quality';
import { Filter } from '../../src/processing/filter';
import { alignedLttbIndices } from '../../src/processing/lttb';
import { analyzeTimebase, antiAliasAndDecimate } from '../../src/processing/sampling';
import { analyticByteBudget, checksumFloat64, countQuality, recordPayloadBytes } from '../synthetic/lab.ts';
import { buildScaleFixture } from '../synthetic/scale.ts';

describe('100k synthetic production scale', () => {
  it('keeps structural, analysis, and checksum invariants without timing assumptions', () => {
    const fixture = buildScaleFixture(100_000);
    const { record } = fixture;
    const budget = analyticByteBudget(record.time.length);

    expect(recordPayloadBytes(record)).toBe(budget.totalBytes);
    expect(budget.totalBytes).toBe(1_800_000);
    expect(analyzeTimebase(record.time)).toMatchObject({ valid: true, uniform: true });
    expect(countQuality(record.quality, QualityFlag.Missing)).toBe(64);
    expect(countQuality(record.quality, QualityFlag.Clipped)).toBeGreaterThan(4000);
    expect(checksumFloat64(record.values)).toBe('b542332f17551c11');

    const filtered = Filter.applyPipelineWithReport(
      record.values,
      record.time,
      [{ id: 'scale-smooth', type: 'movingAverage', enabled: true, windowSize: 9 }],
      record.quality
    );
    expect(filtered.values).toHaveLength(record.values.length);
    expect(filtered.steps[0].changedSamples).toBeGreaterThan(95_000);
    expect(countQuality(filtered.quality, QualityFlag.Missing)).toBe(64);
    expect(countQuality(filtered.quality, QualityFlag.Clipped)).toBeGreaterThan(
      countQuality(record.quality, QualityFlag.Clipped)
    );
    expect(checksumFloat64(filtered.values)).toBe('e8f432763591174e');

    const events = EventDetector.detect({
      t: record.time,
      y: record.values,
      quality: record.quality,
      config: {
        type: 'level',
        direction: 'rising',
        threshold: 0.5,
        hysteresis: 0.05,
        selectionOnly: false
      }
    });
    expect(events.events).toHaveLength(2);
    expect(events.events.map((event) => event.index)).toEqual(fixture.positivePulseStarts.map((index) => index + 7));
    expect(events.warnings.join(' ')).toContain('analysis-blocking quality flags');

    const displayIndices = alignedLttbIndices(record.time, [record.values, filtered.values], 2000);
    expect(displayIndices.length).toBeLessThanOrEqual(2000);
    expect(displayIndices.length).toBeGreaterThan(1500);
    expect(displayIndices[0]).toBe(0);
    expect(displayIndices.at(-1)).toBe(record.values.length - 1);
    expect(displayIndices.every((index, position) => position === 0 || index > displayIndices[position - 1])).toBe(
      true
    );
    expect(checksumFloat64(displayIndices)).toBe('dc8aa0e2e7523d4c');

    const decimated = antiAliasAndDecimate(record.time, record.values, 10);
    let nanCount = 0;
    for (const value of decimated.values) if (Number.isNaN(value)) nanCount += 1;
    expect(decimated.factor).toBe(10);
    expect(decimated.time).toHaveLength(10_000);
    expect(decimated.values).toHaveLength(10_000);
    expect(nanCount).toBe(7);
    expect(checksumFloat64(decimated.values)).toBe('47a8486e2509327a');
  });
});
