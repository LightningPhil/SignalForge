import { describe, expect, it } from 'vitest';
import { QualityFlag } from '../../src/data/quality';
import { analyzeTimebase, resampleLinear } from '../../src/processing/sampling';
import {
  analyticByteBudget,
  checksumFloat64,
  composeSyntheticRecord,
  countQuality,
  createSeededRng,
  jitteredTimebase,
  recordPayloadBytes,
  uniformTimebase
} from '../synthetic/lab.ts';
import { buildScenario, scenarioCatalog, scenarioNames } from '../synthetic/scenarios.ts';

describe('synthetic laboratory primitives', () => {
  it('replays identical random streams and keeps uniforms away from singular endpoints', () => {
    const first = createSeededRng(0x1234_5678);
    const second = createSeededRng(0x1234_5678);
    const different = createSeededRng(0x1234_5679);
    const integers = Array.from({ length: 32 }, () => first.nextUint32());

    expect(integers).toEqual(Array.from({ length: 32 }, () => second.nextUint32()));
    expect(integers).not.toEqual(Array.from({ length: 32 }, () => different.nextUint32()));

    const normalA = createSeededRng(99);
    const normalB = createSeededRng(99);
    expect(Array.from({ length: 17 }, () => normalA.normal())).toEqual(
      Array.from({ length: 17 }, () => normalB.normal())
    );
    const uniforms = Array.from({ length: 1000 }, () => normalA.uniform());
    expect(uniforms.every((value) => value > 0 && value < 1)).toBe(true);
  });

  it('maintains timebase and linear-resampling properties across deterministic seeds', () => {
    for (const seed of [0, 1, 7, 0x8000_0000, 0xffff_ffff]) {
      const sampleRate = 10_000 + (seed & 0xff);
      const uniform = uniformTimebase(257, sampleRate, -0.5);
      const regular = analyzeTimebase(uniform);
      expect(regular.valid, `uniform seed ${seed}`).toBe(true);
      expect(regular.uniform, `uniform seed ${seed}`).toBe(true);
      expect(regular.sampleRate).toBeCloseTo(sampleRate, 6);

      const jittered = jitteredTimebase(257, sampleRate, createSeededRng(seed), 0.08, -0.5);
      const analysis = analyzeTimebase(jittered);
      expect(analysis.valid, `jittered seed ${seed}`).toBe(true);
      expect(analysis.uniform, `jittered seed ${seed}`).toBe(false);
      for (let index = 1; index < jittered.length; index += 1) {
        const interval = jittered[index] - jittered[index - 1];
        expect(interval).toBeGreaterThan((1 - 0.08) / sampleRate);
        expect(interval).toBeLessThan((1 + 0.08) / sampleRate);
      }

      const line = Float64Array.from(jittered, (time) => 3 * time - 2);
      const resampled = resampleLinear(jittered, [line], 1 / sampleRate);
      expect(resampled.time[0]).toBe(jittered[0]);
      expect(resampled.time.at(-1)).toBe(jittered.at(-1));
      for (let index = 0; index < resampled.time.length; index += 1) {
        expect(resampled.values[0][index]).toBeCloseTo(3 * resampled.time[index] - 2, 11);
      }
    }
  });

  it('composes pulses, ringing, noise, clipping, gaps, and matching quality masks', () => {
    const record = composeSyntheticRecord({
      name: 'all-components',
      time: uniformTimebase(2048, 100_000),
      seed: 42,
      components: [
        { kind: 'whiteNoise', sigma: 0.01 },
        {
          kind: 'pulse',
          startSeconds: 0.002,
          widthSeconds: 0.004,
          riseSeconds: 0.0001,
          fallSeconds: 0.0001,
          amplitude: 2
        },
        {
          kind: 'ringing',
          startSeconds: 0.006,
          amplitude: 1.5,
          frequencyHz: 5000,
          decaySeconds: 0.001
        },
        { kind: 'clip', minimum: -1, maximum: 1 },
        { kind: 'nanGap', startIndex: 1500, endIndex: 1520 }
      ]
    });

    expect(countQuality(record.quality, QualityFlag.Missing)).toBe(20);
    expect(countQuality(record.quality, QualityFlag.Clipped)).toBeGreaterThan(300);
    for (let index = 0; index < record.values.length; index += 1) {
      if (index >= 1500 && index < 1520) {
        expect(record.values[index]).toBeNaN();
        expect(record.quality[index] & QualityFlag.Missing).toBeTruthy();
      } else {
        expect(Number.isFinite(record.values[index])).toBe(true);
        expect(record.values[index]).toBeGreaterThanOrEqual(-1);
        expect(record.values[index]).toBeLessThanOrEqual(1);
      }
      if (record.quality[index] & QualityFlag.Clipped) {
        expect(Math.abs(record.values[index])).toBe(1);
      }
    }
  });

  it('locks every named scenario to semantic Float64 checksums', () => {
    for (const name of scenarioNames) {
      const definition = scenarioCatalog[name];
      const record = buildScenario(name);
      expect(record.name).toBe(name);
      expect(record.time).toHaveLength(definition.sampleCount);
      expect(record.values).toHaveLength(definition.sampleCount);
      expect(checksumFloat64(record.time), `${name} time`).toBe(definition.expected.timeChecksum);
      expect(checksumFloat64(record.values), `${name} values`).toBe(definition.expected.valueChecksum);
      expect(countQuality(record.quality, QualityFlag.Missing)).toBe(definition.expected.missingSamples);
      expect(countQuality(record.quality, QualityFlag.Clipped)).toBe(definition.expected.clippedSamples);
      expect(recordPayloadBytes(record)).toBe(analyticByteBudget(definition.sampleCount).totalBytes);
    }
  });

  it('canonicalizes NaN payloads and signed zero in the Float64 checksum', () => {
    expect(checksumFloat64([Number.NaN, -0, 1])).toBe(checksumFloat64([0 / 0, 0, 1]));
    expect(checksumFloat64([1, 2, 3])).not.toBe(checksumFloat64([3, 2, 1]));
  });

  it('computes payload budgets without allocating the claimed records', () => {
    expect(analyticByteBudget(100_000)).toEqual({
      sampleCount: 100_000,
      channelCount: 1,
      timeBytes: 800_000,
      valueBytes: 800_000,
      qualityBytes: 200_000,
      totalBytes: 1_800_000
    });
    expect(analyticByteBudget(1_000_000, 3).totalBytes).toBe(38_000_000);
  });
});
