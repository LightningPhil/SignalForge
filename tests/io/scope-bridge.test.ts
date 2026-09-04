import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateSession } from '../../src/domain/migrations';
import { createSession, createShot } from '../../src/domain/session';
import { NativeScopeAdapter } from '../../src/io/adapters/nativeScopeAdapter';
import { attachAdapterRecord, firstMetadataConflict } from '../../src/io/adapters/sessionBridge';
import type { ImportSource } from '../../src/io/adapters/types';
import { SessionWorkspace } from '../../src/session/workspace';
import { State } from '../../src/state';
import { estimateNativeSessionPeakBytes } from '../../src/io/scope/bridge';
import { ScopeImportLimits } from '../../src/io/scope/limits';

const fixtureRoot = path.resolve('reference-material/SignalForge-scope-import-examples/fixtures');

async function source(relativePath: string): Promise<ImportSource> {
  const bytes = new Uint8Array(await readFile(path.join(fixtureRoot, relativePath)));
  return { name: path.basename(relativePath), bytes, size: bytes.length, lastModified: null };
}

describe('native scope session bridge', () => {
  it('rejects aggregate multi-file persistence peaks rather than budgeting each file alone', () => {
    const fiftyMiB = 50 * 1024 * 1024;
    expect(estimateNativeSessionPeakBytes(fiftyMiB, 0, fiftyMiB)).toBeLessThan(ScopeImportLimits.maxDecodedBytes);
    expect(estimateNativeSessionPeakBytes(fiftyMiB * 2, 0, fiftyMiB * 2)).toBeGreaterThan(
      ScopeImportLimits.maxDecodedBytes
    );
  });

  it('detects per-record metadata conflicts before FastFrame channel merging', () => {
    expect(firstMetadataConflict({ charge_voltage: 25_000 }, [['charge_voltage', 30_000]])).toEqual([
      'charge_voltage',
      30_000
    ]);
    expect(firstMetadataConflict({ charge_voltage: 25_000 }, [['charge_voltage', 25_000]])).toBeUndefined();
  });

  it('preserves immutable originals, source units, quality, and source bytes', async () => {
    const input = await source('keysight/keysight_dsox1102g_single_channel.bin');
    const imported = await NativeScopeAdapter.import(input);
    const channel = imported.channels[0];

    expect(channel.values).not.toBe(channel.originalValues);
    expect(channel.time).not.toBe(channel.originalTime);
    expect(channel.quality).not.toBe(channel.originalQuality);
    expect(channel.sourceUnit).toBe('V');
    expect(channel.sourceFormat).toBe('keysight-agxx-bin');
    expect(imported.sourceFile.bytes).toEqual(input.bytes);
    const attached = attachAdapterRecord(imported, imported.records![0], true);
    expect(attached.sources[0].bytes).not.toBe(input.bytes);
    expect(attached.sources[0].bytes).toEqual(input.bytes);
  });

  it('emits every FastFrame record without multiplying archived source bytes', async () => {
    const input = await source('tektronix/fastframe_5mhz_100frames.wfm');
    const imported = await NativeScopeAdapter.import(input);
    expect(imported.records).toHaveLength(100);

    const first = attachAdapterRecord(imported, imported.records![0], true);
    const second = attachAdapterRecord(imported, imported.records![1], false);
    expect(first.sources[0].bytes).toHaveLength(input.bytes.length);
    expect(second.sources[0].bytes).toBeUndefined();
    expect(first.sources[0].id).not.toBe(second.sources[0].id);
    expect(first.channels[0].sourceFileId).toBe(first.sources[0].id);
    expect(second.channels[0].sourceFileId).toBe(second.sources[0].id);

    const session = createSession('FastFrame');
    const firstShot = createShot('Frame 1');
    firstShot.sourceFiles = first.sources;
    firstShot.channels = first.channels;
    const secondShot = createShot('Frame 2');
    secondShot.sourceFiles = second.sources;
    secondShot.channels = second.channels;
    session.shots.push(firstShot, secondShot);
    SessionWorkspace.setActive(session, secondShot.id);
    expect(State.data.source?.bytes).toEqual(input.bytes);
  });

  it('persists DHO waveforms whose source unit is not encoded', async () => {
    const input = await source('rigol/rigol_dho824.wfm');
    const imported = await NativeScopeAdapter.import(input);
    const attached = attachAdapterRecord(imported, imported.records![0], true);
    const session = createSession('DHO');
    const shot = createShot('DHO 824');
    shot.sourceFiles = attached.sources;
    shot.channels = attached.channels;
    session.shots.push(shot);

    expect(attached.channels[0].sourceUnit).toBeUndefined();
    expect(() => migrateSession(session)).not.toThrow();
  });
});
