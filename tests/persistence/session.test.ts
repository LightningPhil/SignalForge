import { IDBFactory } from 'fake-indexeddb';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  authoritativeAnnotation,
  createAnnotation,
  createSession,
  createShot,
  type Session,
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

    expect(() => migrateSession(session)).toThrow(/repairHistory\[0\]\.changes\[0\] is invalid/);
  });

  it('rejects repair records whose structural fields are wrong even when the id looks valid', () => {
    const session = createSession('Structural repair');
    const shot = createShot('Shot');
    shot.channels.push(channel());
    shot.repairHistory = [
      { id: 'repair-1', label: 'ok', timestamp: new Date().toISOString(), changes: 'not-an-array' } as never
    ];
    shot.repairCursor = 1;
    session.shots.push(shot);

    expect(() => migrateSession(session)).toThrow(/repairHistory\[0\]\.changes is invalid/);
  });

  it('rejects wrong-typed timestamps, units, calibration and provenance instead of persisting them', () => {
    const base = () => {
      const session = createSession('Typed');
      const shot = createShot('Shot');
      shot.channels.push(channel());
      session.shots.push(shot);
      return { session, shot };
    };

    const badUpdatedAt = base();
    (badUpdatedAt.session as unknown as { updatedAt: unknown }).updatedAt = 12345;
    expect(() => migrateSession(badUpdatedAt.session)).toThrow(/session\.updatedAt must be a non-empty string/);
    badUpdatedAt.session.updatedAt = 'yesterday-ish';
    expect(() => migrateSession(badUpdatedAt.session)).toThrow(/session\.updatedAt must be an ISO-8601 timestamp/);

    const badUnit = base();
    (badUnit.shot.channels[0] as unknown as { unit: unknown }).unit = { $: 'V' };
    expect(() => migrateSession(badUnit.session)).toThrow(/unit must be a bounded string/);

    const badCalibration = base();
    (badCalibration.shot.channels[0] as unknown as { calibration: unknown }).calibration = null;
    expect(() => migrateSession(badCalibration.session)).toThrow(/calibration must be an object/);

    const badProvenance = base();
    badProvenance.shot.analysisResults.push({
      id: 'result-1',
      type: 'pulse-power',
      values: { energy: 1 },
      units: { energy: 'J' },
      provenance: { sourceChannelIds: [], annotationIds: [], warnings: [] } as never
    });
    expect(() => migrateSession(badProvenance.session)).toThrow(/processingRecipeHash/);

    const reservedName = base();
    reservedName.shot.channels[0].name = 'Time';
    expect(() => migrateSession(reservedName.session)).toThrow(/reserved for the working time column/);

    const badRevision = base();
    badRevision.session.revision = -3;
    expect(() => migrateSession(badRevision.session)).toThrow(/revision must be a non-negative integer/);
  });

  it('skips a single invalid stored session on list() instead of hiding every saved session', async () => {
    const factory = new IDBFactory();
    const repository = new SessionRepository(factory);
    const good = createSession('Good');
    await repository.save(good);
    // Write a record that bypasses validation, as an older or foreign build could have done.
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open('signalforge', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = raw.transaction('sessions', 'readwrite');
    transaction.objectStore('sessions').put({ id: 'broken', name: 'Broken', updatedAt: 42, shots: 'nope' });
    await new Promise<void>((resolve) => {
      transaction.oncomplete = () => resolve();
    });
    raw.close();

    const listed = await repository.list();
    expect(listed.map((session) => session.id)).toEqual([good.id]);
    expect(repository.listWarnings.join(' ')).toContain('broken');
    repository.close();
  });

  it('refuses to overwrite a newer stored revision and bumps the revision on every save', async () => {
    const factory = new IDBFactory();
    const tabA = new SessionRepository(factory);
    const tabB = new SessionRepository(factory);
    const session = createSession('Shared');
    await tabA.save(session);
    expect(session.revision).toBe(1);

    const staleCopy = await tabB.get(session.id);
    expect(staleCopy?.revision).toBe(1);

    session.name = 'Renamed in tab A';
    await tabA.save(session);
    expect(session.revision).toBe(2);

    staleCopy!.name = 'Renamed in tab B from a stale copy';
    await expect(tabB.save(staleCopy!)).rejects.toThrow(/modified elsewhere/);

    const stored = await tabB.get(session.id);
    expect(stored?.name).toBe('Renamed in tab A');
    expect(stored?.revision).toBe(2);
    tabA.close();
    tabB.close();
  });

  it('reports autosave failures through the error callback and deletes sessions on request', async () => {
    const repository = new SessionRepository(new IDBFactory());
    const session = createSession('Autosave');
    await repository.save(session);
    session.name = 'x'.repeat(501);
    const failure = await new Promise<Error>((resolve) => {
      repository.scheduleAutosave(session, 0, resolve);
    });
    expect(failure.message).toMatch(/500 characters/);

    session.name = 'Autosave';
    const saved = await new Promise<Session>((resolve, reject) => {
      repository.scheduleAutosave(session, 0, reject, resolve);
    });
    expect(saved.name).toBe('Autosave');
    await repository.delete(session.id);
    expect(await repository.get(session.id)).toBeNull();
    repository.close();
  });

  it('serializes in-flight saves before loading the same session revision', async () => {
    const repository = new SessionRepository(new IDBFactory());
    const session = createSession('Initial');
    await repository.save(session);

    session.name = 'First queued save';
    const first = repository.save(session);
    session.name = 'Second queued save';
    const second = repository.save(session);
    const loaded = await repository.get(session.id);
    await Promise.all([first, second]);

    expect(loaded?.name).toBe('Second queued save');
    expect(loaded?.revision).toBe(session.revision);
    loaded!.name = 'Saved after reload';
    await expect(repository.save(loaded!)).resolves.toMatchObject({ name: 'Saved after reload' });
    repository.close();
  });

  it('migrates without cloning typed arrays or source bytes', () => {
    const session = createSession('Alias');
    const shot = createShot('Shot');
    const source = channel();
    shot.channels.push(source);
    session.shots.push(shot);

    const migrated = migrateSession(session);
    expect(migrated).not.toBe(session);
    expect(migrated.shots[0].channels[0].values).toBe(source.values);
    expect(migrated.shots[0].channels[0].quality).toBe(source.quality);
  });

  it('does not let a "__proto__" key in an untrusted payload reach the prototype chain', () => {
    const payload = JSON.parse(
      JSON.stringify({ ...createSession('Proto'), metadata: {} }).replace(
        '"metadata":{}',
        '"metadata":{"__proto__":{"polluted":true}}'
      )
    ) as Record<string, unknown>;
    expect(() => migrateSession(payload)).toThrow(/forbidden key/);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('rejects archives with unreferenced entries or malformed manifests with actionable errors', async () => {
    const session = createSession('Strict archive');
    const shot = createShot('Shot', 1);
    shot.channels.push(channel());
    session.shots.push(shot);
    const archive = await exportProjectArchive(session);

    const withExtra = unzipSync(archive);
    withExtra['smuggled.bin'] = new Uint8Array([1, 2, 3]);
    await expect(importProjectArchive(zipSync(withExtra))).rejects.toThrow(/not referenced by the manifest/);

    const missingChannels = unzipSync(archive);
    const manifest = JSON.parse(strFromU8(missingChannels['manifest.json'])) as {
      session: { shots: Array<Record<string, unknown>> };
    };
    delete manifest.session.shots[0].channels;
    missingChannels['manifest.json'] = strToU8(JSON.stringify(manifest));
    await expect(importProjectArchive(zipSync(missingChannels))).rejects.toThrow(
      /missing its channel or source-file lists/
    );

    const badJson = unzipSync(archive);
    badJson['manifest.json'] = strToU8('{not json');
    await expect(importProjectArchive(zipSync(badJson))).rejects.toThrow(/not valid JSON/);
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

  it('treats a shared timebase with a missing timestamp as shared and never interpolates across it', () => {
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
    const session = createSession('Gapped timebase');
    const shot = createShot('Shot');
    const gappedTime = new Float64Array([0, Number.NaN, 0.2, 0.3]);
    const voltage = {
      ...channel(),
      time: gappedTime.slice(),
      originalTime: gappedTime.slice(),
      values: new Float64Array([1, 2, 3, 4]),
      originalValues: new Float64Array([1, 2, 3, 4]),
      quality: new Uint16Array([0, QualityFlag.Missing, 0, 0]),
      originalQuality: new Uint16Array([0, QualityFlag.Missing, 0, 0])
    };
    const current = {
      ...voltage,
      id: 'channel-current',
      name: 'Current',
      unit: 'A',
      time: gappedTime.slice(),
      originalTime: gappedTime.slice(),
      values: new Float64Array([10, 20, 30, 40]),
      originalValues: new Float64Array([10, 20, 30, 40]),
      quality: new Uint16Array([0, QualityFlag.Missing, 0, 0]),
      originalQuality: new Uint16Array([0, QualityFlag.Missing, 0, 0])
    };
    // A genuinely independent channel with a corrupt timestamp must still interpolate safely.
    const independent = {
      ...voltage,
      id: 'channel-independent',
      name: 'Independent',
      unit: 'V',
      time: new Float64Array([0, 0.1, Number.NaN, 0.3]),
      originalTime: new Float64Array([0, 0.1, Number.NaN, 0.3]),
      values: new Float64Array([0, 100, 999, 300]),
      originalValues: new Float64Array([0, 100, 999, 300]),
      quality: new Uint16Array(4),
      originalQuality: new Uint16Array(4)
    };
    shot.channels.push(voltage, current, independent);
    session.shots.push(shot);
    SessionWorkspace.setActive(session, shot.id);

    expect(Array.from(State.data.columns.Current)).toEqual([10, 20, 30, 40]);
    expect(State.data.quality.Current[1] & QualityFlag.Interpolated).toBe(0);
    const projected = Array.from(State.data.columns.Independent);
    expect(projected[0]).toBe(0);
    expect(Number.isNaN(projected[1])).toBe(true);
    expect(projected[2]).toBeCloseTo(200, 9); // 0.2 s lies between the usable anchors 0.1 s and 0.3 s
    expect(projected[3]).toBe(300);
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
    // The working grid carries the interpolated projection, but the parsed original token is preserved
    // and its quality records why the independent channel could not accept the sample.
    expect(State.data.raw[3].Current).toBeCloseTo(2.5, 12);
    expect(State.data.quality.Current[3] & QualityFlag.Interpolated).toBeTruthy();
    expect(State.data.original[3].Current).toBe(4);
    expect(State.data.originalColumns.Current[3]).toBe(4);
    expect(State.data.originalQuality.Current[3] & QualityFlag.Interpolated).toBeFalsy();
    expect(State.data.originalQuality.Current[3] & QualityFlag.NonMonotonicTime).toBeTruthy();
    sessionRepository.close();
  });
});
