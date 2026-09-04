import { describe, expect, it } from 'vitest';
import { applyXOffset, Filter } from '../../src/processing/filter';

describe('pipeline change reporting', () => {
  it('reports how many samples each explicit step changed', () => {
    const result = Filter.applyPipelineWithReport(
      [0, 10, 0, 10, 0],
      [0, 1, 2, 3, 4],
      [
        { id: 'pass', type: 'nullFilter', enabled: true },
        { id: 'smooth', type: 'movingAverage', enabled: true, windowSize: 3 }
      ]
    );

    expect(result.steps[0]).toMatchObject({ stepId: 'pass', changedSamples: 0, totalSamples: 5 });
    expect(result.steps[1].changedSamples).toBeGreaterThan(0);
  });

  it('rejects configured IIR frequencies above the actual Nyquist limit', () => {
    const time = Array.from({ length: 100 }, (_, index) => index / 1000);
    const values = time.map((value) => Math.sin(2 * Math.PI * 20 * value));

    expect(() =>
      Filter.applyPipeline(values, time, [
        {
          id: 'low-pass',
          type: 'butterworthLowPass',
          enabled: true,
          cutoffFreq: 100_000_000,
          order: 4,
          processingMode: 'zero-phase'
        }
      ])
    ).toThrow(/Nyquist/);
  });

  it('preserves amplitude during frequency-domain fractional-sample deskew', () => {
    const source = Array.from({ length: 4096 }, (_, index) => Math.sin(2 * Math.PI * 0.4 * index));
    const shifted = applyXOffset(source, 0.5);
    const rms = (values: number[]) =>
      Math.sqrt(values.slice(256, -256).reduce((sum, value) => sum + value * value, 0) / (values.length - 512));

    expect(rms(shifted) / rms(source)).toBeCloseTo(1, 3);
  });

  it('applies the requested fractional phase delay at high frequency', () => {
    const frequency = 0.4;
    const requestedDelay = 0.5;
    const source = Array.from({ length: 8192 }, (_, index) => Math.sin(2 * Math.PI * frequency * index));
    const shifted = applyXOffset(source, requestedDelay);
    let sineProjection = 0;
    let cosineProjection = 0;
    for (let index = 1024; index < source.length - 1024; index += 1) {
      sineProjection += shifted[index] * Math.sin(2 * Math.PI * frequency * index);
      cosineProjection += shifted[index] * Math.cos(2 * Math.PI * frequency * index);
    }
    const measuredDelay = Math.atan2(-cosineProjection, sineProjection) / (2 * Math.PI * frequency);

    expect(measuredDelay).toBeCloseTo(requestedDelay, 2);
  });

  it('combines causal and zero-phase response overlays using each step mode', () => {
    const low = {
      id: 'low',
      type: 'butterworthLowPass' as const,
      enabled: true,
      cutoffFreq: 100,
      order: 4,
      processingMode: 'zero-phase' as const
    };
    const high = {
      id: 'high',
      type: 'butterworthHighPass' as const,
      enabled: true,
      cutoffFreq: 100,
      order: 4,
      processingMode: 'causal' as const
    };
    const combined = Filter.calculateDesignedIirResponse([low, high], 1000, 501);
    const lowOnly = Filter.calculateDesignedIirResponse([low], 1000, 501);
    const highOnly = Filter.calculateDesignedIirResponse([high], 1000, 501);
    const bin = 100;

    expect(combined?.magnitudeDb[bin]).toBeCloseTo(
      (lowOnly?.magnitudeDb[bin] || 0) + (highOnly?.magnitudeDb[bin] || 0),
      12
    );
    expect(combined?.phaseDeg[bin]).toBeCloseTo((lowOnly?.phaseDeg[bin] || 0) + (highOnly?.phaseDeg[bin] || 0), 12);
  });

  it('uses serialized worker FIR coefficients without redesigning on the main thread', () => {
    const step = {
      id: 'worker-fir',
      type: 'firLowPass' as const,
      enabled: true,
      cutoffFreq: 100,
      transitionWidth: 0.000001,
      passbandRippleDb: 0.001,
      stopbandAttenuationDb: 160,
      processingMode: 'zero-phase' as const
    };
    expect(() => Filter.calculateDesignedFirResponse([step], 1000, 101)).toThrow(/tap safety limit/);

    const response = Filter.calculateDesignedFirResponse([step], 1000, 101, [
      {
        stepId: step.id,
        sampleRate: 1000,
        specificationKey: Filter.firSpecificationKey(step, 1000),
        coefficients: [0.25, 0.5, 0.25],
        processingMode: 'zero-phase'
      }
    ]);
    expect(response?.magnitudeDb[0]).toBeCloseTo(0, 12);
  });
});
