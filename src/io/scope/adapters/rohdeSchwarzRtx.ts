import type { ImportSource } from '../../adapters/types';
import { CheckedReader, ScopeImportLimits, requireFinite, validateRecordShape } from '../limits';
import {
  ScopeImportError,
  throwIfCancelled,
  type ImportedScopeChannel,
  type ImportedWaveformRecord,
  type ScopeFormat,
  type ScopeImportFailureCode,
  type ScopeImportRequest,
  type ScopeSupportLevel
} from '../types';

const FORMAT: ScopeFormat = 'rohde-schwarz-rtx-bin';
const SOURCE_PREFIX = 'eRS_SIGNAL_SOURCE_';
const XINCLUDE_NAMESPACE = 'http://www.w3.org/2001/XInclude';

const MAX_XML_DEPTH = 64;
const MAX_XML_ELEMENTS = 4096;
const MAX_XML_ATTRIBUTES = 32_768;
const MAX_XML_INDEXED_PROPERTIES = 2048;
const MAX_XML_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_XML_TAG_CHARACTERS = 256 * 1024;
const MAX_XML_ARRAY_INDEX = 64;
const XML_CANCELLATION_INTERVAL = 64 * 1024;
const DECODE_CANCELLATION_INTERVAL = 16 * 1024;

type SampleKind = 'int8' | 'int16' | 'float32' | 'xy-double-float';
type XmlAttributes = ReadonlyMap<string, string>;

interface SignalFormatDescriptor {
  code: number;
  bytesPerValue: number;
  kind: SampleKind;
  supportLevel: ScopeSupportLevel;
}

interface ExtractedXml {
  rootAttributes: XmlAttributes;
  properties: ReadonlyMap<string, XmlAttributes>;
  duplicateProperties: ReadonlySet<string>;
}

interface ParsedStartTag {
  name: string;
  attributes: Map<string, string>;
}

interface ActiveSource {
  source: string;
  channelNumber: number;
  xmlIndex: string | null;
}

interface ParsedDescription {
  signalFormat: string;
  signalDescriptor: SignalFormatDescriptor;
  hardwareRecordLength: number;
  recordLength: number;
  leadingSamples: number;
  xStart: number;
  xStop: number;
  xIncrement: number;
  sources: ActiveSource[];
  firmwareVersion: string;
  multiChannel: boolean;
}

interface IntegerScale {
  factor: number;
  offset: number;
}

interface PayloadLayout {
  rowBytes: number;
  expectedBodyBytes: number;
}

interface DecodedPayload {
  timeSeconds: Float64Array;
  values: Float64Array[];
  invalidMasks: Array<Uint8Array | undefined>;
  invalidValueCount: number;
}

const SIGNAL_FORMATS: Readonly<Record<string, SignalFormatDescriptor>> = {
  eRS_SIGNAL_FORMAT_INT8BIT: {
    code: 0,
    bytesPerValue: 1,
    kind: 'int8',
    supportLevel: 'verified'
  },
  eRS_SIGNAL_FORMAT_INT16BIT: {
    code: 1,
    bytesPerValue: 2,
    kind: 'int16',
    supportLevel: 'layout-tested'
  },
  eRS_SIGNAL_FORMAT_FLOAT: {
    code: 4,
    bytesPerValue: 4,
    kind: 'float32',
    supportLevel: 'verified'
  },
  eRS_SIGNAL_FORMAT_XYDOUBLEFLOAT: {
    code: 6,
    bytesPerValue: 4,
    kind: 'xy-double-float',
    supportLevel: 'verified'
  }
};

const RETAINED_PROPERTY_NAMES: ReadonlySet<string> = new Set([
  'BaseUnit',
  'BaseUnitRelative',
  'LeadingSettlingSamples',
  'MultiChannelExport',
  'MultiChannelExportState',
  'MultiChannelSource',
  'MultiChannelVerticalOffset',
  'MultiChannelVerticalPosition',
  'MultiChannelVerticalScale',
  'MultiChannelViewUnit',
  'NofQuantisationLevels',
  'NumberOfAcquisitions',
  'RecordLength',
  'SignalFormat',
  'SignalHardwareRecordLength',
  'Source',
  'SourceType',
  'TraceType',
  'VerticalOffset',
  'VerticalPosition',
  'VerticalScale',
  'ViewUnit',
  'ViewUnitRelative',
  'XStart',
  'XStop'
]);

const DECIMAL_NUMBER = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;
const DECIMAL_INTEGER = /^[+-]?\d+$/;
const XML_TEXT_ENCODER = new TextEncoder();

function rsError(
  code: ScopeImportFailureCode,
  message: string,
  fileNames: string[],
  cause?: unknown
): ScopeImportError {
  return new ScopeImportError(code, message, {
    format: FORMAT,
    fileNames,
    ...(cause === undefined ? {} : { cause })
  });
}

function reportProgress(request: ScopeImportRequest, progress: number, stage: string): void {
  throwIfCancelled(request.signal);
  request.onProgress?.(progress, stage);
  throwIfCancelled(request.signal);
}

function requireBoundedString(value: string, context: string, fileNames: string[]): void {
  if (
    value.length > ScopeImportLimits.maxMetadataStringBytes ||
    XML_TEXT_ENCODER.encode(value).byteLength > ScopeImportLimits.maxMetadataStringBytes
  ) {
    throw rsError(
      'decode-budget-exceeded',
      `${context} exceeds the ${ScopeImportLimits.maxMetadataStringBytes}-byte metadata string limit.`,
      fileNames
    );
  }
}

function expectedCompanionName(primaryName: string): string {
  if (!/\.bin$/i.test(primaryName) || /\.wfm\.bin$/i.test(primaryName)) {
    throw rsError('invalid-header', 'The R&S waveform description must be a .bin file, not a .Wfm.bin payload.', [
      primaryName
    ]);
  }
  return `${primaryName.slice(0, -4)}.Wfm.bin`;
}

function requireCompanion(request: ScopeImportRequest): ImportSource {
  const expected = expectedCompanionName(request.primary.name);
  const companions = request.companions ?? [];
  if (companions.length > ScopeImportLimits.maxRecords) {
    throw rsError(
      'decode-budget-exceeded',
      `R&S pairing received ${companions.length} companion candidates; the limit is ${ScopeImportLimits.maxRecords}.`,
      [request.primary.name]
    );
  }
  const expectedLower = expected.toLowerCase();
  const matches: ImportSource[] = [];
  for (const candidate of companions) {
    requireBoundedString(candidate.name, 'Companion candidate file name', [request.primary.name]);
    if (candidate.name.toLowerCase() === expectedLower) matches.push(candidate);
  }

  if (matches.length === 0) {
    throw rsError(
      'missing-companion',
      `${request.primary.name} requires exactly one case-paired companion named ${expected}.`,
      [request.primary.name]
    );
  }
  if (matches.length > 1) {
    throw rsError(
      'ambiguous-companion',
      `${request.primary.name} has ${matches.length} case-equivalent companions named ${expected}.`,
      [request.primary.name, ...matches.map((match) => match.name)]
    );
  }
  return matches[0];
}

function requireFileBudget(source: ImportSource, fileNames: string[]): void {
  if (source.bytes.byteLength > ScopeImportLimits.maxFileBytes) {
    throw rsError(
      'decode-budget-exceeded',
      `${source.name} is ${source.bytes.byteLength} bytes; the per-file limit is ${ScopeImportLimits.maxFileBytes} bytes.`,
      fileNames
    );
  }
}

class XmlBudget {
  private nextCancellationCheck = 0;
  private elementCount = 0;
  private attributeCount = 0;
  private indexedPropertyCount = 0;
  private metadataBytes = 0;
  private readonly signal: AbortSignal | undefined;
  private readonly fileNames: string[];

  constructor(signal: AbortSignal | undefined, fileNames: string[]) {
    this.signal = signal;
    this.fileNames = fileNames;
  }

  checkCancellation(position: number): void {
    if (position >= this.nextCancellationCheck) {
      throwIfCancelled(this.signal);
      this.nextCancellationCheck = position + XML_CANCELLATION_INTERVAL;
    }
  }

  addElement(name: string, depth: number): void {
    this.elementCount += 1;
    if (this.elementCount > MAX_XML_ELEMENTS) {
      throw rsError('decode-budget-exceeded', `R&S XML exceeds the ${MAX_XML_ELEMENTS}-element limit.`, this.fileNames);
    }
    if (depth > MAX_XML_DEPTH) {
      throw rsError(
        'decode-budget-exceeded',
        `R&S XML exceeds the maximum element depth of ${MAX_XML_DEPTH}.`,
        this.fileNames
      );
    }
    this.addMetadataString(name, 'XML element name');
  }

  addAttribute(name: string, value: string): void {
    this.attributeCount += 1;
    if (this.attributeCount > MAX_XML_ATTRIBUTES) {
      throw rsError(
        'decode-budget-exceeded',
        `R&S XML exceeds the ${MAX_XML_ATTRIBUTES}-attribute limit.`,
        this.fileNames
      );
    }
    this.addMetadataString(name, 'XML attribute name');
    if (name === 'Name') {
      this.addMetadataString(value, 'XML Name attribute');
    }
  }

  retainAttributes(attributes: XmlAttributes, context: string): void {
    for (const [name, value] of attributes) {
      this.addMetadataString(name, `${context} attribute name`);
      this.addMetadataString(value, `${context}.${name}`);
    }
  }

  addIndexedProperty(): void {
    this.indexedPropertyCount += 1;
    if (this.indexedPropertyCount > MAX_XML_INDEXED_PROPERTIES) {
      throw rsError(
        'decode-budget-exceeded',
        `R&S XML exceeds the ${MAX_XML_INDEXED_PROPERTIES}-property metadata limit.`,
        this.fileNames
      );
    }
  }

  private addMetadataString(value: string, context: string): void {
    if (value.length > ScopeImportLimits.maxMetadataStringBytes) {
      throw rsError(
        'decode-budget-exceeded',
        `${context} exceeds the ${ScopeImportLimits.maxMetadataStringBytes}-byte string limit.`,
        this.fileNames
      );
    }
    const byteLength = XML_TEXT_ENCODER.encode(value).byteLength;
    if (byteLength > ScopeImportLimits.maxMetadataStringBytes) {
      throw rsError(
        'decode-budget-exceeded',
        `${context} exceeds the ${ScopeImportLimits.maxMetadataStringBytes}-byte string limit.`,
        this.fileNames
      );
    }
    this.metadataBytes += byteLength;
    if (this.metadataBytes > MAX_XML_METADATA_BYTES) {
      throw rsError(
        'decode-budget-exceeded',
        `R&S XML metadata exceeds the ${MAX_XML_METADATA_BYTES}-byte aggregate limit.`,
        this.fileNames
      );
    }
  }
}

function isXmlWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function isXmlNameStart(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f || code === 0x3a;
}

function isXmlNameCharacter(code: number): boolean {
  return isXmlNameStart(code) || (code >= 0x30 && code <= 0x39) || code === 0x2d || code === 0x2e;
}

function isValidXmlCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0d ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

function decodeXmlAttributeValue(raw: string, fileNames: string[]): string {
  if (!raw.includes('&')) return raw;

  let result = '';
  let cursor = 0;
  while (cursor < raw.length) {
    const ampersand = raw.indexOf('&', cursor);
    if (ampersand < 0) {
      result += raw.slice(cursor);
      break;
    }
    result += raw.slice(cursor, ampersand);
    const semicolon = raw.indexOf(';', ampersand + 1);
    if (semicolon < 0 || semicolon - ampersand > 32) {
      throw rsError('invalid-header', 'R&S XML contains a malformed entity reference.', fileNames);
    }
    const entity = raw.slice(ampersand + 1, semicolon);
    const predefined: Readonly<Record<string, string>> = {
      amp: '&',
      apos: "'",
      gt: '>',
      lt: '<',
      quot: '"'
    };
    const predefinedValue = predefined[entity];
    if (predefinedValue !== undefined) {
      result += predefinedValue;
    } else {
      const hexadecimal = /^#x([0-9a-f]+)$/i.exec(entity);
      const decimal = /^#([0-9]+)$/.exec(entity);
      const digits = hexadecimal?.[1] ?? decimal?.[1];
      if (digits === undefined) {
        throw rsError(
          'invalid-header',
          'R&S XML uses a non-predefined entity; DTD/entity expansion is not supported.',
          fileNames
        );
      }
      const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
      if (!Number.isSafeInteger(codePoint) || !isValidXmlCodePoint(codePoint)) {
        throw rsError('invalid-header', 'R&S XML contains an invalid numeric character reference.', fileNames);
      }
      result += String.fromCodePoint(codePoint);
    }
    cursor = semicolon + 1;
  }
  return result;
}

function parseStartTag(markup: string, absoluteOffset: number, budget: XmlBudget, fileNames: string[]): ParsedStartTag {
  if (markup.length > MAX_XML_TAG_CHARACTERS) {
    throw rsError(
      'decode-budget-exceeded',
      `R&S XML contains a tag longer than ${MAX_XML_TAG_CHARACTERS} characters.`,
      fileNames
    );
  }

  let cursor = 0;
  const skipWhitespace = (): void => {
    while (cursor < markup.length && isXmlWhitespace(markup.charCodeAt(cursor))) {
      cursor += 1;
      budget.checkCancellation(absoluteOffset + cursor);
    }
  };
  const readName = (context: string): string => {
    if (cursor >= markup.length || !isXmlNameStart(markup.charCodeAt(cursor))) {
      throw rsError('invalid-header', `R&S XML contains an invalid ${context}.`, fileNames);
    }
    const start = cursor;
    cursor += 1;
    while (cursor < markup.length && isXmlNameCharacter(markup.charCodeAt(cursor))) {
      cursor += 1;
      budget.checkCancellation(absoluteOffset + cursor);
    }
    return markup.slice(start, cursor);
  };

  skipWhitespace();
  const name = readName('element name');
  if (cursor < markup.length && !isXmlWhitespace(markup.charCodeAt(cursor))) {
    throw rsError('invalid-header', `R&S XML element ${name} has malformed attributes.`, fileNames);
  }

  const attributes = new Map<string, string>();
  while (cursor < markup.length) {
    skipWhitespace();
    if (cursor >= markup.length) break;
    const attributeName = readName('attribute name');
    if (attributes.has(attributeName)) {
      throw rsError('invalid-header', `R&S XML element ${name} repeats attribute ${attributeName}.`, fileNames);
    }
    skipWhitespace();
    if (markup[cursor] !== '=') {
      throw rsError('invalid-header', `R&S XML attribute ${attributeName} has no equals sign.`, fileNames);
    }
    cursor += 1;
    skipWhitespace();
    const quote = markup[cursor];
    if (quote !== '"' && quote !== "'") {
      throw rsError('invalid-header', `R&S XML attribute ${attributeName} must use quotes.`, fileNames);
    }
    cursor += 1;
    const valueStart = cursor;
    while (cursor < markup.length && markup[cursor] !== quote) {
      if (markup[cursor] === '<') {
        throw rsError('invalid-header', `R&S XML attribute ${attributeName} contains a raw less-than sign.`, fileNames);
      }
      cursor += 1;
      budget.checkCancellation(absoluteOffset + cursor);
    }
    if (cursor >= markup.length) {
      throw rsError('invalid-header', `R&S XML attribute ${attributeName} has no closing quote.`, fileNames);
    }
    const value = decodeXmlAttributeValue(markup.slice(valueStart, cursor), fileNames);
    cursor += 1;
    if (cursor < markup.length && !isXmlWhitespace(markup.charCodeAt(cursor))) {
      throw rsError('invalid-header', `R&S XML attribute ${attributeName} is not followed by whitespace.`, fileNames);
    }
    budget.addAttribute(attributeName, value);
    attributes.set(attributeName, value);
  }

  return { name, attributes };
}

function findStartTagEnd(text: string, start: number, budget: XmlBudget, fileNames: string[]): number {
  let quote = '';
  for (let cursor = start; cursor < text.length; cursor += 1) {
    budget.checkCancellation(cursor);
    const character = text[cursor];
    if (quote !== '') {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return cursor;
    } else if (character === '<') {
      throw rsError('invalid-header', 'R&S XML contains a nested less-than sign in a tag.', fileNames);
    }
  }
  throw rsError('invalid-header', 'R&S XML contains an unterminated start tag.', fileNames);
}

function localXmlName(name: string): string {
  const separator = name.lastIndexOf(':');
  return separator >= 0 ? name.slice(separator + 1) : name;
}

function rejectXInclude(tag: ParsedStartTag, fileNames: string[]): void {
  const localName = localXmlName(tag.name).toLowerCase();
  if (localName === 'include' || localName === 'fallback') {
    throw rsError('invalid-header', 'R&S XML XInclude elements are not supported.', fileNames);
  }
  for (const value of tag.attributes.values()) {
    if (value.toLowerCase() === XINCLUDE_NAMESPACE.toLowerCase()) {
      throw rsError('invalid-header', 'R&S XML XInclude namespaces are not supported.', fileNames);
    }
  }
}

function extractXmlProperties(text: string, signal: AbortSignal | undefined, fileNames: string[]): ExtractedXml {
  const budget = new XmlBudget(signal, fileNames);
  const stack: string[] = [];
  const properties = new Map<string, XmlAttributes>();
  const duplicateProperties = new Set<string>();
  let rootAttributes: XmlAttributes | undefined;
  let rootClosed = false;
  let cursor = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  while (cursor < text.length) {
    budget.checkCancellation(cursor);
    if (text[cursor] !== '<') {
      const nextTag = text.indexOf('<', cursor);
      const textEnd = nextTag < 0 ? text.length : nextTag;
      if (text.slice(cursor, textEnd).trim() !== '') {
        throw rsError(
          'invalid-header',
          'R&S metadata must store values in XML attributes; text content is unsupported.',
          fileNames
        );
      }
      cursor = textEnd;
      continue;
    }

    if (text.startsWith('<!--', cursor)) {
      const end = text.indexOf('-->', cursor + 4);
      if (end < 0) throw rsError('invalid-header', 'R&S XML contains an unterminated comment.', fileNames);
      budget.checkCancellation(end);
      cursor = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', cursor)) {
      const end = text.indexOf(']]>', cursor + 9);
      if (end < 0) throw rsError('invalid-header', 'R&S XML contains unterminated CDATA.', fileNames);
      if (text.slice(cursor + 9, end).trim() !== '') {
        throw rsError('invalid-header', 'R&S XML CDATA content is unsupported.', fileNames);
      }
      budget.checkCancellation(end);
      cursor = end + 3;
      continue;
    }
    if (text.startsWith('<?', cursor)) {
      const end = text.indexOf('?>', cursor + 2);
      if (end < 0) {
        throw rsError('invalid-header', 'R&S XML contains an unterminated processing instruction.', fileNames);
      }
      if (end - cursor > MAX_XML_TAG_CHARACTERS) {
        throw rsError(
          'decode-budget-exceeded',
          `R&S XML contains a processing instruction longer than ${MAX_XML_TAG_CHARACTERS} characters.`,
          fileNames
        );
      }
      budget.checkCancellation(end);
      cursor = end + 2;
      continue;
    }
    if (text.startsWith('<!', cursor)) {
      const declarationProbe = text.slice(cursor + 2, Math.min(text.length, cursor + 32)).trimStart();
      const declaration = /^(DOCTYPE|ENTITY)\b/i.exec(declarationProbe)?.[1];
      throw rsError(
        'invalid-header',
        declaration
          ? `R&S XML ${declaration.toUpperCase()} declarations are not supported.`
          : 'R&S XML declarations other than the XML declaration are not supported.',
        fileNames
      );
    }
    if (text.startsWith('</', cursor)) {
      const end = text.indexOf('>', cursor + 2);
      if (end < 0) throw rsError('invalid-header', 'R&S XML contains an unterminated closing tag.', fileNames);
      const closingName = text.slice(cursor + 2, end).trim();
      if (
        closingName.length === 0 ||
        !isXmlNameStart(closingName.charCodeAt(0)) ||
        Array.from(closingName).some((character) => !isXmlNameCharacter(character.charCodeAt(0)))
      ) {
        throw rsError('invalid-header', 'R&S XML contains an invalid closing tag.', fileNames);
      }
      const expected = stack.pop();
      if (expected === undefined || expected !== closingName) {
        throw rsError(
          'invalid-header',
          `R&S XML closing tag ${closingName} does not match ${expected ?? 'the document root'}.`,
          fileNames
        );
      }
      if (stack.length === 0) rootClosed = true;
      cursor = end + 1;
      continue;
    }

    const end = findStartTagEnd(text, cursor + 1, budget, fileNames);
    let markup = text.slice(cursor + 1, end).trimEnd();
    const selfClosing = markup.endsWith('/');
    if (selfClosing) markup = markup.slice(0, -1).trimEnd();
    const tag = parseStartTag(markup, cursor + 1, budget, fileNames);
    rejectXInclude(tag, fileNames);
    budget.addElement(tag.name, stack.length + 1);

    if (stack.length === 0) {
      if (rootAttributes !== undefined || rootClosed) {
        throw rsError('invalid-header', 'R&S XML must contain exactly one document root.', fileNames);
      }
      if (tag.name !== 'Database') {
        throw rsError('invalid-header', `R&S XML root must be Database, found ${tag.name}.`, fileNames);
      }
      const retainedRootAttributes = new Map<string, string>();
      for (const attributeName of ['FWVersion', 'SaveItemType']) {
        const value = tag.attributes.get(attributeName);
        if (value !== undefined) retainedRootAttributes.set(attributeName, value);
      }
      budget.retainAttributes(retainedRootAttributes, 'Database');
      rootAttributes = retainedRootAttributes;
    }

    const propertyName = tag.attributes.get('Name');
    if (propertyName !== undefined && RETAINED_PROPERTY_NAMES.has(propertyName)) {
      budget.addIndexedProperty();
      budget.retainAttributes(tag.attributes, `R&S property ${propertyName}`);
      if (properties.has(propertyName)) {
        duplicateProperties.add(propertyName);
      } else {
        properties.set(propertyName, tag.attributes);
      }
    }

    if (selfClosing) {
      if (stack.length === 0) rootClosed = true;
    } else {
      stack.push(tag.name);
    }
    cursor = end + 1;
  }

  throwIfCancelled(signal);
  if (rootAttributes === undefined || !rootClosed || stack.length !== 0) {
    throw rsError('invalid-header', 'R&S XML is missing a complete Database root element.', fileNames);
  }
  return { rootAttributes, properties, duplicateProperties };
}

function requiredProperty(xml: ExtractedXml, name: string, fileNames: string[]): XmlAttributes {
  if (xml.duplicateProperties.has(name)) {
    throw rsError('invalid-header', `R&S metadata repeats required property ${name}.`, fileNames);
  }
  const property = xml.properties.get(name);
  if (property === undefined) {
    throw rsError('invalid-header', `R&S metadata is missing required property ${name}.`, fileNames);
  }
  return property;
}

function optionalProperty(xml: ExtractedXml, name: string, fileNames: string[]): XmlAttributes | undefined {
  if (xml.duplicateProperties.has(name)) {
    throw rsError('invalid-header', `R&S metadata repeats property ${name}.`, fileNames);
  }
  return xml.properties.get(name);
}

function requiredAttribute(
  attributes: XmlAttributes,
  attributeName: string,
  propertyName: string,
  fileNames: string[]
): string {
  const value = attributes.get(attributeName);
  if (value === undefined) {
    throw rsError(
      'invalid-header',
      `R&S metadata property ${propertyName} has no ${attributeName} attribute.`,
      fileNames
    );
  }
  return value;
}

function propertyValue(xml: ExtractedXml, name: string, fileNames: string[]): string {
  return requiredAttribute(requiredProperty(xml, name, fileNames), 'Value', name, fileNames);
}

function optionalPropertyValue(xml: ExtractedXml, name: string, fileNames: string[]): string | undefined {
  const property = optionalProperty(xml, name, fileNames);
  return property === undefined ? undefined : requiredAttribute(property, 'Value', name, fileNames);
}

function parseMetadataInteger(value: string, context: string, fileNames: string[]): number {
  const trimmed = value.trim();
  if (!DECIMAL_INTEGER.test(trimmed)) {
    throw rsError('invalid-header', `${context} must be a decimal integer.`, fileNames);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw rsError('invalid-header', `${context} exceeds safe integer precision.`, fileNames);
  }
  return parsed;
}

function parseMetadataFloat(value: string, context: string, fileNames: string[]): number {
  const trimmed = value.trim();
  if (!DECIMAL_NUMBER.test(trimmed)) {
    throw rsError('invalid-header', `${context} must be a decimal number.`, fileNames);
  }
  return requireFinite(Number(trimmed), context, FORMAT);
}

function propertyInteger(xml: ExtractedXml, name: string, fileNames: string[]): number {
  return parseMetadataInteger(propertyValue(xml, name, fileNames), `R&S ${name}`, fileNames);
}

function propertyFloat(xml: ExtractedXml, name: string, fileNames: string[]): number {
  return parseMetadataFloat(propertyValue(xml, name, fileNames), `R&S ${name}`, fileNames);
}

function propertyAttributeFloat(
  xml: ExtractedXml,
  propertyName: string,
  attributeName: string,
  fileNames: string[]
): number {
  const value = requiredAttribute(
    requiredProperty(xml, propertyName, fileNames),
    attributeName,
    propertyName,
    fileNames
  );
  return parseMetadataFloat(value, `R&S ${propertyName}.${attributeName}`, fileNames);
}

function analogueSourceNumber(source: string): number | null {
  if (!source.toUpperCase().startsWith(SOURCE_PREFIX.toUpperCase())) return null;
  const match = /^(?:CH|C)(\d+)/i.exec(source.slice(SOURCE_PREFIX.length));
  if (match === null) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number >= 1 && number <= 64 ? number : null;
}

function requireAnalogueSource(source: string, fileNames: string[]): number {
  const number = analogueSourceNumber(source);
  if (number === null) {
    throw rsError('unsupported-variant', `R&S source ${source} is not a supported analogue channel source.`, fileNames);
  }
  return number;
}

function parseArrayAttributeIndex(attributeName: string, fileNames: string[]): number | null {
  const match = /^I_(\d+)$/.exec(attributeName);
  if (match === null) return null;
  const index = Number(match[1]);
  if (!Number.isSafeInteger(index) || index > MAX_XML_ARRAY_INDEX) {
    throw rsError(
      'decode-budget-exceeded',
      `R&S metadata array index ${attributeName} exceeds the supported metadata bound.`,
      fileNames
    );
  }
  return index;
}

function activeSources(xml: ExtractedXml, fileNames: string[]): { sources: ActiveSource[]; multiChannel: boolean } {
  const exportMode = propertyValue(xml, 'MultiChannelExport', fileNames);
  if (exportMode === 'eRS_ONOFF_OFF') {
    const source = propertyValue(xml, 'Source', fileNames);
    return {
      sources: [{ source, channelNumber: requireAnalogueSource(source, fileNames), xmlIndex: null }],
      multiChannel: false
    };
  }
  if (exportMode !== 'eRS_ONOFF_ON') {
    throw rsError('unsupported-variant', `Unsupported R&S MultiChannelExport value ${exportMode}.`, fileNames);
  }

  const states = requiredProperty(xml, 'MultiChannelExportState', fileNames);
  const names = requiredProperty(xml, 'MultiChannelSource', fileNames);
  const slots: number[] = [];
  for (const attributeName of states.keys()) {
    const index = parseArrayAttributeIndex(attributeName, fileNames);
    if (index !== null) slots.push(index);
  }
  slots.sort((left, right) => left - right);

  const sources: ActiveSource[] = [];
  for (const index of slots) {
    const xmlIndex = `I_${index}`;
    const state = requiredAttribute(states, xmlIndex, 'MultiChannelExportState', fileNames);
    if (state === 'eRS_ONOFF_OFF') continue;
    if (state !== 'eRS_ONOFF_ON') {
      throw rsError('unsupported-variant', `Unsupported R&S channel export state ${state} at ${xmlIndex}.`, fileNames);
    }
    if (index >= ScopeImportLimits.maxChannels || sources.length >= ScopeImportLimits.maxChannels) {
      throw rsError(
        'unsupported-variant',
        `R&S metadata enables more than ${ScopeImportLimits.maxChannels} analogue channels.`,
        fileNames
      );
    }
    const source = requiredAttribute(names, xmlIndex, 'MultiChannelSource', fileNames);
    sources.push({
      source,
      channelNumber: requireAnalogueSource(source, fileNames),
      xmlIndex
    });
  }
  if (sources.length === 0) {
    throw rsError('unsupported-variant', 'R&S metadata enables no analogue channel source.', fileNames);
  }
  if (new Set(sources.map((source) => source.channelNumber)).size !== sources.length) {
    throw rsError(
      'unsupported-variant',
      'R&S metadata repeats an analogue channel identity; repeated channel records are unsupported.',
      fileNames
    );
  }
  return { sources, multiChannel: true };
}

function validateOptionalAnalogueMetadata(xml: ExtractedXml, sources: ActiveSource[], fileNames: string[]): void {
  const sourceType = optionalPropertyValue(xml, 'SourceType', fileNames);
  if (sourceType !== undefined && sourceType !== 'eRS_SIGNAL_SOURCE_TYPE_SOURCE') {
    throw rsError(
      'unsupported-variant',
      `Unsupported R&S source type ${sourceType}; only analogue acquisition sources are supported.`,
      fileNames
    );
  }
  const baseUnit = optionalPropertyValue(xml, 'BaseUnit', fileNames);
  if (baseUnit !== undefined && baseUnit !== 'eRS_UNIT_LEVEL_V') {
    throw rsError(
      'unsupported-variant',
      `Unsupported R&S base unit ${baseUnit}; the verified analogue path requires volts.`,
      fileNames
    );
  }
  const relative = optionalPropertyValue(xml, 'BaseUnitRelative', fileNames);
  if (relative !== undefined && relative !== 'eRS_ONOFF_OFF') {
    throw rsError('unsupported-variant', 'Relative-unit R&S traces are not supported.', fileNames);
  }
  const viewUnit = optionalPropertyValue(xml, 'ViewUnit', fileNames);
  if (viewUnit !== undefined && viewUnit !== 'eRS_UNIT_LEVEL_V') {
    throw rsError(
      'unsupported-variant',
      `Unsupported R&S view unit ${viewUnit}; the verified analogue path requires volts.`,
      fileNames
    );
  }
  const viewUnitRelative = optionalPropertyValue(xml, 'ViewUnitRelative', fileNames);
  if (viewUnitRelative !== undefined && viewUnitRelative !== 'eRS_ONOFF_OFF') {
    throw rsError('unsupported-variant', 'Relative R&S view units are not supported.', fileNames);
  }

  const multiUnits = optionalProperty(xml, 'MultiChannelViewUnit', fileNames);
  if (multiUnits === undefined) return;
  for (const source of sources) {
    if (source.xmlIndex === null) continue;
    const unit = requiredAttribute(multiUnits, source.xmlIndex, 'MultiChannelViewUnit', fileNames);
    if (unit !== 'eRS_UNIT_LEVEL_V') {
      throw rsError(
        'unsupported-variant',
        `Unsupported R&S channel unit ${unit} at ${source.xmlIndex}; the verified path requires volts.`,
        fileNames
      );
    }
  }
}

function parseDescription(xml: ExtractedXml, arithmetic: CheckedReader, fileNames: string[]): ParsedDescription {
  const saveItemType = xml.rootAttributes.get('SaveItemType');
  if (saveItemType === undefined) {
    throw rsError('invalid-header', 'R&S Database metadata has no SaveItemType attribute.', fileNames);
  }
  if (saveItemType !== 'Data') {
    throw rsError(
      'unsupported-variant',
      `Unsupported R&S SaveItemType ${saveItemType}; a waveform Data export is required.`,
      fileNames
    );
  }

  const signalFormat = propertyValue(xml, 'SignalFormat', fileNames);
  const signalDescriptor = SIGNAL_FORMATS[signalFormat];
  if (signalDescriptor === undefined) {
    throw rsError('unsupported-variant', `Unsupported R&S SignalFormat ${signalFormat}.`, fileNames);
  }

  const traceType = propertyValue(xml, 'TraceType', fileNames);
  if (traceType !== 'eRS_TRACE_TYPE_NORMAL') {
    throw rsError(
      'unsupported-variant',
      `Unsupported R&S TraceType ${traceType}; only NORMAL traces are supported.`,
      fileNames
    );
  }
  const acquisitionCount = propertyInteger(xml, 'NumberOfAcquisitions', fileNames);
  if (acquisitionCount !== 1) {
    throw rsError(
      'unsupported-variant',
      `R&S metadata declares ${acquisitionCount} acquisitions; only one acquisition is supported.`,
      fileNames
    );
  }

  const hardwareRecordLength = propertyInteger(xml, 'SignalHardwareRecordLength', fileNames);
  const recordLength = propertyInteger(xml, 'RecordLength', fileNames);
  const leadingSamples = propertyInteger(xml, 'LeadingSettlingSamples', fileNames);
  if (hardwareRecordLength <= 0 || recordLength <= 0) {
    throw rsError('invalid-header', 'R&S hardware and output record lengths must be positive.', fileNames);
  }
  if (leadingSamples < 0) {
    throw rsError('invalid-header', 'R&S LeadingSettlingSamples cannot be negative.', fileNames);
  }
  const recordEnd = arithmetic.checkedSum(
    [leadingSamples, recordLength],
    'R&S LeadingSettlingSamples plus RecordLength'
  );
  if (recordEnd > hardwareRecordLength) {
    throw rsError(
      'length-mismatch',
      'R&S LeadingSettlingSamples and RecordLength exceed SignalHardwareRecordLength.',
      fileNames
    );
  }

  const xStart = propertyFloat(xml, 'XStart', fileNames);
  const xStop = propertyFloat(xml, 'XStop', fileNames);
  const xSpan = requireFinite(xStop - xStart, 'R&S XStop minus XStart', FORMAT);
  const xIncrement = requireFinite(xSpan / recordLength, 'R&S sample interval', FORMAT);
  if (signalDescriptor.kind !== 'xy-double-float' && !(xIncrement > 0)) {
    throw rsError('invalid-header', 'R&S generated sample interval must be positive.', fileNames);
  }

  const { sources, multiChannel } = activeSources(xml, fileNames);
  validateOptionalAnalogueMetadata(xml, sources, fileNames);
  validateRecordShape(recordLength, sources.length, 0, FORMAT);
  const hardwareChannelSamples = arithmetic.checkedProduct(
    hardwareRecordLength,
    sources.length,
    'R&S hardware channel-sample count'
  );
  if (hardwareChannelSamples > ScopeImportLimits.maxTotalChannelSamples) {
    throw rsError(
      'decode-budget-exceeded',
      `R&S hardware channel-sample count ${hardwareChannelSamples} exceeds the limit of ${ScopeImportLimits.maxTotalChannelSamples}.`,
      fileNames
    );
  }

  const rootFirmware = xml.rootAttributes.get('FWVersion') ?? '';
  return {
    signalFormat,
    signalDescriptor,
    hardwareRecordLength,
    recordLength,
    leadingSamples,
    xStart,
    xStop,
    xIncrement,
    sources,
    firmwareVersion: rootFirmware || 'unknown',
    multiChannel
  };
}

function integerScales(xml: ExtractedXml, description: ParsedDescription, fileNames: string[]): IntegerScale[] {
  const levels = propertyInteger(xml, 'NofQuantisationLevels', fileNames);
  if (levels <= 0) {
    throw rsError('invalid-header', 'R&S NofQuantisationLevels must be positive.', fileNames);
  }

  const minimumRaw = description.signalDescriptor.kind === 'int8' ? -128 : -32_768;
  const maximumRaw = description.signalDescriptor.kind === 'int8' ? 127 : 32_767;
  return description.sources.map((source) => {
    const scaleProperty = source.xmlIndex === null ? 'VerticalScale' : 'MultiChannelVerticalScale';
    const positionProperty = source.xmlIndex === null ? 'VerticalPosition' : 'MultiChannelVerticalPosition';
    const offsetProperty = source.xmlIndex === null ? 'VerticalOffset' : 'MultiChannelVerticalOffset';
    const valueAttribute = source.xmlIndex ?? 'Value';

    const scale = propertyAttributeFloat(xml, scaleProperty, valueAttribute, fileNames);
    const positionDivisions = propertyAttributeFloat(xml, positionProperty, valueAttribute, fileNames);
    const verticalOffset = propertyAttributeFloat(xml, offsetProperty, valueAttribute, fileNames);
    const stepFactor = propertyAttributeFloat(xml, scaleProperty, 'StepFactor', fileNames);
    const factor = requireFinite(
      (stepFactor * scale) / levels,
      `R&S integer scale factor for CH${source.channelNumber}`,
      FORMAT
    );
    const offset = requireFinite(
      verticalOffset - positionDivisions * scale,
      `R&S integer offset for CH${source.channelNumber}`,
      FORMAT
    );
    requireFinite(minimumRaw * factor + offset, `R&S calibrated minimum for CH${source.channelNumber}`, FORMAT);
    requireFinite(maximumRaw * factor + offset, `R&S calibrated maximum for CH${source.channelNumber}`, FORMAT);
    return { factor, offset };
  });
}

function validatePayload(reader: CheckedReader, description: ParsedDescription, fileNames: string[]): PayloadLayout {
  if (reader.bytes.byteLength < 8) {
    throw rsError('truncated-file', 'R&S companion payload is shorter than its eight-byte header.', fileNames);
  }
  const payloadFormat = reader.u32(0, true, 'R&S payload format code');
  const payloadHardwareLength = reader.u32(4, true, 'R&S payload hardware record length');
  if (payloadFormat !== description.signalDescriptor.code) {
    throw rsError(
      'length-mismatch',
      `R&S payload format code ${payloadFormat} does not match XML code ${description.signalDescriptor.code}.`,
      fileNames
    );
  }
  if (payloadHardwareLength !== description.hardwareRecordLength) {
    throw rsError(
      'length-mismatch',
      `R&S payload hardware record length ${payloadHardwareLength} does not match XML length ${description.hardwareRecordLength}.`,
      fileNames
    );
  }

  const channelBytes = reader.checkedProduct(
    description.sources.length,
    description.signalDescriptor.bytesPerValue,
    'R&S channel bytes per row'
  );
  const rowBytes =
    description.signalDescriptor.kind === 'xy-double-float'
      ? reader.checkedSum([8, channelBytes], 'R&S XYDOUBLEFLOAT row size')
      : channelBytes;
  const expectedBodyBytes = reader.checkedProduct(description.hardwareRecordLength, rowBytes, 'R&S payload byte count');
  const expectedTotalBytes = reader.checkedSum([8, expectedBodyBytes], 'R&S payload total byte count');
  if (reader.bytes.byteLength !== expectedTotalBytes) {
    throw rsError(
      'length-mismatch',
      `R&S payload byte count is ${reader.bytes.byteLength}; XML and format require exactly ${expectedTotalBytes}.`,
      fileNames
    );
  }
  return { rowBytes, expectedBodyBytes };
}

function allocateDecoded(description: ParsedDescription, fileNames: string[]): DecodedPayload {
  try {
    return {
      timeSeconds: new Float64Array(description.recordLength),
      values: description.sources.map(() => new Float64Array(description.recordLength)),
      invalidMasks: description.sources.map(() => undefined),
      invalidValueCount: 0
    };
  } catch (cause) {
    throw rsError(
      'decode-budget-exceeded',
      'The R&S decoded waveform arrays could not be allocated within available memory.',
      fileNames,
      cause
    );
  }
}

function markInvalid(
  decoded: DecodedPayload,
  channelIndex: number,
  sampleIndex: number,
  sampleCount: number,
  fileNames: string[]
): void {
  let mask = decoded.invalidMasks[channelIndex];
  if (mask === undefined) {
    try {
      mask = new Uint8Array(sampleCount);
    } catch (cause) {
      throw rsError(
        'decode-budget-exceeded',
        'The R&S invalid-sample mask could not be allocated within available memory.',
        fileNames,
        cause
      );
    }
    decoded.invalidMasks[channelIndex] = mask;
  }
  mask[sampleIndex] = 1;
  decoded.invalidValueCount += 1;
}

function readPayloadValue(reader: CheckedReader, offset: number, kind: SampleKind): number {
  if (kind === 'int8') return reader.i8(offset, 'R&S int8 sample');
  if (kind === 'int16') return reader.i16(offset, true, 'R&S int16 sample');
  return reader.f32(offset, true, 'R&S float32 sample');
}

function decodePayload(
  request: ScopeImportRequest,
  reader: CheckedReader,
  xml: ExtractedXml,
  description: ParsedDescription,
  layout: PayloadLayout,
  fileNames: string[]
): DecodedPayload {
  const scales =
    description.signalDescriptor.kind === 'int8' || description.signalDescriptor.kind === 'int16'
      ? integerScales(xml, description, fileNames)
      : undefined;
  const decoded = allocateDecoded(description, fileNames);

  for (let outputIndex = 0; outputIndex < description.recordLength; outputIndex += 1) {
    if (outputIndex % DECODE_CANCELLATION_INTERVAL === 0) {
      reportProgress(request, 0.55 + (0.43 * outputIndex) / description.recordLength, 'Decoding R&S waveform payload');
    }
    const hardwareIndex = description.leadingSamples + outputIndex;
    const rowOffset = 8 + hardwareIndex * layout.rowBytes;

    if (description.signalDescriptor.kind === 'xy-double-float') {
      const explicitTime = requireFinite(
        reader.f64(rowOffset, true, 'R&S explicit time value'),
        `R&S explicit time at sample ${outputIndex}`,
        FORMAT
      );
      if (outputIndex > 0 && !(explicitTime > decoded.timeSeconds[outputIndex - 1])) {
        throw rsError('invalid-header', 'R&S explicit time values must be strictly increasing.', fileNames);
      }
      decoded.timeSeconds[outputIndex] = explicitTime;
      for (let channelIndex = 0; channelIndex < description.sources.length; channelIndex += 1) {
        const value = reader.f32(
          rowOffset + 8 + channelIndex * 4,
          true,
          `R&S XYDOUBLEFLOAT channel ${channelIndex + 1} sample`
        );
        decoded.values[channelIndex][outputIndex] = value;
        if (!Number.isFinite(value)) {
          markInvalid(decoded, channelIndex, outputIndex, description.recordLength, fileNames);
        }
      }
      continue;
    }

    decoded.timeSeconds[outputIndex] = requireFinite(
      description.xStart + outputIndex * description.xIncrement,
      `R&S generated time at sample ${outputIndex}`,
      FORMAT
    );
    for (let channelIndex = 0; channelIndex < description.sources.length; channelIndex += 1) {
      const raw = readPayloadValue(
        reader,
        rowOffset + channelIndex * description.signalDescriptor.bytesPerValue,
        description.signalDescriptor.kind
      );
      const scale = scales?.[channelIndex];
      const value = scale === undefined ? raw : raw * scale.factor + scale.offset;
      decoded.values[channelIndex][outputIndex] = value;
      if (!Number.isFinite(value)) {
        if (scale !== undefined) {
          throw rsError(
            'invalid-header',
            `R&S integer calibration produced a non-finite value at sample ${outputIndex}.`,
            fileNames
          );
        }
        markInvalid(decoded, channelIndex, outputIndex, description.recordLength, fileNames);
      }
    }
  }
  throwIfCancelled(request.signal);
  return decoded;
}

function buildChannels(description: ParsedDescription, decoded: DecodedPayload): ImportedScopeChannel[] {
  const integerPayload = description.signalDescriptor.kind === 'int8' || description.signalDescriptor.kind === 'int16';
  return description.sources.map((source, index) => {
    const invalidMask = decoded.invalidMasks[index];
    return {
      name: `CH${source.channelNumber}`,
      values: decoded.values[index],
      unit: 'V',
      sourceUnit: 'V',
      sourceToSiScale: 1,
      calibrationSource: integerPayload ? 'R&S XML integer scale and offset' : 'R&S calibrated floating-point payload',
      ...(invalidMask === undefined ? {} : { invalidMask })
    };
  });
}

function decodeInternal(request: ScopeImportRequest): ImportedWaveformRecord[] {
  reportProgress(request, 0, 'Validating R&S waveform pair');
  requireBoundedString(request.primary.name, 'Primary file name', [request.primary.name]);
  const companion = requireCompanion(request);
  const fileNames = [request.primary.name, companion.name];
  requireBoundedString(companion.name, 'Companion file name', fileNames);
  requireFileBudget(request.primary, fileNames);
  requireFileBudget(companion, fileNames);
  if (request.primary.bytes.byteLength > ScopeImportLimits.maxXmlBytes) {
    throw rsError(
      'decode-budget-exceeded',
      `${request.primary.name} is ${request.primary.bytes.byteLength} bytes; R&S XML is limited to ${ScopeImportLimits.maxXmlBytes} bytes.`,
      fileNames
    );
  }

  const descriptionReader = new CheckedReader(request.primary.bytes, FORMAT);
  const payloadReader = new CheckedReader(companion.bytes, FORMAT);
  reportProgress(request, 0.1, 'Reading R&S XML metadata');

  let xmlText: string;
  try {
    xmlText = new TextDecoder('utf-8', { fatal: true }).decode(descriptionReader.bytes);
  } catch (cause) {
    throw rsError('invalid-header', 'R&S metadata is not valid UTF-8 XML.', fileNames, cause);
  }
  if (xmlText.includes('\0')) {
    throw rsError('invalid-header', 'R&S XML contains a forbidden null character.', fileNames);
  }

  const xml = extractXmlProperties(xmlText, request.signal, fileNames);
  reportProgress(request, 0.3, 'Validating R&S metadata');
  const description = parseDescription(xml, descriptionReader, fileNames);
  reportProgress(request, 0.45, 'Validating R&S payload');
  const layout = validatePayload(payloadReader, description, fileNames);

  const decoded = decodePayload(request, payloadReader, xml, description, layout, fileNames);
  reportProgress(request, 0.99, 'Finalizing R&S waveform');

  const warnings: string[] = [];
  if (description.signalDescriptor.kind === 'int16') {
    warnings.push(
      'R&S INT16 decoding is layout-tested with a deterministic fixture; retain the source pair for verification.'
    );
  }
  if (decoded.invalidValueCount > 0) {
    warnings.push(`${decoded.invalidValueCount} non-finite payload value(s) were preserved and marked invalid.`);
  }

  const record: ImportedWaveformRecord = {
    sourceFormat: FORMAT,
    supportLevel: description.signalDescriptor.supportLevel,
    timeSeconds: decoded.timeSeconds,
    channels: buildChannels(description, decoded),
    frameIndex: 0,
    metadata: {
      reader: 'SignalForge bounded R&S pair reader',
      brand: 'Rohde & Schwarz',
      parser: 'rohde_schwarz_pair',
      instrument_model: 'RTP/RTO/RTE family',
      firmware_version: description.firmwareVersion,
      companion_file: companion.name,
      signal_format: description.signalFormat,
      payload_format_code: description.signalDescriptor.code,
      trace_type: 'NORMAL',
      hardware_record_length: description.hardwareRecordLength,
      record_length: description.recordLength,
      leading_settling_samples: description.leadingSamples,
      explicit_time_axis: description.signalDescriptor.kind === 'xy-double-float',
      channel_count: description.sources.length,
      channel_sources: description.sources.map((source) => `CH${source.channelNumber}`).join(','),
      multi_channel_export: description.multiChannel,
      x_start_s: description.xStart,
      x_stop_s: description.xStop,
      payload_body_bytes: layout.expectedBodyBytes
    },
    warnings
  };
  reportProgress(request, 1, 'R&S waveform decoded');
  return [record];
}

export function decodeRohdeSchwarzRtx(request: ScopeImportRequest): ImportedWaveformRecord[] {
  try {
    return decodeInternal(request);
  } catch (error) {
    if (error instanceof ScopeImportError) throw error;
    throw rsError(
      'invalid-header',
      `Cannot decode R&S waveform pair for ${request.primary.name}.`,
      [request.primary.name],
      error
    );
  }
}
