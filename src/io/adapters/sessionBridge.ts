import type { SessionChannel, SourceFileRecord } from '../../domain/session';
import type { AdapterImportResult, AdapterWaveformRecord } from './types';

export function firstMetadataConflict(
  metadata: Record<string, string | number | boolean | null>,
  entries: Array<[string, string | number | boolean]>
): [string, string | number | boolean] | undefined {
  return entries.find(
    ([field, value]) => Object.prototype.hasOwnProperty.call(metadata, field) && metadata[field] !== value
  );
}

export function attachAdapterRecord(
  imported: AdapterImportResult,
  record: AdapterWaveformRecord,
  includeBytes: boolean
): { sources: SourceFileRecord[]; channels: SessionChannel[] } {
  const originals = imported.sourceFiles || [imported.sourceFile];
  const idMap = new Map<string, string>();
  const sources = originals.map((source) => {
    const nextId = includeBytes ? source.id : `source-${crypto.randomUUID()}`;
    idMap.set(source.id, nextId);
    return {
      ...source,
      id: nextId,
      bytes: includeBytes ? source.bytes?.slice() : undefined,
      metadata: {
        ...source.metadata,
        sharedSourceId: source.id,
        sourceBytesStored: includeBytes
      },
      warnings: source.warnings.slice()
    };
  });
  const channels = record.channels.map((channel) => ({
    ...channel,
    id: `channel-${crypto.randomUUID()}`,
    sourceFileId: channel.sourceFileId ? idMap.get(channel.sourceFileId) : undefined
  }));
  return { sources, channels };
}
