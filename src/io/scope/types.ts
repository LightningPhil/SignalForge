import type { ImportSource } from '../adapters/types';

export type ScopeSupportLevel = 'verified' | 'layout-tested' | 'experimental' | 'conversion-required' | 'provisional';

export type ScopeImportFailureCode =
  | 'unrecognised-format'
  | 'missing-companion'
  | 'ambiguous-companion'
  | 'conversion-required'
  | 'unsupported-variant'
  | 'truncated-file'
  | 'invalid-header'
  | 'length-mismatch'
  | 'decode-budget-exceeded'
  | 'cancelled';

export type ScopeFormat =
  | 'tektronix-wfm'
  | 'tektronix-isf'
  | 'keysight-agxx-bin'
  | 'rohde-schwarz-rtx-bin'
  | 'rohde-schwarz-wfm-bin-payload'
  | 'teledyne-lecroy-trc'
  | 'rigol-wfm'
  | 'rigol-bin'
  | 'picoscope-psdata'
  | 'picoscope-hdf5'
  | 'picoscope-csv';

export interface ImportedScopeChannel {
  name: string;
  values: Float64Array;
  unit: string;
  sourceUnit: string;
  sourceToSiScale: number;
  invalidMask?: Uint8Array;
  calibrationSource: string;
}

export interface ImportedWaveformRecord {
  sourceFormat: ScopeFormat;
  supportLevel: ScopeSupportLevel;
  timeSeconds: Float64Array;
  channels: ImportedScopeChannel[];
  frameIndex: number;
  metadata: Record<string, string | number | boolean | null>;
  warnings: string[];
}

export interface ScopeImportRequest {
  primary: ImportSource;
  companions?: ImportSource[];
  signal?: AbortSignal;
  onProgress?: (progress: number, stage: string) => void;
}

export interface DetectedScopeFile {
  format: ScopeFormat;
  supportLevel: ScopeSupportLevel;
  manufacturer: string;
  displayName: string;
  confidence: number;
  reason: string;
}

export class ScopeImportError extends Error {
  readonly code: ScopeImportFailureCode;
  readonly format?: ScopeFormat;
  readonly fileNames: string[];

  constructor(
    code: ScopeImportFailureCode,
    message: string,
    options: { format?: ScopeFormat; fileNames?: string[]; cause?: unknown } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = 'ScopeImportError';
    this.code = code;
    this.format = options.format;
    this.fileNames = options.fileNames || [];
  }
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ScopeImportError('cancelled', 'Waveform import was cancelled.');
  }
}
