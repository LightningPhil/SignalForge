import { CheckedReader, requireFinite, validateRecordShape } from '../limits';
import {
  ScopeImportError,
  throwIfCancelled,
  type ImportedWaveformRecord,
  type ScopeImportFailureCode,
  type ScopeImportRequest
} from '../types';

const FORMAT = 'teledyne-lecroy-trc' as const;
const WAVEDESC_SEARCH_BYTES = 1024 * 1024;
const DECODE_PROGRESS_INTERVAL = 64 * 1024;
const WAVEDESC_MARKER = [0x57, 0x41, 0x56, 0x45, 0x44, 0x45, 0x53, 0x43] as const;

type TemplateName = 'LECROY_1_0' | 'LECROY_2_3';

interface DescriptorLocation {
  offset: number;
  template: TemplateName;
  littleEndian: boolean;
}

interface LecroyHeader {
  template: TemplateName;
  littleEndian: boolean;
  descriptorOffset: number;
  descriptorLength: number;
  userTextLength: number;
  triggerTimeLength: number;
  risTimeLength: number;
  waveArray1Length: number;
  waveArray2Length: number;
  reservedArrayLengths: number[];
  waveArrayCount: number;
  firstValidPoint: number;
  lastValidPoint: number;
  subarrayCount: number;
  nominalSubarrayCount: number;
  verticalGain: number;
  verticalOffset: number;
  horizontalInterval: number;
  horizontalOffset: number;
  verticalUnit: string;
  horizontalUnit: string;
  instrumentName: string;
  instrumentNumber: number;
  traceLabel: string;
  channelNumber: number;
  sourcePlugin: number | null;
  recordType: number;
  processingDone: number;
  coupling: number;
  probeAttenuation: number;
  bandwidthLimit: number;
  nominalBits: number;
  sweepsPerAcquisition: number;
}

function fail(request: ScopeImportRequest, code: ScopeImportFailureCode, message: string): never {
  throw new ScopeImportError(code, message, {
    format: FORMAT,
    fileNames: [request.primary.name]
  });
}

function fixedAscii(bytes: Uint8Array, offset: number, length: number): string {
  let value = '';
  const end = offset + length;
  for (let index = offset; index < end; index += 1) {
    const byte = bytes[index];
    if (byte === 0) break;
    value += String.fromCharCode(byte);
  }
  return value.trim();
}

function markerMatches(bytes: Uint8Array, offset: number): boolean {
  for (let index = 0; index < WAVEDESC_MARKER.length; index += 1) {
    if (bytes[offset + index] !== WAVEDESC_MARKER[index]) return false;
  }
  return true;
}

function locateDescriptor(request: ScopeImportRequest): DescriptorLocation {
  const bytes = request.primary.bytes;
  const searchLength = Math.min(bytes.byteLength, WAVEDESC_SEARCH_BYTES);
  const lastOffset = searchLength - WAVEDESC_MARKER.length;
  let sawMarker = false;
  let truncatedMarkerOffset: number | null = null;
  let unsupportedTemplate: string | null = null;
  let invalidOrderTemplate: TemplateName | null = null;

  for (let offset = 0; offset <= lastOffset; offset += 1) {
    if ((offset & (DECODE_PROGRESS_INTERVAL - 1)) === 0) {
      throwIfCancelled(request.signal);
      request.onProgress?.(searchLength === 0 ? 0 : (offset / searchLength) * 0.1, 'Searching for LeCroy WAVEDESC');
      throwIfCancelled(request.signal);
    }
    if (bytes[offset] !== WAVEDESC_MARKER[0] || !markerMatches(bytes, offset)) continue;

    sawMarker = true;
    if (offset > bytes.byteLength - 36) {
      truncatedMarkerOffset ??= offset;
      continue;
    }

    const template = fixedAscii(bytes, offset + 16, 16);
    const supportedTemplate =
      template === 'LECROY_1_0' || template === 'LECROY_2_3' ? (template as TemplateName) : null;
    if (!supportedTemplate) {
      unsupportedTemplate ??= template;
      continue;
    }

    const orderByte = bytes[offset + 34];
    if (orderByte !== 0 && orderByte !== 1) {
      invalidOrderTemplate ??= supportedTemplate;
      continue;
    }

    return {
      offset,
      template: supportedTemplate,
      littleEndian: orderByte === 1
    };
  }

  if (invalidOrderTemplate) {
    fail(
      request,
      'unsupported-variant',
      `${invalidOrderTemplate} has an unsupported COMM_ORDER value. Expected HIFIRST (0) or LOFIRST (1).`
    );
  }
  if (unsupportedTemplate !== null) {
    fail(
      request,
      'unsupported-variant',
      `Unsupported LeCroy waveform template ${unsupportedTemplate || '(empty)'}. Expected LECROY_1_0 or LECROY_2_3.`
    );
  }
  if (truncatedMarkerOffset !== null) {
    fail(
      request,
      'truncated-file',
      `WAVEDESC at byte ${truncatedMarkerOffset} is truncated before the template and COMM_ORDER fields.`
    );
  }
  if (sawMarker) {
    fail(request, 'invalid-header', 'No plausible LeCroy WAVEDESC descriptor was found.');
  }
  fail(
    request,
    'unrecognised-format',
    `No WAVEDESC descriptor was found within the first ${WAVEDESC_SEARCH_BYTES} bytes of ${request.primary.name}.`
  );
}

function readLength(
  reader: CheckedReader,
  request: ScopeImportRequest,
  offset: number,
  littleEndian: boolean,
  context: string
): number {
  const value = reader.i32(offset, littleEndian, context);
  if (value < 0) fail(request, 'invalid-header', `${context} cannot be negative.`);
  return value;
}

function requireKnownEnum(
  request: ScopeImportRequest,
  value: number,
  allowed: readonly number[],
  context: string
): void {
  if (!allowed.includes(value)) {
    fail(request, 'unsupported-variant', `${context} value ${value} is unsupported.`);
  }
}

function requireSingleSweep(
  request: ScopeImportRequest,
  recordType: number,
  subarrayCount: number,
  nominalSubarrayCount: number,
  triggerTimeLength: number,
  risTimeLength: number,
  waveArray2Length: number
): void {
  if (subarrayCount < 1 || nominalSubarrayCount < 0) {
    fail(request, 'invalid-header', 'LeCroy subarray counts are invalid.');
  }
  if (subarrayCount !== 1 || nominalSubarrayCount > 1 || triggerTimeLength !== 0) {
    fail(
      request,
      'unsupported-variant',
      'LeCroy sequence/subarray captures require per-segment timing and are not supported.'
    );
  }
  if (waveArray2Length !== 0) {
    fail(request, 'unsupported-variant', 'LeCroy secondary waveform arrays are not supported.');
  }
  if (risTimeLength !== 0 || recordType === 1 || recordType === 8) {
    fail(request, 'unsupported-variant', 'LeCroy RIS/interleaved acquisitions are not supported.');
  }
  if (recordType === 9) {
    fail(request, 'unsupported-variant', 'LeCroy peak-detect waveform pairs are not supported.');
  }
  if (recordType !== 0) {
    fail(request, 'unsupported-variant', `LeCroy record type ${recordType} is not a supported single-sweep waveform.`);
  }
}

function requireValidPointRange(
  request: ScopeImportRequest,
  firstValidPoint: number,
  lastValidPoint: number,
  waveArrayCount: number
): void {
  if (firstValidPoint < 0 || lastValidPoint < firstValidPoint || lastValidPoint >= waveArrayCount) {
    fail(request, 'invalid-header', 'LeCroy valid-point bounds do not fit WAVE_ARRAY_COUNT.');
  }
}

function readTemplate10Header(
  reader: CheckedReader,
  request: ScopeImportRequest,
  location: DescriptorLocation
): LecroyHeader {
  const base = location.offset;
  const littleEndian = location.littleEndian;
  const descriptorLength = readLength(reader, request, base + 36, littleEndian, 'WAVE_DESCRIPTOR length');
  if (descriptorLength < 320) {
    fail(
      request,
      'invalid-header',
      `LECROY_1_0 WAVE_DESCRIPTOR is ${descriptorLength} bytes; at least 320 are required.`
    );
  }
  reader.requireRange(base, descriptorLength, 'LECROY_1_0 WAVE_DESCRIPTOR');

  const userTextLength = readLength(reader, request, base + 40, littleEndian, 'USER_TEXT length');
  const triggerTimeLength = readLength(reader, request, base + 44, littleEndian, 'TRIGTIME_ARRAY length');
  const waveArray1Length = readLength(reader, request, base + 48, littleEndian, 'WAVE_ARRAY_1 length');
  const waveArray2Length = readLength(reader, request, base + 52, littleEndian, 'WAVE_ARRAY_2 length');
  const waveArrayCount = reader.i32(base + 92, littleEndian, 'WAVE_ARRAY_COUNT');
  const firstValidPoint = reader.i32(base + 100, littleEndian, 'FIRST_VALID_PNT');
  const lastValidPoint = reader.i32(base + 104, littleEndian, 'LAST_VALID_PNT');
  const subarrayCount = reader.i32(base + 108, littleEndian, 'SUBARRAY_COUNT');
  const nominalSubarrayCount = reader.i32(base + 112, littleEndian, 'NOM_SUBARRAY_COUNT');
  const sweepsPerAcquisition = reader.i32(base + 116, littleEndian, 'SWEEPS_PER_ACQ');
  const verticalGain = requireFinite(reader.f32(base + 120, littleEndian, 'VERTICAL_GAIN'), 'VERTICAL_GAIN', FORMAT);
  requireFinite(reader.f32(base + 124, littleEndian, 'VERTICAL_OFFSET'), 'VERTICAL_OFFSET', FORMAT);
  const nominalBits = reader.i16(base + 132, littleEndian, 'NOMINAL_BITS');
  const horizontalInterval = requireFinite(
    reader.f32(base + 134, littleEndian, 'HORIZ_INTERVAL'),
    'HORIZ_INTERVAL',
    FORMAT
  );
  const horizontalOffset = requireFinite(reader.f64(base + 138, littleEndian, 'HORIZ_OFFSET'), 'HORIZ_OFFSET', FORMAT);
  requireFinite(reader.f64(base + 146, littleEndian, 'PIXEL_OFFSET'), 'PIXEL_OFFSET', FORMAT);
  requireFinite(reader.f64(base + 250, littleEndian, 'TRIGGER_TIME seconds'), 'TRIGGER_TIME seconds', FORMAT);
  requireFinite(reader.f32(base + 266, littleEndian, 'ACQ_DURATION'), 'ACQ_DURATION', FORMAT);
  const recordType = reader.i16(base + 270, littleEndian, 'RECORD_TYPE');
  const processingDone = reader.i16(base + 272, littleEndian, 'PROCESSING_DONE');
  const coupling = reader.u16(base + 276, littleEndian, 'VERT_COUPLING');
  const probeAttenuation = requireFinite(reader.f32(base + 278, littleEndian, 'PROBE_ATT'), 'PROBE_ATT', FORMAT);
  const bandwidthLimit = reader.u16(base + 284, littleEndian, 'BANDWIDTH_LIMIT');
  requireFinite(reader.f32(base + 286, littleEndian, 'VERT_VERNIER'), 'VERT_VERNIER', FORMAT);
  const verticalOffset = requireFinite(
    reader.f32(base + 290, littleEndian, 'ACQ_VERT_OFFSET'),
    'ACQ_VERT_OFFSET',
    FORMAT
  );
  const sourcePlugin = reader.i16(base + 294, littleEndian, 'WAVE_SOURCE_PLUGIN');
  const channelNumber = reader.i16(base + 296, littleEndian, 'WAVE_SOURCE');
  requireFinite(reader.f32(base + 306, littleEndian, 'TRIGGER_LEVEL'), 'TRIGGER_LEVEL', FORMAT);
  const sweepsArray2 = reader.i32(base + 314, littleEndian, 'SWEEPS_ARRAY_2');

  requireKnownEnum(request, recordType, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'RECORD_TYPE');
  requireKnownEnum(request, processingDone, [0, 1, 2, 3, 4, 5, 6, 7], 'PROCESSING_DONE');
  requireKnownEnum(request, coupling, [0, 1, 2, 3, 4], 'VERT_COUPLING');
  requireKnownEnum(request, bandwidthLimit, [0, 1], 'BANDWIDTH_LIMIT');
  requireKnownEnum(request, channelNumber, [1, 2, 3, 4], 'WAVE_SOURCE');
  if (sweepsArray2 !== 0) {
    fail(request, 'unsupported-variant', 'LeCroy secondary waveform sweeps are not supported.');
  }

  requireSingleSweep(request, recordType, subarrayCount, nominalSubarrayCount, triggerTimeLength, 0, waveArray2Length);
  requireValidPointRange(request, firstValidPoint, lastValidPoint, waveArrayCount);

  return {
    template: location.template,
    littleEndian,
    descriptorOffset: base,
    descriptorLength,
    userTextLength,
    triggerTimeLength,
    risTimeLength: 0,
    waveArray1Length,
    waveArray2Length,
    reservedArrayLengths: [],
    waveArrayCount,
    firstValidPoint,
    lastValidPoint,
    subarrayCount,
    nominalSubarrayCount,
    verticalGain,
    verticalOffset,
    horizontalInterval,
    horizontalOffset,
    verticalUnit: reader.ascii(base + 154, 48, 'VERTUNIT').trim(),
    horizontalUnit: reader.ascii(base + 202, 48, 'HORUNIT').trim(),
    instrumentName: reader.ascii(base + 56, 16, 'INSTRUMENT_NAME').trim(),
    instrumentNumber: reader.i32(base + 72, littleEndian, 'INSTRUMENT_NUMBER'),
    traceLabel: reader.ascii(base + 76, 16, 'TRACE_LABEL').trim(),
    channelNumber,
    sourcePlugin,
    recordType,
    processingDone,
    coupling,
    probeAttenuation,
    bandwidthLimit,
    nominalBits,
    sweepsPerAcquisition
  };
}

function readTemplate23Header(
  reader: CheckedReader,
  request: ScopeImportRequest,
  location: DescriptorLocation
): LecroyHeader {
  const base = location.offset;
  const littleEndian = location.littleEndian;
  const descriptorLength = readLength(reader, request, base + 36, littleEndian, 'WAVE_DESCRIPTOR length');
  if (descriptorLength < 346) {
    fail(
      request,
      'invalid-header',
      `LECROY_2_3 WAVE_DESCRIPTOR is ${descriptorLength} bytes; at least 346 are required.`
    );
  }
  reader.requireRange(base, descriptorLength, 'LECROY_2_3 WAVE_DESCRIPTOR');

  const userTextLength = readLength(reader, request, base + 40, littleEndian, 'USER_TEXT length');
  const reservedDescriptorLength = readLength(reader, request, base + 44, littleEndian, 'RES_DESC1 length');
  const triggerTimeLength = readLength(reader, request, base + 48, littleEndian, 'TRIGTIME_ARRAY length');
  const risTimeLength = readLength(reader, request, base + 52, littleEndian, 'RIS_TIME_ARRAY length');
  const reservedArray1Length = readLength(reader, request, base + 56, littleEndian, 'RES_ARRAY1 length');
  const waveArray1Length = readLength(reader, request, base + 60, littleEndian, 'WAVE_ARRAY_1 length');
  const waveArray2Length = readLength(reader, request, base + 64, littleEndian, 'WAVE_ARRAY_2 length');
  const reservedArray2Length = readLength(reader, request, base + 68, littleEndian, 'RES_ARRAY2 length');
  const reservedArray3Length = readLength(reader, request, base + 72, littleEndian, 'RES_ARRAY3 length');
  const reservedArrayLengths = [
    reservedDescriptorLength,
    reservedArray1Length,
    reservedArray2Length,
    reservedArray3Length
  ];
  if (reservedArrayLengths.some((length) => length !== 0)) {
    fail(request, 'unsupported-variant', 'LeCroy reserved descriptor/array blocks are not supported.');
  }
  const waveArrayCount = reader.i32(base + 116, littleEndian, 'WAVE_ARRAY_COUNT');
  const firstValidPoint = reader.i32(base + 124, littleEndian, 'FIRST_VALID_PNT');
  const lastValidPoint = reader.i32(base + 128, littleEndian, 'LAST_VALID_PNT');
  const firstPoint = reader.i32(base + 132, littleEndian, 'FIRST_POINT');
  const sparsingFactor = reader.i32(base + 136, littleEndian, 'SPARSING_FACTOR');
  const segmentIndex = reader.i32(base + 140, littleEndian, 'SEGMENT_INDEX');
  const subarrayCount = reader.i32(base + 144, littleEndian, 'SUBARRAY_COUNT');
  const sweepsPerAcquisition = reader.i32(base + 148, littleEndian, 'SWEEPS_PER_ACQ');
  const pointsPerPair = reader.i16(base + 152, littleEndian, 'POINTS_PER_PAIR');
  const pairOffset = reader.i16(base + 154, littleEndian, 'PAIR_OFFSET');
  const verticalGain = requireFinite(reader.f32(base + 156, littleEndian, 'VERTICAL_GAIN'), 'VERTICAL_GAIN', FORMAT);
  const verticalOffset = requireFinite(
    reader.f32(base + 160, littleEndian, 'VERTICAL_OFFSET'),
    'VERTICAL_OFFSET',
    FORMAT
  );
  requireFinite(reader.f32(base + 164, littleEndian, 'MAX_VALUE'), 'MAX_VALUE', FORMAT);
  requireFinite(reader.f32(base + 168, littleEndian, 'MIN_VALUE'), 'MIN_VALUE', FORMAT);
  const nominalBits = reader.i16(base + 172, littleEndian, 'NOMINAL_BITS');
  const nominalSubarrayCount = reader.i16(base + 174, littleEndian, 'NOM_SUBARRAY_COUNT');
  const horizontalInterval = requireFinite(
    reader.f32(base + 176, littleEndian, 'HORIZ_INTERVAL'),
    'HORIZ_INTERVAL',
    FORMAT
  );
  const horizontalOffset = requireFinite(reader.f64(base + 180, littleEndian, 'HORIZ_OFFSET'), 'HORIZ_OFFSET', FORMAT);
  requireFinite(reader.f64(base + 188, littleEndian, 'PIXEL_OFFSET'), 'PIXEL_OFFSET', FORMAT);
  requireFinite(reader.f32(base + 292, littleEndian, 'HORIZ_UNCERTAINTY'), 'HORIZ_UNCERTAINTY', FORMAT);
  requireFinite(reader.f64(base + 296, littleEndian, 'TRIGGER_TIME seconds'), 'TRIGGER_TIME seconds', FORMAT);
  requireFinite(reader.f32(base + 312, littleEndian, 'ACQ_DURATION'), 'ACQ_DURATION', FORMAT);
  const recordType = reader.u16(base + 316, littleEndian, 'RECORD_TYPE');
  const processingDone = reader.u16(base + 318, littleEndian, 'PROCESSING_DONE');
  const risSweeps = reader.i16(base + 322, littleEndian, 'RIS_SWEEPS');
  const coupling = reader.u16(base + 326, littleEndian, 'VERT_COUPLING');
  const probeAttenuation = requireFinite(reader.f32(base + 328, littleEndian, 'PROBE_ATT'), 'PROBE_ATT', FORMAT);
  const bandwidthLimit = reader.u16(base + 334, littleEndian, 'BANDWIDTH_LIMIT');
  requireFinite(reader.f32(base + 336, littleEndian, 'VERTICAL_VERNIER'), 'VERTICAL_VERNIER', FORMAT);
  requireFinite(reader.f32(base + 340, littleEndian, 'ACQ_VERT_OFFSET'), 'ACQ_VERT_OFFSET', FORMAT);
  const waveSource = reader.u16(base + 344, littleEndian, 'WAVE_SOURCE');

  requireKnownEnum(request, recordType, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'RECORD_TYPE');
  requireKnownEnum(request, processingDone, [0, 1, 2, 3, 4, 5, 6, 7], 'PROCESSING_DONE');
  requireKnownEnum(request, coupling, [0, 1, 2, 3, 4], 'VERT_COUPLING');
  requireKnownEnum(request, bandwidthLimit, [0, 1], 'BANDWIDTH_LIMIT');
  requireKnownEnum(request, waveSource, [0, 1, 2, 3], 'WAVE_SOURCE');
  if (firstPoint !== 0 || sparsingFactor !== 1 || segmentIndex !== 0) {
    fail(request, 'unsupported-variant', 'LeCroy sparse, partial, or segment-indexed transfers are not supported.');
  }
  if (pointsPerPair !== 0 || pairOffset !== 0) {
    fail(request, 'unsupported-variant', 'LeCroy peak-detect point pairs are not supported.');
  }
  if (risSweeps !== 1) {
    fail(request, 'unsupported-variant', 'LeCroy RIS sweep layouts are not supported.');
  }

  requireSingleSweep(
    request,
    recordType,
    subarrayCount,
    nominalSubarrayCount,
    triggerTimeLength,
    risTimeLength,
    waveArray2Length
  );
  requireValidPointRange(request, firstValidPoint, lastValidPoint, waveArrayCount);

  return {
    template: location.template,
    littleEndian,
    descriptorOffset: base,
    descriptorLength,
    userTextLength,
    triggerTimeLength,
    risTimeLength,
    waveArray1Length,
    waveArray2Length,
    reservedArrayLengths,
    waveArrayCount,
    firstValidPoint,
    lastValidPoint,
    subarrayCount,
    nominalSubarrayCount,
    verticalGain,
    verticalOffset,
    horizontalInterval,
    horizontalOffset,
    verticalUnit: reader.ascii(base + 196, 48, 'VERTUNIT').trim(),
    horizontalUnit: reader.ascii(base + 244, 48, 'HORUNIT').trim(),
    instrumentName: reader.ascii(base + 76, 16, 'INSTRUMENT_NAME').trim(),
    instrumentNumber: reader.i32(base + 92, littleEndian, 'INSTRUMENT_NUMBER'),
    traceLabel: reader.ascii(base + 96, 16, 'TRACE_LABEL').trim(),
    channelNumber: waveSource + 1,
    sourcePlugin: null,
    recordType,
    processingDone,
    coupling,
    probeAttenuation,
    bandwidthLimit,
    nominalBits,
    sweepsPerAcquisition
  };
}

function normalizeVerticalUnit(request: ScopeImportRequest, unit: string): string {
  const normalized = unit.trim().toLowerCase();
  if (normalized === 'v' || normalized === 'volt' || normalized === 'volts') return 'V';
  fail(
    request,
    'unsupported-variant',
    `LeCroy vertical unit ${unit || '(empty)'} is unsupported; this decoder handles voltage traces.`
  );
}

function requireSecondsUnit(request: ScopeImportRequest, unit: string): void {
  const normalized = unit.trim().toLowerCase();
  if (normalized === 's' || normalized === 'sec' || normalized === 'second' || normalized === 'seconds') {
    return;
  }
  fail(request, 'unsupported-variant', `LeCroy horizontal unit ${unit || '(empty)'} is unsupported; expected seconds.`);
}

function decode(request: ScopeImportRequest): ImportedWaveformRecord[] {
  throwIfCancelled(request.signal);
  request.onProgress?.(0, 'Starting LeCroy import');
  throwIfCancelled(request.signal);

  const reader = new CheckedReader(request.primary.bytes, FORMAT);
  const location = locateDescriptor(request);
  reader.requireRange(location.offset, 36, 'LeCroy WAVEDESC dispatch header');

  const descriptorName = reader.ascii(location.offset, 16, 'DESCRIPTOR_NAME').trim();
  if (descriptorName !== 'WAVEDESC') {
    fail(request, 'invalid-header', 'LeCroy descriptor name is not a null-padded WAVEDESC field.');
  }
  const commOrder = reader.u16(location.offset + 34, location.littleEndian, 'COMM_ORDER');
  if (commOrder !== (location.littleEndian ? 1 : 0)) {
    fail(request, 'unsupported-variant', `LeCroy COMM_ORDER value ${commOrder} is unsupported.`);
  }
  const commType = reader.u16(location.offset + 32, location.littleEndian, 'COMM_TYPE');
  if (commType !== 1) {
    fail(
      request,
      'unsupported-variant',
      `LeCroy COMM_TYPE value ${commType} is unsupported; signed int16 word data is required.`
    );
  }

  request.onProgress?.(0.12, `Reading ${location.template} descriptor`);
  throwIfCancelled(request.signal);
  const header =
    location.template === 'LECROY_1_0'
      ? readTemplate10Header(reader, request, location)
      : readTemplate23Header(reader, request, location);

  if (header.horizontalInterval <= 0) {
    fail(request, 'invalid-header', 'LeCroy HORIZ_INTERVAL must be positive.');
  }
  if (header.verticalGain === 0) {
    fail(request, 'invalid-header', 'LeCroy VERTICAL_GAIN cannot be zero.');
  }
  if (header.nominalBits < 1 || header.nominalBits > 16) {
    fail(request, 'invalid-header', `LeCroy NOMINAL_BITS value ${header.nominalBits} is invalid.`);
  }
  if (header.sweepsPerAcquisition < 0) {
    fail(request, 'invalid-header', 'LeCroy SWEEPS_PER_ACQ cannot be negative.');
  }

  validateRecordShape(header.waveArrayCount, 1, 0, FORMAT);
  const requiredWaveBytes = reader.checkedProduct(header.waveArrayCount, 2, 'LeCroy WAVE_ARRAY_1 sample extent');
  if (header.waveArray1Length !== requiredWaveBytes) {
    fail(
      request,
      'length-mismatch',
      `WAVE_ARRAY_1 declares ${header.waveArray1Length} bytes, but ${header.waveArrayCount} signed int16 samples require exactly ${requiredWaveBytes} bytes.`
    );
  }
  validateRecordShape(header.waveArrayCount, 1, requiredWaveBytes, FORMAT);

  const waveArrayOffset = reader.checkedSum(
    [
      header.descriptorOffset,
      header.descriptorLength,
      header.userTextLength,
      header.triggerTimeLength,
      header.risTimeLength
    ],
    'LeCroy WAVE_ARRAY_1 offset'
  );
  const logicalLength = reader.checkedSum(
    [
      header.descriptorLength,
      header.userTextLength,
      header.triggerTimeLength,
      header.risTimeLength,
      header.waveArray1Length,
      header.waveArray2Length
    ],
    'LeCroy logical block extent'
  );
  reader.requireRange(header.descriptorOffset, logicalLength, 'LeCroy declared logical blocks');
  reader.requireRange(waveArrayOffset, requiredWaveBytes, 'LeCroy WAVE_ARRAY_1 payload');
  const logicalEnd = reader.checkedSum([header.descriptorOffset, logicalLength], 'LeCroy logical block end');
  const trailing = reader.bytes.subarray(logicalEnd);
  // The IEEE 488.2 block export may terminate with a single line ending; anything else is not part of
  // the declared waveform and the file is rejected rather than partially trusted.
  const trailingIsLineEnding =
    trailing.length === 0 ||
    (trailing.length === 1 && trailing[0] === 0x0a) ||
    (trailing.length === 2 && trailing[0] === 0x0d && trailing[1] === 0x0a);
  if (!trailingIsLineEnding) {
    fail(
      request,
      'length-mismatch',
      `LeCroy declared blocks end at byte ${logicalEnd}, but the source contains ${reader.bytes.byteLength} bytes.`
    );
  }

  const unit = normalizeVerticalUnit(request, header.verticalUnit);
  requireSecondsUnit(request, header.horizontalUnit);
  const values = new Float64Array(header.waveArrayCount);
  const timeSeconds = new Float64Array(header.waveArrayCount);
  const hasInvalidEdges = header.firstValidPoint !== 0 || header.lastValidPoint !== header.waveArrayCount - 1;
  const invalidMask = hasInvalidEdges ? new Uint8Array(header.waveArrayCount) : undefined;

  request.onProgress?.(0.3, 'Decoding LeCroy samples');
  for (let index = 0; index < header.waveArrayCount; index += 1) {
    if ((index & (DECODE_PROGRESS_INTERVAL - 1)) === 0) {
      throwIfCancelled(request.signal);
      request.onProgress?.(0.3 + (index / header.waveArrayCount) * 0.68, 'Decoding LeCroy samples');
      throwIfCancelled(request.signal);
    }
    const adc = reader.i16(waveArrayOffset + index * 2, header.littleEndian, 'LeCroy signed int16 sample');
    const time = header.horizontalOffset + index * header.horizontalInterval;
    const value = Math.fround(header.verticalGain * adc - header.verticalOffset);
    if (!Number.isFinite(time) || !Number.isFinite(value)) {
      fail(request, 'invalid-header', `LeCroy sample ${index} decodes to a non-finite value.`);
    }
    timeSeconds[index] = time;
    values[index] = value;
    if (invalidMask && (index < header.firstValidPoint || index > header.lastValidPoint)) {
      invalidMask[index] = 1;
    }
  }

  throwIfCancelled(request.signal);
  request.onProgress?.(1, 'LeCroy import complete');
  throwIfCancelled(request.signal);

  const instrumentModel = header.instrumentName || 'Teledyne LeCroy';
  return [
    {
      sourceFormat: FORMAT,
      supportLevel: header.littleEndian ? 'verified' : 'layout-tested',
      timeSeconds,
      channels: [
        {
          name: `CH${header.channelNumber}`,
          values,
          unit,
          sourceUnit: unit,
          sourceToSiScale: 1,
          ...(invalidMask ? { invalidMask } : {}),
          calibrationSource:
            header.template === 'LECROY_1_0'
              ? 'WAVEDESC VERTICAL_GAIN and ACQ_VERT_OFFSET'
              : 'WAVEDESC VERTICAL_GAIN and VERTICAL_OFFSET'
        }
      ],
      frameIndex: 0,
      metadata: {
        parser: 'lecroy_trc',
        instrument_model: instrumentModel,
        instrument_number: header.instrumentNumber,
        template: header.template,
        byte_order: header.littleEndian ? 'LOFIRST' : 'HIFIRST',
        sample_type: 'signed-int16',
        channel: `CH${header.channelNumber}`,
        wave_source_plugin: header.sourcePlugin,
        trace_label: header.traceLabel,
        descriptor_offset: header.descriptorOffset,
        descriptor_length: header.descriptorLength,
        wave_array_count: header.waveArrayCount,
        wave_array_1_bytes: header.waveArray1Length,
        vertical_gain: header.verticalGain,
        vertical_offset: header.verticalOffset,
        horizontal_interval_s: header.horizontalInterval,
        horizontal_offset_s: header.horizontalOffset,
        coupling: header.coupling,
        probe_attenuation: header.probeAttenuation,
        bandwidth_limited: header.bandwidthLimit === 1,
        nominal_bits: header.nominalBits,
        processing_done: header.processingDone,
        sweeps_per_acquisition: header.sweepsPerAcquisition,
        source_vertical_unit: header.verticalUnit,
        source_horizontal_unit: header.horizontalUnit
      },
      warnings: []
    }
  ];
}

export function decodeLecroyTrc(request: ScopeImportRequest): ImportedWaveformRecord[] {
  try {
    return decode(request);
  } catch (error) {
    if (error instanceof ScopeImportError && error.fileNames.length === 0) {
      throw new ScopeImportError(error.code, error.message, {
        format: error.format || FORMAT,
        fileNames: [request.primary.name],
        cause: error
      });
    }
    throw error;
  }
}
