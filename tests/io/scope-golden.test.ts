import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ImportSource } from '../../src/io/adapters/types';
import { decodeScopeRequest } from '../../src/io/scope/decode';
import { detectScopeFile } from '../../src/io/scope/detect';

interface GoldenSample {
  index: number;
  value?: number | null;
  value_s?: number;
}

interface GoldenChannel {
  name: string;
  unit: string;
  source_unit: string;
  source_to_si_scale: number;
  value_tolerance: number;
  invalid_indices: number[];
  samples: GoldenSample[];
}

interface GoldenRecord {
  frame_index: number;
  sample_count: number;
  time_tolerance_s: number;
  time_samples: GoldenSample[];
  channels: GoldenChannel[];
}

interface GoldenFile {
  path: string;
  detected_format: string;
  source_format: string;
  record_count: number;
  records: GoldenRecord[];
}

const bundleRoot = path.resolve('reference-material/SignalForge-scope-import-examples');
const fixtureRoot = path.join(bundleRoot, 'fixtures');
const golden = JSON.parse(await readFile(path.join(fixtureRoot, 'golden_results.json'), 'utf8')) as {
  files: GoldenFile[];
};

async function source(relativePath: string): Promise<ImportSource> {
  const bytes = new Uint8Array(await readFile(path.join(fixtureRoot, relativePath)));
  return { name: path.basename(relativePath), bytes, size: bytes.length, lastModified: null };
}

async function companions(entry: GoldenFile): Promise<ImportSource[]> {
  if (entry.source_format !== 'rohde-schwarz-rtx-bin') return [];
  return [await source(entry.path.replace(/\.bin$/i, '.Wfm.bin'))];
}

describe('native oscilloscope golden fixtures', () => {
  const supported = golden.files.filter((entry) => entry.source_format !== 'picoscope-hdf5');

  it.each(supported.map((entry) => [entry.path, entry] as const))(
    'decodes %s against the cross-language oracle',
    async (_name, entry) => {
      const primary = await source(entry.path);
      const detected = detectScopeFile(primary);
      expect(detected?.format).toBe(entry.source_format);
      const records = await decodeScopeRequest({
        primary,
        companions: await companions(entry)
      });
      expect(records).toHaveLength(entry.record_count);

      entry.records.forEach((expectedRecord, recordIndex) => {
        const actual = records[recordIndex];
        expect(actual.sourceFormat).toBe(entry.source_format);
        expect(actual.frameIndex).toBe(expectedRecord.frame_index);
        expect(actual.timeSeconds).toHaveLength(expectedRecord.sample_count);
        expectedRecord.time_samples.forEach((sample) => {
          expect(actual.timeSeconds[sample.index]).toBeCloseTo(sample.value_s as number, 12);
          expect(Math.abs(actual.timeSeconds[sample.index] - (sample.value_s as number))).toBeLessThanOrEqual(
            expectedRecord.time_tolerance_s
          );
        });
        expect(actual.channels).toHaveLength(expectedRecord.channels.length);
        expectedRecord.channels.forEach((expectedChannel, channelIndex) => {
          const channel = actual.channels[channelIndex];
          expect(channel.name).toBe(expectedChannel.name);
          expect(channel.unit).toBe(expectedChannel.unit);
          expect(channel.sourceUnit).toBe(expectedChannel.source_unit);
          expect(channel.sourceToSiScale).toBe(expectedChannel.source_to_si_scale);
          const actualInvalid = Array.from(channel.invalidMask || [])
            .map((value, index) => (value ? index : -1))
            .filter((index) => index >= 0);
          expect(actualInvalid).toEqual(expectedChannel.invalid_indices);
          expectedChannel.samples.forEach((sample) => {
            const expectedValue = sample.value;
            if (expectedValue === null) {
              expect(channel.values[sample.index]).toBeNaN();
            } else {
              expect(
                Math.abs(channel.values[sample.index] - (expectedValue as number)),
                `${entry.path} ${expectedChannel.name} sample ${sample.index}`
              ).toBeLessThanOrEqual(expectedChannel.value_tolerance);
            }
          });
        });
      });
    },
    20_000
  );
});
