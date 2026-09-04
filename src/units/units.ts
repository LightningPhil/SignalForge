export interface Dimension {
  mass: number;
  length: number;
  time: number;
  current: number;
}

export interface UnitDefinition {
  symbol: string;
  scale: number;
  dimension: Dimension;
}

const dimension = (mass = 0, length = 0, time = 0, current = 0): Dimension => ({
  mass,
  length,
  time,
  current
});

const UNIT_DEFINITIONS: Record<string, UnitDefinition> = {
  '': { symbol: '', scale: 1, dimension: dimension() },
  '1': { symbol: '', scale: 1, dimension: dimension() },
  s: { symbol: 's', scale: 1, dimension: dimension(0, 0, 1, 0) },
  ms: { symbol: 'ms', scale: 1e-3, dimension: dimension(0, 0, 1, 0) },
  us: { symbol: 'µs', scale: 1e-6, dimension: dimension(0, 0, 1, 0) },
  µs: { symbol: 'µs', scale: 1e-6, dimension: dimension(0, 0, 1, 0) },
  ns: { symbol: 'ns', scale: 1e-9, dimension: dimension(0, 0, 1, 0) },
  m: { symbol: 'm', scale: 1, dimension: dimension(0, 1, 0, 0) },
  cm: { symbol: 'cm', scale: 1e-2, dimension: dimension(0, 1, 0, 0) },
  mm: { symbol: 'mm', scale: 1e-3, dimension: dimension(0, 1, 0, 0) },
  v: { symbol: 'V', scale: 1, dimension: dimension(1, 2, -3, -1) },
  kv: { symbol: 'kV', scale: 1e3, dimension: dimension(1, 2, -3, -1) },
  mv: { symbol: 'mV', scale: 1e-3, dimension: dimension(1, 2, -3, -1) },
  a: { symbol: 'A', scale: 1, dimension: dimension(0, 0, 0, 1) },
  ka: { symbol: 'kA', scale: 1e3, dimension: dimension(0, 0, 0, 1) },
  ma: { symbol: 'mA', scale: 1e-3, dimension: dimension(0, 0, 0, 1) },
  w: { symbol: 'W', scale: 1, dimension: dimension(1, 2, -3, 0) },
  j: { symbol: 'J', scale: 1, dimension: dimension(1, 2, -2, 0) },
  c: { symbol: 'C', scale: 1, dimension: dimension(0, 0, 1, 1) },
  ohm: { symbol: 'Ω', scale: 1, dimension: dimension(1, 2, -3, -2) },
  ω: { symbol: 'Ω', scale: 1, dimension: dimension(1, 2, -3, -2) },
  hz: { symbol: 'Hz', scale: 1, dimension: dimension(0, 0, -1, 0) },
  a2s: { symbol: 'A²·s', scale: 1, dimension: dimension(0, 0, 1, 2) },
  'a²·s': { symbol: 'A²·s', scale: 1, dimension: dimension(0, 0, 1, 2) }
};

const UNIT_SYNONYMS: Record<string, string> = {
  amp: 'a',
  amps: 'a',
  ampere: 'a',
  amperes: 'a',
  volt: 'v',
  volts: 'v',
  second: 's',
  seconds: 's',
  sec: 's',
  metre: 'm',
  metres: 'm',
  meter: 'm',
  meters: 'm',
  millimeter: 'mm',
  millimeters: 'mm',
  millimetre: 'mm',
  millimetres: 'mm',
  ohms: 'ohm'
};

export function normalizeUnit(unitText: string | null | undefined): UnitDefinition | null {
  const normalized = (unitText || '').trim().replace(/μ/g, 'µ').toLowerCase();
  const key = UNIT_SYNONYMS[normalized] || normalized;
  const definition = UNIT_DEFINITIONS[key];
  return definition ? { ...definition, dimension: { ...definition.dimension } } : null;
}

export function unitFromLabel(label: string): UnitDefinition | null {
  const unitText = label.match(/(?:\(|\[)\s*([^\])]+)\s*(?:\)|\])\s*$/)?.[1];
  return unitText ? normalizeUnit(unitText) : null;
}

export function timeScaleToSeconds(labelOrUnit: string | null | undefined): number {
  const candidate = unitFromLabel(labelOrUnit || '') || normalizeUnit(labelOrUnit);
  const seconds = normalizeUnit('s');
  return candidate && seconds && dimensionsEqual(candidate.dimension, seconds.dimension) ? candidate.scale : 1;
}

export function isTimeUnit(labelOrUnit: string | null | undefined): boolean {
  const candidate = unitFromLabel(labelOrUnit || '') || normalizeUnit(labelOrUnit);
  const seconds = normalizeUnit('s');
  return Boolean(candidate && seconds && dimensionsEqual(candidate.dimension, seconds.dimension));
}

export function dimensionsEqual(left: Dimension, right: Dimension): boolean {
  return (
    left.mass === right.mass &&
    left.length === right.length &&
    left.time === right.time &&
    left.current === right.current
  );
}

export function multiplyDimensions(left: Dimension, right: Dimension): Dimension {
  return dimension(
    left.mass + right.mass,
    left.length + right.length,
    left.time + right.time,
    left.current + right.current
  );
}

export function divideDimensions(left: Dimension, right: Dimension): Dimension {
  return dimension(
    left.mass - right.mass,
    left.length - right.length,
    left.time - right.time,
    left.current - right.current
  );
}

export function convertToSi(value: number, unit: UnitDefinition): number {
  return value * unit.scale;
}

export function requireCompatibleUnits(left: UnitDefinition, right: UnitDefinition): void {
  if (!dimensionsEqual(left.dimension, right.dimension)) {
    throw new Error(`Incompatible units: ${left.symbol || 'dimensionless'} and ${right.symbol || 'dimensionless'}.`);
  }
}
