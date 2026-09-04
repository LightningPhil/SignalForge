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
});
