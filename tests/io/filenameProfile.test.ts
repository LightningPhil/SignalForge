import { describe, expect, it } from 'vitest';
import {
  compileExpertFilenameRegex,
  compileFilenameProfile,
  groupFilenameMatches,
  matchFilename
} from '../../src/io/filenameProfile';

describe('filename convention profiles', () => {
  const profile = compileFilenameProfile(
    'shot {shot:int} - {charge_voltage:quantity[V]} - {length:quantity[mm]} - {channel:text}.csv'
  );

  it('extracts and SI-normalizes quantities while preserving raw filename text', () => {
    const result = matchFilename(profile, 'shot 17 - 25kV - 200 millimeters - Current.csv');

    expect(result.matched).toBe(true);
    expect(result.filename).toBe('shot 17 - 25kV - 200 millimeters - Current.csv');
    expect(result.fields.shot.value).toBe(17);
    expect(result.fields.charge_voltage.valueSi).toBe(25_000);
    expect(result.fields.length.valueSi).toBe(0.2);
    expect(result.fields.channel.value).toBe('Current');
  });

  it('accepts unit synonyms', () => {
    const simple = compileFilenameProfile('shot {shot:int} - {voltage:quantity[V]}');
    const result = matchFilename(simple, 'shot 2 - 300 volts');

    expect(result.fields.voltage.unit).toBe('V');
    expect(result.fields.voltage.valueSi).toBe(300);
  });

  it('groups separate channel files belonging to the same shot', () => {
    const matches = [
      matchFilename(profile, 'shot 17 - 25kV - 200mm - Voltage.csv'),
      matchFilename(profile, 'shot 17 - 25kV - 200mm - Current.csv'),
      matchFilename(profile, 'shot 18 - 30kV - 200mm - Voltage.csv')
    ];
    const groups = groupFilenameMatches(matches, ['shot']);

    expect(groups.size).toBe(2);
    expect([...groups.values()].map((group) => group.length).sort()).toEqual([1, 2]);
  });

  it('rejects simple catastrophic expert-regex shapes', () => {
    expect(() => compileExpertFilenameRegex('(.*)*')).toThrow(/quantifiers/);
  });
});
