import { describe, expect, it } from 'vitest';
import { QualityFlag } from '../../src/data/quality';
import {
  buildAnalysisRecipePayload,
  buildProcessingRecipePayload,
  buildQualitySummary,
  buildSourceFingerprint,
  canonicalJson,
  collectLimitations,
  hashCanonicalJson,
  sourceSha256
} from '../../src/domain/provenance';
import { APP_VERSION, resolveAppVersion, TEST_APP_VERSION } from '../../src/domain/version';

describe('application version', () => {
  it('uses a declared build value when present and exposes a deterministic test fallback', () => {
    expect(APP_VERSION).toEqual(expect.any(String));
    expect(APP_VERSION.length).toBeGreaterThan(0);
    expect(resolveAppVersion(undefined)).toBe(TEST_APP_VERSION);
    expect(resolveAppVersion(' 6.2.1 ')).toBe('6.2.1');
  });
});

describe('canonical provenance hashing', () => {
  it('sorts object keys recursively without changing array order', async () => {
    const first = {
      z: 4,
      nested: { beta: true, alpha: [{ y: 2, x: 1 }, 3] },
      a: 'value'
    };
    const reordered = {
      a: 'value',
      nested: { alpha: [{ x: 1, y: 2 }, 3], beta: true },
      z: 4
    };

    expect(canonicalJson(first)).toBe(canonicalJson(reordered));
    expect(canonicalJson(first)).toBe('{"a":"value","nested":{"alpha":[{"x":1,"y":2},3],"beta":true},"z":4}');
    expect(await hashCanonicalJson(first)).toBe(await hashCanonicalJson(reordered));
  });

  it('matches JSON null/omission behavior and rejects circular data', () => {
    expect(canonicalJson({ finite: 1, missing: undefined, invalid: Number.NaN, list: [undefined, Infinity] })).toBe(
      '{"finite":1,"invalid":null,"list":[null,null]}'
    );
    expect(canonicalJson(new Array(2))).toBe('[null,null]');
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() => canonicalJson(circular)).toThrow(/circular/i);
  });

  it('hashes the original source bytes and changes when any byte changes', async () => {
    const abc = new TextEncoder().encode('abc');
    const abd = new TextEncoder().encode('abd');

    expect(await sourceSha256(abc)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sourceSha256(abd)).not.toBe(await sourceSha256(abc));
    await expect(sourceSha256({ bytes: abc })).resolves.toBe(await sourceSha256(abc));
    await expect(sourceSha256(new Blob([abc]))).resolves.toBe(await sourceSha256(abc));

    const fingerprint = await buildSourceFingerprint({
      name: 'capture.csv',
      bytes: abc,
      lastModified: 123
    });
    expect(fingerprint).toEqual({
      name: 'capture.csv',
      size: 3,
      lastModified: 123,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    });
  });

  it('builds detached processing and analysis recipe payloads', async () => {
    const pipeline = [{ id: 'smooth', type: 'movingAverage', enabled: true, windowSize: 5 }];
    const config = { fftWindow: 'hann', trigger: { threshold: 2, direction: 'rising' } };
    const processing = buildProcessingRecipePayload({
      columnId: 'Voltage',
      sourceMode: 'filtered',
      pipeline,
      pipelineReport: [{ stepId: 'smooth', effectiveParameters: { windowSize: 5 } }],
      repairHistory: [{ id: 'repair-1', label: 'Interpolate' }],
      repairCursor: 1
    });
    const analysis = buildAnalysisRecipePayload({
      config,
      selection: { i0: 20, i1: 80, xMin: 0.2, xMax: 0.8 },
      series: { name: 'Voltage', isMath: false }
    });
    const processingHash = await hashCanonicalJson(processing);

    pipeline[0].windowSize = 99;
    config.trigger.threshold = 8;

    expect((processing.pipeline as Array<{ windowSize: number }>)[0].windowSize).toBe(5);
    expect((analysis.config as { trigger: { threshold: number } }).trigger.threshold).toBe(2);
    expect(await hashCanonicalJson(processing)).toBe(processingHash);
    expect(processing.source).toEqual({ columnId: 'Voltage', mode: 'filtered', isMath: false });
    expect(processing.repairCursor).toBe(1);
    expect(analysis.kind).toBe('signalforge-analysis-recipe');
  });
});

describe('quality and limitation provenance', () => {
  it('counts every selected quality flag and blocking sample without counting outside the selection', () => {
    const quality = new Uint16Array([
      QualityFlag.Invalid,
      QualityFlag.None,
      QualityFlag.Missing,
      QualityFlag.Clipped | QualityFlag.Interpolated,
      QualityFlag.UserEdited,
      QualityFlag.Saturated
    ]);

    const summary = buildQualitySummary(quality, { i0: 4, i1: 1 });

    expect(summary).toMatchObject({
      selection: { i0: 1, i1: 4 },
      totalSampleCount: 6,
      selectedSampleCount: 4,
      cleanSampleCount: 1,
      flaggedSampleCount: 3,
      analysisExcludedSampleCount: 2
    });
    expect(summary.counts.Missing).toBe(1);
    expect(summary.counts.Clipped).toBe(1);
    expect(summary.counts.Interpolated).toBe(1);
    expect(summary.counts.UserEdited).toBe(1);
    expect(summary.counts.Invalid).toBe(0);
    expect(summary.counts.Saturated).toBe(0);
  });

  it('collects all warning-bearing analysis paths and deduplicates exact limitations', () => {
    const limitations = collectLimitations({
      measurements: { warnings: ['Shared warning.', ' Measurement limitation. '] },
      events: { warnings: ['Shared warning.', 'Event limitation.'] },
      spectral: { warnings: ['Spectral limitation.'] },
      system: {
        warnings: ['System limitation.'],
        delay: { warnings: ['Shared warning.', 'Delay limitation.'] },
        frf: { warnings: ['FRF limitation.'] }
      },
      pipeline: [
        { warnings: ['Pipeline limitation.', 'Shared warning.'] },
        { warnings: ['Pipeline limitation.', 'Second pipeline limitation.'] }
      ]
    });

    expect(limitations).toEqual([
      'Shared warning.',
      'Measurement limitation.',
      'Event limitation.',
      'Spectral limitation.',
      'System limitation.',
      'Delay limitation.',
      'FRF limitation.',
      'Pipeline limitation.',
      'Second pipeline limitation.'
    ]);
  });
});
