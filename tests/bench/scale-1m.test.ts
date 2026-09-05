import { describe, expect, it } from 'vitest';
import { QualityFlag } from '../../src/data/quality';
import { alignedLttbIndices } from '../../src/processing/lttb';
import { analyzeTimebase } from '../../src/processing/sampling';
import { analyticByteBudget, checksumFloat64, countQuality, recordPayloadBytes } from '../synthetic/lab.ts';
import { buildScaleFixture } from '../synthetic/scale.ts';

const enabled = process.env.SIGNALFORGE_LAB_1M === '1';

describe.skipIf(!enabled)('one-million-sample synthetic structure', () => {
  it('validates payload shape and bounded display selection without timing assertions', () => {
    const fixture = buildScaleFixture(1_000_000);
    const { record } = fixture;
    const budget = analyticByteBudget(record.time.length);

    expect(record.time).toHaveLength(1_000_000);
    expect(record.values).toHaveLength(1_000_000);
    expect(record.quality).toHaveLength(1_000_000);
    expect(budget.totalBytes).toBe(18_000_000);
    expect(recordPayloadBytes(record)).toBe(budget.totalBytes);
    expect(analyzeTimebase(record.time)).toMatchObject({ valid: true, uniform: true });
    expect(countQuality(record.quality, QualityFlag.Missing)).toBe(64);
    expect(countQuality(record.quality, QualityFlag.Clipped)).toBeGreaterThan(40_000);
    expect(record.values[fixture.gap[0] - 1]).not.toBeNaN();
    expect(record.values[fixture.gap[0]]).toBeNaN();
    expect(record.values[fixture.gap[1]]).not.toBeNaN();
    expect(checksumFloat64(record.values)).toBe('e4ec5eec0ff4232a');

    const displayIndices = alignedLttbIndices(record.time, [record.values], 4096);
    expect(displayIndices).toHaveLength(4096);
    expect(displayIndices[0]).toBe(0);
    expect(displayIndices.at(-1)).toBe(record.values.length - 1);
    expect(displayIndices.every((index, position) => position === 0 || index > displayIndices[position - 1])).toBe(
      true
    );
    expect(checksumFloat64(displayIndices)).toBe('8e78b183828f686d');
  });
});
