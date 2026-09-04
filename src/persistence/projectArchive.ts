import { strFromU8, strToU8, Unzip, UnzipInflate, zip, type UnzipFile } from 'fflate';
import { migrateSession } from '../domain/migrations';
import type { Session, SessionChannel, Shot, SourceFileRecord } from '../domain/session';

const FORMAT = 'signalforge-project';
const FORMAT_VERSION = 1;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_CHANNEL_SAMPLES = 50_000_000;

interface ArchivedChannel extends Omit<SessionChannel, 'time' | 'values' | 'quality'> {
  timePath: string;
  valuesPath: string;
  qualityPath: string;
  originalTimePath?: string;
  originalValuesPath?: string;
  originalQualityPath?: string;
  sampleCount: number;
}

interface ArchivedSourceFile extends Omit<SourceFileRecord, 'bytes'> {
  payloadPath?: string;
}

interface ArchivedShot extends Omit<Shot, 'channels' | 'sourceFiles'> {
  channels: ArchivedChannel[];
  sourceFiles: ArchivedSourceFile[];
}

interface ProjectManifest {
  format: typeof FORMAT;
  formatVersion: number;
  applicationVersion: string;
  createdAt: string;
  session: Omit<Session, 'shots'> & { shots: ArchivedShot[] };
  checksums: Record<string, string>;
}

function encodeFloat64(values: Float64Array): Uint8Array {
  const bytes = new Uint8Array(values.length * Float64Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat64(index * Float64Array.BYTES_PER_ELEMENT, value, true));
  return bytes;
}

function decodeFloat64(bytes: Uint8Array, expectedLength: number): Float64Array {
  if (bytes.byteLength !== expectedLength * Float64Array.BYTES_PER_ELEMENT) {
    throw new Error('Float64 channel payload length does not match the manifest.');
  }
  const values = new Float64Array(expectedLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < expectedLength; index += 1) {
    values[index] = view.getFloat64(index * Float64Array.BYTES_PER_ELEMENT, true);
  }
  return values;
}

function encodeUint16(values: Uint16Array): Uint8Array {
  const bytes = new Uint8Array(values.length * Uint16Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint16(index * Uint16Array.BYTES_PER_ELEMENT, value, true));
  return bytes;
}

function decodeUint16(bytes: Uint8Array, expectedLength: number): Uint16Array {
  if (bytes.byteLength !== expectedLength * Uint16Array.BYTES_PER_ELEMENT) {
    throw new Error('Quality payload length does not match the manifest.');
  }
  const values = new Uint16Array(expectedLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < expectedLength; index += 1) {
    values[index] = view.getUint16(index * Uint16Array.BYTES_PER_ELEMENT, true);
  }
  return values;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const stableBytes = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest('SHA-256', stableBytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

function unzipSafely(bytes: Uint8Array): Record<string, Uint8Array> {
  const files = Object.create(null) as Record<string, Uint8Array>;
  const entryNames = new Set<string>();
  let entryCount = 0;
  let totalBytes = 0;
  let pendingFiles = 0;
  let failure: Error | null = null;
  const unzip = new Unzip((file: UnzipFile) => {
    if (failure) {
      file.terminate();
      return;
    }
    entryCount += 1;
    if (
      entryCount > MAX_ARCHIVE_ENTRIES ||
      file.name.length > 1000 ||
      file.name.startsWith('/') ||
      file.name.includes('..') ||
      file.name.includes('\\') ||
      ['__proto__', 'prototype', 'constructor'].includes(file.name) ||
      entryNames.has(file.name)
    ) {
      failure = new Error('Project archive contains too many, duplicate, or unsafe entries.');
      file.terminate();
      return;
    }
    entryNames.add(file.name);
    if (file.originalSize !== undefined && file.originalSize > MAX_ENTRY_BYTES) {
      failure = new Error(`Project archive entry exceeds the 256 MB limit: ${file.name}`);
      file.terminate();
      return;
    }
    pendingFiles += 1;
    const chunks: Uint8Array[] = [];
    let entryBytes = 0;
    file.ondata = (error, chunk, final) => {
      if (failure) return;
      if (error) {
        failure = error;
        return;
      }
      entryBytes += chunk.byteLength;
      totalBytes += chunk.byteLength;
      if (entryBytes > MAX_ENTRY_BYTES || totalBytes > MAX_ARCHIVE_BYTES) {
        failure = new Error('Uncompressed project contents exceed the configured safety limits.');
        file.terminate();
        return;
      }
      chunks.push(chunk.slice());
      if (final) {
        const combined = new Uint8Array(entryBytes);
        let offset = 0;
        for (const part of chunks) {
          combined.set(part, offset);
          offset += part.byteLength;
        }
        files[file.name] = combined;
        pendingFiles -= 1;
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  unzip.push(bytes, true);
  if (failure) throw failure;
  if (pendingFiles !== 0) throw new Error('Project archive extraction did not complete synchronously.');
  return files;
}

function safePayload(files: Record<string, Uint8Array>, path: string): Uint8Array {
  if (!path || path.startsWith('/') || path.includes('..') || path.includes('\\')) {
    throw new Error(`Unsafe project payload path: ${path}`);
  }
  const payload = files[path];
  if (!payload) throw new Error(`Project payload is missing: ${path}`);
  return payload;
}

function zipAsynchronously(payloads: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    zip(payloads, { level: 6 }, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

function escapedJsonStringByteLength(value: string, remainingLimit: number): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      bytes += 2;
    } else if (code < 0x20) {
      bytes += 6;
    } else if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
    if (bytes > remainingLimit) return bytes;
  }
  return bytes;
}

function estimateJsonBytes(
  value: unknown,
  limit: number,
  seen = new WeakSet<object>(),
  running = { bytes: 0 }
): number {
  const add = (bytes: number) => {
    running.bytes += bytes;
    if (running.bytes > limit) throw new Error('Project manifest exceeds the 256 MB entry limit.');
  };
  if (value === null || value === undefined) {
    add(4);
  } else if (typeof value === 'string') {
    add(escapedJsonStringByteLength(value, limit - running.bytes) + 2);
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    add(String(value).length);
  } else if (ArrayBuffer.isView(value)) {
    add(32);
  } else if (Array.isArray(value)) {
    add(2 + Math.max(0, value.length - 1));
    for (const entry of value) estimateJsonBytes(entry, limit, seen, running);
  } else if (typeof value === 'object') {
    if (seen.has(value)) throw new Error('Project data contains a circular reference.');
    seen.add(value);
    const entries = Object.entries(value);
    add(2 + Math.max(0, entries.length - 1));
    for (const [key, entry] of entries) {
      add(escapedJsonStringByteLength(key, limit - running.bytes) + 3);
      estimateJsonBytes(entry, limit, seen, running);
    }
    seen.delete(value);
  }
  return running.bytes;
}

export async function exportProjectArchive(session: Session, applicationVersion = '6.0.0-dev'): Promise<Uint8Array> {
  let estimatedEntries = 1;
  const manifestEstimate = estimateJsonBytes(session, MAX_ENTRY_BYTES);
  let estimatedBytes = manifestEstimate;
  for (const shot of session.shots) {
    for (const channel of shot.channels) {
      if (channel.values.length > MAX_CHANNEL_SAMPLES) {
        throw new Error(`Channel "${channel.name}" exceeds the 50 million sample export limit.`);
      }
      const currentArrays = [channel.time, channel.values, channel.quality];
      const originalArrays = [channel.originalTime, channel.originalValues, channel.originalQuality].filter(
        (array): array is Float64Array | Uint16Array => Boolean(array)
      );
      estimatedEntries += currentArrays.length + originalArrays.length;
      for (const array of [...currentArrays, ...originalArrays]) {
        if (array.byteLength > MAX_ENTRY_BYTES) {
          throw new Error(`Channel "${channel.name}" contains an array larger than 256 MB.`);
        }
        estimatedBytes += array.byteLength;
      }
    }
    for (const sourceFile of shot.sourceFiles) {
      if (sourceFile.bytes) {
        if (sourceFile.bytes.byteLength > MAX_ENTRY_BYTES) {
          throw new Error(`Source file "${sourceFile.name}" exceeds the 256 MB entry limit.`);
        }
        estimatedEntries += 1;
        estimatedBytes += sourceFile.bytes.byteLength;
      }
    }
  }
  if (estimatedEntries > MAX_ARCHIVE_ENTRIES) throw new Error('Project archive exceeds the entry-count limit.');
  if (estimatedBytes > MAX_ARCHIVE_BYTES) {
    throw new Error('Project archive exceeds the 512 MB expanded-size limit.');
  }
  const payloads: Record<string, Uint8Array> = {};
  const checksums: Record<string, string> = {};
  const shots: ArchivedShot[] = [];

  for (const shot of session.shots) {
    const channels: ArchivedChannel[] = [];
    const sourceFiles: ArchivedSourceFile[] = [];
    for (const channel of shot.channels) {
      if (channel.time.length !== channel.values.length || channel.values.length !== channel.quality.length) {
        throw new Error(`Channel "${channel.name}" has unaligned time, value and quality arrays.`);
      }
      const base = `channels/${shot.id}/${channel.id}`;
      const timePath = `${base}.time.f64le`;
      const valuesPath = `${base}.values.f64le`;
      const qualityPath = `${base}.quality.u16le`;
      payloads[timePath] = encodeFloat64(channel.time);
      payloads[valuesPath] = encodeFloat64(channel.values);
      payloads[qualityPath] = encodeUint16(channel.quality);
      checksums[timePath] = await sha256(payloads[timePath]);
      checksums[valuesPath] = await sha256(payloads[valuesPath]);
      checksums[qualityPath] = await sha256(payloads[qualityPath]);
      const originalTimePath = channel.originalTime ? `${base}.original-time.f64le` : undefined;
      const originalValuesPath = channel.originalValues ? `${base}.original-values.f64le` : undefined;
      const originalQualityPath = channel.originalQuality ? `${base}.original-quality.u16le` : undefined;
      if (originalTimePath && originalValuesPath && originalQualityPath) {
        if (
          channel.originalTime?.length !== channel.values.length ||
          channel.originalValues?.length !== channel.values.length ||
          channel.originalQuality?.length !== channel.values.length
        ) {
          throw new Error(`Channel "${channel.name}" has unaligned original-data arrays.`);
        }
        payloads[originalTimePath] = encodeFloat64(channel.originalTime);
        payloads[originalValuesPath] = encodeFloat64(channel.originalValues);
        payloads[originalQualityPath] = encodeUint16(channel.originalQuality);
        checksums[originalTimePath] = await sha256(payloads[originalTimePath]);
        checksums[originalValuesPath] = await sha256(payloads[originalValuesPath]);
        checksums[originalQualityPath] = await sha256(payloads[originalQualityPath]);
      }
      channels.push({
        id: channel.id,
        name: channel.name,
        unit: channel.unit,
        timeUnit: channel.timeUnit,
        calibration: channel.calibration,
        probe: channel.probe,
        originalValueTokens: channel.originalValueTokens,
        originalTimeTokens: channel.originalTimeTokens,
        timingOffsetSeconds: channel.timingOffsetSeconds,
        sourceFileId: channel.sourceFileId,
        timePath,
        valuesPath,
        qualityPath,
        originalTimePath,
        originalValuesPath,
        originalQualityPath,
        sampleCount: channel.values.length
      });
    }
    for (const sourceFile of shot.sourceFiles) {
      let payloadPath: string | undefined;
      if (sourceFile.bytes) {
        payloadPath = `sources/${shot.id}/${sourceFile.id}.bin`;
        payloads[payloadPath] = sourceFile.bytes.slice();
        checksums[payloadPath] = await sha256(payloads[payloadPath]);
      }
      sourceFiles.push({
        id: sourceFile.id,
        name: sourceFile.name,
        size: sourceFile.size,
        lastModified: sourceFile.lastModified,
        adapterId: sourceFile.adapterId,
        checksum: sourceFile.checksum,
        metadata: sourceFile.metadata,
        warnings: sourceFile.warnings,
        payloadPath
      });
    }
    shots.push({ ...shot, channels, sourceFiles });
  }

  const manifest: ProjectManifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    applicationVersion,
    createdAt: new Date().toISOString(),
    session: {
      id: session.id,
      name: session.name,
      metadata: session.metadata,
      importProfileId: session.importProfileId,
      processingRecipe: session.processingRecipe,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      schemaVersion: session.schemaVersion,
      shots
    },
    checksums
  };
  payloads['manifest.json'] = strToU8(JSON.stringify(manifest));
  const entries = Object.entries(payloads);
  if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error('Project archive exceeds the entry-count limit.');
  let totalBytes = 0;
  for (const [path, payload] of entries) {
    if (payload.byteLength > MAX_ENTRY_BYTES) {
      throw new Error(`Project archive entry exceeds the 256 MB limit: ${path}`);
    }
    totalBytes += payload.byteLength;
    if (totalBytes > MAX_ARCHIVE_BYTES) {
      throw new Error('Project archive exceeds the 512 MB expanded-size limit.');
    }
  }
  const compressed = await zipAsynchronously(payloads);
  if (compressed.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error('Compressed project archive exceeds the 512 MB import limit.');
  }
  return compressed;
}

export async function importProjectArchive(bytes: Uint8Array): Promise<Session> {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error('Project archive exceeds the 512 MB safety limit.');
  const files = unzipSafely(bytes);
  const manifestBytes = safePayload(files, 'manifest.json');
  const manifest = JSON.parse(strFromU8(manifestBytes)) as ProjectManifest;
  if (manifest.format !== FORMAT || manifest.formatVersion !== FORMAT_VERSION) {
    throw new Error('Unsupported SignalForge project format or version.');
  }
  if (!manifest.session?.id || !Array.isArray(manifest.session.shots)) {
    throw new Error('Project manifest is missing required session fields.');
  }

  const shots: Shot[] = [];
  const referencedPayloads = new Set<string>();
  const claimPayload = (path: string) => {
    if (referencedPayloads.has(path)) throw new Error(`Project payload is referenced more than once: ${path}`);
    referencedPayloads.add(path);
  };
  for (const shot of manifest.session.shots) {
    const channels: SessionChannel[] = [];
    const sourceFiles: SourceFileRecord[] = [];
    for (const channel of shot.channels) {
      if (
        !Number.isInteger(channel.sampleCount) ||
        channel.sampleCount < 0 ||
        channel.sampleCount > MAX_CHANNEL_SAMPLES
      ) {
        throw new Error(`Channel "${channel.name}" has an invalid sample count.`);
      }
      const originalPathCount = [
        channel.originalTimePath,
        channel.originalValuesPath,
        channel.originalQualityPath
      ].filter(Boolean).length;
      if (originalPathCount !== 0 && originalPathCount !== 3) {
        throw new Error(`Channel "${channel.name}" has an incomplete original-data payload.`);
      }
      const paths = [
        channel.timePath,
        channel.valuesPath,
        channel.qualityPath,
        channel.originalTimePath,
        channel.originalValuesPath,
        channel.originalQualityPath
      ].filter((path): path is string => Boolean(path));
      for (const path of paths) {
        claimPayload(path);
        const payload = safePayload(files, path);
        const expectedChecksum = manifest.checksums[path];
        if (!expectedChecksum || (await sha256(payload)) !== expectedChecksum) {
          throw new Error(`Checksum verification failed: ${path}`);
        }
      }
      const {
        timePath,
        valuesPath,
        qualityPath,
        originalTimePath,
        originalValuesPath,
        originalQualityPath,
        sampleCount,
        ...metadata
      } = channel;
      channels.push({
        ...metadata,
        time: decodeFloat64(safePayload(files, timePath), sampleCount),
        originalTime: originalTimePath ? decodeFloat64(safePayload(files, originalTimePath), sampleCount) : undefined,
        values: decodeFloat64(safePayload(files, valuesPath), sampleCount),
        originalValues: originalValuesPath
          ? decodeFloat64(safePayload(files, originalValuesPath), sampleCount)
          : undefined,
        quality: decodeUint16(safePayload(files, qualityPath), sampleCount),
        originalQuality: originalQualityPath
          ? decodeUint16(safePayload(files, originalQualityPath), sampleCount)
          : undefined
      });
    }
    for (const sourceFile of shot.sourceFiles) {
      let bytes: Uint8Array | undefined;
      if (sourceFile.payloadPath) {
        claimPayload(sourceFile.payloadPath);
        const payload = safePayload(files, sourceFile.payloadPath);
        const expectedChecksum = manifest.checksums[sourceFile.payloadPath];
        if (!expectedChecksum || (await sha256(payload)) !== expectedChecksum) {
          throw new Error(`Checksum verification failed: ${sourceFile.payloadPath}`);
        }
        bytes = payload.slice();
      }
      sourceFiles.push({
        id: sourceFile.id,
        name: sourceFile.name,
        size: sourceFile.size,
        lastModified: sourceFile.lastModified,
        adapterId: sourceFile.adapterId,
        checksum: sourceFile.checksum,
        metadata: sourceFile.metadata,
        warnings: sourceFile.warnings,
        bytes
      });
    }
    shots.push({ ...shot, channels, sourceFiles });
  }
  return migrateSession({ ...manifest.session, shots });
}

export async function downloadProjectArchive(session: Session): Promise<void> {
  const archive = await exportProjectArchive(session);
  const archiveBuffer = Uint8Array.from(archive).buffer as ArrayBuffer;
  const blob = new Blob([archiveBuffer], { type: 'application/vnd.signalforge.project+zip' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${session.name.replace(/[^a-z0-9_-]+/gi, '_') || 'session'}.signalforge`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
