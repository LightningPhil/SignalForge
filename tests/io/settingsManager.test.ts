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

  beforeEach(() => {
    originalConfig = clone(State.config);
    vi.stubGlobal('alert', vi.fn());
  });

  afterEach(() => {
    State.config = originalConfig;
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
    expect(State.config.settingsVersion).toBe(4);
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
