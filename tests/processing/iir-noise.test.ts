import { describe, expect, it } from 'vitest';
import {
  applyIirCascade,
  computeFilterResponse,
  designButterworth,
  designButterworthBandPass,
  designCombNotch,
  designNotch
} from '../../src/processing/iir';
import {
  blankArtifact,
  hampelDeglitch,
  residual,
  subtractBaseline,
  waveletDenoiseHaar
} from '../../src/processing/noise';

describe('designed IIR filtering', () => {
  it('builds a Butterworth response with the expected cutoff gain', () => {
    const sampleRate = 10_000;
    const cutoff = 1000;
    const sections = designButterworth('lowpass', sampleRate, cutoff, 4);
    const response = computeFilterResponse(sections, sampleRate, 5001);
    const cutoffIndex = Math.round((cutoff / (sampleRate / 2)) * (response.frequency.length - 1));

    expect(response.magnitudeDb[0]).toBeCloseTo(0, 8);
    expect(response.magnitudeDb[cutoffIndex]).toBeCloseTo(-3.0103, 2);
    expect(response.magnitudeDb.at(-1)).toBeLessThan(-100);
  });

  it('supports causal and zero-phase IIR processing explicitly', () => {
    const input = new Array<number>(1000).fill(0);
    input[500] = 1;
    const sections = designButterworth('lowpass', 1000, 100, 4);
    const causal = applyIirCascade(input, sections, 'causal');
    const zeroPhase = applyIirCascade(input, sections, 'zero-phase');

    expect(causal.indexOf(Math.max(...causal))).toBeGreaterThan(500);
    expect(zeroPhase.indexOf(Math.max(...zeroPhase))).toBe(500);
  });

  it('preserves a constant record through a very-low-cutoff zero-phase low-pass', () => {
    const input = new Array<number>(1000).fill(1);
    const output = applyIirCascade(input, designButterworth('lowpass', 1000, 1, 4), 'zero-phase');

    expect(output[0]).toBeCloseTo(1, 10);
    expect(output[500]).toBeCloseTo(1, 10);
    expect(output.at(-1)).toBeCloseTo(1, 10);
  });

  it('preserves a linear trend through a very-low-cutoff zero-phase low-pass', () => {
    const input = Array.from({ length: 1000 }, (_, index) => index / 999);
    const output = applyIirCascade(input, designButterworth('lowpass', 1000, 1, 4), 'zero-phase');

    output.forEach((value, index) => expect(value).toBeCloseTo(input[index], 9));
  });

  it('creates calibrated notch and comb sections', () => {
    expect(designNotch(10_000, 1000, 50)).toHaveLength(1);
    expect(designCombNotch(10_000, 1000, 30)).toHaveLength(4);
  });

  it('maps IIR notch bandwidth to approximately minus-3-dB edge frequencies', () => {
    const response = computeFilterResponse(designNotch(10_000, 1000, 100), 10_000, 5001);

    expect(response.magnitudeDb[1000]).toBeLessThan(-200);
    expect(Math.abs(response.magnitudeDb[950] + 3.0103)).toBeLessThan(0.11);
    expect(Math.abs(response.magnitudeDb[1050] + 3.0103)).toBeLessThan(0.11);
  });

  it('honors the requested total Butterworth band-pass order', () => {
    const effectiveOrder = (order: number) =>
      designButterworthBandPass(10_000, 500, 1500, order).reduce(
        (total, section) => total + (section.a2 === 0 ? 1 : 2),
        0
      );

    expect(effectiveOrder(2)).toBe(2);
    expect(effectiveOrder(6)).toBe(6);
    expect(effectiveOrder(10)).toBe(10);
  });

  it('places transformed Butterworth band-pass edges at minus 3 dB', () => {
    const response = computeFilterResponse(designButterworthBandPass(10_000, 900, 1100, 4), 10_000, 5001);

    expect(Math.abs(response.magnitudeDb[1000])).toBeLessThan(0.001);
    expect(response.magnitudeDb[900]).toBeCloseTo(-3.0103, 2);
    expect(response.magnitudeDb[1100]).toBeCloseTo(-3.0103, 2);
  });
});

describe('transient-preserving noise operations', () => {
  it('subtracts a baseline only when given an explicit region', () => {
    const result = subtractBaseline([5, 5, 6, 7], { startIndex: 0, endIndex: 1 });

    expect(result.values).toEqual([0, 0, 1, 2]);
  });

  it('replaces isolated Hampel outliers and reports changed indices', () => {
    const result = hampelDeglitch([1, 1.1, 0.9, 50, 1, 1.05, 0.95], 2, 3);

    expect(result.changedIndices).toContain(3);
    expect(result.values[3]).toBeCloseTo(1.05, 12);
  });

  it('denoises a non-power-of-two record while preserving its length', () => {
    const input = Array.from({ length: 101 }, (_, index) => Math.sin(index / 10) + (index % 2 ? 0.1 : -0.1));
    const result = waveletDenoiseHaar(input, { levels: 3 });

    expect(result.values).toHaveLength(input.length);
    expect(result.changedIndices.length).toBeGreaterThan(0);
  });

  it('reconstructs exactly when the wavelet threshold is zero', () => {
    const input = Array.from({ length: 101 }, (_, index) => Math.sin(index / 7) + index / 1000);
    const result = waveletDenoiseHaar(input, { levels: 5, threshold: 0 });

    result.values.forEach((value, index) => expect(value).toBeCloseTo(input[index], 12));
  });

  it('reduces deterministic high-frequency error without collapsing the waveform', () => {
    const clean = Array.from({ length: 1024 }, (_, index) => Math.sin((2 * Math.PI * index) / 128));
    const noisy = clean.map((value, index) => value + (index % 2 === 0 ? 0.15 : -0.15));
    const denoised = waveletDenoiseHaar(noisy, { levels: 6, threshold: 0.1 }).values;
    const mse = (values: number[]) =>
      values.reduce((sum, value, index) => sum + (value - clean[index]) ** 2, 0) / values.length;

    expect(mse(denoised)).toBeLessThan(mse(noisy));
    expect(Math.max(...denoised) - Math.min(...denoised)).toBeGreaterThan(1);
  });

  it('makes artifact interpolation explicit and keeps a residual', () => {
    const original = [0, 1, 100, 3, 4];
    const repaired = blankArtifact([0, 1, 2, 3, 4], original, 2, 2, 'interpolate');

    expect(repaired.values).toEqual([0, 1, 2, 3, 4]);
    expect(repaired.warnings.join(' ')).toContain('explicitly interpolated');
    expect(residual(original, repaired.values)).toEqual([0, 0, 98, 0, 0]);
  });

  it('marks endpoint artifact regions missing instead of claiming interpolation', () => {
    const repaired = blankArtifact([0, 1, 2], [100, 1, 2], 0, 0, 'interpolate');

    expect(repaired.values[0]).toBeNaN();
    expect(repaired.warnings.join(' ')).toContain('marked missing instead');
  });
});
