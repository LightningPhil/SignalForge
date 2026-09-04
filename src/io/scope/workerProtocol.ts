import type { ImportSource } from '../adapters/types';
import type { ImportedWaveformRecord, ScopeImportFailureCode, ScopeFormat } from './types';

export interface ScopeWorkerRequest {
  id: string;
  primary: ImportSource;
  companions: ImportSource[];
}

export type ScopeWorkerResponse =
  | { id: string; type: 'progress'; progress: number; stage: string }
  | { id: string; type: 'result'; records: ImportedWaveformRecord[] }
  | {
      id: string;
      type: 'error';
      error: {
        code: ScopeImportFailureCode;
        message: string;
        format?: ScopeFormat;
        fileNames: string[];
      };
    };
