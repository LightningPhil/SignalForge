import type { Shot } from '../domain/session';
import { AnalysisExclusionMask } from '../data/quality';
import { analyzeTimebase } from '../processing/sampling';
import type { FftDetrend, FftWindowType } from '../types';
import { eventAlignShots } from './ensemble';
import { TimeFrequency, type SpectrogramResult } from './timeFrequency';

export const EVENT_ALIGNED_SPECTROGRAM_LIMITS = Object.freeze({
  maxWindowSeconds: 3600,
  minSampleCount: 16,
  maxSampleCount: 40_000,
  minWindowSize: 8,
  maxWindowSize: 4096,
  maxOverlap: 0.95,
  maxFrequencyHz: 1e15,
  maxShots: 8
} as const);

export interface EventAlignedSpectrogramOptions {
  beforeSeconds: number;
  afterSeconds: number;
  sampleCount?: number;
  windowSize?: number;
  overlap?: number;
  windowType?: FftWindowType;
  detrend?: FftDetrend;
  maxPoints?: number;
  freqMin?: number;
  freqMax?: number | null;
}

export interface ResolvedEventAlignedSpectrogramOptions {
  beforeSeconds: number;
  afterSeconds: number;
  sampleCount: number;
  windowSize: number;
  overlap: number;
  windowType: FftWindowType;
  detrend: FftDetrend;
  maxPoints: number;
  freqMin: number;
  freqMax: number | null;
}

export interface EventAlignedShotSpectrogram {
  shotId: string;
  shotName: string;
  metadata: Shot['metadata'];
  timeBins: number[];
  freqBins: number[];
  magnitudeDb: number[][];
  warnings: string[];
  meta: SpectrogramResult['meta'];
}

export interface EventAlignedSpectrogramResult {
  shots: EventAlignedShotSpectrogram[];
  warnings: string[];
  options: ResolvedEventAlignedSpectrogramOptions;
}

function boundNumber(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
  warnings: string[],
  integer = false
): number {
  const finite = value !== undefined && Number.isFinite(value) ? value : fallback;
  const normalized = integer ? Math.floor(finite) : finite;
  const bounded = Math.max(minimum, Math.min(maximum, normalized));
  if (value !== undefined && (!Number.isFinite(value) || bounded !== value)) {
    warnings.push(`${label} was bounded to ${bounded}.`);
  }
  return bounded;
}

function resolveOptions(options: EventAlignedSpectrogramOptions): {
  options: ResolvedEventAlignedSpectrogramOptions;
  warnings: string[];
} {
  const warnings: string[] = [];
  const limits = EVENT_ALIGNED_SPECTROGRAM_LIMITS;
  const beforeSeconds = boundNumber(
    options.beforeSeconds,
    0,
    0,
    limits.maxWindowSeconds,
    'Pre-event duration',
    warnings
  );
  const afterSeconds = boundNumber(
    options.afterSeconds,
    0,
    0,
    limits.maxWindowSeconds,
    'Post-event duration',
    warnings
  );
  const sampleCount = boundNumber(
    options.sampleCount,
    1000,
    limits.minSampleCount,
    limits.maxSampleCount,
    'Aligned sample count',
    warnings,
    true
  );
  const windowSize = boundNumber(
    options.windowSize,
    512,
    limits.minWindowSize,
    Math.min(limits.maxWindowSize, sampleCount),
    'STFT window size',
    warnings,
    true
  );
  const overlap = boundNumber(options.overlap, 0.5, 0, limits.maxOverlap, 'STFT overlap', warnings);
  const maxPoints = boundNumber(
    options.maxPoints,
    sampleCount,
    limits.minSampleCount,
    sampleCount,
    'STFT point limit',
    warnings,
    true
  );
  const freqMin = boundNumber(options.freqMin, 0, 0, limits.maxFrequencyHz, 'Minimum frequency', warnings);
  let freqMax =
    options.freqMax === null || options.freqMax === undefined
      ? null
      : boundNumber(options.freqMax, limits.maxFrequencyHz, 0, limits.maxFrequencyHz, 'Maximum frequency', warnings);
  if (freqMax !== null && freqMax < freqMin) {
    freqMax = freqMin;
    warnings.push(`Maximum frequency was raised to the ${freqMin} Hz minimum.`);
  }

  return {
    options: {
      beforeSeconds,
      afterSeconds,
      sampleCount,
      windowSize,
      overlap,
      windowType: options.windowType ?? 'hann',
      detrend: options.detrend ?? 'removeMean',
      maxPoints,
      freqMin,
      freqMax
    },
    warnings
  };
}

function validSpectrogram(result: SpectrogramResult): boolean {
  return (
    result.timeBins.length > 0 &&
    result.freqBins.length > 0 &&
    result.timeBins.every(Number.isFinite) &&
    result.freqBins.every(Number.isFinite) &&
    result.magnitudeDb.length === result.freqBins.length &&
    result.magnitudeDb.every(
      (frequencyRow) => frequencyRow.length === result.timeBins.length && frequencyRow.every(Number.isFinite)
    )
  );
}

export function computeEventAlignedSpectrogram(
  shots: readonly Shot[],
  channelName: string,
  markerName: string,
  requestedOptions: EventAlignedSpectrogramOptions
): EventAlignedSpectrogramResult {
  const resolved = resolveOptions(requestedOptions);
  const warnings = resolved.warnings.slice();
  const options = resolved.options;
  if (!(options.beforeSeconds + options.afterSeconds > 0)) {
    warnings.push('Event-aligned spectrogram requires a nonzero time window.');
    return { shots: [], warnings, options };
  }

  const spectrograms: EventAlignedShotSpectrogram[] = [];

  // Align one shot at a time because the ensemble helper also calculates cross-shot aggregates;
  // those aggregates are intentionally unnecessary for independent per-shot STFT matrices.
  for (const sourceShot of shots) {
    if (spectrograms.length >= EVENT_ALIGNED_SPECTROGRAM_LIMITS.maxShots) {
      warnings.push(
        `Spectrogram comparison is limited to the first ${EVENT_ALIGNED_SPECTROGRAM_LIMITS.maxShots} valid shots.`
      );
      break;
    }
    const aligned = eventAlignShots([sourceShot], channelName, markerName, {
      beforeSeconds: options.beforeSeconds,
      afterSeconds: options.afterSeconds,
      sampleCount: options.sampleCount
    });
    warnings.push(...aligned.warnings);
    const alignedShot = aligned.shots[0];
    const channel = sourceShot.channels.find((candidate) => candidate.name === channelName);
    if (!alignedShot || !channel) continue;

    if (channel.time.length < 2 || channel.time.length !== channel.values.length) {
      warnings.push(`${sourceShot.name}: "${channelName}" channel arrays are missing or unaligned; shot omitted.`);
      continue;
    }
    const sourceTimebase = analyzeTimebase(channel.time);
    if (!sourceTimebase.valid) {
      const detail = sourceTimebase.warnings.join(' ');
      warnings.push(
        `${sourceShot.name}: "${channelName}" channel has an invalid timebase; shot omitted.${detail ? ` ${detail}` : ''}`
      );
      continue;
    }
    if (
      alignedShot.values.length !== alignedShot.relativeTime.length ||
      alignedShot.values.some((value) => !Number.isFinite(value))
    ) {
      warnings.push(
        `${sourceShot.name}: the requested event window is not fully covered by finite samples; shot omitted.`
      );
      continue;
    }
    let excludedQualitySamples = 0;
    for (const mask of alignedShot.quality) {
      if ((mask & AnalysisExclusionMask) !== 0) excludedQualitySamples += 1;
    }
    if (excludedQualitySamples > 0) {
      warnings.push(
        `${sourceShot.name}: ${excludedQualitySamples} aligned sample(s) carry analysis-blocking quality flags; shot omitted.`
      );
      continue;
    }

    let spectrogram: SpectrogramResult;
    try {
      spectrogram = TimeFrequency.computeSpectrogram(alignedShot.values, alignedShot.relativeTime, {
        windowSize: options.windowSize,
        overlap: options.overlap,
        windowType: options.windowType,
        detrend: options.detrend,
        maxPoints: options.maxPoints,
        freqMin: options.freqMin,
        freqMax: options.freqMax
      });
    } catch (error) {
      warnings.push(
        `${sourceShot.name}: spectrogram failed; shot omitted. ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }

    const shotWarnings = [...sourceTimebase.warnings, ...spectrogram.warnings];
    warnings.push(...shotWarnings.map((warning) => `${sourceShot.name}: ${warning}`));
    if (!validSpectrogram(spectrogram)) {
      warnings.push(`${sourceShot.name}: spectrogram produced no finite time-frequency matrix; shot omitted.`);
      continue;
    }
    spectrograms.push({
      shotId: alignedShot.shotId,
      shotName: alignedShot.shotName,
      metadata: alignedShot.metadata,
      timeBins: spectrogram.timeBins,
      freqBins: spectrogram.freqBins,
      magnitudeDb: spectrogram.magnitudeDb,
      warnings: shotWarnings,
      meta: spectrogram.meta
    });
  }

  return { shots: spectrograms, warnings, options };
}
