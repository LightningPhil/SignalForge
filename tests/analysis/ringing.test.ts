import { describe, expect, it } from 'vitest';
import { analyzeRinging } from '../../src/analysis/ringing';

describe('ringing analysis', () => {
  it('estimates frequency, exponential decay and Q from a damped sinusoid', () => {
    const sampleRate = 20_000;
    const frequency = 500;
    const decay = 0.01;
    const time = Array.from({ length: 1000 }, (_, index) => index / sampleRate);
    const values = time.map(
      (timestamp) => Math.exp(-timestamp / decay) * Math.sin(2 * Math.PI * frequency * timestamp)
    );
    const result = analyzeRinging(time, values);

    expect(result.frequencyHz).toBeCloseTo(frequency, 1);
    expect(result.decayTimeConstant).toBeCloseTo(decay, 3);
    expect(result.qualityFactor).toBeCloseTo(Math.PI * frequency * decay, 1);
    expect(result.fitR2).toBeGreaterThan(0.99);
  });

  it('gates peaks and crossings on the noise floor so 5 % noise does not destroy the estimate', () => {
    let seed = 2024;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      const u1 = (seed + 1) / 4294967297;
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      const u2 = (seed + 1) / 4294967297;
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    };
    const sampleRate = 10e6;
    const frequency = 50e3;
    const tau = 200e-6;
    const time = Array.from({ length: 20_000 }, (_, index) => index / sampleRate);
    const values = time.map((t) => Math.exp(-t / tau) * Math.cos(2 * Math.PI * frequency * t) + 0.05 * random());

    const result = analyzeRinging(time, values);
    expect(result.frequencyHz).not.toBeNull();
    expect(Math.abs((result.frequencyHz as number) - frequency) / frequency).toBeLessThan(0.02);
    expect(result.decayTimeConstant).not.toBeNull();
    expect(Math.abs((result.decayTimeConstant as number) - tau) / tau).toBeLessThan(0.15);
    expect(result.noiseSigma).toBeGreaterThan(0.03);
    expect(result.noiseSigma).toBeLessThan(0.08);
  });

  it('withholds a frequency and decay for pure noise instead of reporting confident numbers', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      const u1 = (seed + 1) / 4294967297;
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      const u2 = (seed + 1) / 4294967297;
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    };
    const time = Array.from({ length: 4000 }, (_, index) => index / 1e6);
    const values = time.map(() => random());

    const result = analyzeRinging(time, values);
    expect(result.frequencyHz).toBeNull();
    expect(result.qualityFactor).toBeNull();
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
