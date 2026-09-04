import type { ImportSource } from '../adapters/types';
import { ScopeImportLimits } from './limits';
import { ScopeImportError, type ImportedWaveformRecord } from './types';
import type { ScopeWorkerRequest, ScopeWorkerResponse } from './workerProtocol';

export interface ScopeImportClientOptions {
  companions?: ImportSource[];
  signal?: AbortSignal;
  onProgress?: (progress: number, stage: string) => void;
}

type WorkerFactory = () => Worker;

function defaultFactory(): Worker {
  return new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module' });
}

function transferableSource(source: ImportSource): ImportSource {
  return { ...source, bytes: source.bytes.slice() };
}

export class ScopeImportClient {
  private readonly factory: WorkerFactory;

  constructor(factory: WorkerFactory = defaultFactory) {
    this.factory = factory;
  }

  decode(primary: ImportSource, options: ScopeImportClientOptions = {}): Promise<ImportedWaveformRecord[]> {
    const sources = [primary, ...(options.companions || [])];
    let totalBytes = 0;
    for (const source of sources) {
      if (source.bytes.byteLength > ScopeImportLimits.maxFileBytes) {
        return Promise.reject(
          new ScopeImportError(
            'decode-budget-exceeded',
            `${source.name} exceeds the ${ScopeImportLimits.maxFileBytes}-byte per-file limit.`,
            { fileNames: [source.name] }
          )
        );
      }
      totalBytes += source.bytes.byteLength;
    }
    if (totalBytes > ScopeImportLimits.maxDecodedBytes) {
      return Promise.reject(
        new ScopeImportError(
          'decode-budget-exceeded',
          `Selected native source bytes exceed the ${ScopeImportLimits.maxDecodedBytes}-byte aggregate limit.`,
          { fileNames: sources.map((source) => source.name) }
        )
      );
    }
    const worker = this.factory();
    const id = `scope-${crypto.randomUUID()}`;
    const transferablePrimary = transferableSource(primary);
    const transferableCompanions = (options.companions || []).map(transferableSource);
    const request: ScopeWorkerRequest = {
      id,
      primary: transferablePrimary,
      companions: transferableCompanions
    };
    const transfers: Transferable[] = [
      transferablePrimary.bytes.buffer,
      ...transferableCompanions.map((source) => source.bytes.buffer)
    ];

    return new Promise<ImportedWaveformRecord[]>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return false;
        settled = true;
        options.signal?.removeEventListener('abort', abort);
        worker.terminate();
        return true;
      };
      const abort = () => {
        if (!finish()) return;
        reject(new DOMException('Waveform import was cancelled.', 'AbortError'));
      };
      if (options.signal?.aborted) {
        abort();
        return;
      }
      options.signal?.addEventListener('abort', abort, { once: true });
      worker.addEventListener('message', (event: MessageEvent<ScopeWorkerResponse>) => {
        if (event.data.id !== id) return;
        if (event.data.type === 'progress') {
          options.onProgress?.(event.data.progress, event.data.stage);
          return;
        }
        if (!finish()) return;
        if (event.data.type === 'result') {
          resolve(event.data.records);
        } else {
          reject(
            new ScopeImportError(event.data.error.code, event.data.error.message, {
              format: event.data.error.format,
              fileNames: event.data.error.fileNames
            })
          );
        }
      });
      worker.addEventListener('error', (event) => {
        if (!finish()) return;
        reject(new Error(event.message || 'Native waveform import worker failed.'));
      });
      try {
        worker.postMessage(request, transfers);
      } catch (error) {
        if (!finish()) return;
        reject(error);
      }
    });
  }
}

export const scopeImportClient = new ScopeImportClient();
