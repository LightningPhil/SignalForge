import { describe, expect, it } from 'vitest';
import { ScopeImportClient } from '../../src/io/scope/client';
import { ScopeImportError } from '../../src/io/scope/types';
import type { ScopeWorkerRequest, ScopeWorkerResponse } from '../../src/io/scope/workerProtocol';

class FakeScopeWorker extends EventTarget {
  terminated = false;

  postMessage(request: ScopeWorkerRequest): void {
    queueMicrotask(() => {
      if (this.terminated) return;
      const progress: ScopeWorkerResponse = {
        id: request.id,
        type: 'progress',
        progress: 0.5,
        stage: 'Decoding'
      };
      this.dispatchEvent(new MessageEvent('message', { data: progress }));
      const result: ScopeWorkerResponse = {
        id: request.id,
        type: 'result',
        records: [
          {
            sourceFormat: 'tektronix-isf',
            supportLevel: 'layout-tested',
            timeSeconds: new Float64Array([0]),
            channels: [
              {
                name: 'CH1',
                values: new Float64Array([1]),
                unit: 'V',
                sourceUnit: 'V',
                sourceToSiScale: 1,
                calibrationSource: 'fixture'
              }
            ],
            frameIndex: 0,
            metadata: {},
            warnings: []
          }
        ]
      };
      this.dispatchEvent(new MessageEvent('message', { data: result }));
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

const source = {
  name: 'capture.isf',
  bytes: new Uint8Array([1, 2, 3]),
  size: 3,
  lastModified: null
};

describe('scope import worker client', () => {
  it('reports progress, preserves caller bytes, and terminates after success', async () => {
    const worker = new FakeScopeWorker();
    const progress: number[] = [];
    const client = new ScopeImportClient(() => worker as unknown as Worker);
    const records = await client.decode(source, { onProgress: (value) => progress.push(value) });

    expect(records[0].channels[0].values[0]).toBe(1);
    expect(progress).toEqual([0.5]);
    expect(source.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(worker.terminated).toBe(true);
  });

  it('terminates immediately on cancellation', async () => {
    const worker = new FakeScopeWorker();
    const client = new ScopeImportClient(() => worker as unknown as Worker);
    const controller = new AbortController();
    const pending = client.decode(source, { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminated).toBe(true);
  });

  it('reconstructs typed parser failures from the worker', async () => {
    class ErrorWorker extends EventTarget {
      postMessage(request: ScopeWorkerRequest): void {
        queueMicrotask(() => {
          const response: ScopeWorkerResponse = {
            id: request.id,
            type: 'error',
            error: {
              code: 'unsupported-variant',
              message: 'Unsupported waveform class.',
              format: 'tektronix-wfm',
              fileNames: [request.primary.name]
            }
          };
          this.dispatchEvent(new MessageEvent('message', { data: response }));
        });
      }
      terminate(): void {}
    }
    const client = new ScopeImportClient(() => new ErrorWorker() as unknown as Worker);
    await expect(client.decode(source)).rejects.toBeInstanceOf(ScopeImportError);
    await expect(client.decode(source)).rejects.toMatchObject({ code: 'unsupported-variant' });
  });

  it('turns a synchronous worker construction failure into a typed import rejection', async () => {
    const client = new ScopeImportClient(() => {
      throw new DOMException('Refused to create a worker (CSP worker-src).', 'SecurityError');
    });
    let pending: Promise<unknown>;
    expect(() => {
      pending = client.decode(source);
    }).not.toThrow();
    await expect(pending!).rejects.toBeInstanceOf(ScopeImportError);
    await expect(pending!).rejects.toMatchObject({ fileNames: [source.name] });
    // The caller's bytes are untouched because nothing was transferred.
    expect(source.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });
});
