import { describe, expect, it } from 'vitest';
import { AnalysisWorkerClient } from '../../src/workers/client';
import type { WorkerResponse, WorkerTask } from '../../src/workers/protocol';

class CheckpointWorker extends EventTarget {
  terminated = false;
  checkpoints = 0;
  processedSamples = 0;

  postMessage(task: WorkerTask): void {
    if (task.kind !== 'filter') throw new Error('Checkpoint worker accepts filter tasks only.');
    let cursor = 0;
    const checkpoint = () => {
      if (this.terminated) return;
      const end = Math.min(task.signal.length, cursor + 10_000);
      let checksum = 0;
      for (; cursor < end; cursor += 1) checksum += task.signal[cursor];
      if (!Number.isFinite(checksum)) throw new Error('Synthetic worker checksum became non-finite.');
      this.processedSamples = cursor;
      this.checkpoints += 1;
      const response: WorkerResponse = {
        id: task.id,
        type: 'progress',
        progress: this.checkpoints / 100,
        stage: `checkpoint-${this.checkpoints}`
      };
      this.dispatchEvent(new MessageEvent('message', { data: response }));
      setTimeout(checkpoint, 0);
    };
    setTimeout(checkpoint, 0);
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe('worker cancellation budget', () => {
  it('terminates at the requested deterministic progress checkpoint', async () => {
    const worker = new CheckpointWorker();
    const client = new AnalysisWorkerClient(() => worker as unknown as Worker);
    const controller = new AbortController();
    const pending = client.run(
      {
        kind: 'filter',
        signal: new Float64Array(100_000),
        time: new Float64Array(100_000),
        quality: new Uint16Array(100_000),
        pipeline: []
      },
      {
        signal: controller.signal,
        onProgress: () => {
          if (worker.checkpoints === 2) controller.abort();
        }
      }
    );

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminated).toBe(true);
    expect(worker.checkpoints).toBe(2);
    expect(worker.processedSamples).toBe(20_000);
    expect(worker.processedSamples).toBeLessThan(100_000);
  });
});
