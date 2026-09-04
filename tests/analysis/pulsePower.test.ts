import { describe, expect, it } from 'vitest';
import { calculatePulsePower } from '../../src/analysis/pulsePower';
import { QualityFlag } from '../../src/data/quality';

describe('structured pulse-power calculations', () => {
  it('integrates charge, energy and action on the actual timebase', () => {
    const result = calculatePulsePower({
      time: [0, 1, 3],
      voltage: [2, 2, 2],
      current: [1, 1, 1],
      voltageUnit: 'V',
      currentUnit: 'A',
      minimumCurrent: 0.1
    });

    expect(result.metrics.charge).toEqual({ value: 3, unit: 'C' });
    expect(result.metrics.energy).toEqual({ value: 6, unit: 'J' });
    expect(result.metrics.actionIntegral).toEqual({ value: 3, unit: 'A²·s' });
    expect(result.metrics.averagePower).toEqual({ value: 2, unit: 'W' });
  });

  it('normalizes units and records polarity and deskew provenance', () => {
    const result = calculatePulsePower({
      time: [0, 1, 2, 3],
      voltage: [1, 1, 1, 1],
      current: [1, 1, 1, 1],
      voltageUnit: 'kV',
      currentUnit: 'mA',
      voltagePolarity: -1,
      currentDelaySamples: 0.25,
      minimumCurrent: 1e-6
    });

    expect(result.metrics.averagePower.value).toBeCloseTo(-1, 12);
    expect(result.provenance.currentDelaySamples).toBe(0.25);
    expect(result.provenance.voltagePolarity).toBe(-1);
  });

  it('applies non-cancelling unit scales and rejects unknown or mis-cased units', () => {
    const scaled = calculatePulsePower({
      time: [0, 1, 2, 3],
      voltage: [1, 1, 1, 1],
      current: [1, 1, 1, 1],
      voltageUnit: 'kV',
      currentUnit: 'A',
      minimumCurrent: 1e-6
    });
    expect(scaled.metrics.averagePower.value).toBeCloseTo(1e3, 9);

    const mega = calculatePulsePower({
      time: [0, 1],
      voltage: [1, 1],
      current: [1, 1],
      voltageUnit: 'MV',
      currentUnit: 'mA',
      minimumCurrent: 1e-6
    });
    expect(mega.metrics.averagePower.value).toBeCloseTo(1e3, 9);

    expect(() =>
      calculatePulsePower({ time: [0, 1], voltage: [1, 1], current: [1, 1], voltageUnit: 'furlongs' })
    ).toThrow(/not recognised/);
    expect(() => calculatePulsePower({ time: [0, 1], voltage: [1, 1], current: [1, 1], currentUnit: 'V' })).toThrow(
      /not dimensionally compatible/
    );
  });

  it('excludes clipped or missing samples from every metric instead of using them verbatim', () => {
    const time = Array.from({ length: 11 }, (_, index) => index / 100);
    const voltage = new Array<number>(time.length).fill(1);
    const voltageQuality = new Uint16Array(time.length);
    voltage[5] = 1000;
    voltageQuality[5] = QualityFlag.Clipped;
    const result = calculatePulsePower({
      time,
      voltage,
      current: new Array<number>(time.length).fill(1),
      voltageQuality,
      minimumCurrent: 0
    });

    expect(result.metrics.peakVoltage.value).toBe(1);
    expect(result.metrics.peakPower.value).toBe(1);
    // Two intervals adjoin the excluded sample, so 8 of 10 intervals of 0.01 s × 1 W remain.
    expect(result.metrics.energy.value).toBeCloseTo(0.08, 12);
    expect(result.warnings.join(' ')).toContain('excluded from all pulse-power metrics');
  });

  it('restores the aligned energy when the reported current delay is applied', () => {
    const length = 400;
    const time = Array.from({ length }, (_, index) => index / 1000);
    const pulse = (index: number) => (index >= 100 && index < 200 ? 1 : 0);
    const voltage = time.map((_, index) => pulse(index));
    const laggedCurrent = time.map((_, index) => pulse(index - 3));
    const aligned = calculatePulsePower({
      time,
      voltage,
      current: laggedCurrent,
      currentDelaySamples: 3,
      minimumCurrent: 0
    });
    const misaligned = calculatePulsePower({ time, voltage, current: laggedCurrent, minimumCurrent: 0 });
    const wrongSign = calculatePulsePower({
      time,
      voltage,
      current: laggedCurrent,
      currentDelaySamples: -3,
      minimumCurrent: 0
    });

    // 100 unit-power samples 1 ms apart: 99 full intervals plus two trapezoidal half-intervals at the edges.
    expect(aligned.metrics.energy.value).toBeCloseTo(0.1, 9);
    expect(misaligned.metrics.energy.value as number).toBeLessThan(aligned.metrics.energy.value as number);
    expect(wrongSign.metrics.energy.value as number).toBeLessThan(misaligned.metrics.energy.value as number);
  });

  it('masks dynamic impedance near zero current', () => {
    const result = calculatePulsePower({
      time: [0, 1, 2],
      voltage: [1, 2, 3],
      current: [0, 1e-12, 1],
      minimumCurrent: 1e-6
    });

    expect(result.provenance.maskedImpedanceSamples).toBe(2);
    expect(result.metrics.dynamicImpedanceMedian.value).toBe(3);
    expect(result.warnings.join(' ')).toContain('Masked 2');
  });

  it('aligns current by its own timebase before calculating power', () => {
    const result = calculatePulsePower({
      time: [0, 1, 2],
      voltage: [2, 2, 2],
      currentTime: [-1, 0, 1, 2, 3],
      current: [-1, 0, 1, 2, 3],
      minimumCurrent: 0
    });

    expect(result.metrics.energy.value).toBeCloseTo(4, 12);
    expect(result.metrics.charge.value).toBeCloseTo(2, 12);
  });

  it('aligns current quality flags onto the voltage grid', () => {
    const result = calculatePulsePower({
      time: [0, 1, 2],
      voltage: [1, 1, 1],
      currentTime: [0.5, 1.5, 2.5],
      current: [1, 9, 1],
      currentQuality: [0, QualityFlag.Clipped, 0],
      region: { i0: 1, i1: 1 },
      minimumCurrent: 0
    });

    expect(result.warnings.join(' ')).toContain('clipped quality flags');
  });

  it('anti-alias filters a higher-rate current channel before alignment', () => {
    const voltageTime = Array.from({ length: 1000 }, (_, index) => index / 1000);
    const currentTime = Array.from({ length: 4000 }, (_, index) => index / 4000);
    const result = calculatePulsePower({
      time: voltageTime,
      voltage: voltageTime.map((time) => Math.sin(2 * Math.PI * 400 * time)),
      currentTime,
      current: currentTime.map((time) => Math.sin(2 * Math.PI * 600 * time)),
      minimumCurrent: 0
    });

    expect(Math.abs(result.metrics.energy.value || 0)).toBeLessThan(0.01);
    // Uniform, aligned grids use exact Fourier band-limiting (no in-band IIR droop); other grids use
    // the IIR anti-alias cascade. Either way the 600 Hz tone above the 500 Hz Nyquist is removed.
    expect(result.warnings.join(' ')).toMatch(/band-limited Fourier interpolation|anti-alias filtering/);
  });

  it('uses channel timing offsets relatively, so equal offsets do not create false deskew', () => {
    const time = Array.from({ length: 100 }, (_, index) => index / 100);
    const waveform = time.map((value) => Math.sin(2 * Math.PI * 5 * value));
    const baseline = calculatePulsePower({
      time,
      voltage: waveform,
      currentTime: time,
      current: waveform,
      minimumCurrent: 0
    });
    const shifted = calculatePulsePower({
      time,
      voltage: waveform,
      currentTime: time,
      current: waveform,
      voltageTimingOffsetSeconds: 0.25,
      currentTimingOffsetSeconds: 0.25,
      minimumCurrent: 0
    });

    expect(shifted.metrics.energy.value).toBeCloseTo(baseline.metrics.energy.value || 0, 10);
  });

  it('anti-alias filters short mixed-rate records instead of silently bypassing them', () => {
    const voltageTime = Array.from({ length: 16 }, (_, index) => index / 1000);
    const currentTime = Array.from({ length: 61 }, (_, index) => index / 4000);
    const result = calculatePulsePower({
      time: voltageTime,
      voltage: voltageTime.map((time) => Math.sin(2 * Math.PI * 400 * time)),
      currentTime,
      current: currentTime.map((time) => Math.sin(2 * Math.PI * 600 * time)),
      minimumCurrent: 0
    });

    expect(result.warnings.join(' ')).toContain('anti-alias filtering');
    expect(result.metrics.energy.value).toBeNull();
  });

  it('does not bypass anti-alias filtering for very short mixed-rate records', () => {
    const voltageTime = Array.from({ length: 4 }, (_, index) => index / 1000);
    const currentTime = Array.from({ length: 13 }, (_, index) => index / 4000);
    const result = calculatePulsePower({
      time: voltageTime,
      voltage: voltageTime.map((time) => Math.sin(2 * Math.PI * 400 * time)),
      currentTime,
      current: currentTime.map((time) => Math.sin(2 * Math.PI * 600 * time)),
      minimumCurrent: 0
    });

    expect(result.warnings.join(' ')).toContain('anti-alias filtering');
    expect(result.metrics.energy.value).toBeNull();
  });

  it('contains a missing high-rate current sample instead of poisoning the full aligned record', () => {
    const voltageTime = Array.from({ length: 1001 }, (_, index) => index / 1000);
    const currentTime = Array.from({ length: 4001 }, (_, index) => index / 4000);
    const current = new Array<number>(currentTime.length).fill(1);
    current[2000] = Number.NaN;
    const result = calculatePulsePower({
      time: voltageTime,
      voltage: new Array<number>(voltageTime.length).fill(1),
      currentTime,
      current,
      minimumCurrent: 0
    });

    expect(result.metrics.peakCurrent.value).toBeCloseTo(1, 6);
    expect(result.metrics.energy.value).toBeGreaterThan(0.9);
    expect(result.warnings.join(' ')).not.toContain('1001 target sample(s) fall outside');
  });

  it('preserves valid near-Nyquist target-band energy during small-ratio resampling', () => {
    const voltageTime = Array.from({ length: 4000 }, (_, index) => index / 1000);
    const currentTime = Array.from({ length: 4204 }, (_, index) => index / 1051);
    const result = calculatePulsePower({
      time: voltageTime,
      voltage: voltageTime.map((time) => Math.sin(2 * Math.PI * 400 * time)),
      currentTime,
      current: currentTime.map((time) => Math.sin(2 * Math.PI * 400 * time)),
      minimumCurrent: 0
    });

    expect(result.metrics.energy.value).toBeCloseTo(2, 1);
  });

  it('preserves target-band energy on endpoint-inclusive mixed-rate grids', () => {
    const voltageTime = Array.from({ length: 4001 }, (_, index) => index / 1000);
    const currentTime = Array.from({ length: 4205 }, (_, index) => index / 1051);
    const result = calculatePulsePower({
      time: voltageTime,
      voltage: voltageTime.map((time) => Math.sin(2 * Math.PI * 400 * time)),
      currentTime,
      current: currentTime.map((time) => Math.sin(2 * Math.PI * 400 * time)),
      minimumCurrent: 0
    });

    expect(result.metrics.energy.value).toBeCloseTo(2, 1);
    expect(result.warnings.join(' ')).toContain('endpoint-inclusive');
  });

  it('avoids periodic Fourier boundary artifacts for endpoint-discontinuous ramps', () => {
    const voltageTime = Array.from({ length: 4001 }, (_, index) => index / 1000);
    const currentTime = Array.from({ length: 4205 }, (_, index) => index / 1051);
    const result = calculatePulsePower({
      time: voltageTime,
      voltage: new Array<number>(voltageTime.length).fill(1),
      currentTime,
      current: currentTime.map((time) => time / 4),
      minimumCurrent: 0
    });

    expect(result.metrics.maxDiDt.value).toBeCloseTo(0.25, 3);
    expect(result.warnings.join(' ')).not.toContain('endpoint-inclusive');
  });

  it('propagates clipped quality across the anti-alias filter neighborhood', () => {
    const voltageTime = Array.from({ length: 1001 }, (_, index) => index / 1000);
    const currentTime = Array.from({ length: 4001 }, (_, index) => index / 4000);
    const current = new Array<number>(currentTime.length).fill(1);
    const quality = new Uint16Array(currentTime.length);
    current[2000] = 9;
    quality[2000] = QualityFlag.Clipped;
    const result = calculatePulsePower({
      time: voltageTime,
      voltage: new Array<number>(voltageTime.length).fill(1),
      currentTime,
      current,
      currentQuality: quality,
      region: { i0: 501, i1: 501 },
      minimumCurrent: 0
    });

    expect(result.warnings.join(' ')).toContain('clipped quality flags');
  });
});
