import { composeSyntheticRecord, uniformTimebase } from './lab.ts';
import type { SyntheticRecord } from './lab.ts';

export const SCALE_SAMPLE_RATE = 1_000_000;

export interface ScaleFixture {
  record: SyntheticRecord;
  positivePulseStarts: readonly [number, number];
  negativePulseStart: number;
  pulseWidthSamples: number;
  gap: readonly [number, number];
}

export function buildScaleFixture(sampleCount: number, seed = 0x600d_f00d): ScaleFixture {
  const time = uniformTimebase(sampleCount, SCALE_SAMPLE_RATE);
  const positivePulseStarts = [Math.floor(sampleCount * 0.1), Math.floor(sampleCount * 0.45)] as const;
  const negativePulseStart = Math.floor(sampleCount * 0.78);
  const pulseWidthSamples = Math.max(200, Math.floor(sampleCount * 0.02));
  const gapStart = Math.floor(sampleCount * 0.62);
  const gap = [gapStart, Math.min(sampleCount, gapStart + 64)] as const;
  const seconds = (index: number) => index / SCALE_SAMPLE_RATE;

  const record = composeSyntheticRecord({
    name: `scale-${sampleCount}`,
    time,
    seed,
    baseline: 0.02,
    components: [
      { kind: 'whiteNoise', sigma: 0.006 },
      ...positivePulseStarts.map((startIndex) => ({
        kind: 'pulse' as const,
        startSeconds: seconds(startIndex),
        widthSeconds: seconds(pulseWidthSamples),
        riseSeconds: 16 / SCALE_SAMPLE_RATE,
        fallSeconds: 24 / SCALE_SAMPLE_RATE,
        amplitude: 1.3
      })),
      {
        kind: 'ringing',
        startSeconds: seconds(positivePulseStarts[0] + pulseWidthSamples),
        amplitude: 0.32,
        frequencyHz: 25_000,
        decaySeconds: 450e-6
      },
      {
        kind: 'pulse',
        startSeconds: seconds(negativePulseStart),
        widthSeconds: seconds(pulseWidthSamples),
        riseSeconds: 12 / SCALE_SAMPLE_RATE,
        fallSeconds: 20 / SCALE_SAMPLE_RATE,
        amplitude: -1.2
      },
      { kind: 'clip', minimum: -1, maximum: 1 },
      { kind: 'nanGap', startIndex: gap[0], endIndex: gap[1] }
    ]
  });
  return { record, positivePulseStarts, negativePulseStart, pulseWidthSamples, gap };
}
