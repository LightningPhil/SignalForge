import { describe, expect, it } from 'vitest';
import { Filter, validateFilterStep } from '../../src/processing/filter';
import { QualityFlag } from '../../src/data/quality';
import { Config } from '../../src/config';
import { FFT } from '../../src/processing/fft';
import { computeFilterResponse } from '../../src/processing/iir';
import { hampelDeglitch, subtractReference, timeGate, waveletDenoiseHaar } from '../../src/processing/noise';
import { State } from '../../src/state';

function uniformTime(length: number, sampleRate: number): number[] {
  return Array.from({ length }, (_, index) => index / sampleRate);
}

function toneAmplitude(values: number[], sampleRate: number, frequency: number, trim = 0): number {
  let sine = 0;
  let cosine = 0;
  let count = 0;
  for (let index = trim; index < values.length - trim; index += 1) {
    const angle = (2 * Math.PI * frequency * index) / sampleRate;
    sine += values[index] * Math.sin(angle);
    cosine += values[index] * Math.cos(angle);
    count += 1;
  }
  return count > 0 ? (2 * Math.hypot(sine, cosine)) / count : 0;
}

describe('time-domain filter quality', () => {
  it('rejects pathological recipes before allocating or iterating', () => {
    const values = [1, 2, 3];
    const time = [0, 1, 2];

    expect(() =>
      Filter.applyPipeline(values, time, [
        {
          id: 'huge-window',
          type: 'movingAverage',
          enabled: true,
          windowSize: 1e308
        }
      ])
    ).toThrow(/windowSize/);
    expect(() =>
      Filter.applyPipeline(values, time, [
        {
          id: 'bad-sg',
          type: 'savitzkyGolay',
          enabled: true,
          windowSize: 5,
          polyOrder: 8
        }
      ])
    ).toThrow(/polyOrder/);
    expect(() =>
      Filter.applyPipeline(values, time, [
        {
          id: 'bad-comb',
          type: 'iirComb',
          enabled: true,
          centerFreq: 1,
          bandwidth: 1,
          harmonicCount: 1e9,
          processingMode: 'zero-phase'
        }
      ])
    ).toThrow(/harmonicCount/);
  });

  it('validates complete discriminated recipes and sample-rate-dependent edges', () => {
    expect(() => validateFilterStep({ id: 'missing', type: 'lowPassFFT', enabled: true })).toThrow(
      /cutoffFreq is required/
    );
    expect(() =>
      validateFilterStep({
        id: 'tiny-sg',
        type: 'savitzkyGolay',
        enabled: true,
        windowSize: 1,
        polyOrder: 0,
        iterations: 1
      })
    ).toThrow(/windowSize/);
    expect(() =>
      validateFilterStep({
        id: 'mode',
        type: 'iirNotch',
        enabled: true,
        centerFreq: 100,
        bandwidth: 10,
        processingMode: 'invalid' as 'causal'
      })
    ).toThrow(/processingMode/);
    expect(() =>
      validateFilterStep({
        id: 'boolean',
        type: 'startStopNorm',
        enabled: true,
        startLength: 1,
        endLength: 1,
        startOffset: 0,
        autoOffset: 'yes' as unknown as boolean,
        autoOffsetPoints: 5,
        applyStart: true,
        applyEnd: true
      })
    ).toThrow(/boolean/);
    expect(() =>
      validateFilterStep({
        id: 'fractional',
        type: 'butterworthLowPass',
        enabled: true,
        cutoffFreq: 100,
        order: 3.5,
        processingMode: 'causal'
      })
    ).toThrow(/integer/);
    expect(() =>
      validateFilterStep(
        {
          id: 'crossing',
          type: 'butterworthBandPass',
          enabled: true,
          centerFreq: 450,
          bandwidth: 200,
          order: 4,
          processingMode: 'causal'
        },
        1000
      )
    ).toThrow(/upper edge.*Nyquist/);
    expect(() =>
      validateFilterStep({
        id: 'stale-q',
        type: 'lowPassFFT',
        enabled: true,
        cutoffFreq: 100,
        slope: 12,
        qFactor: 0.707
      } as never)
    ).toThrow(/unsupported parameter.*qFactor/);
    expect(() =>
      validateFilterStep({
        id: 'fir-missing-transition',
        type: 'firLowPass',
        enabled: true,
        cutoffFreq: 100,
        passbandRippleDb: 0.1,
        stopbandAttenuationDb: 80,
        processingMode: 'zero-phase'
      })
    ).toThrow(/transitionWidth is required/);
    expect(() =>
      validateFilterStep(
        {
          id: 'fir-crossing',
          type: 'firBandPass',
          enabled: true,
          centerFreq: 400,
          bandwidth: 100,
          transitionWidth: 75,
          passbandRippleDb: 0.1,
          stopbandAttenuationDb: 80,
          processingMode: 'causal'
        },
        1000
      )
    ).toThrow(/upper outer edge.*Nyquist/);
  });

  it('derives valid FIR defaults from split timestamp runs', () => {
    const originalConfig = State.config;
    try {
      State.config = JSON.parse(JSON.stringify(Config));
      State.setData(
        [
          { Time: 0, Value: 0 },
          { Time: 0.001, Value: 1 },
          { Time: 0.002, Value: 0 },
          { Time: 0.002, Value: 0 },
          { Time: 0.003, Value: 1 },
          { Time: 0.004, Value: 0 }
        ],
        ['Time', 'Value']
      );
      const step = State.addStep('firLowPass');

      expect(step.cutoffFreq).toBeLessThan(500);
      expect((step.cutoffFreq || 0) + (step.transitionWidth || 0)).toBeLessThan(500);
      expect(() => validateFilterStep(step, 1000)).not.toThrow();
    } finally {
      State.config = originalConfig;
    }
  });

  it('keeps pass-through data bit-for-bit, including quality gaps', () => {
    const values = [1, Number.NaN, 3];
    const output = Filter.applyPipeline(values, [0, 1, 2], [{ id: 'pass', type: 'nullFilter', enabled: true }]);

    expect(output[0]).toBe(1);
    expect(output[1]).toBeNaN();
    expect(output[2]).toBe(3);
  });

  it('uses a normalized, zero-phase moving average with stable reflected boundaries', () => {
    expect(Filter.movingAverage(new Array<number>(100).fill(7), 21)).toEqual(new Array<number>(100).fill(7));
    const impulse = new Array<number>(101).fill(0);
    impulse[50] = 1;
    const filtered = Filter.movingAverage(impulse, 11);

    expect(filtered.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
    expect(filtered[45]).toBeCloseTo(filtered[55], 12);
  });

  it('preserves an interior polynomial through a numerically stable Savitzky-Golay fit', () => {
    const values = Array.from({ length: 101 }, (_, index) => 2 + 3 * index - 0.25 * index ** 2);
    const filtered = Filter.savitzkyGolay(values, 11, 2);

    for (let index = 5; index < values.length - 5; index += 1) {
      expect(filtered[index]).toBeCloseTo(values[index], 8);
    }
  });

  it('matches the reference size-5 order-2 Savitzky-Golay coefficients', () => {
    const expected = [-3, 12, 17, 12, -3].map((value) => value / 35);
    const actual = Filter.computeSGWeights(2, 2);

    actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 12));
  });

  it('removes an isolated median spike while preserving a constant state', () => {
    const values = new Array<number>(21).fill(2);
    values[10] = 100;
    const filtered = Filter.median(values, 5);

    expect(filtered).toEqual(new Array<number>(21).fill(2));
  });

  it('implements the documented one-pole IIR recursion exactly', () => {
    expect(Filter.iirLowPass([0, 1, 1], 0.25)).toEqual([0, 0.25, 0.4375]);
  });

  it('normalizes and symmetrically applies the Gaussian kernel', () => {
    const impulse = new Array<number>(101).fill(0);
    impulse[50] = 1;
    const filtered = Filter.gaussian(impulse, 2, 13);

    expect(filtered.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
    for (let offset = 1; offset <= 6; offset += 1) {
      expect(filtered[50 - offset]).toBeCloseTo(filtered[50 + offset], 12);
    }
  });

  it('applies explicit baseline subtraction and endpoint tapers', () => {
    const filtered = Filter.startStopNorm(new Array<number>(20).fill(5), {
      id: 'taper',
      type: 'startStopNorm',
      enabled: true,
      autoOffset: true,
      autoOffsetPoints: 5,
      startLength: 5,
      endLength: 5
    });

    filtered.forEach((value) => expect(value).toBeCloseTo(0, 12));
  });

  it('does not create extra tapers or baseline changes around a quality gap', () => {
    const values = new Array<number>(21).fill(5);
    values[10] = Number.NaN;
    const filtered = Filter.applyPipeline(values, uniformTime(values.length, 1000), [
      {
        id: 'taper',
        type: 'startStopNorm',
        enabled: true,
        startLength: 3,
        endLength: 3,
        startOffset: 0,
        autoOffset: false,
        autoOffsetPoints: 5,
        applyStart: true,
        applyEnd: true
      }
    ]);

    expect(filtered[0]).toBe(0);
    expect(filtered[9]).toBe(5);
    expect(filtered[10]).toBeNaN();
    expect(filtered[11]).toBe(5);
    expect(filtered[20]).toBe(0);
  });

  it('contains non-finite gaps instead of poisoning recursive filters', () => {
    const output = Filter.applyPipeline(
      [1, 1, Number.NaN, 2, 2],
      [0, 1, 2, 3, 4],
      [{ id: 'iir', type: 'iir', enabled: true, alpha: 0.2 }]
    );

    expect(output.slice(0, 2).every(Number.isFinite)).toBe(true);
    expect(output[2]).toBeNaN();
    expect(output.slice(3).every(Number.isFinite)).toBe(true);
  });

  it('propagates quality across each filter contamination footprint', () => {
    const quality = new Uint16Array(11);
    quality[5] = QualityFlag.Clipped;
    const result = Filter.applyPipelineWithReport(
      new Array<number>(11).fill(1),
      uniformTime(11, 1000),
      [{ id: 'smooth', type: 'movingAverage', enabled: true, windowSize: 5 }],
      quality
    );

    for (let index = 0; index < result.quality.length; index += 1) {
      expect(Boolean(result.quality[index] & QualityFlag.Clipped)).toBe(index >= 3 && index <= 7);
      expect(result.quality[index] & QualityFlag.Processed).toBeTruthy();
    }
  });

  it('expands repeated Savitzky-Golay quality footprints and carries auto-offset quality across gaps', () => {
    const sgQuality = new Uint16Array(21);
    sgQuality[10] = QualityFlag.Clipped;
    const sg = Filter.applyPipelineWithReport(
      new Array<number>(21).fill(1),
      uniformTime(21, 1000),
      [
        {
          id: 'sg',
          type: 'savitzkyGolay',
          enabled: true,
          windowSize: 5,
          polyOrder: 2,
          iterations: 2
        }
      ],
      sgQuality
    );
    for (let index = 0; index < sg.quality.length; index += 1) {
      expect(Boolean(sg.quality[index] & QualityFlag.Clipped)).toBe(index >= 6 && index <= 14);
    }

    const baselineQuality = new Uint16Array(7);
    baselineQuality[1] = QualityFlag.Saturated;
    const baseline = Filter.applyPipelineWithReport(
      [1, 1, Number.NaN, 1, 1, 1, 1],
      uniformTime(7, 1000),
      [
        {
          id: 'baseline',
          type: 'startStopNorm',
          enabled: true,
          startLength: 0,
          endLength: 0,
          startOffset: 0,
          autoOffset: true,
          autoOffsetPoints: 5,
          applyStart: false,
          applyEnd: false
        }
      ],
      baselineQuality
    );
    for (const index of [0, 1, 3, 4, 5, 6]) {
      expect(baseline.quality[index] & QualityFlag.Saturated).toBeTruthy();
    }
  });
});

describe('frequency-selective filter quality', () => {
  const sampleRate = 2048;
  const length = 4096;
  const time = uniformTime(length, sampleRate);

  it('meets Kaiser FIR passband and stopband behavior in the pipeline', () => {
    const firRate = 1000;
    const firTime = uniformTime(4096, firRate);
    const values = firTime.map(
      (timestamp) => Math.sin(2 * Math.PI * 50 * timestamp) + Math.sin(2 * Math.PI * 250 * timestamp)
    );
    const result = Filter.applyPipelineWithReport(values, firTime, [
      {
        id: 'fir-low',
        type: 'firLowPass',
        enabled: true,
        cutoffFreq: 100,
        transitionWidth: 50,
        passbandRippleDb: 0.1,
        stopbandAttenuationDb: 60,
        processingMode: 'zero-phase'
      }
    ]);

    expect(toneAmplitude(result.values, firRate, 50, 256)).toBeGreaterThan(0.99);
    expect(toneAmplitude(result.values, firRate, 250, 256)).toBeLessThan(0.002);
    expect(result.steps[0].effectiveParameters.tapCountMin).toBeGreaterThanOrEqual(75);
    expect(result.steps[0].effectiveParameters.achievedStopbandAttenuationDbMin).toBeGreaterThan(59.95);
  });

  it('propagates centered and causal FIR quality over their exact finite footprints', () => {
    const firRate = 1000;
    const firTime = uniformTime(201, firRate);
    const step = {
      id: 'fir-low',
      type: 'firLowPass' as const,
      enabled: true,
      cutoffFreq: 100,
      transitionWidth: 50,
      passbandRippleDb: 0.1,
      stopbandAttenuationDb: 60,
      processingMode: 'zero-phase' as const
    };
    const design = Filter.designedFir(step, firRate);
    const quality = new Uint16Array(firTime.length);
    quality[100] = QualityFlag.Clipped;
    const centered = Filter.applyPipelineWithReport(
      new Array<number>(firTime.length).fill(1),
      firTime,
      [step],
      quality
    );
    const causal = Filter.applyPipelineWithReport(
      new Array<number>(firTime.length).fill(1),
      firTime,
      [{ ...step, processingMode: 'causal' }],
      quality
    );

    for (let index = 0; index < firTime.length; index += 1) {
      expect(Boolean(centered.quality[index] & QualityFlag.Clipped)).toBe(
        index >= 100 - design.delaySamples && index <= 100 + design.delaySamples
      );
      expect(Boolean(causal.quality[index] & QualityFlag.Clipped)).toBe(
        index >= 100 && index <= Math.min(firTime.length - 1, 100 + design.tapCount - 1)
      );
    }
  });

  it('preserves strict FIR causality on uniform data and rejects non-uniform causal reconstruction', () => {
    const step = {
      id: 'fir-causal',
      type: 'firLowPass' as const,
      enabled: true,
      cutoffFreq: 100,
      transitionWidth: 50,
      passbandRippleDb: 0.1,
      stopbandAttenuationDb: 60,
      processingMode: 'causal' as const
    };
    const firTime = uniformTime(300, 1000);
    const impulse = new Array<number>(firTime.length).fill(0);
    impulse[100] = 1;
    const result = Filter.applyPipelineWithReport(impulse, firTime, [step]);
    const design = Filter.designedFir(step, 1000);
    const peakIndex = result.values.reduce(
      (best, value, index) => (Math.abs(value) > Math.abs(result.values[best]) ? index : best),
      0
    );

    result.values.slice(0, 100).forEach((value) => expect(Math.abs(value)).toBeLessThan(1e-14));
    expect(peakIndex).toBe(100 + design.delaySamples);
    expect(result.steps[0].warnings.join(' ')).toContain('constant prehistory');
    expect(result.steps[0].effectiveParameters.boundaryMode).toBe('constant-first-sample prehistory');

    expect(() => Filter.applyPipeline([0, 0, 0, 1], [0, 0.001005, 0.002, 0.003005], [step])).toThrow(
      /Causal FIR filtering requires a uniform timebase/
    );
  });

  it('excludes quality-blocked samples from spectral analysis', () => {
    const values = time.map((timestamp) => Math.sin(2 * Math.PI * 50 * timestamp));
    values[100] = 1e9;
    const quality = new Uint16Array(values.length);
    quality[100] = QualityFlag.Saturated;
    const spectrum = FFT.computeSpectrum(values, time, { quality, zeroPadMode: 'none' });

    const toneBin = Math.round(50 / spectrum.meta.deltaF);
    expect(spectrum.linearMagnitude[toneBin]).toBeCloseTo(1, 3);
    expect(spectrum.meta.resampled).toBe(true);
    expect(spectrum.warnings.join(' ')).toContain('analysis-blocking quality flags');
  });

  it('separates low and high tones with smooth FFT low/high-pass responses', () => {
    const values = time.map(
      (timestamp) => Math.sin(2 * Math.PI * 50 * timestamp) + Math.sin(2 * Math.PI * 400 * timestamp)
    );
    const low = Filter.applyPipeline(values, time, [
      {
        id: 'low',
        type: 'lowPassFFT',
        enabled: true,
        cutoffFreq: 100,
        slope: 24
      }
    ]);
    const high = Filter.applyPipeline(values, time, [
      {
        id: 'high',
        type: 'highPassFFT',
        enabled: true,
        cutoffFreq: 200,
        slope: 24
      }
    ]);

    expect(toneAmplitude(low, sampleRate, 50, 256)).toBeGreaterThan(0.95);
    expect(toneAmplitude(low, sampleRate, 400, 256)).toBeLessThan(0.02);
    expect(toneAmplitude(high, sampleRate, 400, 256)).toBeGreaterThan(0.95);
    expect(toneAmplitude(high, sampleRate, 50, 256)).toBeLessThan(0.02);
  });

  it('avoids circular FFT edge artifacts on constant records', () => {
    const values = new Array<number>(2048).fill(3);
    const low = Filter.applyPipeline(values, time.slice(0, values.length), [
      { id: 'low', type: 'lowPassFFT', enabled: true, cutoffFreq: 100, slope: 24 }
    ]);
    const high = Filter.applyPipeline(values, time.slice(0, values.length), [
      { id: 'high', type: 'highPassFFT', enabled: true, cutoffFreq: 100, slope: 24 }
    ]);

    low.forEach((value) => expect(value).toBeCloseTo(3, 8));
    high.forEach((value) => expect(Math.abs(value)).toBeLessThan(1e-8));
  });

  it('rejects unresolvable FFT notches and preserves baselines for resolvable records', () => {
    const shortRate = 1000;
    const shortTime = uniformTime(100, shortRate);
    const constant = new Array<number>(shortTime.length).fill(3);
    const ramp = shortTime.map((_, index) => -2 + index * 0.025);
    expect(() =>
      Filter.applyPipeline(constant, shortTime, [
        { id: 'unresolved', type: 'notchFFT', enabled: true, centerFreq: 1, bandwidth: 0.2 }
      ])
    ).toThrow(/record resolution/);
    const tooShort = uniformTime(50, shortRate);
    expect(() =>
      Filter.applyPipeline(
        tooShort.map((timestamp) => Math.sin(2 * Math.PI * 200 * timestamp)),
        tooShort,
        [{ id: 'too-short', type: 'notchFFT', enabled: true, centerFreq: 200, bandwidth: 2 }]
      )
    ).toThrow(/record resolution/);

    for (const centerFreq of [10, 100]) {
      const step = {
        id: `notch-${centerFreq}`,
        type: 'notchFFT' as const,
        enabled: true,
        centerFreq,
        bandwidth: 10
      };
      const filteredConstant = Filter.applyPipeline(constant, shortTime, [step]);
      const filteredRamp = Filter.applyPipeline(ramp, shortTime, [step]);
      filteredConstant.forEach((value, index) => expect(Math.abs(value - constant[index])).toBeLessThan(1e-10));
      filteredRamp.forEach((value, index) => expect(Math.abs(value - ramp[index])).toBeLessThan(1e-10));
    }
  });

  it('filters valid runs surrounding invalid, duplicate and decreasing timestamps', () => {
    const values = new Array<number>(9).fill(1);
    const step = {
      id: 'high',
      type: 'highPassFFT' as const,
      enabled: true,
      cutoffFreq: 100,
      slope: 24
    };
    const invalidTime = [0, 0.001, 0.002, 0.003, Number.NaN, 0.005, 0.006, 0.007, 0.008];
    const invalid = Filter.applyPipelineWithReport(values, invalidTime, [step]);
    expect(invalid.values[4]).toBe(1);
    for (const index of [0, 1, 2, 3, 5, 6, 7, 8]) {
      expect(Math.abs(invalid.values[index])).toBeLessThan(1e-10);
    }
    expect(invalid.steps[0].warnings.join(' ')).toContain('Skipped index 4');

    for (const brokenTime of [
      [0, 0.001, 0.002, 0.003, 0.003, 0.004, 0.005, 0.006, 0.007],
      [0, 0.001, 0.002, 0.003, -0.001, 0, 0.001, 0.002, 0.003]
    ]) {
      const split = Filter.applyPipelineWithReport(values, brokenTime, [step]);
      split.values.forEach((value) => expect(Math.abs(value)).toBeLessThan(1e-10));
      expect(split.steps[0].warnings.join(' ')).toContain('Split the frequency-filter run');
    }
  });

  it('uses a tapered FFT notch that removes its band while retaining a nearby tone', () => {
    const values = time.map(
      (timestamp) => Math.sin(2 * Math.PI * 200 * timestamp) + Math.sin(2 * Math.PI * 260 * timestamp)
    );
    const output = Filter.applyPipeline(values, time, [
      {
        id: 'notch',
        type: 'notchFFT',
        enabled: true,
        centerFreq: 200,
        bandwidth: 20
      }
    ]);

    expect(toneAmplitude(output, sampleRate, 200, 256)).toBeLessThan(0.02);
    expect(toneAmplitude(output, sampleRate, 260, 256)).toBeGreaterThan(0.95);
  });

  it('resolves and removes a narrow off-bin FFT notch', () => {
    const narrowSampleRate = 1024;
    const narrowTime = uniformTime(4096, narrowSampleRate);
    const values = narrowTime.map(
      (timestamp) => Math.sin(2 * Math.PI * 50.23 * timestamp) + Math.sin(2 * Math.PI * 55 * timestamp)
    );
    const output = Filter.applyPipeline(values, narrowTime, [
      {
        id: 'narrow-notch',
        type: 'notchFFT',
        enabled: true,
        centerFreq: 50.23,
        bandwidth: 2
      }
    ]);

    expect(toneAmplitude(output, narrowSampleRate, 50.23, 512)).toBeLessThan(0.02);
    expect(toneAmplitude(output, narrowSampleRate, 55, 512)).toBeGreaterThan(0.95);
  });

  it('produces useful Butterworth low/high/band-pass responses', () => {
    const low = computeFilterResponse(
      Filter.designedIirSections(
        {
          id: 'low',
          type: 'butterworthLowPass',
          enabled: true,
          cutoffFreq: 200,
          order: 4,
          processingMode: 'causal'
        },
        sampleRate
      ),
      sampleRate,
      1025
    );
    const high = computeFilterResponse(
      Filter.designedIirSections(
        {
          id: 'high',
          type: 'butterworthHighPass',
          enabled: true,
          cutoffFreq: 200,
          order: 4,
          processingMode: 'causal'
        },
        sampleRate
      ),
      sampleRate,
      1025
    );
    const band = computeFilterResponse(
      Filter.designedIirSections(
        {
          id: 'band',
          type: 'butterworthBandPass',
          enabled: true,
          centerFreq: 300,
          bandwidth: 200,
          order: 4,
          processingMode: 'causal'
        },
        sampleRate
      ),
      sampleRate,
      1025
    );

    expect(low.magnitudeDb[50]).toBeGreaterThan(-0.1);
    expect(low.magnitudeDb[800]).toBeLessThan(-40);
    expect(high.magnitudeDb[50]).toBeLessThan(-40);
    expect(high.magnitudeDb[800]).toBeGreaterThan(-0.1);
    expect(band.magnitudeDb[300]).toBeGreaterThan(-1);
    expect(band.magnitudeDb[50]).toBeLessThan(-20);
    expect(band.magnitudeDb[700]).toBeLessThan(-12);
  });

  it('calibrates broad asymmetric Butterworth band-pass edges for every supported order', () => {
    const calibrationRate = 10_000;
    for (const order of [2, 4, 6, 8, 10, 12]) {
      const response = computeFilterResponse(
        Filter.designedIirSections(
          {
            id: `broad-${order}`,
            type: 'butterworthBandPass',
            enabled: true,
            centerFreq: 2050,
            bandwidth: 3900,
            order,
            processingMode: 'causal'
          },
          calibrationRate
        ),
        calibrationRate,
        5001,
        'causal'
      );
      expect(response.magnitudeDb[100]).toBeCloseTo(-3.0103, 2);
      expect(response.magnitudeDb[4000]).toBeCloseTo(-3.0103, 2);
    }
  });

  it('calibrates requested IIR notch edges in causal and zero-phase modes', () => {
    const calibrationRate = 10_000;
    for (const mode of ['causal', 'zero-phase'] as const) {
      const response = computeFilterResponse(
        Filter.designedIirSections(
          {
            id: `notch-${mode}`,
            type: 'iirNotch',
            enabled: true,
            centerFreq: 4000,
            bandwidth: 1000,
            processingMode: mode
          },
          calibrationRate
        ),
        calibrationRate,
        5001,
        mode
      );
      expect(response.magnitudeDb[3500]).toBeCloseTo(-3.0103, 2);
      expect(response.magnitudeDb[4500]).toBeCloseTo(-3.0103, 2);
      expect(response.magnitudeDb[4000]).toBeLessThan(-200);
    }
  });

  it('calibrates narrow comb-notch edges without silently dropping harmonics', () => {
    const calibrationRate = 10_000;
    for (const mode of ['causal', 'zero-phase'] as const) {
      const response = computeFilterResponse(
        Filter.designedIirSections(
          {
            id: `comb-${mode}`,
            type: 'iirComb',
            enabled: true,
            centerFreq: 1000,
            bandwidth: 20,
            harmonicCount: 4,
            processingMode: mode
          },
          calibrationRate
        ),
        calibrationRate,
        5001,
        mode
      );
      for (const center of [1000, 2000, 3000, 4000]) {
        expect(response.magnitudeDb[center]).toBeLessThan(-200);
        expect(response.magnitudeDb[center - 10]).toBeCloseTo(-3.0103, 1);
        expect(response.magnitudeDb[center + 10]).toBeCloseTo(-3.0103, 1);
      }
    }
  });

  it('places IIR notch and comb zeros at their requested frequencies', () => {
    const notch = computeFilterResponse(
      Filter.designedIirSections(
        {
          id: 'notch',
          type: 'iirNotch',
          enabled: true,
          centerFreq: 200,
          bandwidth: 10,
          processingMode: 'causal'
        },
        sampleRate
      ),
      sampleRate,
      1025
    );
    const comb = computeFilterResponse(
      Filter.designedIirSections(
        {
          id: 'comb',
          type: 'iirComb',
          enabled: true,
          centerFreq: 100,
          bandwidth: 5,
          harmonicCount: 4,
          processingMode: 'causal'
        },
        sampleRate
      ),
      sampleRate,
      1025
    );

    expect(notch.magnitudeDb[200]).toBeLessThan(-200);
    for (const frequency of [100, 200, 300, 400]) {
      expect(comb.magnitudeDb[frequency]).toBeLessThan(-180);
    }
  });

  it('keeps every designed IIR mode finite at the maximum supported order', () => {
    const impulse = new Array<number>(4096).fill(0);
    impulse[2048] = 1;
    for (const step of [
      { id: 'lp', type: 'butterworthLowPass' as const, enabled: true, cutoffFreq: 200, order: 12 },
      { id: 'hp', type: 'butterworthHighPass' as const, enabled: true, cutoffFreq: 200, order: 12 },
      {
        id: 'bp',
        type: 'butterworthBandPass' as const,
        enabled: true,
        centerFreq: 300,
        bandwidth: 200,
        order: 12
      },
      { id: 'notch', type: 'iirNotch' as const, enabled: true, centerFreq: 200, bandwidth: 10 },
      {
        id: 'comb',
        type: 'iirComb' as const,
        enabled: true,
        centerFreq: 100,
        bandwidth: 5,
        harmonicCount: 8
      }
    ]) {
      const output = Filter.applyPipeline(impulse, time, [{ ...step, processingMode: 'zero-phase' }]);
      expect(output.every(Number.isFinite)).toBe(true);
    }
  });

  it('reports analytic moving-average and one-pole responses', () => {
    const moving = Filter.calculateSmootherResponse(
      [{ id: 'moving', type: 'movingAverage', enabled: true, windowSize: 3 }],
      1000,
      501
    );
    const onePole = Filter.calculateSmootherResponse(
      [{ id: 'one-pole', type: 'iir', enabled: true, alpha: 0.2 }],
      1000,
      501
    );
    const omega = (2 * Math.PI * 100) / 1000;
    const expectedOnePole = 0.2 / Math.hypot(1 - 0.8 * Math.cos(omega), 0.8 * Math.sin(omega));

    expect(moving?.magnitudeDb[0]).toBeCloseTo(0, 12);
    expect(moving?.magnitudeDb[250]).toBeCloseTo(20 * Math.log10(1 / 3), 10);
    expect(onePole?.magnitudeDb[100]).toBeCloseTo(20 * Math.log10(expectedOnePole), 10);
  });

  it('keeps the final sample finite when filtering a non-uniform endpoint', () => {
    const output = Filter.applyPipeline(
      [0, 1, 0, -1],
      [0, 1, 2, 3.4],
      [
        {
          id: 'low',
          type: 'butterworthLowPass',
          enabled: true,
          cutoffFreq: 0.2,
          order: 4,
          processingMode: 'zero-phase'
        }
      ]
    );

    expect(output).toHaveLength(4);
    expect(output.every(Number.isFinite)).toBe(true);
  });

  it('maps short non-uniform frequency-filter runs back without anti-alias failure', () => {
    const output = Filter.applyPipeline(
      [0, 1, 0, -1],
      [0, 1, 2, 2.6],
      [
        {
          id: 'low',
          type: 'butterworthLowPass',
          enabled: true,
          cutoffFreq: 0.2,
          order: 4,
          processingMode: 'zero-phase'
        }
      ]
    );

    expect(output).toHaveLength(4);
    expect(output.every(Number.isFinite)).toBe(true);
  });

  it('rejects infeasible broad notch and overlapping comb bandwidths explicitly', () => {
    expect(() =>
      Filter.designedIirSections(
        {
          id: 'broad-notch',
          type: 'iirNotch',
          enabled: true,
          centerFreq: 100,
          bandwidth: 180,
          processingMode: 'causal'
        },
        1000
      )
    ).toThrow(/too broad/);
    expect(() =>
      Filter.designedIirSections(
        {
          id: 'overlap-comb',
          type: 'iirComb',
          enabled: true,
          centerFreq: 100,
          bandwidth: 100,
          harmonicCount: 4,
          processingMode: 'causal'
        },
        1000
      )
    ).toThrow(/harmonic spacing/);
    expect(() =>
      Filter.designedIirSections(
        {
          id: 'distorted-comb',
          type: 'iirComb',
          enabled: true,
          centerFreq: 100,
          bandwidth: 80,
          harmonicCount: 4,
          processingMode: 'causal'
        },
        1000
      )
    ).toThrow(/violate the requested -3 dB bandwidth/);
  });
});

describe('robust denoising quality', () => {
  it('Hampel-replaces an isolated spike even when local MAD is zero', () => {
    const values = new Array<number>(21).fill(1);
    values[10] = 100;
    const result = hampelDeglitch(values, 3, 3);

    expect(result.values).toEqual(new Array<number>(21).fill(1));
    expect(result.changedIndices).toEqual([10]);
  });

  it('keeps a constant signal unchanged through automatic wavelet thresholding', () => {
    const values = new Array<number>(256).fill(3);
    const result = waveletDenoiseHaar(values, { levels: 6 });

    result.values.forEach((value) => expect(value).toBeCloseTo(3, 12));
    expect(result.effectiveParameters?.thresholdRule).toBe('per-level universal MAD');
    expect(result.effectiveParameters?.thresholds).toHaveLength(6);
  });

  it('time-gates and reference-subtracts with explicit, aligned operations', () => {
    expect(timeGate([0, 1, 2, 3], [1, 2, 3, 4], 1, 2).values).toEqual([0, 2, 3, 0]);
    expect(timeGate([0, 1, 2, 3], [1, 2, 3, 4], 2, 1).values).toEqual([0, 2, 3, 0]);
    expect(subtractReference([3, 5, 7], [1, 2, 3], 2).values).toEqual([1, 1, 1]);
    expect(subtractReference([3, 5, 7], [1], 2).values).toEqual([1, Number.NaN, Number.NaN]);
  });
});
