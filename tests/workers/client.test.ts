import { describe, expect, it } from 'vitest';
import { AnalysisWorkerClient, AnalysisWorkerTaskError } from '../../src/workers/client';
import type { WorkerResponse, WorkerTask } from '../../src/workers/protocol';

class FakeWorker extends EventTarget {
  terminated = false;

  postMessage(task: WorkerTask): void {
    setTimeout(() => {
      if (this.terminated) return;
      const progress: WorkerResponse = { id: task.id, type: 'progress', progress: 0.5, stage: 'Halfway' };
      this.dispatchEvent(new MessageEvent('message', { data: progress }));
      const result: WorkerResponse = {
        id: task.id,
        type: 'result',
        result: { values: [1, 2], quality: new Uint16Array(2), steps: [], firDesigns: [] }
      };
      this.dispatchEvent(new MessageEvent('message', { data: result }));
    }, 5);
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe('AnalysisWorkerClient', () => {
  it('reports progress and resolves results', async () => {
    const worker = new FakeWorker();
    const client = new AnalysisWorkerClient(() => worker as unknown as Worker);
    const progress: number[] = [];
    const result = await client.run<{ values: number[]; quality: Uint16Array; steps: []; firDesigns: [] }>(
      {
        kind: 'filter',
        signal: new Float64Array([1, 2]),
        time: new Float64Array([0, 1]),
        quality: new Uint16Array(2),
        pipeline: []
      },
      { onProgress: (value) => progress.push(value) }
    );

    expect(result.values).toEqual([1, 2]);
    expect(progress).toEqual([0.5]);
    expect(worker.terminated).toBe(true);
  });

  it('terminates work and rejects on cancellation', async () => {
    const worker = new FakeWorker();
    const client = new AnalysisWorkerClient(() => worker as unknown as Worker);
    const controller = new AbortController();
    const result = client.run(
      {
        kind: 'filter',
        signal: new Float64Array([1, 2]),
        time: new Float64Array([0, 1]),
        quality: new Uint16Array(2),
        pipeline: []
      },
      { signal: controller.signal }
    );
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminated).toBe(true);
  });

  it('distinguishes deterministic task failures from worker transport failures', async () => {
    class TaskErrorWorker extends EventTarget {
      postMessage(task: WorkerTask): void {
        queueMicrotask(() => {
          const response: WorkerResponse = {
            id: task.id,
            type: 'error',
            error: 'FIR specification exceeds the tap safety limit.'
          };
          this.dispatchEvent(new MessageEvent('message', { data: response }));
        });
      }

      terminate(): void {}
    }

    const client = new AnalysisWorkerClient(() => new TaskErrorWorker() as unknown as Worker);
    await expect(
      client.run({
        kind: 'filter',
        signal: new Float64Array([1, 2]),
        time: new Float64Array([0, 1]),
        quality: new Uint16Array(2),
        pipeline: []
      })
    ).rejects.toBeInstanceOf(AnalysisWorkerTaskError);
  });
});
