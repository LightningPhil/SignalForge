import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Config } from '../../src/config';
import { State } from '../../src/state';
import type { AppConfig } from '../../src/types';

let originalConfig: AppConfig;

describe('processing recipe undo and redo', () => {
  beforeEach(() => {
    originalConfig = structuredClone(State.config);
    State.config = structuredClone(Config);
    State.clearPipelineHistory();
    State.ui.selectedStepId = State.config.pipeline[0]?.id || null;
  });

  afterEach(() => {
    State.config = originalConfig;
    State.clearPipelineHistory();
  });

  it('restores add and parameter edits without touching source data', () => {
    const original = [1, 2, 3];
    State.setData(
      original.map((value, index) => ({ Time: index, Signal: value })),
      ['Time', 'Signal']
    );
    const immutableBefore = State.data.original.map((row) => ({ ...row }));

    const step = State.addStep('movingAverage');
    State.updateStepParams(step.id, { windowSize: 11 });
    expect(State.getPipeline()[0].windowSize).toBe(11);

    expect(State.undoPipelineChange()).toBe(true);
    expect(State.getPipeline()[0].windowSize).toBe(Config.defaults.movingAverage.windowSize);
    expect(State.undoPipelineChange()).toBe(true);
    expect(State.getPipeline()[0].type).toBe('nullFilter');
    expect(State.redoPipelineChange()).toBe(true);
    expect(State.getPipeline()[0].type).toBe('movingAverage');
    expect(State.data.original).toEqual(immutableBefore);
  });

  it('restores per-column and global scope recipes atomically', () => {
    State.config.columnPipelines = {
      Voltage: [{ id: 'v', type: 'movingAverage', enabled: true, windowSize: 5 }],
      Current: [{ id: 'i', type: 'median', enabled: true, windowSize: 5 }]
    };
    State.config.pipelineScope = false;
    State.data.dataColumn = 'Voltage';

    State.setPipelineScope(true, ['Voltage', 'Current']);
    expect(State.config.pipelineScope).toBe(true);
    expect(State.undoPipelineChange()).toBe(true);
    expect(State.config.pipelineScope).toBe(false);
    expect(State.config.columnPipelines.Current[0].type).toBe('median');
    expect(State.redoPipelineChange()).toBe(true);
    expect(State.config.pipelineScope).toBe(true);
  });
});
