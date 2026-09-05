import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../../src/config';
import { SettingsManager } from '../../src/io/settingsManager';
import { State } from '../../src/state';
import type { AppConfig } from '../../src/types';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('settings filter migrations', () => {
  let originalConfig: AppConfig;
  let originalWorkspace: {
    multiViews: typeof State.multiViews;
    composer: typeof State.composer;
    traceConfigs: typeof State.traceConfigs;
    viewRanges: typeof State.ui.viewRanges;
    activeMultiViewId: string | null;
    dataColumn: string | null;
  };

  beforeEach(() => {
    originalConfig = clone(State.config);
    originalWorkspace = {
      multiViews: clone(State.multiViews),
      composer: clone(State.composer),
      traceConfigs: clone(State.traceConfigs),
      viewRanges: clone(State.ui.viewRanges),
      activeMultiViewId: State.ui.activeMultiViewId,
      dataColumn: State.data.dataColumn
    };
    vi.stubGlobal('alert', vi.fn());
  });

  afterEach(() => {
    State.config = originalConfig;
    State.multiViews = originalWorkspace.multiViews;
    State.composer = originalWorkspace.composer;
    State.traceConfigs = originalWorkspace.traceConfigs;
    State.ui.viewRanges = originalWorkspace.viewRanges;
    State.ui.activeMultiViewId = originalWorkspace.activeMultiViewId;
    State.data.dataColumn = originalWorkspace.dataColumn;
    State.clearPipelineHistory();
    vi.unstubAllGlobals();
  });

  it('removes legacy FFT qFactor and fills versioned filter defaults', () => {
    const payload = clone(Config) as unknown as Record<string, unknown>;
    payload.settingsVersion = 2;
    payload.pipeline = [
      {
        id: 'legacy-low',
        type: 'lowPassFFT',
        enabled: true,
        cutoffFreq: 100,
        slope: 12,
        qFactor: 0.707
      },
      {
        id: 'legacy-notch',
        type: 'iirNotch',
        enabled: true,
        centerFreq: 200,
        bandwidth: 10
      }
    ];

    expect(SettingsManager.applySettings(JSON.stringify(payload))).toBe(true);
    expect(State.config.settingsVersion).toBe(5);
    expect(State.config.pipeline[0]).toEqual({
      id: 'legacy-low',
      type: 'lowPassFFT',
      enabled: true,
      cutoffFreq: 100,
      slope: 12
    });
    expect(State.config.pipeline[1].processingMode).toBe('zero-phase');
    expect(JSON.stringify(SettingsManager.getSerializableConfig())).not.toContain('qFactor');
  });

  it('rejects parameters that do not belong to the selected filter schema', () => {
    const payload = clone(Config) as unknown as Record<string, unknown>;
    payload.pipeline = [
      {
        id: 'invalid',
        type: 'movingAverage',
        enabled: true,
        windowSize: 5,
        bandwidth: 10
      }
    ];

    expect(SettingsManager.applySettings(JSON.stringify(payload))).toBe(false);
    expect(vi.mocked(alert).mock.calls[0]?.[0]).toContain('unsupported parameter');
  });

  it('clears processing undo history when settings replace the recipe', () => {
    State.config = clone(Config);
    State.clearPipelineHistory();
    const existing = State.addStep('movingAverage');
    State.updateStepParams(existing.id, { windowSize: 11 });
    expect(State.pipelineUndoStack.length).toBeGreaterThan(0);

    const replacement = clone(Config);
    replacement.pipeline = [{ id: 'replacement', type: 'median', enabled: true, windowSize: 7 }];
    expect(SettingsManager.applySettings(JSON.stringify(replacement))).toBe(true);
    expect(State.getPipeline()[0]).toMatchObject({ id: 'replacement', type: 'median', windowSize: 7 });
    expect(State.undoPipelineChange()).toBe(false);
  });

  it('rejects unknown sections, out-of-range numbers and invalid enums instead of applying them', () => {
    const base = () => clone(Config) as unknown as Record<string, unknown>;

    const unknownSection = base();
    unknownSection.telemetry = { enabled: true };
    expect(SettingsManager.applySettings(JSON.stringify(unknownSection))).toBe(false);
    expect(vi.mocked(alert).mock.calls.at(-1)?.[0]).toContain('"telemetry" is not a recognised settings section');

    const badGraph = base();
    (badGraph.graph as Record<string, unknown>).maxDisplayPoints = 'lots';
    expect(SettingsManager.applySettings(JSON.stringify(badGraph))).toBe(false);
    expect(vi.mocked(alert).mock.calls.at(-1)?.[0]).toContain('graph.maxDisplayPoints');

    const badAnalysis = base();
    (badAnalysis.analysis as Record<string, unknown>).fftWindow = 'triangular-ish';
    expect(SettingsManager.applySettings(JSON.stringify(badAnalysis))).toBe(false);
    expect(vi.mocked(alert).mock.calls.at(-1)?.[0]).toContain('analysis.fftWindow must be one of');

    const badTrigger = base();
    ((badTrigger.analysis as Record<string, unknown>).trigger as Record<string, unknown>).threshold = 'NaN';
    expect(SettingsManager.applySettings(JSON.stringify(badTrigger))).toBe(false);
    expect(vi.mocked(alert).mock.calls.at(-1)?.[0]).toContain('analysis.trigger.threshold');

    const badColor = base();
    ((badColor.colors as Record<string, unknown>).dark as Record<string, unknown>).filtered =
      'url(javascript:alert(1))';
    expect(SettingsManager.applySettings(JSON.stringify(badColor))).toBe(false);
    expect(vi.mocked(alert).mock.calls.at(-1)?.[0]).toContain('colors.dark.filtered must be a hex colour');

    const badWorkspace = base();
    badWorkspace.workspace = { traceConfigs: { V: { xOffset: 'far' } } };
    expect(SettingsManager.applySettings(JSON.stringify(badWorkspace))).toBe(false);
    expect(vi.mocked(alert).mock.calls.at(-1)?.[0]).toContain('workspace.traceConfigs.V.xOffset');

    const badCalibration = base();
    badCalibration.displayCalibration = { pixelsPerCm: 0 };
    expect(SettingsManager.applySettings(JSON.stringify(badCalibration))).toBe(false);
    expect(vi.mocked(alert).mock.calls.at(-1)?.[0]).toContain('displayCalibration.pixelsPerCm');

    // Nothing above may have leaked into the live configuration.
    expect(State.config.graph.maxDisplayPoints).toBe(originalConfig.graph.maxDisplayPoints);
    expect(State.config.analysis.fftWindow).toBe(originalConfig.analysis.fftWindow);
    expect(State.config.colors.dark.filtered).toBe(originalConfig.colors.dark.filtered);
  });

  it('accepts a complete valid payload including workspace state and legacy boolean zero-padding', () => {
    const payload = clone(Config) as unknown as Record<string, unknown>;
    (payload.analysis as Record<string, unknown>).fftZeroPad = true;
    (payload.analysis as Record<string, unknown>).fftWindow = 'kaiser';
    payload.workspace = {
      multiViews: [{ id: 'view-1', name: 'View', activeColumnIds: ['Voltage'] }],
      composer: { views: { 'view-1': { traces: [{ columnId: 'Voltage', yOffset: 0.5 }] } } },
      traceConfigs: { Voltage: { xOffset: 2 } },
      viewRanges: { Voltage: { x: [0, 1], y: null } },
      activeMultiViewId: 'view-1',
      dataColumn: 'Voltage'
    };

    expect(SettingsManager.applySettings(JSON.stringify(payload))).toBe(true);
    expect(State.config.analysis.fftZeroPad).toBe('nextPow2');
    expect(State.config.analysis.fftWindow).toBe('kaiser');
    expect(State.traceConfigs.Voltage?.xOffset).toBe(2);
    expect(State.multiViews[0]?.id).toBe('view-1');
  });

  it('round-trips complete FIR specifications without persisting derived taps', () => {
    const payload = clone(Config) as unknown as Record<string, unknown>;
    payload.pipeline = [
      {
        id: 'fir-band',
        type: 'firBandPass',
        enabled: true,
        centerFreq: 150,
        bandwidth: 100,
        transitionWidth: 20,
        passbandRippleDb: 0.05,
        stopbandAttenuationDb: 90,
        processingMode: 'causal'
      }
    ];

    expect(SettingsManager.applySettings(JSON.stringify(payload))).toBe(true);
    expect(State.config.pipeline[0]).toEqual(payload.pipeline[0]);
    const serialized = JSON.stringify(SettingsManager.getSerializableConfig());
    expect(serialized).toContain('"firBandPass"');
    expect(serialized).not.toContain('"tapCount"');
  });
});
