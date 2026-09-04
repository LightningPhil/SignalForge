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

interface BaseUnit {
  symbol: string;
  dimension: Dimension;
  /** Whether SI prefixes may be attached (e.g. "kV"); dimensionless and compound units do not accept them. */
  prefixable: boolean;
}

/**
 * Base units keyed by their canonical, case-sensitive symbol. Spelled-out synonyms are matched
 * case-insensitively because words carry no prefix ambiguity.
 */
const BASE_UNITS: Record<string, BaseUnit> = {
  s: { symbol: 's', dimension: dimension(0, 0, 1, 0), prefixable: true },
  m: { symbol: 'm', dimension: dimension(0, 1, 0, 0), prefixable: true },
  V: { symbol: 'V', dimension: dimension(1, 2, -3, -1), prefixable: true },
  A: { symbol: 'A', dimension: dimension(0, 0, 0, 1), prefixable: true },
  W: { symbol: 'W', dimension: dimension(1, 2, -3, 0), prefixable: true },
  J: { symbol: 'J', dimension: dimension(1, 2, -2, 0), prefixable: true },
  C: { symbol: 'C', dimension: dimension(0, 0, 1, 1), prefixable: true },
  Ω: { symbol: 'Ω', dimension: dimension(1, 2, -3, -2), prefixable: true },
  Hz: { symbol: 'Hz', dimension: dimension(0, 0, -1, 0), prefixable: true },
  'A²·s': { symbol: 'A²·s', dimension: dimension(0, 0, 1, 2), prefixable: false },
  'V/s': { symbol: 'V/s', dimension: dimension(1, 2, -4, -1), prefixable: false },
  'A/s': { symbol: 'A/s', dimension: dimension(0, 0, -1, 1), prefixable: false },
  min: { symbol: 'min', dimension: dimension(0, 0, 1, 0), prefixable: false },
  h: { symbol: 'h', dimension: dimension(0, 0, 1, 0), prefixable: false }
};

const NON_SI_SCALES: Record<string, number> = { min: 60, h: 3600 };

/** Case-sensitive SI prefixes. `m` (milli) and `M` (mega) differ by nine orders of magnitude. */
const SI_PREFIXES: Record<string, number> = {
  f: 1e-15,
  p: 1e-12,
  n: 1e-9,
  µ: 1e-6,
  u: 1e-6,
  m: 1e-3,
  c: 1e-2,
  d: 1e-1,
  da: 1e1,
  h: 1e2,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12
};

const DIMENSIONLESS: UnitDefinition = { symbol: '', scale: 1, dimension: dimension() };

/** Alternate spellings that map onto a canonical symbol string (which is then parsed normally). */
const SYMBOL_ALIASES: Record<string, string> = {
  ω: 'Ω',
  A2s: 'A²·s',
  a2s: 'A²·s',
  'A2·s': 'A²·s',
  'A^2·s': 'A²·s',
  'A^2s': 'A²·s',
  'A²s': 'A²·s',
  'A2*s': 'A²·s',
  'A²*s': 'A²·s'
};

const WORD_SYNONYMS: Record<string, string> = {
  amp: 'A',
  amps: 'A',
  ampere: 'A',
  amperes: 'A',
  volt: 'V',
  volts: 'V',
  watt: 'W',
  watts: 'W',
  joule: 'J',
  joules: 'J',
  coulomb: 'C',
  coulombs: 'C',
  hertz: 'Hz',
  second: 's',
  seconds: 's',
  sec: 's',
  secs: 's',
  minute: 'min',
  minutes: 'min',
  hour: 'h',
  hours: 'h',
  metre: 'm',
  metres: 'm',
  meter: 'm',
  meters: 'm',
  millisecond: 'ms',
  milliseconds: 'ms',
  microsecond: 'µs',
  microseconds: 'µs',
  nanosecond: 'ns',
  nanoseconds: 'ns',
  millimeter: 'mm',
  millimeters: 'mm',
  millimetre: 'mm',
  millimetres: 'mm',
  kilovolt: 'kV',
  kilovolts: 'kV',
  millivolt: 'mV',
  millivolts: 'mV',
  kiloamp: 'kA',
  kiloamps: 'kA',
  milliamp: 'mA',
  milliamps: 'mA'
};

const WORD_UNIT_PATTERN = /^[a-z]{3,}$/i;

/**
 * Base symbols whose case must not be relaxed: `M` is not a unit (mega prefix only), `S` would be
 * siemens and `H` henry, neither of which SignalForge models.
 */
const CASE_STRICT_BASES = new Set(['M', 'S', 'H']);

function lookupBase(text: string): { key: string; base: BaseUnit } | null {
  const exact = BASE_UNITS[text];
  if (exact) return { key: text, base: exact };
  if (CASE_STRICT_BASES.has(text)) return null;
  // Base-unit letters carry no scale ambiguity ("kv" can only be kilovolt), so relax their case.
  const lowered = text.toLowerCase();
  for (const [key, base] of Object.entries(BASE_UNITS)) {
    if (key.toLowerCase() === lowered && key !== 'm') return { key, base };
  }
  return null;
}

const PREFIXES_LONGEST_FIRST = Object.keys(SI_PREFIXES).sort((left, right) => right.length - left.length);

function parseSymbol(symbol: string): UnitDefinition | null {
  const bare = lookupBase(symbol);
  if (bare) {
    return { symbol: bare.base.symbol, scale: NON_SI_SCALES[bare.key] ?? 1, dimension: { ...bare.base.dimension } };
  }
  // Prefixes stay case-sensitive; longest first so "da" is not read as deci + "a".
  for (const prefix of PREFIXES_LONGEST_FIRST) {
    if (!symbol.startsWith(prefix) || symbol.length === prefix.length) continue;
    const candidate = lookupBase(symbol.slice(prefix.length));
    if (!candidate || !candidate.base.prefixable) continue;
    return {
      symbol: `${prefix === 'u' ? 'µ' : prefix}${candidate.base.symbol}`,
      scale: SI_PREFIXES[prefix],
      dimension: { ...candidate.base.dimension }
    };
  }
  return null;
}

/**
 * Parses a unit symbol or spelled-out unit name. Symbols are matched case-sensitively so `mV`
 * (millivolt) and `MV` (megavolt) stay distinct; spelled-out words (`volts`, `milliseconds`) are
 * case-insensitive. Unknown text returns null rather than a guess.
 */
export function normalizeUnit(unitText: string | null | undefined): UnitDefinition | null {
  const trimmed = (unitText || '').trim().replace(/μ/g, 'µ').replace(/\s+/g, '');
  if (trimmed === '' || trimmed === '1') return { ...DIMENSIONLESS, dimension: { ...DIMENSIONLESS.dimension } };

  const aliased = SYMBOL_ALIASES[trimmed] ?? trimmed.replace(/ohms?$/i, 'Ω');
  const direct = parseSymbol(aliased);
  if (direct) return direct;

  if (WORD_UNIT_PATTERN.test(trimmed)) {
    const canonical = WORD_SYNONYMS[trimmed.toLowerCase()];
    if (canonical) return parseSymbol(canonical);
  }
  return null;
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
