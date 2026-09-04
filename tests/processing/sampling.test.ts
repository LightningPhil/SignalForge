import { describe, expect, it } from 'vitest';
import { FFT } from '../../src/processing/fft';
import { designButterworth, iirPaddingPlan } from '../../src/processing/iir';
import {
  alignQualityToTimebase,
  analyzeTimebase,
  antiAliasAndDecimate,
  interpolateToTimebase,
  resampleBandlimited,
  resampleLinear
} from '../../src/processing/sampling';
import { QualityFlag } from '../../src/data/quality';

describe('sampling utilities', () => {
  it('detects local timing variation even when the mean interval is unchanged', () => {
    const time = [0, 1, 3, 4, 6, 7];
    const analysis = analyzeTimebase(time);

    expect(analysis.valid).toBe(true);
    expect(analysis.uniform).toBe(false);
    expect(analysis.maxRelativeDeviation).toBeGreaterThan(0.3);
  });

  it('linearly resamples aligned channels onto the median interval', () => {
    const time = [0, 1, 2.1, 3, 4];
    const values = time.map((value) => 3 * value - 2);
    const result = resampleLinear(time, [values], 1);

    expect(result.time).toEqual([0, 1, 2, 3, 4]);
    result.values[0].forEach((value, index) => expect(value).toBeCloseTo(3 * result.time[index] - 2, 12));
  });

  it('includes a non-integer-span endpoint on a uniform output grid', () => {
    const result = resampleLinear([0, 1, 2, 3.4], [[0, 2, 4, 6.8]], 1);

    expect(result.time.at(-1)).toBe(3.4);
    expect(result.values[0].at(-1)).toBeCloseTo(6.8, 12);
    expect(result.values[0].every(Number.isFinite)).toBe(true);
  });

  it('band-limited resampling of a jittered timebase preserves a 0.3 fs tone that linear resampling attenuates', () => {
    const length = 4096;
    let seed = 7;
    const jitter = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return (seed / 4294967296 - 0.5) * 0.04;
    };
    const time = Array.from({ length }, (_, index) => (index + jitter()) / 1000);
    const values = time.map((value) => Math.sin(2 * Math.PI * 300 * value));
    const linear = resampleLinear(time, [values], 0.001);
    const bandlimited = resampleBandlimited(time, [values], 0.001);
    const error = (resampled: { time: number[]; values: number[][] }) => {
      let worst = 0;
      for (let index = 16; index < resampled.time.length - 16; index += 1) {
        worst = Math.max(
          worst,
          Math.abs(resampled.values[0][index] - Math.sin(2 * Math.PI * 300 * resampled.time[index]))
        );
      }
      return worst;
    };

    expect(bandlimited.time).toEqual(linear.time);
    expect(error(bandlimited)).toBeLessThan(2e-3);
    expect(error(linear)).toBeGreaterThan(0.03);
  });

  it('does not add IIR passband droop when Fourier resampling already band-limits the alignment', () => {
    const sourceTime = Array.from({ length: 4096 }, (_, index) => index / 4096);
    const targetTime = Array.from({ length: 1024 }, (_, index) => index / 1024);
    const values = sourceTime.map((value) => Math.sin(2 * Math.PI * 480 * value));
    const aligned = interpolateToTimebase(sourceTime, values, targetTime);
    let peak = 0;
    for (let index = 64; index < 960; index += 1) peak = Math.max(peak, Math.abs(aligned.values[index]));

    expect(aligned.warnings.join(' ')).toContain('Fourier interpolation');
    expect(aligned.warnings.join(' ')).not.toContain('IIR anti-alias');
    expect(peak).toBeGreaterThan(0.99);
  });

  it('applies IIR anti-alias filtering before decimation', () => {
    const sampleRate = 4096;
    const length = 8192;
    const factor = 4;
    const time = Array.from({ length }, (_, index) => index / sampleRate);
    const values = time.map(
      (timestamp) => Math.sin(2 * Math.PI * 100 * timestamp) + Math.sin(2 * Math.PI * 900 * timestamp)
    );
    const decimated = antiAliasAndDecimate(time, values, factor);
    const spectrum = FFT.computeSpectrum(decimated.values, decimated.time, {
      windowType: 'hann',
      detrend: 'removeMean',
      zeroPadMode: 'nextPow2'
    });
    const lowBin = Math.round(100 / spectrum.meta.deltaF);
    const aliasedBin = Math.round(124 / spectrum.meta.deltaF);

    expect(decimated.factor).toBe(factor);
    expect(spectrum.linearMagnitude[lowBin]).toBeGreaterThan(0.9);
    expect(spectrum.linearMagnitude[aliasedBin]).toBeLessThan(0.03);
  });

  it('strongly suppresses energy immediately above the output Nyquist frequency', () => {
    const sampleRate = 4096;
    const factor = 4;
    const time = Array.from({ length: 16_384 }, (_, index) => index / sampleRate);
    const values = time.map((timestamp) => Math.sin(2 * Math.PI * 520 * timestamp));
    const decimated = antiAliasAndDecimate(time, values, factor);
    const spectrum = FFT.computeSpectrum(decimated.values, decimated.time, {
      windowType: 'hann',
      detrend: 'removeMean',
      zeroPadMode: 'nextPow2'
    });
    const aliasBin = Math.round(504 / spectrum.meta.deltaF);

    expect(spectrum.linearMagnitude[aliasBin]).toBeLessThan(0.01);
  });

  it('preserves DC while anti-alias filtering and decimating', () => {
    const time = Array.from({ length: 1000 }, (_, index) => index / 1000);
    const result = antiAliasAndDecimate(time, new Array<number>(1000).fill(3), 4);

    result.values.forEach((value) => expect(value).toBeCloseTo(3, 10));
  });

  it('uses pole-aware settling padding and preserves complete ramp edges at large decimation factors', () => {
    const sampleRate = 4096;
    const time = Array.from({ length: 16_384 }, (_, index) => index / sampleRate);
    const ramp = time.map((timestamp) => 2 - 0.25 * timestamp);
    for (const factor of [4, 16, 64]) {
      const result = antiAliasAndDecimate(time, ramp, factor);
      expect(result.filterOrder).toBe(8);
      expect(result.paddingSamples).toBeGreaterThan(24);
      result.values.forEach((value, index) => {
        expect(value).toBeCloseTo(2 - 0.25 * result.time[index], 10);
      });
    }
  });

  it('does not cap low-cutoff settling padding below the documented decay target', () => {
    const sections = designButterworth('lowpass', 4096, (4096 / 1024) * 0.35, 8);
    const padding = iirPaddingPlan(sections, 100_000);

    expect(padding.required).toBeGreaterThan(16_384);
    expect(padding.effective).toBe(padding.required);
    expect(padding.truncated).toBe(false);
  });

  it('contains missing samples while anti-alias filtering and decimating', () => {
    const time = Array.from({ length: 8192 }, (_, index) => index / 4096);
    const values = new Array<number>(time.length).fill(2);
    values[4096] = Number.NaN;
    const result = antiAliasAndDecimate(time, values, 4);
    const finite = result.values.filter(Number.isFinite);

    expect(finite.length).toBeGreaterThan(result.values.length * 0.99);
    finite.forEach((value) => expect(value).toBeCloseTo(2, 8));
  });

  it('extends short finite runs to the full pole-aware settling length instead of record-limiting them', () => {
    const time = Array.from({ length: 201 }, (_, index) => index / 1000);
    const values = new Array<number>(time.length).fill(2);
    values[100] = Number.NaN;
    const result = antiAliasAndDecimate(time, values, 64);

    expect(result.requiredPaddingSamples).toBeGreaterThan(100);
    expect(result.paddingSamples).toBe(result.requiredPaddingSamples);
    expect(result.settlingTruncated).toBe(false);
    expect(result.skippedFilterRuns).toBe(0);
  });

  it('propagates quality across the full polynomial interpolation footprint', () => {
    const sourceTime = Array.from({ length: 20 }, (_, index) => index);
    const quality = new Uint16Array(20);
    quality[8] = QualityFlag.Clipped;
    const aligned = alignQualityToTimebase(sourceTime, quality, [0.5, 1.5]);

    expect(aligned[0] & QualityFlag.Clipped).toBeTruthy();
  });

  it('does not apply a global Fourier quality footprint to endpoint-discontinuous data', () => {
    const sourceTime = Array.from({ length: 20 }, (_, index) => index / 19);
    const targetTime = Array.from({ length: 10 }, (_, index) => index / 9);
    const values = sourceTime.slice();
    const quality = new Uint16Array(20);
    quality[19] = QualityFlag.Clipped;
    const aligned = alignQualityToTimebase(sourceTime, quality, targetTime, 0, values);

    expect(aligned[1] & QualityFlag.Clipped).toBeFalsy();
  });
});
