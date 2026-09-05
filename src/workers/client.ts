import type { WorkerResponse, WorkerTask, WorkerTaskResult } from './protocol';

export interface WorkerRunOptions {
  signal?: AbortSignal;
  onProgress?: (progress: number, stage: string) => void;
  transferOwnership?: boolean;
}

type WorkerFactory = () => Worker;
type WorkerTaskInput = WorkerTask extends infer Task
  ? Task extends { id: string }
    ? Omit<Task, 'id'> & { id?: string }
    : never
  : never;

function defaultFactory(): Worker {
  return new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
}

export class AnalysisWorkerTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisWorkerTaskError';
  }
}

export class AnalysisWorkerTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AnalysisWorkerTransportError';
  }
}

function transferableBuffers(task: WorkerTask): Transferable[] {
  if (task.kind === 'parse-delimited') return [];
  const buffers: Transferable[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (ArrayBuffer.isView(value)) {
      if (value.buffer instanceof ArrayBuffer && !buffers.includes(value.buffer)) buffers.push(value.buffer);
      return;
    }
    if (value instanceof ArrayBuffer) {
      if (!buffers.includes(value)) buffers.push(value);
      return;
    }
    Object.values(value as Record<string, unknown>).forEach(visit);
  };
  visit(task);
  return buffers;
}

export class AnalysisWorkerClient {
  private readonly factory: WorkerFactory;

  constructor(factory: WorkerFactory = defaultFactory) {
    this.factory = factory;
  }

  run<TResult extends WorkerTaskResult>(task: WorkerTaskInput, options: WorkerRunOptions = {}): Promise<TResult> {
    const id = task.id || `task-${crypto.randomUUID()}`;
    const request = { ...task, id } as WorkerTask;
    // Worker construction can throw synchronously (CSP worker-src, file://, no module-worker support).
    // That is a transport failure and must reach the caller's .catch, not escape the event handler.
    let worker: Worker;
    try {
      worker = this.factory();
    } catch (error) {
      return Promise.reject(new AnalysisWorkerTransportError('Unable to start the analysis worker.', { cause: error }));
    }

    return new Promise<TResult>((resolve, reject) => {
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
        reject(new DOMException('Analysis task was cancelled.', 'AbortError'));
      };
      if (options.signal?.aborted) {
        abort();
        return;
      }
      options.signal?.addEventListener('abort', abort, { once: true });
      worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
        if (event.data.id !== id) return;
        if (event.data.type === 'progress') {
          options.onProgress?.(event.data.progress, event.data.stage);
        } else if (event.data.type === 'result') {
          if (!finish()) return;
          resolve(event.data.result as TResult);
        } else {
          if (!finish()) return;
          reject(new AnalysisWorkerTaskError(event.data.error));
        }
      });
      worker.addEventListener('error', (event) => {
        if (!finish()) return;
        reject(
          new AnalysisWorkerTransportError(event.message || 'Analysis worker failed.', {
            cause: event.error
          })
        );
      });
      worker.addEventListener('messageerror', () => {
        // A result that cannot be deserialised must fail the task, otherwise the promise never settles.
        if (!finish()) return;
        reject(new AnalysisWorkerTransportError('The analysis worker result could not be deserialised.'));
      });
      const transfer = options.transferOwnership ? transferableBuffers(request) : [];
      try {
        worker.postMessage(request, transfer);
      } catch (error) {
        if (!finish()) return;
        reject(
          new AnalysisWorkerTransportError('Unable to send the analysis task to the worker.', {
            cause: error
          })
        );
      }
    });
  }
}

export const analysisWorkerClient = new AnalysisWorkerClient();
