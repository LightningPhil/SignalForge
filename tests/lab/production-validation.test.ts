import { describe, expect, it } from 'vitest';
import { EventDetector } from '../../src/analysis/eventDetector';
import { analyzeRinging } from '../../src/analysis/ringing';
import { QualityFlag } from '../../src/data/quality';
import { Filter } from '../../src/processing/filter';
import { alignedLttbIndices } from '../../src/processing/lttb';
import { analyzeTimebase, resampleBandlimited } from '../../src/processing/sampling';
import { checksumFloat64, countQuality } from '../synthetic/lab.ts';
import { buildScenario } from '../synthetic/scenarios.ts';

function standardDeviation(values: ArrayLike<number>, start: number, end: number): number {
  let sum = 0;
  let count = 0;
  for (let index = start; index < end; index += 1) {
    const value = Number(values[index]);
    if (!Number.isFinite(value)) continue;
    sum += value;
    count += 1;
  }
  const mean = sum / count;
  let squared = 0;
  for (let index = start; index < end; index += 1) {
    const value = Number(values[index]);
    if (Number.isFinite(value)) squared += (value - mean) ** 2;
  }
  return Math.sqrt(squared / count);
}

function finiteExtent(values: ArrayLike<number>, indices?: readonly number[]): { minimum: number; maximum: number } {
  let minimum = Infinity;
  let maximum = -Infinity;
  const length = indices?.length ?? values.length;
  for (let position = 0; position < length; position += 1) {
    const index = indices?.[position] ?? position;
    const value = Number(values[index]);
    if (!Number.isFinite(value)) continue;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  return { minimum, maximum };
}

describe('synthetic records through production analysis', () => {
  it('detects all catalog pulses with interpolated widths', () => {
    const pulseTrain = buildScenario('clean-pulse-train');
    const result = EventDetector.detect({
      t: pulseTrain.time,
      y: pulseTrain.values,
      quality: pulseTrain.quality,
      config: {
        type: 'pulse',
        direction: 'rising',
        threshold: 0.5,
        minWidth: 350e-6,
        maxWidth: 450e-6,
        selectionOnly: false
      }
    });

    expect(result.events).toHaveLength(4);
    for (const detected of result.events) {
      expect(detected.metadata.width).toBeTypeOf('number');
      expect(detected.metadata.width as number).toBeGreaterThan(390e-6);
      expect(detected.metadata.width as number).toBeLessThan(410e-6);
      expect(detected.metadata.peak as number).toBeGreaterThan(0.98);
    }
  });

  it('estimates the noisy jittered ringdown frequency and decay', () => {
    const ringdown = buildScenario('jittered-ringdown');
    const timebase = analyzeTimebase(ringdown.time);
    const result = analyzeRinging(ringdown.time, ringdown.values);

    expect(timebase.valid).toBe(true);
    expect(timebase.uniform).toBe(false);
    expect(result.frequencyHz).not.toBeNull();
    expect(Math.abs((result.frequencyHz as number) - 50_000) / 50_000).toBeLessThan(0.02);
    expect(result.decayTimeConstant).not.toBeNull();
    expect(Math.abs((result.decayTimeConstant as number) - 200e-6) / 200e-6).toBeLessThan(0.15);
    expect(result.fitR2).not.toBeNull();
    expect(result.fitR2 as number).toBeGreaterThan(0.9);
    expect(result.peakCount).toBeGreaterThan(8);
  });

  it('resamples a jittered scenario onto a finite uniform grid with a locked checksum', () => {
    const ringdown = buildScenario('jittered-ringdown');
    const resampled = resampleBandlimited(ringdown.time, [ringdown.values], 1 / 10_000_000);
    const outputAnalysis = analyzeTimebase(resampled.time);

    expect(resampled.analysis.uniform).toBe(false);
    expect(outputAnalysis.valid).toBe(true);
    expect(outputAnalysis.uniform).toBe(true);
    expect(resampled.values[0].every(Number.isFinite)).toBe(true);
    expect(resampled.time[0]).toBe(ringdown.time[0]);
    expect(resampled.time.at(-1)).toBe(ringdown.time.at(-1));
    expect(checksumFloat64(resampled.values[0])).toBe('fe2f36c79a1f8dc9');
  });

  it('filters finite runs, propagates quality, and reduces seeded baseline noise', () => {
    const pulseTrain = buildScenario('clean-pulse-train');
    const smoothedPulse = Filter.applyPipelineWithReport(
      pulseTrain.values,
      pulseTrain.time,
      [{ id: 'lab-smooth', type: 'movingAverage', enabled: true, windowSize: 11 }],
      pulseTrain.quality
    );
    expect(standardDeviation(smoothedPulse.values, 100, 850)).toBeLessThan(
      standardDeviation(pulseTrain.values, 100, 850) * 0.45
    );

    const mixed = buildScenario('mixed-pulse-ringing');
    const result = Filter.applyPipelineWithReport(
      mixed.values,
      mixed.time,
      [{ id: 'lab-smooth', type: 'movingAverage', enabled: true, windowSize: 9 }],
      mixed.quality
    );
    expect(result.values).toHaveLength(mixed.values.length);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].changedSamples).toBeGreaterThan(16_000);
    expect(countQuality(result.quality, QualityFlag.Missing)).toBe(48);
    expect(countQuality(result.quality, QualityFlag.Clipped)).toBeGreaterThan(
      countQuality(mixed.quality, QualityFlag.Clipped)
    );
    for (let index = 0; index < result.values.length; index += 1) {
      expect(Number.isNaN(result.values[index])).toBe(index >= 7000 && index < 7048);
      if (Number.isFinite(result.values[index])) expect(result.quality[index] & QualityFlag.Processed).toBeTruthy();
    }
    expect(checksumFloat64(result.values)).toBe('099dce66211a2fda');
  });

  it('retains record endpoints and both clipped extrema under aligned LTTB', () => {
    const mixed = buildScenario('mixed-pulse-ringing');
    const smoothed = Filter.applyPipeline(mixed.values, mixed.time, [
      { id: 'display-smooth', type: 'movingAverage', enabled: true, windowSize: 9 }
    ]);
    const indices = alignedLttbIndices(mixed.time, [mixed.values, smoothed], 600);
    const sourceExtent = finiteExtent(mixed.values);
    const selectedExtent = finiteExtent(mixed.values, indices);

    expect(indices.length).toBeLessThanOrEqual(600);
    expect(indices[0]).toBe(0);
    expect(indices.at(-1)).toBe(mixed.values.length - 1);
    expect(indices.every((index, position) => position === 0 || index > indices[position - 1])).toBe(true);
    expect(selectedExtent.minimum).toBe(sourceExtent.minimum);
    expect(selectedExtent.maximum).toBe(sourceExtent.maximum);
  });
});
