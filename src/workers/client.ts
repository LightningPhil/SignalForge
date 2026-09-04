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
  for (const value of Object.values(task)) {
    if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) buffers.push(value.buffer);
  }
  return buffers;
}

export class AnalysisWorkerClient {
  private readonly factory: WorkerFactory;

  constructor(factory: WorkerFactory = defaultFactory) {
    this.factory = factory;
  }

  run<TResult extends WorkerTaskResult>(task: WorkerTaskInput, options: WorkerRunOptions = {}): Promise<TResult> {
    const worker = this.factory();
    const id = task.id || `task-${crypto.randomUUID()}`;
    const request = { ...task, id } as WorkerTask;

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
