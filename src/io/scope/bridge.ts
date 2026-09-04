import { QualityFlag } from '../../data/quality';
import type { SessionChannel, SourceFileRecord } from '../../domain/session';
import type { AdapterImportResult, AdapterWaveformRecord, ImportSource } from '../adapters/types';
import { ScopeImportLimits } from './limits';
import { ScopeImportError, type DetectedScopeFile, type ImportedWaveformRecord } from './types';

function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function estimateNativeSessionPeakBytes(
  sourceBytes: number,
  channelSamples: number,
  retainedPreviewBytes = sourceBytes
): number {
  return retainedPreviewBytes + sourceBytes * 2 + channelSamples * 73;
}

function sourceRecord(
  source: ImportSource,
  adapterId: string,
  detected: DetectedScopeFile,
  role: string
): SourceFileRecord {
  return {
    id: id('source'),
    name: source.name,
    size: source.size,
    lastModified: source.lastModified,
    adapterId,
    bytes: source.bytes,
    metadata: {
      role,
      format: detected.format,
      manufacturer: detected.manufacturer,
      supportLevel: detected.supportLevel
    },
    warnings: []
  };
}

function toSessionChannel(record: ImportedWaveformRecord, channelIndex: number, sourceFileId: string): SessionChannel {
  const source = record.channels[channelIndex];
  const quality = new Uint16Array(source.values.length);
  for (let index = 0; index < source.values.length; index += 1) {
    if (!Number.isFinite(source.values[index]) || source.invalidMask?.[index]) quality[index] |= QualityFlag.Invalid;
    if (index > 0 && !(record.timeSeconds[index] > record.timeSeconds[index - 1])) {
      quality[index] |= QualityFlag.NonMonotonicTime;
    }
  }
  const originalTime = record.timeSeconds;
  const originalValues = source.values;
  return {
    id: id('channel'),
    name: source.name,
    unit: source.unit,
    ...(source.sourceUnit ? { sourceUnit: source.sourceUnit } : {}),
    sourceToSiScale: source.sourceToSiScale,
    sourceFormat: record.sourceFormat,
    timeUnit: 's',
    time: originalTime.slice(),
    originalTime,
    values: originalValues.slice(),
    originalValues,
    quality: quality.slice(),
    originalQuality: quality,
    calibration: {
      scale: source.sourceToSiScale,
      offset: 0,
      source: source.calibrationSource
    },
    timingOffsetSeconds: 0,
    sourceFileId
  };
}

export function bridgeScopeRecords(
  adapterId: string,
  detected: DetectedScopeFile,
  primary: ImportSource,
  companions: ImportSource[],
  records: ImportedWaveformRecord[]
): AdapterImportResult {
  if (records.length === 0) throw new Error('Native scope decoder returned no waveform records.');
  let totalChannelSamples = 0;
  for (const record of records) {
    for (const channel of record.channels) totalChannelSamples += channel.values.length;
  }
  const sourceBytes =
    primary.bytes.byteLength + companions.reduce((total, source) => total + source.bytes.byteLength, 0);
  const predictedResidentBytes = estimateNativeSessionPeakBytes(sourceBytes, totalChannelSamples);
  if (!Number.isSafeInteger(predictedResidentBytes) || predictedResidentBytes > ScopeImportLimits.maxDecodedBytes) {
    throw new ScopeImportError(
      'decode-budget-exceeded',
      `Import would require approximately ${predictedResidentBytes} bytes after preserving working/original arrays; the session limit is ${ScopeImportLimits.maxDecodedBytes} bytes.`,
      { format: detected.format, fileNames: [primary.name, ...companions.map((source) => source.name)] }
    );
  }
  const sourceFiles = [
    sourceRecord(primary, adapterId, detected, 'primary'),
    ...companions.map((source) => sourceRecord(source, adapterId, detected, 'companion'))
  ];
  const adapterRecords: AdapterWaveformRecord[] = records.map((record) => ({
    channels: record.channels.map((_, index) => toSessionChannel(record, index, sourceFiles[0].id)),
    metadata: {
      ...record.metadata,
      sourceFormat: record.sourceFormat,
      supportLevel: record.supportLevel,
      frameIndex: record.frameIndex
    },
    warnings: record.warnings.slice(),
    frameIndex: record.frameIndex
  }));
  const first = adapterRecords[0];
  const warnings = records.flatMap((record) => record.warnings);
  sourceFiles.forEach((source) => {
    source.warnings = warnings.slice();
  });
  return {
    adapterId,
    sourceFile: sourceFiles[0],
    sourceFiles,
    channels: first.channels,
    metadata: first.metadata,
    warnings,
    records: adapterRecords,
    supportLevel: detected.supportLevel
  };
}
