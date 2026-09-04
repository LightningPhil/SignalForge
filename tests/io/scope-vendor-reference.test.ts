import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ImportSource } from '../../src/io/adapters/types';
import { decodeScopeRequest } from '../../src/io/scope/decode';

const bundleRoot = path.resolve('reference-material/SignalForge-scope-import-examples');

async function source(stem: string, suffix: '.bin' | '.Wfm.bin'): Promise<ImportSource> {
  const filePath = path.join(bundleRoot, 'fixtures', 'rohde_schwarz', `${stem}${suffix}`);
  const bytes = new Uint8Array(await readFile(filePath));
  return { name: `${stem}${suffix}`, bytes, size: bytes.length, lastModified: null };
}

async function decode(stem: string) {
  return (
    await decodeScopeRequest({
      primary: await source(stem, '.bin'),
      companions: [await source(stem, '.Wfm.bin')]
    })
  )[0];
}

async function csv(name: string): Promise<number[][]> {
  const text = await readFile(path.join(bundleRoot, 'reference_exports', 'rohde_schwarz', name), 'utf8');
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(',').map(Number));
}

describe('R&S vendor reference exports', () => {
  it('matches both float32 channels for every sample', async () => {
    const actual = await decode('rs_rtp_two_channel');
    const expected = await csv('rs_rtp_two_channel_reference.Wfm.csv');
    expect(expected).toHaveLength(actual.timeSeconds.length);
    actual.channels.forEach((channel, channelIndex) => {
      channel.values.forEach((value, sampleIndex) => {
        expect(Math.abs(value - expected[sampleIndex][channelIndex])).toBeLessThanOrEqual(5e-6);
      });
    });
  });

  it('matches integer scaling for every sample', async () => {
    const actual = await decode('rs_rtp_int8');
    const expected = await csv('rs_rtp_float_and_int8_reference.Wfm.csv');
    actual.channels[0].values.forEach((value, sampleIndex) => {
      expect(Math.abs(value - expected[sampleIndex][0])).toBeLessThanOrEqual(5e-6);
    });
  });

  it('preserves every explicit float64 timestamp and value', async () => {
    const actual = await decode('rs_rtp_explicit_time');
    const expected = await csv('rs_rtp_explicit_time_reference.Wfm.csv');
    actual.timeSeconds.forEach((value, sampleIndex) => {
      expect(Math.abs(value - expected[sampleIndex][0])).toBeLessThanOrEqual(1e-18);
      expect(Math.abs(actual.channels[0].values[sampleIndex] - expected[sampleIndex][1])).toBeLessThanOrEqual(5e-6);
    });
  });
});
