import { convertToSi, dimensionsEqual, normalizeUnit } from '../units/units';

export type FilenameFieldType = 'int' | 'number' | 'text' | 'quantity';

export interface FilenameProfileField {
  name: string;
  type: FilenameFieldType;
  expectedUnit?: string;
}

export interface CompiledFilenameProfile {
  source: string;
  regex: RegExp;
  fields: Array<FilenameProfileField & { valueGroup: number; unitGroup?: number }>;
}

export interface ExtractedFilenameField {
  name: string;
  type: FilenameFieldType;
  raw: string;
  value: string | number;
  unit: string | null;
  valueSi: number | null;
}

export interface FilenameMatch {
  filename: string;
  matched: boolean;
  fields: Record<string, ExtractedFilenameField>;
  warnings: string[];
}

const NUMBER_SOURCE = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compileFilenameProfile(profile: string): CompiledFilenameProfile {
  const token = /\{([A-Za-z_][A-Za-z0-9_]*):([^}]+)\}/g;
  const fields: CompiledFilenameProfile['fields'] = [];
  const names = new Set<string>();
  let expression = '^';
  let cursor = 0;
  let captureGroup = 0;
  let match: RegExpExecArray | null;

  while ((match = token.exec(profile))) {
    expression += escapeRegExp(profile.slice(cursor, match.index)).replace(/\s+/g, '\\s+');
    const name = match[1];
    const specification = match[2].trim();
    if (names.has(name)) throw new Error(`Filename field "${name}" is duplicated.`);
    names.add(name);

    if (specification === 'int') {
      expression += '([+-]?\\d+)';
      captureGroup += 1;
      fields.push({ name, type: 'int', valueGroup: captureGroup });
    } else if (specification === 'number') {
      expression += `(${NUMBER_SOURCE})`;
      captureGroup += 1;
      fields.push({ name, type: 'number', valueGroup: captureGroup });
    } else if (specification === 'text') {
      expression += '(.+?)';
      captureGroup += 1;
      fields.push({ name, type: 'text', valueGroup: captureGroup });
    } else {
      const quantity = specification.match(/^quantity\[([^\]]+)\]$/i);
      if (!quantity) throw new Error(`Unsupported filename field type "${specification}".`);
      if (!normalizeUnit(quantity[1])) throw new Error(`Unknown expected unit "${quantity[1]}".`);
      expression += `(${NUMBER_SOURCE})\\s*([A-Za-zµμΩω²·]+)`;
      captureGroup += 2;
      fields.push({
        name,
        type: 'quantity',
        expectedUnit: quantity[1],
        valueGroup: captureGroup - 1,
        unitGroup: captureGroup
      });
    }
    cursor = match.index + match[0].length;
  }

  if (fields.length === 0) throw new Error('Filename profile must contain at least one field.');
  expression += `${escapeRegExp(profile.slice(cursor)).replace(/\s+/g, '\\s+')}$`;
  return { source: profile, regex: new RegExp(expression, 'i'), fields };
}

type FieldParse = { field: ExtractedFilenameField; warning?: undefined } | { field?: undefined; warning: string };

/** Parses one captured field value (and unit text for quantities) with the same rules the matcher uses. */
function parseFieldValue(field: FilenameProfileField, raw: string, unitText: string): FieldParse {
  if (field.type === 'text') {
    if (raw.trim() === '') return { warning: `Field "${field.name}" must not be empty.` };
    return { field: { name: field.name, type: field.type, raw, value: raw, unit: null, valueSi: null } };
  }
  const numericValue = Number(raw);
  if (
    raw.trim() === '' ||
    !Number.isFinite(numericValue) ||
    (field.type === 'int' && !Number.isInteger(numericValue))
  ) {
    return { warning: `Field "${field.name}" is not a valid ${field.type}.` };
  }
  if (field.type !== 'quantity') {
    return {
      field: { name: field.name, type: field.type, raw, value: numericValue, unit: null, valueSi: numericValue }
    };
  }
  const actualUnit = normalizeUnit(unitText);
  const expectedUnit = normalizeUnit(field.expectedUnit);
  if (!actualUnit || !expectedUnit) {
    return { warning: `Field "${field.name}" contains an unknown unit "${unitText}".` };
  }
  if (!dimensionsEqual(actualUnit.dimension, expectedUnit.dimension)) {
    return { warning: `Field "${field.name}" unit "${unitText}" is incompatible with "${field.expectedUnit}".` };
  }
  return {
    field: {
      name: field.name,
      type: field.type,
      raw: `${raw}${unitText}`,
      value: numericValue,
      unit: actualUnit.symbol,
      valueSi: convertToSi(numericValue, actualUnit)
    }
  };
}

const CORRECTION_QUANTITY = new RegExp(`^(${NUMBER_SOURCE})\\s*([A-Za-zµμΩω²·]+)$`);

/**
 * Re-parses a manual preview correction with the field's own rules, so a corrected "25 kV" becomes
 * the SI number 25000 exactly like an extracted one, and an unparsable correction is reported instead
 * of being stored as free text.
 */
export function parseFieldCorrection(field: FilenameProfileField, text: string): FieldParse {
  const trimmed = text.trim();
  if (field.type !== 'quantity') return parseFieldValue(field, trimmed, '');
  const match = CORRECTION_QUANTITY.exec(trimmed);
  if (!match) {
    return {
      warning: `Field "${field.name}" must be a number followed by a unit compatible with "${field.expectedUnit}".`
    };
  }
  return parseFieldValue(field, match[1], match[2]);
}

export function matchFilename(profile: CompiledFilenameProfile, filename: string): FilenameMatch {
  const match = profile.regex.exec(filename);
  if (!match) return { filename, matched: false, fields: {}, warnings: ['Filename does not match the profile.'] };
  const fields: Record<string, ExtractedFilenameField> = {};
  const warnings: string[] = [];

  for (const field of profile.fields) {
    const raw = match[field.valueGroup] || '';
    const unitText = field.unitGroup ? match[field.unitGroup] || '' : '';
    const parsed = parseFieldValue(field, raw, unitText);
    if (parsed.field) fields[field.name] = parsed.field;
    else warnings.push(parsed.warning);
  }

  return { filename, matched: true, fields, warnings };
}

export function groupFilenameMatches(matches: FilenameMatch[], fieldNames: string[]): Map<string, FilenameMatch[]> {
  const grouped = new Map<string, FilenameMatch[]>();
  for (const match of matches) {
    if (!match.matched) continue;
    const values = fieldNames.map((fieldName) => match.fields[fieldName]?.valueSi ?? match.fields[fieldName]?.value);
    if (values.some((value) => value === undefined)) continue;
    const key = JSON.stringify(values);
    const group = grouped.get(key) || [];
    group.push(match);
    grouped.set(key, group);
  }
  return grouped;
}

export function compileExpertFilenameRegex(source: string, flags = 'i'): RegExp {
  if (source.length > 500) throw new Error('Expert filename expression exceeds the 500-character safety limit.');
  if (/(\([^)]*[+*][^)]*\))[+*{]/.test(source) || /(\.\*){2,}|(\.\+){2,}/.test(source)) {
    throw new Error('Expert filename expression contains nested or repeated unbounded quantifiers.');
  }
  return new RegExp(source, flags.replace(/[^gimsuy]/g, ''));
}
