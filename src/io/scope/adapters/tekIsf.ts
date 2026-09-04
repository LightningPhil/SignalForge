import { CheckedReader, ScopeImportLimits, requireFinite, validateRecordShape } from '../limits';
import {
  ScopeImportError,
  throwIfCancelled,
  type ImportedWaveformRecord,
  type ScopeFormat,
  type ScopeImportFailureCode,
  type ScopeImportRequest
} from '../types';

const FORMAT: ScopeFormat = 'tektronix-isf';
const MAX_PREAMBLE_BYTES = ScopeImportLimits.maxMetadataStringBytes * 16;
const CANCELLATION_INTERVAL = 8_192;
const PROGRESS_INTERVAL = 65_536;

const FIELD_ALIASES = {
  BYT_NR: ['BYT_NR', 'BYT_N'],
  BIT_NR: ['BIT_NR', 'BIT_N'],
  ENCDG: ['ENCDG', 'ENC'],
  BN_FMT: ['BN_FMT', 'BN_F'],
  BYT_OR: ['BYT_OR', 'BYT_O'],
  NR_PT: ['NR_PT', 'NR_P'],
  WFID: ['WFID', 'WFI'],
  PT_FMT: ['PT_FMT', 'PT_F'],
  XUNIT: ['XUNIT', 'XUN'],
  XINCR: ['XINCR', 'XIN'],
  XZERO: ['XZERO', 'XZE'],
  PT_OFF: ['PT_OFF', 'PT_O'],
  YUNIT: ['YUNIT', 'YUN'],
  YMULT: ['YMULT', 'YMU'],
  YOFF: ['YOFF', 'YOF'],
  YZERO: ['YZERO', 'YZE']
} as const;

type CanonicalField = keyof typeof FIELD_ALIASES;
type PreambleFields = Map<string, string[]>;
type BinaryFormat = 'RI' | 'RP' | 'FP';
type ByteOrder = 'MSB' | 'LSB';
type EncodingKind = 'BIN' | 'RIBINARY' | 'RPBINARY' | 'SRIBINARY' | 'SRPBINARY' | 'FPBINARY' | 'SFPBINARY';
type SampleKind = 'i8' | 'i16' | 'i32' | 'u8' | 'u16' | 'u32' | 'f32' | 'f64';

interface CurveMarker {
  preambleEnd: number;
  hashOffset: number;
}

interface BinaryBlock {
  payloadStart: number;
  payloadLength: number;
}

interface EncodingDetails {
  format?: BinaryFormat;
  byteOrder?: ByteOrder;
}

interface NormalizedUnit {
  sourceUnit: string;
  unit: string;
  scale: number;
  recognized: boolean;
}

const KNOWN_KEYS = new Set<string>(Object.values(FIELD_ALIASES).flat());
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const UTF8_ENCODER = new TextEncoder();
const DECIMAL_NUMBER = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;
const DECIMAL_INTEGER = /^[+-]?\d+$/;

function fail(code: ScopeImportFailureCode, message: string, sourceName: string, cause?: unknown): never {
  throw new ScopeImportError(code, message, {
    format: FORMAT,
    fileNames: [sourceName],
    cause
  });
}

function report(request: ScopeImportRequest, progress: number, stage: string): void {
  request.onProgress?.(progress, stage);
  throwIfCancelled(request.signal);
}

function isAsciiWhitespace(value: number): boolean {
  return value === 0x09 || value === 0x0a || value === 0x0b || value === 0x0c || value === 0x0d || value === 0x20;
}

function matchesUpperAscii(bytes: Uint8Array, offset: number, expected: string): boolean {
  if (offset > bytes.length - expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    const actual = bytes[offset + index];
    const upper = expected.charCodeAt(index);
    if (actual !== upper && actual !== upper + 0x20) return false;
  }
  return true;
}

function findCurveMarker(bytes: Uint8Array, signal?: AbortSignal): CurveMarker | null {
  const searchEnd = Math.min(bytes.length, MAX_PREAMBLE_BYTES + 1);
  let inQuotes = false;

  for (let index = 0; index < searchEnd; index += 1) {
    if (index % CANCELLATION_INTERVAL === 0) throwIfCancelled(signal);
    const value = bytes[index];
    if (value === 0x22) {
      if (inQuotes && bytes[index + 1] === 0x22) {
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (inQuotes || value !== 0x3a || !matchesUpperAscii(bytes, index + 1, 'CURV')) continue;

    let cursor = index + 5;
    if (matchesUpperAscii(bytes, cursor, 'E')) cursor += 1;
    while (
      cursor < bytes.length &&
      cursor - index <= ScopeImportLimits.maxMetadataStringBytes &&
      isAsciiWhitespace(bytes[cursor])
    ) {
      if ((cursor - index) % CANCELLATION_INTERVAL === 0) throwIfCancelled(signal);
      cursor += 1;
    }
    if (bytes[cursor] === 0x23) {
      return { preambleEnd: index, hashOffset: cursor };
    }
  }
  return null;
}

function splitPreamble(text: string, sourceName: string): string[] {
  const tokens: string[] = [];
  let start = 0;
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '"') {
      if (inQuotes && text[index + 1] === '"') {
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (text[index] === ';' && !inQuotes) {
      tokens.push(text.slice(start, index));
      start = index + 1;
    }
  }
  if (inQuotes) fail('invalid-header', 'Tektronix ISF preamble contains an unterminated quoted value.', sourceName);
  tokens.push(text.slice(start));
  return tokens;
}

function unquote(value: string, sourceName: string): string {
  const trimmed = value.trim();
  const startsQuoted = trimmed.startsWith('"');
  const endsQuoted = trimmed.endsWith('"');
  if (startsQuoted !== endsQuoted || (startsQuoted && trimmed.length < 2)) {
    fail('invalid-header', 'Tektronix ISF preamble contains an unterminated quoted value.', sourceName);
  }
  return startsQuoted ? trimmed.slice(1, -1).replace(/""/g, '"') : trimmed;
}

function parsePreamble(raw: Uint8Array, sourceName: string): PreambleFields {
  let text: string;
  try {
    text = UTF8_DECODER.decode(raw);
  } catch (error) {
    fail('invalid-header', 'Tektronix ISF preamble is not valid text.', sourceName, error);
  }

  const fields: PreambleFields = new Map();
  for (const rawToken of splitPreamble(text, sourceName)) {
    const token = rawToken.trim().replace(/^:+/, '');
    if (!token) continue;

    const separator = token.search(/\s/);
    const rawKey = separator < 0 ? token : token.slice(0, separator);
    const key = rawKey.slice(rawKey.lastIndexOf(':') + 1).toUpperCase();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    if (separator < 0) {
      if (KNOWN_KEYS.has(key)) {
        fail('invalid-header', `Tektronix ISF field ${key} has no value.`, sourceName);
      }
      continue;
    }

    const value = unquote(token.slice(separator + 1), sourceName);
    if (UTF8_ENCODER.encode(value).byteLength > ScopeImportLimits.maxMetadataStringBytes) {
      fail('decode-budget-exceeded', `Tektronix ISF field ${key} exceeds the metadata string limit.`, sourceName);
    }
    if (!KNOWN_KEYS.has(key)) continue;
    const existing = fields.get(key);
    if (existing) existing.push(value);
    else fields.set(key, [value]);
  }
  return fields;
}

function rawFieldValues(fields: PreambleFields, field: CanonicalField): string[] {
  const values: string[] = [];
  for (const alias of FIELD_ALIASES[field]) {
    const matches = fields.get(alias);
    if (matches) values.push(...matches);
  }
  return values;
}

function parsedField<T>(
  fields: PreambleFields,
  field: CanonicalField,
  parser: (raw: string) => T,
  sourceName: string
): T | undefined {
  const values = rawFieldValues(fields, field);
  if (values.length === 0) return undefined;
  const first = parser(values[0]);
  for (let index = 1; index < values.length; index += 1) {
    const next = parser(values[index]);
    if (next !== first) {
      fail('invalid-header', `Tektronix ISF aliases for ${field} contain conflicting values.`, sourceName);
    }
  }
  return first;
}

function parseIntegerValue(raw: string, field: CanonicalField, sourceName: string): number {
  if (!DECIMAL_INTEGER.test(raw)) {
    fail('invalid-header', `Tektronix ISF field ${field} is not an integer.`, sourceName);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    fail('invalid-header', `Tektronix ISF field ${field} exceeds safe integer precision.`, sourceName);
  }
  return value;
}

function integerField(fields: PreambleFields, field: CanonicalField, sourceName: string, fallback?: number): number {
  const parsed = parsedField(fields, field, (raw) => parseIntegerValue(raw, field, sourceName), sourceName);
  if (parsed !== undefined) return parsed;
  if (fallback !== undefined) return fallback;
  fail('invalid-header', `Tektronix ISF preamble has no ${field} field.`, sourceName);
}

function optionalIntegerField(fields: PreambleFields, field: CanonicalField, sourceName: string): number | undefined {
  return parsedField(fields, field, (raw) => parseIntegerValue(raw, field, sourceName), sourceName);
}

function parseNumberValue(raw: string, field: CanonicalField, sourceName: string): number {
  if (!DECIMAL_NUMBER.test(raw)) {
    fail('invalid-header', `Tektronix ISF field ${field} is not numeric.`, sourceName);
  }
  return requireFinite(Number(raw), `Tektronix ISF field ${field}`, FORMAT);
}

function textField(fields: PreambleFields, field: CanonicalField, fallback: string, sourceName: string): string {
  return parsedField(fields, field, (raw) => raw, sourceName) ?? fallback;
}

function parseEncoding(raw: string, sourceName: string): EncodingKind {
  switch (raw.toUpperCase().replace(/[\s_-]/g, '')) {
    case 'BIN':
    case 'BINARY':
      return 'BIN';
    case 'RIB':
    case 'RIBINARY':
      return 'RIBINARY';
    case 'RPB':
    case 'RPBINARY':
      return 'RPBINARY';
    case 'SRI':
    case 'SRIB':
    case 'SRIBINARY':
      return 'SRIBINARY';
    case 'SRP':
    case 'SRPB':
    case 'SRPBINARY':
      return 'SRPBINARY';
    case 'FPB':
    case 'FPBINARY':
      return 'FPBINARY';
    case 'SFP':
    case 'SFPB':
    case 'SFPBINARY':
      return 'SFPBINARY';
    default:
      fail('unsupported-variant', `Unsupported Tektronix ISF encoding ${JSON.stringify(raw)}.`, sourceName);
  }
}

function encodingDetails(encoding: EncodingKind): EncodingDetails {
  switch (encoding) {
    case 'BIN':
      return {};
    case 'RIBINARY':
      return { format: 'RI', byteOrder: 'MSB' };
    case 'RPBINARY':
      return { format: 'RP', byteOrder: 'MSB' };
    case 'SRIBINARY':
      return { format: 'RI', byteOrder: 'LSB' };
    case 'SRPBINARY':
      return { format: 'RP', byteOrder: 'LSB' };
    case 'FPBINARY':
      return { format: 'FP', byteOrder: 'MSB' };
    case 'SFPBINARY':
      return { format: 'FP', byteOrder: 'LSB' };
  }
}

function parseBinaryFormat(raw: string, sourceName: string): BinaryFormat {
  switch (raw.toUpperCase().replace(/[\s_-]/g, '')) {
    case 'RI':
    case 'SIGNED':
    case 'SIGNEDINTEGER':
      return 'RI';
    case 'RP':
    case 'UNSIGNED':
    case 'UNSIGNEDINTEGER':
      return 'RP';
    case 'FP':
    case 'FLOAT':
    case 'FLOATINGPOINT':
      return 'FP';
    default:
      fail('unsupported-variant', `Unsupported Tektronix ISF binary format ${JSON.stringify(raw)}.`, sourceName);
  }
}

function parseByteOrder(raw: string, sourceName: string): ByteOrder {
  switch (raw.toUpperCase().replace(/[\s_-]/g, '')) {
    case 'MSB':
    case 'MSBFIRST':
    case 'BIG':
    case 'BIGENDIAN':
      return 'MSB';
    case 'LSB':
    case 'LSBFIRST':
    case 'LITTLE':
    case 'LITTLEENDIAN':
      return 'LSB';
    default:
      fail('unsupported-variant', `Unsupported Tektronix ISF byte order ${JSON.stringify(raw)}.`, sourceName);
  }
}

function sampleKind(format: BinaryFormat, bytesPerSample: number, sourceName: string): SampleKind {
  if (format === 'RI') {
    if (bytesPerSample === 1) return 'i8';
    if (bytesPerSample === 2) return 'i16';
    if (bytesPerSample === 4) return 'i32';
  } else if (format === 'RP') {
    if (bytesPerSample === 1) return 'u8';
    if (bytesPerSample === 2) return 'u16';
    if (bytesPerSample === 4) return 'u32';
  } else {
    if (bytesPerSample === 4) return 'f32';
    if (bytesPerSample === 8) return 'f64';
  }
  fail(
    'unsupported-variant',
    `Unsupported Tektronix ISF sample type ${format} with ${bytesPerSample} bytes per sample.`,
    sourceName
  );
}

function parseAsciiDecimal(bytes: Uint8Array, offset: number, length: number, sourceName: string): number {
  let value = 0;
  for (let index = 0; index < length; index += 1) {
    const byte = bytes[offset + index];
    if (byte < 0x30 || byte > 0x39) {
      fail('invalid-header', 'Tektronix ISF payload length is not numeric.', sourceName);
    }
    const digit = byte - 0x30;
    if (value > Math.floor((Number.MAX_SAFE_INTEGER - digit) / 10)) {
      fail('invalid-header', 'Tektronix ISF payload length exceeds safe integer precision.', sourceName);
    }
    value = value * 10 + digit;
  }
  return value;
}

function parseBinaryBlock(reader: CheckedReader, hashOffset: number, sourceName: string): BinaryBlock {
  reader.requireRange(hashOffset + 1, 1, 'Tektronix ISF binary-block digit count');
  const digitCountByte = reader.u8(hashOffset + 1, 'Tektronix ISF binary-block digit count');
  if (digitCountByte < 0x31 || digitCountByte > 0x39) {
    fail(
      'invalid-header',
      'Tektronix ISF binary-block digit count must be an ASCII digit from 1 through 9.',
      sourceName
    );
  }

  const digitCount = digitCountByte - 0x30;
  const lengthStart = reader.checkedSum([hashOffset, 2], 'Tektronix ISF binary-block length offset');
  reader.requireRange(lengthStart, digitCount, 'Tektronix ISF binary-block length');
  const payloadLength = parseAsciiDecimal(reader.bytes, lengthStart, digitCount, sourceName);
  const payloadStart = reader.checkedSum([lengthStart, digitCount], 'Tektronix ISF payload offset');
  return { payloadStart, payloadLength };
}

function cleanUnit(raw: string): string {
  let value = raw.slice(0, raw.indexOf('\0') >= 0 ? raw.indexOf('\0') : raw.length).trim();
  value = value.replace(/μ/g, 'µ');
  let changed = true;
  while (changed && value.length >= 2) {
    changed = false;
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '(' && last === ')') || (first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1).trim();
      changed = true;
    }
  }
  return value;
}

function prefixScale(prefix: string): number | undefined {
  if (!prefix) return 1;
  if (prefix === 'M') return 1e6;
  if (prefix.toUpperCase() === 'G') return 1e9;
  switch (prefix.toLowerCase()) {
    case 'p':
      return 1e-12;
    case 'n':
      return 1e-9;
    case 'u':
    case 'µ':
      return 1e-6;
    case 'm':
      return 1e-3;
    case 'k':
      return 1e3;
    default:
      return undefined;
  }
}

function normalizeSiUnit(raw: string): NormalizedUnit {
  const sourceUnit = cleanUnit(raw);
  if (!sourceUnit) return { sourceUnit, unit: '', scale: 1, recognized: true };

  const word = sourceUnit.toLowerCase();
  const wordUnits: Record<string, string> = {
    s: 's',
    sec: 's',
    second: 's',
    seconds: 's',
    v: 'V',
    volt: 'V',
    volts: 'V',
    a: 'A',
    amp: 'A',
    amps: 'A',
    ampere: 'A',
    amperes: 'A',
    hz: 'Hz',
    hertz: 'Hz',
    ohm: 'Ω',
    ohms: 'Ω',
    ω: 'Ω'
  };
  const wordUnit = wordUnits[word];
  if (wordUnit) return { sourceUnit, unit: wordUnit, scale: 1, recognized: true };

  const compact = sourceUnit.replace(/µ/g, 'u');
  const match = /^([pnumkMG]?)(s|v|a|hz|ohm|Ω)$/i.exec(compact);
  if (!match) return { sourceUnit, unit: sourceUnit, scale: 1, recognized: false };

  const scale = prefixScale(match[1]);
  if (scale === undefined) return { sourceUnit, unit: sourceUnit, scale: 1, recognized: false };
  const base = match[2].toLowerCase();
  const unit = base === 's' ? 's' : base === 'v' ? 'V' : base === 'a' ? 'A' : base === 'hz' ? 'Hz' : 'Ω';
  return { sourceUnit, unit, scale, recognized: true };
}

function validateTrailingBytes(bytes: Uint8Array, payloadEnd: number, sourceName: string, signal?: AbortSignal): void {
  for (let offset = payloadEnd; offset < bytes.length; offset += 1) {
    if ((offset - payloadEnd) % CANCELLATION_INTERVAL === 0) throwIfCancelled(signal);
    if (bytes[offset] !== 0x0d && bytes[offset] !== 0x0a) {
      fail('length-mismatch', 'Tektronix ISF contains non-CR/LF bytes after the declared binary payload.', sourceName);
    }
  }
}

function readRawSample(view: DataView, offset: number, kind: SampleKind, littleEndian: boolean): number {
  switch (kind) {
    case 'i8':
      return view.getInt8(offset);
    case 'i16':
      return view.getInt16(offset, littleEndian);
    case 'i32':
      return view.getInt32(offset, littleEndian);
    case 'u8':
      return view.getUint8(offset);
    case 'u16':
      return view.getUint16(offset, littleEndian);
    case 'u32':
      return view.getUint32(offset, littleEndian);
    case 'f32':
      return view.getFloat32(offset, littleEndian);
    case 'f64':
      return view.getFloat64(offset, littleEndian);
  }
}

function decode(request: ScopeImportRequest): ImportedWaveformRecord[] {
  const sourceName = request.primary.name;
  throwIfCancelled(request.signal);
  report(request, 0, 'Reading Tektronix ISF header');

  const reader = new CheckedReader(request.primary.bytes, FORMAT);
  const marker = findCurveMarker(reader.bytes, request.signal);
  if (!marker) {
    if (reader.bytes.length > MAX_PREAMBLE_BYTES) {
      fail(
        'decode-budget-exceeded',
        `Tektronix ISF preamble exceeds the ${MAX_PREAMBLE_BYTES}-byte limit.`,
        sourceName
      );
    }
    fail('invalid-header', 'Tektronix ISF file has no CURVE binary block.', sourceName);
  }
  if (marker.preambleEnd > MAX_PREAMBLE_BYTES) {
    fail('decode-budget-exceeded', `Tektronix ISF preamble exceeds the ${MAX_PREAMBLE_BYTES}-byte limit.`, sourceName);
  }

  const fields = parsePreamble(reader.bytes.subarray(0, marker.preambleEnd), sourceName);
  const block = parseBinaryBlock(reader, marker.hashOffset, sourceName);
  reader.requireRange(block.payloadStart, block.payloadLength, 'Tektronix ISF binary payload');
  const payloadEnd = reader.checkedSum([block.payloadStart, block.payloadLength], 'Tektronix ISF payload end');

  const bytesPerSample = integerField(fields, 'BYT_NR', sourceName);
  const bitCount = optionalIntegerField(fields, 'BIT_NR', sourceName);

  const encoding = parsedField(fields, 'ENCDG', (raw) => parseEncoding(raw, sourceName), sourceName) ?? 'BIN';
  const implied = encodingDetails(encoding);
  const binaryFormat =
    parsedField(fields, 'BN_FMT', (raw) => parseBinaryFormat(raw, sourceName), sourceName) ?? implied.format ?? 'RI';
  const byteOrder =
    parsedField(fields, 'BYT_OR', (raw) => parseByteOrder(raw, sourceName), sourceName) ?? implied.byteOrder ?? 'MSB';
  if (implied.format && implied.format !== binaryFormat) {
    fail(
      'invalid-header',
      `Tektronix ISF encoding ${encoding} conflicts with binary format ${binaryFormat}.`,
      sourceName
    );
  }
  if (implied.byteOrder && implied.byteOrder !== byteOrder) {
    fail('invalid-header', `Tektronix ISF encoding ${encoding} conflicts with byte order ${byteOrder}.`, sourceName);
  }

  const pointFormat = textField(fields, 'PT_FMT', 'Y', sourceName).trim().toUpperCase();
  if (pointFormat !== 'Y') {
    fail('unsupported-variant', `Unsupported Tektronix ISF point format ${JSON.stringify(pointFormat)}.`, sourceName);
  }

  const kind = sampleKind(binaryFormat, bytesPerSample, sourceName);
  if (bitCount !== undefined && bitCount !== bytesPerSample * 8) {
    fail('invalid-header', `Tektronix ISF BIT_NR ${bitCount} disagrees with BYT_NR ${bytesPerSample}.`, sourceName);
  }
  const sampleCount = integerField(fields, 'NR_PT', sourceName);
  validateRecordShape(sampleCount, 1, 0, FORMAT);
  const expectedPayloadLength = reader.checkedProduct(
    sampleCount,
    bytesPerSample,
    'Tektronix ISF expected payload length'
  );
  if (block.payloadLength !== expectedPayloadLength) {
    fail(
      'length-mismatch',
      `Tektronix ISF declares ${sampleCount} points at ${bytesPerSample} bytes each, but the binary block declares ${block.payloadLength} bytes.`,
      sourceName
    );
  }

  validateTrailingBytes(reader.bytes, payloadEnd, sourceName, request.signal);

  // XINCR and YMULT define the time and amplitude scales; defaulting them would fabricate a 1 s/sample
  // axis or raw-count volts, so they are required. The remaining calibration terms have well-defined
  // neutral defaults but every defaulted field is disclosed.
  const defaultedFields: string[] = [];
  const optionalNumber = (field: CanonicalField, fallback: number): number => {
    const parsed = parsedField(fields, field, (raw) => parseNumberValue(raw, field, sourceName), sourceName);
    if (parsed === undefined) defaultedFields.push(`${field}=${fallback}`);
    return parsed ?? fallback;
  };
  const optionalText = (field: CanonicalField, fallback: string): string => {
    const parsed = parsedField(fields, field, (raw) => raw, sourceName);
    if (parsed === undefined) defaultedFields.push(`${field}=${JSON.stringify(fallback)}`);
    return parsed ?? fallback;
  };
  const requiredNumber = (field: CanonicalField): number => {
    const parsed = parsedField(fields, field, (raw) => parseNumberValue(raw, field, sourceName), sourceName);
    if (parsed === undefined) fail('invalid-header', `Tektronix ISF preamble has no ${field} field.`, sourceName);
    return parsed;
  };
  const yMultiplier = requiredNumber('YMULT');
  const yOffset = optionalNumber('YOFF', 0);
  const yZero = optionalNumber('YZERO', 0);
  const xIncrement = requiredNumber('XINCR');
  const xZero = optionalNumber('XZERO', 0);
  const pointOffset = optionalNumber('PT_OFF', 0);

  const xUnit = normalizeSiUnit(optionalText('XUNIT', 's'));
  if (!xUnit.recognized || xUnit.unit !== 's') {
    fail(
      'unsupported-variant',
      `Tektronix ISF horizontal unit ${JSON.stringify(xUnit.sourceUnit)} is not a supported time unit.`,
      sourceName
    );
  }
  const yUnit = normalizeSiUnit(optionalText('YUNIT', 'V'));
  const sampleIntervalSeconds = requireFinite(xIncrement * xUnit.scale, 'Tektronix ISF sample interval', FORMAT);
  if (!(sampleIntervalSeconds > 0)) {
    fail('invalid-header', 'Tektronix ISF sample interval must be positive.', sourceName);
  }
  const xZeroSeconds = requireFinite(xZero * xUnit.scale, 'Tektronix ISF horizontal zero', FORMAT);
  const waveformId = textField(fields, 'WFID', '', sourceName);

  report(request, 0.2, 'Decoding Tektronix ISF samples');
  const timeSeconds = new Float64Array(sampleCount);
  const values = new Float64Array(sampleCount);
  const invalidMask = new Uint8Array(sampleCount);
  const littleEndian = byteOrder === 'LSB';

  for (let index = 0; index < sampleCount; index += 1) {
    if (index % CANCELLATION_INTERVAL === 0) throwIfCancelled(request.signal);
    if (index > 0 && index % PROGRESS_INTERVAL === 0) {
      report(request, 0.2 + (0.75 * index) / sampleCount, 'Decoding Tektronix ISF samples');
    }

    const raw = readRawSample(reader.view, block.payloadStart + index * bytesPerSample, kind, littleEndian);
    const sourceValue = (raw - yOffset) * yMultiplier + yZero;
    const convertedValue = sourceValue * yUnit.scale;
    if (Number.isFinite(raw)) {
      values[index] = requireFinite(convertedValue, `Tektronix ISF calibrated sample ${index}`, FORMAT);
    } else {
      values[index] = convertedValue;
      invalidMask[index] = 1;
    }

    const sourceTime = xZero + (index - pointOffset) * xIncrement;
    timeSeconds[index] = requireFinite(sourceTime * xUnit.scale, `Tektronix ISF time sample ${index}`, FORMAT);
  }

  throwIfCancelled(request.signal);
  report(request, 1, 'Tektronix ISF decode complete');
  const channelName = waveformId.split(',', 1)[0].trim() || 'Waveform';
  return [
    {
      sourceFormat: FORMAT,
      supportLevel: 'layout-tested',
      timeSeconds,
      channels: [
        {
          name: channelName,
          values,
          unit: yUnit.unit,
          sourceUnit: yUnit.sourceUnit,
          sourceToSiScale: yUnit.scale,
          invalidMask,
          calibrationSource: 'Tektronix ISF preamble: (raw - YOFF) * YMULT + YZERO, followed by SI unit scaling.'
        }
      ],
      frameIndex: 0,
      metadata: {
        bytes_per_sample: bytesPerSample,
        bit_count: bitCount ?? bytesPerSample * 8,
        binary_format: binaryFormat,
        byte_order: byteOrder,
        encoding,
        record_length: sampleCount,
        point_format: pointFormat,
        sample_interval_s: sampleIntervalSeconds,
        x_zero_s: xZeroSeconds,
        x_unit: xUnit.sourceUnit,
        x_to_si_scale: xUnit.scale,
        point_offset: pointOffset,
        y_multiplier: yMultiplier,
        y_offset: yOffset,
        y_zero: yZero,
        y_unit: yUnit.sourceUnit,
        y_si_unit: yUnit.unit,
        y_to_si_scale: yUnit.scale,
        waveform_id: waveformId
      },
      warnings:
        defaultedFields.length > 0
          ? [`Tektronix ISF preamble omitted ${defaultedFields.join(', ')}; the neutral default was used.`]
          : []
    }
  ];
}

export function decodeTekIsf(request: ScopeImportRequest): ImportedWaveformRecord[] {
  try {
    return decode(request);
  } catch (error) {
    if (error instanceof ScopeImportError && (error.format !== FORMAT || error.fileNames.length === 0)) {
      throw new ScopeImportError(error.code, error.message, {
        format: FORMAT,
        fileNames: error.fileNames.length > 0 ? error.fileNames : [request.primary.name],
        cause: error
      });
    }
    throw error;
  }
}
