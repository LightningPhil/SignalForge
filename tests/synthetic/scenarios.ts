import { createSeededRng, jitteredTimebase, uniformTimebase } from './lab.ts';
import type { SyntheticComponent, SyntheticRecord } from './lab.ts';
import { composeSyntheticRecord } from './lab.ts';

export const scenarioNames = ['clean-pulse-train', 'mixed-pulse-ringing', 'jittered-ringdown'] as const;
export type ScenarioName = (typeof scenarioNames)[number];

export interface ScenarioCatalogEntry {
  name: ScenarioName;
  description: string;
  sampleCount: number;
  nominalSampleRate: number;
  timebase: 'uniform' | 'jittered';
  expected: {
    timeChecksum: string;
    valueChecksum: string;
    missingSamples: number;
    clippedSamples: number;
  };
  build(): SyntheticRecord;
}

// LAB_CHECKSUMS_START
export const expectedScenarioChecksums: Record<ScenarioName, { timeChecksum: string; valueChecksum: string }> = {
  'clean-pulse-train': { timeChecksum: 'fce8f0fc08aeeb82', valueChecksum: '50d4220471e58442' },
  'mixed-pulse-ringing': { timeChecksum: '968bbab431f5a0fe', valueChecksum: 'c884f45c9d2477c8' },
  'jittered-ringdown': { timeChecksum: 'bce97b9b02806fa9', valueChecksum: '6a1b334c9be96c92' }
};
// LAB_CHECKSUMS_END

function cleanPulseTrain(): SyntheticRecord {
  const sampleRate = 1_000_000;
  const pulseStarts = [0.001, 0.004, 0.007, 0.01];
  const components: SyntheticComponent[] = [
    { kind: 'whiteNoise', sigma: 0.004 },
    ...pulseStarts.map((startSeconds): SyntheticComponent => ({
      kind: 'pulse',
      startSeconds,
      widthSeconds: 400e-6,
      riseSeconds: 8e-6,
      fallSeconds: 12e-6,
      amplitude: 1
    }))
  ];
  return composeSyntheticRecord({
    name: 'clean-pulse-train',
    time: uniformTimebase(12_000, sampleRate),
    seed: 0x1357_9bdf,
    components
  });
}

function mixedPulseRinging(): SyntheticRecord {
  const sampleRate = 1_000_000;
  return composeSyntheticRecord({
    name: 'mixed-pulse-ringing',
    time: uniformTimebase(16_384, sampleRate, -0.001),
    seed: 0x2468_ace0,
    baseline: 0.05,
    components: [
      { kind: 'whiteNoise', sigma: 0.012 },
      {
        kind: 'pulse',
        startSeconds: 0.002,
        widthSeconds: 1.2e-3,
        riseSeconds: 20e-6,
        fallSeconds: 30e-6,
        amplitude: 1.25
      },
      {
        kind: 'ringing',
        startSeconds: 0.0032,
        amplitude: 0.55,
        frequencyHz: 55_000,
        decaySeconds: 350e-6,
        endSeconds: 0.0055
      },
      {
        kind: 'pulse',
        startSeconds: 0.009,
        widthSeconds: 800e-6,
        riseSeconds: 10e-6,
        fallSeconds: 10e-6,
        amplitude: -1.1
      },
      { kind: 'clip', minimum: -0.9, maximum: 1.05 },
      { kind: 'nanGap', startIndex: 7000, endIndex: 7048 }
    ]
  });
}

function jitteredRingdown(): SyntheticRecord {
  const sampleRate = 10_000_000;
  const time = jitteredTimebase(20_000, sampleRate, createSeededRng(0x0bad_c0de), 0.025);
  return composeSyntheticRecord({
    name: 'jittered-ringdown',
    time,
    seed: 0x51a1_f00d,
    components: [
      {
        kind: 'ringing',
        startSeconds: 0,
        amplitude: 1,
        frequencyHz: 50_000,
        decaySeconds: 200e-6
      },
      { kind: 'whiteNoise', sigma: 0.03 }
    ]
  });
}

export const scenarioCatalog: Record<ScenarioName, ScenarioCatalogEntry> = {
  'clean-pulse-train': {
    name: 'clean-pulse-train',
    description: 'Four finite-edge pulses on low seeded white noise.',
    sampleCount: 12_000,
    nominalSampleRate: 1_000_000,
    timebase: 'uniform',
    expected: {
      ...expectedScenarioChecksums['clean-pulse-train'],
      missingSamples: 0,
      clippedSamples: 0
    },
    build: cleanPulseTrain
  },
  'mixed-pulse-ringing': {
    name: 'mixed-pulse-ringing',
    description: 'Bipolar pulses, ringdown, clipping, noise, and one explicit NaN gap.',
    sampleCount: 16_384,
    nominalSampleRate: 1_000_000,
    timebase: 'uniform',
    expected: {
      ...expectedScenarioChecksums['mixed-pulse-ringing'],
      missingSamples: 48,
      clippedSamples: 1942
    },
    build: mixedPulseRinging
  },
  'jittered-ringdown': {
    name: 'jittered-ringdown',
    description: 'A noisy exponential ringdown sampled on a seeded non-uniform timebase.',
    sampleCount: 20_000,
    nominalSampleRate: 10_000_000,
    timebase: 'jittered',
    expected: {
      ...expectedScenarioChecksums['jittered-ringdown'],
      missingSamples: 0,
      clippedSamples: 0
    },
    build: jitteredRingdown
  }
};

export function buildScenario(name: ScenarioName): SyntheticRecord {
  return scenarioCatalog[name].build();
}
