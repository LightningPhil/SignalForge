import { describe, expect, it } from 'vitest';
import {
  computeEventAlignedSpectrogram,
  EVENT_ALIGNED_SPECTROGRAM_LIMITS
} from '../../src/analysis/eventAlignedSpectrogram';
import { QualityFlag } from '../../src/data/quality';
import { createAnnotation, createShot, type SessionChannel, type Shot } from '../../src/domain/session';

const SAMPLE_RATE = 2048;
const TONE_HZ = 80;

function eventChannel(eventTime: number): SessionChannel {
  const time = Float64Array.from({ length: SAMPLE_RATE * 2 + 1 }, (_, index) => index / SAMPLE_RATE);
  const values = Float64Array.from(time, (value) => {
    const relative = value - eventTime;
    return Math.abs(relative) <= 0.18 ? Math.sin(2 * Math.PI * TONE_HZ * relative) : 0;
  });
  return {
    id: `signal-${eventTime}`,
    name: 'Signal',
    unit: 'V',
    timeUnit: 's',
    time,
    values,
    quality: new Uint16Array(time.length),
    calibration: { scale: 1, offset: 0 },
    timingOffsetSeconds: 0
  };
}

function markedShot(name: string, eventTime: number): Shot {
  const shot = createShot(name);
  shot.channels.push(eventChannel(eventTime));
  shot.annotations.push(createAnnotation('event', eventTime));
  shot.metadata.campaign = name;
  return shot;
}

function peak(result: { freqBins: number[]; magnitudeDb: number[][] }): { frequency: number; magnitude: number } {
  let index = 0;
  let magnitude = -Infinity;
  result.magnitudeDb.forEach((row, rowIndex) => {
    const rowPeak = row.reduce((maximum, value) => Math.max(maximum, value), -Infinity);
    if (rowPeak > magnitude) {
      index = rowIndex;
      magnitude = rowPeak;
    }
  });
  return { frequency: result.freqBins[index], magnitude };
}

const ANALYSIS_OPTIONS = {
  beforeSeconds: 0.2,
  afterSeconds: 0.2,
  sampleCount: 513,
  windowSize: 128,
  overlap: 0.5,
  windowType: 'rectangular' as const,
  detrend: 'none' as const
};

describe('event-aligned spectrograms', () => {
  it('computes deterministic per-shot STFT matrices on the shared relative-time alignment', () => {
    const first = markedShot('First', 0.5);
    const second = markedShot('Second', 1.25);

    const result = computeEventAlignedSpectrogram([first, second], 'Signal', 'event', ANALYSIS_OPTIONS);

    expect(result.warnings.join(' ')).toContain('anti-alias');
    expect(result.shots.map((shot) => shot.shotName)).toEqual(['First', 'Second']);
    expect(result.shots[0].metadata.campaign).toBe('First');
    expect(result.shots[0].timeBins).toEqual(result.shots[1].timeBins);
    expect(result.shots[0].freqBins).toEqual(result.shots[1].freqBins);
    expect(result.shots[0].magnitudeDb).toHaveLength(result.shots[0].freqBins.length);
    expect(result.shots[0].magnitudeDb.every((row) => row.length === result.shots[0].timeBins.length)).toBe(true);
    expect(result.shots[0].timeBins.some((time) => Math.abs(time) < 1e-12)).toBe(true);
    expect(peak(result.shots[0]).frequency).toBeCloseTo(TONE_HZ, 8);
    expect(peak(result.shots[1]).frequency).toBeCloseTo(TONE_HZ, 8);
    expect(peak(result.shots[1]).magnitude).toBeCloseTo(peak(result.shots[0]).magnitude, 10);
    expect(result.shots[0].meta.windowSize).toBe(128);
  });

  it('keeps a manual marker authoritative over an earlier accepted suggestion', () => {
    const manual = createShot('Manual authority');
    manual.channels.push(eventChannel(1));
    manual.annotations.push(
      createAnnotation('event', 0.4, { source: 'suggested', suggestionState: 'accepted' }),
      createAnnotation('event', 1, { source: 'manual' })
    );
    const suggestionOnly = createShot('Suggestion only');
    suggestionOnly.channels.push(eventChannel(1));
    suggestionOnly.annotations.push(
      createAnnotation('event', 0.4, { source: 'suggested', suggestionState: 'accepted' })
    );

    const result = computeEventAlignedSpectrogram([manual, suggestionOnly], 'Signal', 'event', ANALYSIS_OPTIONS);

    expect(result.shots).toHaveLength(2);
    expect(peak(result.shots[0]).frequency).toBeCloseTo(TONE_HZ, 8);
    expect(peak(result.shots[0]).magnitude).toBeGreaterThan(-6);
    expect(peak(result.shots[1]).magnitude).toBe(-240);
  });

  it('omits missing, incomplete and invalid shots while preserving diagnostic warnings', () => {
    const valid = markedShot('Valid', 1);
    const missingMarker = createShot('Missing marker');
    missingMarker.channels.push(eventChannel(1));
    const missingChannel = createShot('Missing channel');
    missingChannel.annotations.push(createAnnotation('event', 1));
    const pendingOnly = createShot('Pending only');
    pendingOnly.channels.push(eventChannel(1));
    pendingOnly.annotations.push(createAnnotation('event', 1, { source: 'suggested' }));
    const invalidTimebase = markedShot('Invalid timebase', 1);
    invalidTimebase.channels[0].time[1000] = invalidTimebase.channels[0].time[999];
    const nonFinite = markedShot('Non-finite samples', 1);
    nonFinite.channels[0].values[SAMPLE_RATE] = Number.NaN;
    const incompleteWindow = markedShot('Incomplete window', 0.05);

    const result = computeEventAlignedSpectrogram(
      [valid, missingMarker, missingChannel, pendingOnly, invalidTimebase, nonFinite, incompleteWindow],
      'Signal',
      'event',
      ANALYSIS_OPTIONS
    );
    const warnings = result.warnings.join(' ');

    expect(result.shots.map((shot) => shot.shotName)).toEqual(['Valid']);
    expect(warnings).toContain('Missing marker: missing accepted "event" marker');
    expect(warnings).toContain('Missing channel: missing accepted "event" marker or "Signal" channel');
    expect(warnings).toContain('Pending only: missing accepted "event" marker');
    expect(warnings).toContain('Invalid timebase: "Signal" channel has an invalid timebase');
    expect(warnings).toContain('Non-finite samples: the requested event window is not fully covered');
    expect(warnings).toContain('Incomplete window: the requested event window is not fully covered');
  });

  it('returns authoritative STFT warnings at both shot and aggregate levels', () => {
    const result = computeEventAlignedSpectrogram([markedShot('Decimated', 1)], 'Signal', 'event', {
      ...ANALYSIS_OPTIONS,
      sampleCount: 512,
      windowSize: 64,
      maxPoints: 64
    });

    expect(result.shots).toHaveLength(1);
    expect(result.shots[0].warnings.join(' ')).toContain('IIR anti-alias');
    expect(result.warnings.join(' ')).toContain('Decimated: Applied IIR anti-alias');
  });

  it('omits event windows carrying analysis-blocking quality flags', () => {
    const clipped = markedShot('Clipped', 1);
    clipped.channels[0].quality.fill(QualityFlag.Clipped);
    const result = computeEventAlignedSpectrogram([clipped], 'Signal', 'event', ANALYSIS_OPTIONS);

    expect(result.shots).toHaveLength(0);
    expect(result.warnings.join(' ')).toContain('analysis-blocking quality flags');
  });

  it('normalizes unsafe options to fixed bounds without consulting mutable application state', () => {
    const maximum = Number.MAX_VALUE;
    expect(Object.isFrozen(EVENT_ALIGNED_SPECTROGRAM_LIMITS)).toBe(true);
    const first = computeEventAlignedSpectrogram([], 'Signal', 'event', {
      beforeSeconds: maximum,
      afterSeconds: maximum,
      sampleCount: maximum,
      windowSize: maximum,
      overlap: maximum,
      maxPoints: maximum,
      freqMin: -1,
      freqMax: maximum
    });
    const second = computeEventAlignedSpectrogram([], 'Signal', 'event', {
      beforeSeconds: maximum,
      afterSeconds: maximum,
      sampleCount: maximum,
      windowSize: maximum,
      overlap: maximum,
      maxPoints: maximum,
      freqMin: -1,
      freqMax: maximum
    });

    expect(first.options).toEqual(second.options);
    expect(first.options).toEqual({
      beforeSeconds: EVENT_ALIGNED_SPECTROGRAM_LIMITS.maxWindowSeconds,
      afterSeconds: EVENT_ALIGNED_SPECTROGRAM_LIMITS.maxWindowSeconds,
      sampleCount: EVENT_ALIGNED_SPECTROGRAM_LIMITS.maxSampleCount,
      windowSize: EVENT_ALIGNED_SPECTROGRAM_LIMITS.maxWindowSize,
      overlap: EVENT_ALIGNED_SPECTROGRAM_LIMITS.maxOverlap,
      windowType: 'hann',
      detrend: 'removeMean',
      maxPoints: EVENT_ALIGNED_SPECTROGRAM_LIMITS.maxSampleCount,
      freqMin: 0,
      freqMax: EVENT_ALIGNED_SPECTROGRAM_LIMITS.maxFrequencyHz
    });
    expect(first.warnings.every((warning) => warning.includes('bounded'))).toBe(true);
  });
});
