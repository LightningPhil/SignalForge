import { describe, expect, it } from 'vitest';
import { alignedLttbIndices } from '../../src/processing/lttb';

describe('aligned LTTB downsampling', () => {
  it('handles large records without spread-argument stack overflow', () => {
    const length = 150_000;
    const x = Float64Array.from({ length }, (_, index) => index);
    const raw = Float64Array.from({ length }, (_, index) => Math.sin(index / 100));
    const filtered = raw.slice();
    filtered[123_456] = 20;

    const indices = alignedLttbIndices(x, [raw, filtered], 2000);

    expect(indices.length).toBeLessThanOrEqual(2000);
    expect(indices.length).toBeGreaterThan(1500);
    expect(indices[0]).toBe(0);
    expect(indices.at(-1)).toBe(length - 1);
    expect(indices).toContain(123_456);
  });

  it('keeps a full-scale glitch in one trace when a low-variance residual is displayed alongside it', () => {
    const length = 100_000;
    const x = Float64Array.from({ length }, (_, index) => index);
    let seed = 12345;
    const noise = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296 - 0.5;
    };
    const processed = Float64Array.from({ length }, (_, index) => Math.sin(index / 500));
    const raw = Float64Array.from(processed, (value) => value + 0.05 * noise());
    raw[43_210] += 3;
    processed[77_777] -= 2.5;
    const residual = Float64Array.from(raw, (value, index) => value - processed[index]);

    const indices = alignedLttbIndices(x, [raw, processed, residual], 3000);

    expect(indices.length).toBeLessThanOrEqual(3000);
    expect(indices).toContain(77_777);
    expect(indices).toContain(43_210);
    expect(indices.every((index, position) => position === 0 || index > indices[position - 1])).toBe(true);
  });

  it('returns one shared, ordered index set for all aligned signals', () => {
    const x = Array.from({ length: 1000 }, (_, index) => index / 10);
    const raw = x.map((value) => Math.sin(value));
    const processed = x.map((value) => Math.cos(value));
    const indices = alignedLttbIndices(x, [raw, processed], 100);

    expect(indices.every((index, position) => position === 0 || index > indices[position - 1])).toBe(true);
    expect(indices.map((index) => x[index])).toHaveLength(indices.map((index) => raw[index]).length);
    expect(indices.map((index) => x[index])).toHaveLength(indices.map((index) => processed[index]).length);
  });
});
