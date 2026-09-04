import { describe, expect, it } from 'vitest';
import { EventDetector } from '../../src/analysis/eventDetector';
import { Measurements } from '../../src/analysis/measurements';
import { QualityFlag } from '../../src/data/quality';

describe('event detection', () => {
  it('interpolates level crossings and preserves original indices across invalid pairs', () => {
    const result = EventDetector.detect({
      t: [0, 1, 2, 3],
      y: [-1, Number.NaN, -0.5, 0.5],
      config: { type: 'level', threshold: 0, direction: 'rising', selectionOnly: false }
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0].index).toBe(3);
    expect(result.events[0].time).toBe(2.5);
    expect(result.warnings.join(' ')).toContain('source indices were preserved');
  });

  it('uses a robust nonzero edge threshold when zero is configured', () => {
    const time = Array.from({ length: 100 }, (_, index) => index / 1000);
    const result = EventDetector.detect({
      t: time,
      y: new Array<number>(time.length).fill(4),
      config: { type: 'edge', slopeThreshold: 0, direction: 'either', selectionOnly: false }
    });

    expect(result.events).toHaveLength(0);
    expect(result.warnings.join(' ')).toContain('automatic robust slope threshold');
  });

  it('timestamps hysteretic level events at the boundary that triggered the state change', () => {
    const result = EventDetector.detect({
      t: [0, 1, 2, 3, 4],
      y: [-2, -0.5, 0.2, 0.8, 1.2],
      config: {
        type: 'level',
        threshold: 0,
        hysteresis: 1,
        direction: 'rising',
        selectionOnly: false
      }
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0].time).toBeCloseTo(3.5, 12);
    expect(result.events[0].metadata.triggerLevel).toBe(1);
  });

  it('identifies a runt that crosses the low state threshold but misses the high threshold', () => {
    const result = EventDetector.detect({
      t: [0, 1, 2, 3, 4, 5],
      y: [0, 0.2, 0.7, 0.8, 0.3, 0],
      config: {
        type: 'runt',
        direction: 'rising',
        lowThreshold: 0.5,
        highThreshold: 1,
        minWidth: 0,
        maxWidth: 10,
        selectionOnly: false
      }
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0].metadata.missedThreshold).toBe(1);
  });

  it('honors falling pulse direction for negative-going pulses', () => {
    const falling = EventDetector.detect({
      t: [0, 1, 2, 3],
      y: [0, -1, -1, 0],
      config: {
        type: 'pulse',
        direction: 'falling',
        threshold: -0.5,
        minWidth: 0,
        maxWidth: 10,
        selectionOnly: false
      }
    });
    const rising = EventDetector.detect({
      t: [0, 1, 2, 3],
      y: [0, -1, -1, 0],
      config: {
        type: 'pulse',
        direction: 'rising',
        threshold: 0.5,
        minWidth: 0,
        maxWidth: 10,
        selectionOnly: false
      }
    });

    expect(falling.events).toHaveLength(1);
    expect(falling.events[0].metadata.direction).toBe('falling');
    expect(falling.events[0].metadata.peak).toBe(-1);
    expect(rising.events).toHaveLength(0);
  });

  it('does not detect across samples blocked by the selected source quality mask', () => {
    const quality = new Uint16Array(3);
    quality[1] = QualityFlag.Clipped;
    const result = EventDetector.detect({
      trace: {
        rawX: [0, 1, 2],
        rawY: [-1, 1, -1],
        rawQuality: quality,
        filteredY: null,
        filteredQuality: null,
        seriesName: 'quality',
        isMath: false
      },
      config: { type: 'level', threshold: 0, direction: 'either', selectionOnly: false }
    });

    expect(result.events).toHaveLength(0);
    expect(result.warnings.join(' ')).toContain('analysis-blocking quality flags');
  });

  it('uses raw quality when a requested filtered event source is unavailable', () => {
    const quality = new Uint16Array(3);
    quality[1] = QualityFlag.Clipped;
    const result = EventDetector.detect({
      trace: {
        rawX: [0, 1, 2],
        rawY: [-1, 1, -1],
        rawQuality: quality,
        filteredY: null,
        filteredQuality: null,
        seriesName: 'raw-fallback',
        isMath: false
      },
      config: { type: 'level', source: 'filtered', threshold: 0, direction: 'either', selectionOnly: false }
    });

    expect(result.events).toHaveLength(0);
    expect(result.warnings.join(' ')).toContain('analysis-blocking quality flags');
  });
});

describe('measurements', () => {
  it('keeps time and amplitude pairs aligned when invalid samples are removed', () => {
    const result = Measurements.compute({
      t: [0, 1, 2, 3],
      y: [0, Number.NaN, 4, 6]
    });

    expect(result.meta.invalidPairCount).toBe(1);
    expect(result.metrics.peakTime).toBe(3);
    expect(result.metrics.area).toBe(5);
    expect(result.warnings.join(' ')).toContain('do not bridge gaps');
  });

  it('handles records larger than the JavaScript argument limit', () => {
    const length = 150_000;
    const time = Float64Array.from({ length }, (_, index) => index / 1000);
    const values = Float64Array.from({ length }, (_, index) => (index === 123_456 ? 20 : Math.sin(index / 50)));

    const result = Measurements.compute({ t: time, y: values });

    expect(result.metrics.max).toBe(20);
    expect(result.metrics.peakTime).toBeCloseTo(123.456, 10);
    expect(result.meta.sampleCount).toBe(length);
  });

  it('estimates state levels for a low-duty pulse without collapsing the top state', () => {
    const length = 1000;
    const time = Array.from({ length }, (_, index) => index / 1000);
    const values = new Array<number>(length).fill(0);
    values.fill(10, 400, 440);

    const result = Measurements.compute({ t: time, y: values });

    expect(result.metrics.baseline).toBeCloseTo(0, 12);
    expect(result.metrics.top).toBeCloseTo(10, 12);
    expect(result.metrics.pulseAmplitude).toBeCloseTo(10, 12);
    expect(result.metrics.dutyCycle).toBeCloseTo(0.04, 2);
    expect(result.metrics.overshootPct).toBeCloseTo(0, 12);
  });

  it('separates a sparse overshoot sample from the low-duty pulse top state', () => {
    const length = 1000;
    const time = Array.from({ length }, (_, index) => index / 1000);
    const values = new Array<number>(length).fill(0);
    values.fill(1, 400, 440);
    values[420] = 3;

    const result = Measurements.compute({ t: time, y: values });

    expect(result.metrics.top).toBeCloseTo(1, 12);
    expect(result.metrics.overshootPct).toBeCloseTo(200, 10);
    expect(result.metrics.dutyCycle).toBeCloseTo(0.04, 2);
    expect(result.metrics.pulseWidth).toBeCloseTo(0.04, 3);
  });

  it('does not chain a slow trapezoidal edge into the estimated top state', () => {
    const time = Array.from({ length: 320 }, (_, index) => index / 1000);
    const values = new Array<number>(time.length).fill(0);
    for (let index = 50; index < 130; index += 1) values[index] = (index - 50) / 80;
    values.fill(1, 130, 190);
    for (let index = 190; index < 270; index += 1) values[index] = 1 - (index - 190) / 80;

    const result = Measurements.compute({ t: time, y: values });

    expect(result.metrics.top).toBeCloseTo(1, 2);
    expect(result.metrics.overshootPct).toBeLessThan(2);
    expect(result.metrics.riseTime).toBeCloseTo(0.064, 2);
    expect(result.metrics.fallTime).toBeCloseTo(0.064, 2);
    expect(result.metrics.pulseWidth).toBeCloseTo(0.14, 2);
  });

  it('excludes clipped samples from measurements while retaining aligned indices', () => {
    const quality = new Uint16Array(4);
    quality[2] = QualityFlag.Clipped;
    const result = Measurements.compute({
      t: [0, 1, 2, 3],
      y: [0, 1, 100, 1],
      quality
    });

    expect(result.metrics.max).toBe(1);
    expect(result.meta.qualityExcludedCount).toBe(1);
    expect(result.warnings.join(' ')).toContain('analysis-blocking quality flags');
  });
});
