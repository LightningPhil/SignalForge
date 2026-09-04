import type { SessionChannel, SourceFileRecord } from '../../domain/session';

export interface ImportSource {
  name: string;
  bytes: Uint8Array;
  size: number;
  lastModified: number | null;
}

export interface AdapterIdentification {
  confidence: number;
  manufacturer?: string;
  format?: string;
  reason: string;
}

export interface ImportAdapterOptions {
  headerRow?: number;
  delimiter?: string;
  timeColumn?: string;
  channelUnits?: Record<string, string>;
  companions?: ImportSource[];
  signal?: AbortSignal;
  onProgress?: (progress: number, stage: string) => void;
}

export interface AdapterWaveformRecord {
  channels: SessionChannel[];
  metadata: Record<string, string | number | boolean | null>;
  warnings: string[];
  frameIndex: number;
}

export interface AdapterImportResult {
  adapterId: string;
  sourceFile: SourceFileRecord;
  sourceFiles?: SourceFileRecord[];
  channels: SessionChannel[];
  metadata: Record<string, string | number | boolean | null>;
  warnings: string[];
  records?: AdapterWaveformRecord[];
  supportLevel?: 'verified' | 'layout-tested' | 'experimental' | 'conversion-required' | 'provisional';
}

export interface WaveformImportAdapter {
  id: string;
  name: string;
  status: 'supported' | 'experimental' | 'fixture-required';
  identify(source: ImportSource): AdapterIdentification;
  import(source: ImportSource, options?: ImportAdapterOptions): Promise<AdapterImportResult>;
}

export class UnsupportedVariantError extends Error {
  readonly adapterId: string;

  constructor(adapterId: string, message: string) {
    super(message);
    this.name = 'UnsupportedVariantError';
    this.adapterId = adapterId;
  }
}
