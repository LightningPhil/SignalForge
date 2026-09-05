import { describe, expect, it } from 'vitest';
import { CrossChannel } from '../../src/analysis/crossChannel';
import { QualityFlag } from '../../src/data/quality';

function uniformTime(length: number, sampleRate: number): number[] {
  return Array.from({ length }, (_, index) => index / sampleRate);
}

function pseudoRandom(length: number, seed: number): number[] {
  let state = seed >>> 0;
  return Array.from({ length }, () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffff_ffff - 0.5;
  });
}

describe('CrossChannel', () => {
  it('removes offsets and estimates a fractional-sample delay', () => {
    const length = 2048;
    const sampleRate = 10_000;
    const expectedDelay = 3.4;
    const time = uniformTime(length, sampleRate);
    const waveform = (sample: number) =>
      Math.exp(-(((sample - 700) / 70) ** 2)) +
      0.35 * Math.exp(-(((sample - 1180) / 35) ** 2)) -
      0.2 * Math.exp(-(((sample - 1450) / 100) ** 2));
    const input = Array.from({ length }, (_, index) => waveform(index) + 12);
    const output = Array.from({ length }, (_, index) => waveform(index - expectedDelay) - 7);

    const estimate = CrossChannel.estimateDelay(time, input, output, { maxLagSeconds: 0.002 });

    expect(estimate.delaySamples).toBeCloseTo(expectedDelay, 1);
    expect(estimate.delaySeconds).toBeCloseTo(expectedDelay / sampleRate, 5);
    expect(estimate.correlationPeak).toBeGreaterThan(0.999);
  });

  it('does not let floating-point rounding collapse the lag bound to zero and warns when it is zero', () => {
    const length = 512;
    const sampleRate = 1e6;
    const time = uniformTime(length, sampleRate);
    const waveform = (sample: number) => Math.exp(-(((sample - 200) / 20) ** 2));
    const input = Array.from({ length }, (_, index) => waveform(index));
    const output = Array.from({ length }, (_, index) => waveform(index - 1));

    // 3 / fs is exactly three samples; 3e-6 * 1e6 evaluates to 2.9999999999999996 in floating point.
    const bounded = CrossChannel.estimateDelay(time, input, output, { maxLagSeconds: 3 / sampleRate });
    expect(bounded.delaySamples).toBeCloseTo(1, 2);
    expect(bounded.warnings.join(' ')).not.toContain('rounds to zero');

    const zero = CrossChannel.estimateDelay(time, input, output, { maxLagSeconds: 0.1 / sampleRate });
    expect(zero.delaySamples).toBe(0);
    expect(zero.warnings.join(' ')).toContain('rounds to zero samples');
  });

  it('computes Welch transfer magnitude and coherence for a linear response', () => {
    const sampleRate = 4096;
    const input = pseudoRandom(8192, 0x12345678);
    const output = input.map((value) => value * 2);
    const result = CrossChannel.computeTransferFunction(input, output, uniformTime(input.length, sampleRate));
    const excitedBins = result.coherence
      .map((coherence, index) => ({ coherence, index }))
      .filter(({ index }) => index > 1 && index < result.coherence.length - 1);

    expect(result.meta.segmentCount).toBeGreaterThanOrEqual(10);
    for (const { coherence, index } of excitedBins) {
      expect(coherence).toBeGreaterThan(0.999999);
      expect(result.magnitudeDb[index]).toBeCloseTo(20 * Math.log10(2), 8);
    }
  });

  it('does not report near-unity broadband coherence for independent noise', () => {
    const length = 16_384;
    const sampleRate = 8192;
    const input = pseudoRandom(length, 0x10203040);
    const output = pseudoRandom(length, 0xa0b0c0d0);
    const result = CrossChannel.computeTransferFunction(input, output, uniformTime(length, sampleRate), {
      segmentLength: 512,
      overlap: 0.5
    });
    const finite = result.coherence.slice(1, -1).filter(Number.isFinite);
    const meanCoherence = finite.reduce((sum, value) => sum + value, 0) / finite.length;

    expect(result.meta.segmentCount).toBeGreaterThan(50);
    expect(meanCoherence).toBeLessThan(0.08);
  });

  it('jointly excludes analysis-blocking quality from delay and FRF inputs', () => {
    const sampleRate = 2048;
    const input = pseudoRandom(4096, 0xabcdef01);
    const output = input.map((value) => value * 2);
    input[777] = 1e12;
    output[777] = -1e12;
    const inputQuality = new Uint16Array(input.length);
    inputQuality[777] = QualityFlag.Clipped;

    const delay = CrossChannel.estimateDelay(uniformTime(input.length, sampleRate), input, output, {
      inputQuality
    });
    const frf = CrossChannel.computeTransferFunction(input, output, uniformTime(input.length, sampleRate), {
      inputQuality,
      segmentLength: 256
    });

    expect(Math.abs(delay.delaySamples)).toBeLessThan(0.1);
    expect(delay.warnings.join(' ')).toContain('analysis-blocking quality');
    expect(frf.warnings.join(' ')).toContain('analysis-blocking quality');
    const finiteMagnitude = frf.magnitudeDb.slice(2, -2).filter(Number.isFinite);
    expect(finiteMagnitude.reduce((sum, value) => sum + value, 0) / finiteMagnitude.length).toBeCloseTo(
      20 * Math.log10(2),
      4
    );
  });

  it('does not select a high-confidence two-sample edge overlap for unrelated records', () => {
    const length = 256;
    const result = CrossChannel.estimateDelay(
      uniformTime(length, 1000),
      pseudoRandom(length, 0x11111111),
      pseudoRandom(length, 0xeeeeeeee)
    );

    expect(Math.abs(result.delaySamples)).toBeLessThanOrEqual(length / 2);
    expect(result.confidence).toBeLessThan(0.4);
  });

  it('reports zero statistical confidence for very short delay records', () => {
    for (const length of [4, 8]) {
      const result = CrossChannel.estimateDelay(
        uniformTime(length, 1000),
        pseudoRandom(length, 0x1234),
        pseudoRandom(length, 0x9876)
      );

      expect(result.confidence).toBe(0);
      expect(result.warnings.join(' ')).toContain('insufficient');
    }
  });
});
