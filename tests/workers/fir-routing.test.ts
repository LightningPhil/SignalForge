import { describe, expect, it } from 'vitest';
import { Filter } from '../../src/processing/filter';
import type { FilterStep } from '../../src/types';

const uniformTime = Array.from({ length: 256 }, (_, index) => index / 2000);

describe('FIR worker routing', () => {
  it('keeps small ordinary designs synchronous and routes expensive designs to a worker', () => {
    const ordinary: FilterStep = {
      id: 'ordinary',
      type: 'firLowPass',
      enabled: true,
      cutoffFreq: 300,
      transitionWidth: 100,
      passbandRippleDb: 0.1,
      stopbandAttenuationDb: 60,
      processingMode: 'zero-phase'
    };
    const expensive: FilterStep = {
      id: 'expensive',
      type: 'firBandPass',
      enabled: true,
      centerFreq: 102.5,
      bandwidth: 95,
      transitionWidth: 15,
      passbandRippleDb: 0.1,
      stopbandAttenuationDb: 160,
      processingMode: 'zero-phase'
    };

    expect(Filter.shouldRunFirInWorker([ordinary], uniformTime, uniformTime.length)).toBe(false);
    expect(Filter.shouldRunFirInWorker([expensive], uniformTime, uniformTime.length)).toBe(true);
  });

  it('routes timebases outside the strict FIR uniformity tolerance to a worker', () => {
    const jittered = uniformTime.map((value, index) => value + (index % 2 === 0 ? 0 : 0.0000025));
    const step: FilterStep = {
      id: 'causal',
      type: 'firLowPass',
      enabled: true,
      cutoffFreq: 300,
      transitionWidth: 100,
      passbandRippleDb: 0.1,
      stopbandAttenuationDb: 60,
      processingMode: 'causal'
    };

    expect(Filter.shouldRunFirInWorker([step], jittered, jittered.length)).toBe(true);
  });
});
