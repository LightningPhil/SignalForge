import { IDBFactory } from 'fake-indexeddb';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  authoritativeAnnotation,
  createAnnotation,
  createSession,
  createShot,
  type SessionChannel
} from '../../src/domain/session';
import { migrateSession } from '../../src/domain/migrations';
import { exportProjectArchive, importProjectArchive } from '../../src/persistence/projectArchive';
import { sessionRepository, SessionRepository } from '../../src/persistence/sessionRepository';
import { SessionWorkspace } from '../../src/session/workspace';
import { State } from '../../src/state';
import { QualityFlag } from '../../src/data/quality';

function channel(): SessionChannel {
  return {
    id: 'channel-voltage',
    name: 'Voltage',
    unit: 'V',
    timeUnit: 's',
    time: new Float64Array([0, 0.1, 0.2]),
    originalTime: new Float64Array([0, 0.1, 0.2]),
    originalValues: new Float64Array([1, 99, 3]),
    values: new Float64Array([1, 2, 3]),
    originalQuality: new Uint16Array([0, 4, 0]),
    quality: new Uint16Array([0, 0, 4]),
    calibration: { scale: 1, offset: 0 },
    timingOffsetSeconds: 0
  };
}

describe('session persistence', () => {
  it('round-trips typed channel data through IndexedDB', async () => {
    const repository = new SessionRepository(new IDBFactory());
    const session = createSession('Campaign A');
    const shot = createShot('Shot 1', 1);
    shot.channels.push(channel());
    session.shots.push(shot);

    const saved = await repository.save(session);
    const restored = await repository.get(saved.id);

    expect(restored?.name).toBe('Campaign A');
    expect(restored?.shots[0].channels[0].values).toBeInstanceOf(Float64Array);
    expect(Array.from(restored?.shots[0].channels[0].values || [])).toEqual([1, 2, 3]);
    repository.close();
  });

  it('validates sessions before saving them to IndexedDB', async () => {
    const repository = new SessionRepository(new IDBFactory());
    const session = createSession('Valid');
    session.name = 'x'.repeat(501);

    await expect(repository.save(session)).rejects.toThrow(/500 characters/);
    expect(await repository.list()).toEqual([]);
    repository.close();
  });

  it('exports and imports a checksum-verified project archive', async () => {
    const session = createSession('Archive fixture');
    const shot = createShot('Shot 7', 7);
    shot.channels.push(channel());
    shot.sourceFiles.push({
      id: 'source-1',
      name: 'original.csv',
      size: 4,
      lastModified: null,
      adapterId: 'delimited-text',
      bytes: new TextEncoder().encode('a,b\n'),
      metadata: {},
      warnings: []
    });
    session.shots.push(shot);

    const archive = await exportProjectArchive(session, 'test');
    const restored = await importProjectArchive(archive);

    expect(restored.id).toBe(session.id);
    expect(restored.shots[0].sequence).toBe(7);
    expect(Array.from(restored.shots[0].channels[0].time)).toEqual([0, 0.1, 0.2]);
    expect(Array.from(restored.shots[0].channels[0].quality)).toEqual([0, 0, 4]);
    expect(Array.from(restored.shots[0].channels[0].originalValues || [])).toEqual([1, 99, 3]);
    expect(Array.from(restored.shots[0].channels[0].originalQuality || [])).toEqual([0, 4, 0]);
    expect(new TextDecoder().decode(restored.shots[0].sourceFiles[0].bytes)).toBe('a,b\n');
  });

  it('rejects manifests that reference one expanded payload repeatedly', async () => {
    const session = createSession('Repeated payload');
    const shot = createShot('Shot', 1);
    shot.channels.push(channel());
    session.shots.push(shot);
    const files = unzipSync(await exportProjectArchive(session));
    const manifest = JSON.parse(strFromU8(files['manifest.json'])) as {
      session: { shots: Array<{ channels: Array<{ timePath: string; valuesPath: string }> }> };
    };
    manifest.session.shots[0].channels[0].valuesPath = manifest.session.shots[0].channels[0].timePath;
    files['manifest.json'] = strToU8(JSON.stringify(manifest));

    await expect(importProjectArchive(zipSync(files))).rejects.toThrow(/referenced more than once/);
  });

  it('prefers an accepted manual marker over an automatic suggestion', () => {
    const suggested = createAnnotation('flashover', 1.2, { source: 'suggested', suggestionState: 'accepted' });
    const manual = createAnnotation('flashover', 1.25, { source: 'manual' });

    expect(authoritativeAnnotation([suggested, manual], 'flashover')?.id).toBe(manual.id);
  });

  it('migrates a version-zero session without discarding shots', () => {
    const migrated = migrateSession({ id: 'legacy', name: 'Legacy', shots: [createShot('Old shot')] });

    expect(migrated.schemaVersion).toBe(1);
    expect(migrated.shots).toHaveLength(1);
    expect(migrated.processingRecipe).toEqual({});
  });

  it('rejects unsafe identifiers from imported session data', () => {
    const session = createSession('Unsafe archive');
    const shot = createShot('Injected shot');
    shot.id = 'shot-" onmouseover="alert(1)';
    session.shots.push(shot);

    expect(() => migrateSession(session)).toThrow(/unsafe characters/);
  });

  it('rejects malformed repair history before undo can consume it', () => {
    const session = createSession('Malformed repair');
    const shot = createShot('Shot');
    shot.repairHistory = [{} as never];
    shot.repairCursor = 1;
    session.shots.push(shot);

    expect(() => migrateSession(session)).toThrow(/repairHistory/);
  });

  it('rejects repair history that references unknown columns or rows', () => {
    const session = createSession('Invalid repair reference');
    const shot = createShot('Shot');
    shot.channels.push(channel());
    shot.repairHistory = [
      {
        id: 'repair-1',
        label: 'Invalid',
        timestamp: new Date().toISOString(),
        changes: [
          {
            rowIndex: 999,
            columnId: 'Unknown',
            before: 1,
            after: 2,
            qualityBefore: 0,
            qualityAfter: 0
          }
        ]
      }
    ];
    shot.repairCursor = 1;
    session.shots.push(shot);

    expect(() => migrateSession(session)).toThrow(/invalid/);
  });

  it('restores parsed originals, working repairs, quality, and undo history when reopening a shot', () => {
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
    State.setData(
      [
        { Time: 0, Voltage: 1 },
        { Time: 1, Voltage: 'CLIPPED' },
        { Time: 2, Voltage: 3 }
      ],
      ['Time', 'Voltage']
    );
    State.applyDataChanges('Repair clipped sample', [
      { rowIndex: 1, columnId: 'Voltage', value: 2, quality: QualityFlag.Interpolated }
    ]);
    SessionWorkspace.create('Round trip');
    const shot = SessionWorkspace.captureCurrentData('Shot');
    State.setData([{ Time: 0, Other: 9 }], ['Time', 'Other']);

    SessionWorkspace.openShot(shot.id);

    expect(State.data.original[1].Voltage).toBe('CLIPPED');
    expect(State.data.raw[1].Voltage).toBe(2);
    expect(State.data.originalQuality.Voltage[1] & QualityFlag.Clipped).toBeTruthy();
    expect(State.data.quality.Voltage[1]).toBe(QualityFlag.Interpolated);
    expect(State.data.repairHistory).toHaveLength(1);
    State.undoDataRepair();
    expect(State.data.raw[1].Voltage).toBe('CLIPPED');
    sessionRepository.close();
  });

  it('synchronizes repairs made to an open shot back into the persisted session model', () => {
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
    State.setData(
      [
        { Time: 0, Voltage: 1 },
        { Time: 1, Voltage: 2 }
      ],
      ['Time', 'Voltage']
    );
    SessionWorkspace.create('Live synchronization');
    const shot = SessionWorkspace.captureCurrentData('Shot');
    SessionWorkspace.openShot(shot.id);

    State.applyDataChanges('Visible repair', [{ rowIndex: 1, columnId: 'Voltage', value: 7 }]);

    expect(shot.channels[0].values[1]).toBe(7);
    expect(shot.channels[0].originalValues?.[1]).toBe(2);
    expect(shot.repairHistory).toHaveLength(1);
    SessionWorkspace.openShot(shot.id);
    expect(State.data.raw[1].Voltage).toBe(7);
    sessionRepository.close();
  });

  it('does not flatten untouched channels or original grids when repairing a projected shot', () => {
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
    const session = createSession('Independent grids');
    const shot = createShot('Shot');
    const voltage = channel();
    const current = {
      ...channel(),
      id: 'channel-current',
      name: 'Current',
      unit: 'A',
      time: new Float64Array([0, 0.05, 0.1, 0.15, 0.2]),
      originalTime: new Float64Array([0, 0.05, 0.1, 0.15, 0.2]),
      values: new Float64Array([1, 1, 1, 1, 1]),
      originalValues: new Float64Array([1, 1, 1, 1, 1]),
      quality: new Uint16Array(5),
      originalQuality: new Uint16Array(5)
    };
    shot.channels.push(voltage, current);
    session.shots.push(shot);
    SessionWorkspace.setActive(session, shot.id);

    State.applyDataChanges('Voltage-only repair', [{ rowIndex: 1, columnId: 'Voltage', value: 8 }]);

    expect(voltage.values[1]).toBe(8);
    expect(voltage.originalValues?.[1]).toBe(99);
    expect(Array.from(current.time)).toEqual([0, 0.05, 0.1, 0.15, 0.2]);
    expect(Array.from(current.originalTime || [])).toEqual([0, 0.05, 0.1, 0.15, 0.2]);
    State.applyDataChanges('Current projected repair', [{ rowIndex: 1, columnId: 'Current', value: 5 }]);
    expect(Array.from(current.time)).toEqual([0, 0.05, 0.1, 0.15, 0.2]);
    expect(current.values[2]).toBe(5);
    sessionRepository.close();
  });

  it('synchronizes trace sample offsets into channel timing metadata', () => {
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
    const session = createSession('Offsets');
    const shot = createShot('Shot');
    const voltage = channel();
    shot.channels.push(voltage);
    session.shots.push(shot);
    SessionWorkspace.setActive(session, shot.id);

    State.updateTraceConfig('Voltage', { xOffset: 2 });

    expect(voltage.timingOffsetSeconds).toBeCloseTo(0.2, 12);
    sessionRepository.close();
  });

  it('detaches the active shot when an unrelated dataset replaces the workspace', () => {
    const session = createSession('Replacement guard');
    const shot = createShot('Shot');
    const voltage = channel();
    shot.channels.push(voltage);
    session.shots.push(shot);
    SessionWorkspace.setActive(session, shot.id);

    State.setData(
      [
        { Time: 0, Voltage: 50 },
        { Time: 1, Voltage: 60 }
      ],
      ['Time', 'Voltage']
    );
    State.applyDataChanges('Unrelated edit', [{ rowIndex: 1, columnId: 'Voltage', value: 70 }]);

    expect(SessionWorkspace.activeShotId).toBeNull();
    expect(Array.from(voltage.values)).toEqual([1, 2, 3]);
  });

  it('extends both working and original shot arrays when rows are appended', () => {
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
    const session = createSession('Append');
    const shot = createShot('Shot');
    const voltage = channel();
    shot.channels.push(voltage);
    session.shots.push(shot);
    SessionWorkspace.setActive(session, shot.id);

    State.appendDataRows([{ Time: 0.3, Voltage: 4 }]);

    expect(Array.from(voltage.time)).toEqual([0, 0.1, 0.2, 0.3]);
    expect(Array.from(voltage.values)).toEqual([1, 2, 3, 4]);
    expect(Array.from(voltage.originalTime || [])).toEqual([0, 0.1, 0.2, 0.3]);
    expect(Array.from(voltage.originalValues || [])).toEqual([1, 99, 3, 4]);
    expect(() => migrateSession(session)).not.toThrow();
    sessionRepository.close();
  });

  it('does not append out-of-order reference timestamps to a longer independent channel', () => {
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
    const session = createSession('Monotonic append');
    const shot = createShot('Shot');
    const voltage = channel();
    const current = {
      ...channel(),
      id: 'long-current',
      name: 'Current',
      unit: 'A',
      time: new Float64Array([0, 0.2, 0.4]),
      originalTime: new Float64Array([0, 0.2, 0.4])
    };
    shot.channels.push(voltage, current);
    session.shots.push(shot);
    SessionWorkspace.setActive(session, shot.id);

    State.appendDataRows([{ Time: 0.3, Voltage: 4, Current: 4 }]);

    expect(Array.from(current.time)).toEqual([0, 0.2, 0.4]);
    expect(shot.metadata.appendWarning).toContain('not monotonic');
    expect(State.data.raw[3].Current).toBeCloseTo(2.5, 12);
    expect(State.data.original[3].Current).toBeCloseTo(2.5, 12);
    expect(State.data.originalColumns.Current[3]).toBeCloseTo(2.5, 12);
    expect(State.data.originalQuality.Current[3] & QualityFlag.Interpolated).toBeTruthy();
    sessionRepository.close();
  });
});
