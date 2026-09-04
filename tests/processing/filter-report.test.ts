import { describe, expect, it } from 'vitest';
import { applyXOffset, Filter, validateFilterStep } from '../../src/processing/filter';
import { applyIirCascade, designNotch, iirPaddingPlan, MAX_IIR_SETTLING_PADDING } from '../../src/processing/iir';

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

  it('keeps fractional-shift error small at 0.45 fs and confines edge ringing to the kernel half-width', () => {
    // Regression: the FFT-based shifter spread edge artefacts across the whole record and lost
    // amplitude near Nyquist; the windowed-sinc kernel is exact to < 1e-3 up to 0.45 fs.
    const frequency = 0.45;
    const delay = 0.37;
    const length = 4096;
    const source = Array.from({ length }, (_, index) => Math.sin(2 * Math.PI * frequency * index));
    const shifted = applyXOffset(source, delay);
    let worst = 0;
    for (let index = 64; index < length - 64; index += 1) {
      worst = Math.max(worst, Math.abs(shifted[index] - Math.sin(2 * Math.PI * frequency * (index - delay))));
    }
    expect(worst).toBeLessThan(1e-3);

    const step = Array.from({ length }, (_, index) => (index < length / 2 ? 0 : 1));
    const shiftedStep = applyXOffset(step, delay);
    // Far from the step and from the record edges the shift of a constant must be that constant.
    expect(Math.abs(shiftedStep[200])).toBeLessThan(1e-9);
    expect(Math.abs(shiftedStep[length - 200] - 1)).toBeLessThan(1e-9);
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

  it('rejects Hampel windows below the three-sample minimum the implementation actually uses', () => {
    const base = { id: 'h', type: 'hampel' as const, enabled: true, thresholdSigma: 3 };
    expect(() => validateFilterStep({ ...base, windowSize: 1 })).toThrow(/hampel windowSize/);
    expect(() => validateFilterStep({ ...base, windowSize: 2 })).toThrow(/hampel windowSize/);
    expect(() => validateFilterStep({ ...base, windowSize: 3 })).not.toThrow();
  });

  it('accepts odd Butterworth low/high-pass orders and only forces even orders for band-pass', () => {
    expect(() =>
      validateFilterStep(
        { id: 'l', type: 'butterworthLowPass', enabled: true, cutoffFreq: 100, order: 5, processingMode: 'causal' },
        1000
      )
    ).not.toThrow();
    expect(() =>
      validateFilterStep(
        {
          id: 'b',
          type: 'butterworthBandPass',
          enabled: true,
          centerFreq: 200,
          bandwidth: 50,
          order: 5,
          processingMode: 'causal'
        },
        1000
      )
    ).toThrow(/even/);
  });

  it('discloses causal IIR start-up and only warns about settling when the padding bound truncates it', () => {
    const time = Array.from({ length: 300 }, (_, index) => index / 1000);
    const values = time.map((value) => Math.sin(2 * Math.PI * 5 * value));
    const zeroPhase = {
      id: 'zp',
      type: 'butterworthLowPass' as const,
      enabled: true,
      cutoffFreq: 2,
      order: 4,
      processingMode: 'zero-phase' as const
    };
    const causal = { ...zeroPhase, id: 'c', processingMode: 'causal' as const };

    expect(Filter.filterWarnings(causal, time, values).join(' ')).toMatch(/start-up transient/);
    // Short records are now extended to the full settling length, so no truncation warning.
    expect(Filter.filterWarnings(zeroPhase, time, values).join(' ')).not.toMatch(/settling/);
    // A pole this close to the unit circle exceeds the bounded extension and must be reported.
    const plan = iirPaddingPlan([{ b0: 1, b1: 0, b2: 0, a1: 0, a2: 0.99999998 }], 1000);
    expect(plan.required).toBeGreaterThan(MAX_IIR_SETTLING_PADDING);
    expect(plan.effective).toBe(MAX_IIR_SETTLING_PADDING);
    expect(plan.truncated).toBe(true);
  });

  it('settles a narrow zero-phase notch on a record far shorter than its settling length', () => {
    // Regression: padding was capped at N-1 reflected samples, so a 1 Hz notch at 10 kHz on 4096
    // samples only reached -16 dB on its centre tone. The odd-periodic extension settles it fully.
    const fs = 10_000;
    const tone = Array.from({ length: 4096 }, (_, index) => Math.sin(2 * Math.PI * 1000 * (index / fs)));
    const sections = designNotch(fs, 1000, 1, 'zero-phase');
    const plan = iirPaddingPlan(sections, tone.length);
    const notched = applyIirCascade(tone, sections, 'zero-phase');
    let sumSquares = 0;
    for (let index = 1024; index < 3072; index += 1) sumSquares += notched[index] ** 2;
    const residualDb = 20 * Math.log10(Math.sqrt(sumSquares / 2048) / Math.SQRT1_2);

    expect(plan.required).toBeGreaterThan(tone.length);
    expect(plan.truncated).toBe(false);
    expect(residualDb).toBeLessThan(-120);
  });
});
