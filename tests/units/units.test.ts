import { describe, expect, it } from 'vitest';
import { isTimeUnit, normalizeUnit, timeScaleToSeconds, unitFromLabel } from '../../src/units/units';

describe('unit parsing', () => {
  it('distinguishes milli from mega prefixes case-sensitively', () => {
    expect(normalizeUnit('mV')).toMatchObject({ symbol: 'mV', scale: 1e-3 });
    expect(normalizeUnit('MV')).toMatchObject({ symbol: 'MV', scale: 1e6 });
    expect(normalizeUnit('mA')).toMatchObject({ symbol: 'mA', scale: 1e-3 });
    expect(normalizeUnit('MA')).toMatchObject({ symbol: 'MA', scale: 1e6 });
    expect(normalizeUnit('ms')).toMatchObject({ symbol: 'ms', scale: 1e-3 });
    expect(normalizeUnit('Ms')).toMatchObject({ symbol: 'Ms', scale: 1e6 });
    expect(timeScaleToSeconds('Time (Ms)')).toBe(1e6);
    expect(timeScaleToSeconds('Time (ms)')).toBe(1e-3);
  });

  it('parses the full SI prefix range for the supported base units', () => {
    expect(normalizeUnit('uA')).toMatchObject({ symbol: 'µA', scale: 1e-6 });
    expect(normalizeUnit('µV')).toMatchObject({ symbol: 'µV', scale: 1e-6 });
    expect(normalizeUnit('μs')).toMatchObject({ symbol: 'µs', scale: 1e-6 });
    expect(normalizeUnit('ns')).toMatchObject({ symbol: 'ns', scale: 1e-9 });
    expect(normalizeUnit('ps')).toMatchObject({ symbol: 'ps', scale: 1e-12 });
    expect(normalizeUnit('kHz')).toMatchObject({ symbol: 'kHz', scale: 1e3 });
    expect(normalizeUnit('MHz')).toMatchObject({ symbol: 'MHz', scale: 1e6 });
    expect(normalizeUnit('kW')).toMatchObject({ symbol: 'kW', scale: 1e3 });
    expect(normalizeUnit('mJ')).toMatchObject({ symbol: 'mJ', scale: 1e-3 });
    expect(normalizeUnit('mΩ')).toMatchObject({ symbol: 'mΩ', scale: 1e-3 });
    expect(normalizeUnit('kohm')).toMatchObject({ symbol: 'kΩ', scale: 1e3 });
    expect(normalizeUnit('ohm')).toMatchObject({ symbol: 'Ω', scale: 1 });
    expect(normalizeUnit('min')).toMatchObject({ symbol: 'min', scale: 60 });
    expect(normalizeUnit('V/s')).toMatchObject({ symbol: 'V/s', scale: 1 });
    expect(normalizeUnit('A²·s')).toMatchObject({ symbol: 'A²·s', scale: 1 });
  });

  it('relaxes case only where it is unambiguous', () => {
    // Base-unit letters carry no scale, so "kv" can only mean kilovolt.
    expect(normalizeUnit('kv')).toMatchObject({ symbol: 'kV', scale: 1e3 });
    expect(normalizeUnit('v')).toMatchObject({ symbol: 'V', scale: 1 });
    expect(normalizeUnit('hz')).toMatchObject({ symbol: 'Hz', scale: 1 });
    expect(normalizeUnit('Volts')).toMatchObject({ symbol: 'V', scale: 1 });
    expect(normalizeUnit('MILLISECONDS')).toMatchObject({ symbol: 'ms', scale: 1e-3 });
    // Prefix letters are never relaxed and unsupported symbols stay unknown.
    expect(normalizeUnit('KV')).toBeNull();
    expect(normalizeUnit('S')).toBeNull();
    expect(normalizeUnit('M')).toBeNull();
    expect(normalizeUnit('furlong')).toBeNull();
  });

  it('extracts units from column labels and recognises time dimensions', () => {
    expect(unitFromLabel('Voltage (kV)')).toMatchObject({ symbol: 'kV', scale: 1e3 });
    expect(unitFromLabel('Time [µs]')).toMatchObject({ symbol: 'µs', scale: 1e-6 });
    expect(isTimeUnit('Time (ns)')).toBe(true);
    expect(isTimeUnit('Time (Hz)')).toBe(false);
    expect(isTimeUnit('Time (min)')).toBe(true);
    expect(timeScaleToSeconds('Time (min)')).toBe(60);
    // Unknown units never silently scale.
    expect(timeScaleToSeconds('Time (ticks)')).toBe(1);
    expect(isTimeUnit('Time (ticks)')).toBe(false);
  });
});
