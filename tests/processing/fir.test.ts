import { describe, expect, it } from 'vitest';
import {
  applyFir,
  computeFirResponse,
  designKaiserFir,
  estimateFirWorkingBytes,
  kaiserBeta,
  MAX_FIR_WORKING_BYTES,
  type FirSpecification
} from '../../src/processing/fir';

const specifications: FirSpecification[] = [
  {
    kind: 'lowpass',
    sampleRate: 1000,
    passbandEdgeHz: 100,
    stopbandEdgeHz: 150,
    passbandRippleDb: 0.1,
    stopbandAttenuationDb: 60
  },
  {
    kind: 'highpass',
    sampleRate: 1000,
    stopbandEdgeHz: 100,
    passbandEdgeHz: 150,
    passbandRippleDb: 0.1,
    stopbandAttenuationDb: 60
  },
  {
    kind: 'bandpass',
    sampleRate: 1000,
    lowerStopbandEdgeHz: 80,
    lowerPassbandEdgeHz: 100,
    upperPassbandEdgeHz: 200,
    upperStopbandEdgeHz: 220,
    passbandRippleDb: 0.1,
    stopbandAttenuationDb: 60
  },
  {
    kind: 'bandstop',
    sampleRate: 1000,
    lowerPassbandEdgeHz: 80,
    lowerStopbandEdgeHz: 100,
    upperStopbandEdgeHz: 200,
    upperPassbandEdgeHz: 220,
    passbandRippleDb: 0.1,
    stopbandAttenuationDb: 60
  }
];

function independentMagnitude(coefficients: number[], frequencyHz: number, sampleRate: number): number {
  let real = 0;
  let imaginary = 0;
  const omega = (2 * Math.PI * frequencyHz) / sampleRate;
  for (let tap = 0; tap < coefficients.length; tap += 1) {
    real += coefficients[tap] * Math.cos(omega * tap);
    imaginary -= coefficients[tap] * Math.sin(omega * tap);
  }
  return Math.hypot(real, imaginary);
}

function region(specification: FirSpecification, frequency: number): 'pass' | 'stop' | null {
  if (specification.kind === 'lowpass') {
    if (frequency <= specification.passbandEdgeHz) return 'pass';
    if (frequency >= specification.stopbandEdgeHz) return 'stop';
  } else if (specification.kind === 'highpass') {
    if (frequency <= specification.stopbandEdgeHz) return 'stop';
    if (frequency >= specification.passbandEdgeHz) return 'pass';
  } else if (specification.kind === 'bandpass') {
    if (frequency >= specification.lowerPassbandEdgeHz && frequency <= specification.upperPassbandEdgeHz) {
      return 'pass';
    }
    if (frequency <= specification.lowerStopbandEdgeHz || frequency >= specification.upperStopbandEdgeHz) {
      return 'stop';
    }
  } else {
    if (frequency <= specification.lowerPassbandEdgeHz || frequency >= specification.upperPassbandEdgeHz) {
      return 'pass';
    }
    if (frequency >= specification.lowerStopbandEdgeHz && frequency <= specification.upperStopbandEdgeHz) {
      return 'stop';
    }
  }
  return null;
}

describe('Kaiser FIR design', () => {
  it('uses the reference Kaiser equations and odd Type-I tap counts', () => {
    expect(kaiserBeta(20)).toBe(0);
    expect(kaiserBeta(60)).toBeCloseTo(5.65326, 5);
    const design = designKaiserFir(specifications[0]);

    expect(design.tapCount).toBeGreaterThanOrEqual(75);
    expect(design.tapCount % 2).toBe(1);
    expect(design.delaySamples).toBe((design.tapCount - 1) / 2);
  });

  it.each(specifications.map((specification) => [specification.kind, specification] as const))(
    'meets %s ripple and attenuation specifications',
    (_kind, specification) => {
      const design = designKaiserFir(specification);
      expect(design.achievedPassbandRippleDb).toBeLessThanOrEqual(specification.passbandRippleDb);
      expect(design.achievedStopbandAttenuationDb).toBeGreaterThanOrEqual(specification.stopbandAttenuationDb);
      for (let index = 0; index < design.tapCount; index += 1) {
        expect(design.coefficients[index]).toBe(design.coefficients[design.tapCount - 1 - index]);
      }
      let passMinimum = Infinity;
      let passMaximum = 0;
      let stopMaximum = 0;
      for (let frequency = 0; frequency <= specification.sampleRate / 2; frequency += 0.5) {
        const magnitude = independentMagnitude(design.coefficients, frequency, specification.sampleRate);
        const classified = region(specification, frequency);
        if (classified === 'pass') {
          passMinimum = Math.min(passMinimum, magnitude);
          passMaximum = Math.max(passMaximum, magnitude);
        } else if (classified === 'stop') {
          stopMaximum = Math.max(stopMaximum, magnitude);
        }
      }
      expect(20 * Math.log10(passMaximum / passMinimum)).toBeLessThanOrEqual(specification.passbandRippleDb);
      expect(-20 * Math.log10(stopMaximum)).toBeGreaterThanOrEqual(specification.stopbandAttenuationDb);
    }
  );

  it('normalizes the appropriate passband reference for every response family', () => {
    for (const specification of specifications) {
      const design = designKaiserFir(specification);
      const response = computeFirResponse(design.coefficients, specification.sampleRate, 1001, 'causal');
      const referenceHz =
        specification.kind === 'lowpass' || specification.kind === 'bandstop'
          ? 0
          : specification.kind === 'highpass'
            ? specification.sampleRate / 2
            : (specification.lowerPassbandEdgeHz + specification.upperPassbandEdgeHz) / 2;
      const referenceIndex = Math.round((referenceHz / (specification.sampleRate / 2)) * 1000);
      expect(response.magnitudeDb[referenceIndex]).toBeCloseTo(0, 9);
    }
  });

  it('reports exact causal linear-phase delay and zero centered delay', () => {
    const design = designKaiserFir(specifications[0]);
    const causal = computeFirResponse(design.coefficients, 1000, 501, 'causal');
    const centered = computeFirResponse(design.coefficients, 1000, 501, 'zero-phase');

    expect(causal.groupDelaySeconds[50]).toBeCloseTo(design.delaySamples / 1000, 12);
    expect(centered.groupDelaySeconds[50]).toBe(0);
    expect(Math.abs(centered.phaseDeg[50])).toBeLessThan(1e-9);
  });

  it('rejects infeasible transition specifications before large allocation', () => {
    expect(() =>
      designKaiserFir({
        kind: 'lowpass',
        sampleRate: 1_000_000,
        passbandEdgeHz: 100_000,
        stopbandEdgeHz: 100_001,
        passbandRippleDb: 0.001,
        stopbandAttenuationDb: 160
      })
    ).toThrow(/tap safety limit/);
  });

  it('checks exact off-grid edges without relaxing requested attenuation', () => {
    const design = designKaiserFir({
      kind: 'lowpass',
      sampleRate: 2,
      passbandEdgeHz: 0.2024,
      stopbandEdgeHz: 0.33022,
      passbandRippleDb: 3,
      stopbandAttenuationDb: 30
    });
    const stopEdgeMagnitude = independentMagnitude(design.coefficients, 0.33022, 2);
    let stopbandMaximum = 0;
    for (let frequency = 0.33022; frequency <= 1; frequency += 0.0001) {
      stopbandMaximum = Math.max(stopbandMaximum, independentMagnitude(design.coefficients, frequency, 2));
    }

    expect(-20 * Math.log10(stopEdgeMagnitude)).toBeGreaterThanOrEqual(30);
    expect(-20 * Math.log10(stopbandMaximum)).toBeGreaterThanOrEqual(30);
    expect(design.achievedStopbandAttenuationDb).toBeGreaterThanOrEqual(30);
  });

  it('continues feasible high-attenuation searches beyond the former retry window', () => {
    const design = designKaiserFir({
      kind: 'bandpass',
      sampleRate: 2000,
      lowerStopbandEdgeHz: 40,
      lowerPassbandEdgeHz: 55,
      upperPassbandEdgeHz: 150,
      upperStopbandEdgeHz: 165,
      passbandRippleDb: 0.1,
      stopbandAttenuationDb: 160
    });

    expect(design.tapCount).toBeGreaterThanOrEqual(1549);
    expect(design.tapCount).toBeLessThanOrEqual(16_385);
    expect(design.achievedStopbandAttenuationDb).toBeGreaterThanOrEqual(160);
  });

  it('designs a 10k-tap filter whose reported extrema match an independent dense sweep', () => {
    // Regression: the search stepped +2 taps per dense verification and re-evaluated every grid
    // extremum with the direct O(taps) sum, so this specification took more than ten minutes.
    const specification: FirSpecification = {
      kind: 'lowpass',
      sampleRate: 1_000_000,
      passbandEdgeHz: 10_000,
      stopbandEdgeHz: 10_500,
      passbandRippleDb: 0.1,
      stopbandAttenuationDb: 80
    };
    const design = designKaiserFir(specification);

    expect(design.tapCount).toBeGreaterThan(10_000);
    expect(design.achievedStopbandAttenuationDb).toBeGreaterThanOrEqual(80);
    expect(design.achievedPassbandRippleDb).toBeLessThanOrEqual(0.1);

    // Independent sweep of the stopband just above the edge where the worst lobe lives.
    let stopbandMaximum = 0;
    for (let frequency = 10_500; frequency <= 12_000; frequency += 2.5) {
      stopbandMaximum = Math.max(stopbandMaximum, independentMagnitude(design.coefficients, frequency, 1_000_000));
    }
    expect(-20 * Math.log10(stopbandMaximum)).toBeGreaterThanOrEqual(design.achievedStopbandAttenuationDb - 1e-6);
  }, 30_000);
});

describe('FIR application', () => {
  it('preserves DC with centered reflection and rejects it in high-pass mode', () => {
    const low = designKaiserFir(specifications[0]);
    const high = designKaiserFir(specifications[1]);
    const source = new Array<number>(1000).fill(3);

    applyFir(source, low.coefficients, 'zero-phase').forEach((value) => expect(value).toBeCloseTo(3, 11));
    applyFir(source, high.coefficients, 'zero-phase').forEach((value) => expect(Math.abs(value)).toBeLessThan(1e-11));
  });

  it('matches independent direct centered convolution when overlap-add is selected', () => {
    const design = designKaiserFir(specifications[0]);
    const source = Array.from({ length: 60_000 }, (_, index) => Math.sin(index * 0.17) + 0.1 * Math.cos(index * 0.03));
    const actual = applyFir(source, design.coefficients, 'zero-phase');
    const delay = design.delaySamples;
    const reflected = (index: number) => {
      const period = 2 * (source.length - 1);
      const wrapped = ((index % period) + period) % period;
      return source[wrapped < source.length ? wrapped : period - wrapped];
    };

    for (const index of [0, 1, delay, 10_000, source.length - delay - 1, source.length - 1]) {
      let expected = 0;
      for (let tap = 0; tap < design.tapCount; tap += 1) {
        expected += design.coefficients[tap] * reflected(index + delay - tap);
      }
      expect(actual[index]).toBeCloseTo(expected, 10);
    }
  });

  it('rejects excessive working sets and non-finite coefficients before convolution', () => {
    expect(estimateFirWorkingBytes(100_000_000, 1)).toBeGreaterThan(MAX_FIR_WORKING_BYTES);
    const oversized = { length: 100_000_000, 0: 1 } as ArrayLike<number>;
    expect(() => applyFir(oversized, [1], 'causal')).toThrow(/working set/);
    expect(() => applyFir([1, 2, 3], [0, Number.NaN, 0], 'zero-phase')).toThrow(/finite/);
  });
});
