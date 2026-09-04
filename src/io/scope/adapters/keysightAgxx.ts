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

const FORMAT: ScopeFormat = 'keysight-agxx-bin';
const MIN_WAVEFORM_HEADER_BYTES = 140;
const FILE_HEADER_BYTES_32 = 12;
const FILE_HEADER_BYTES_64 = 16;
const DATA_HEADER_BYTES_32 = 12;
const DATA_HEADER_BYTES_64 = 16;
const CANCELLATION_STRIDE = 4096;

type ContainerVersion = '01' | '03' | '10';

interface ParsedWaveform {
  waveformIndex: number;
  pointCount: number;
  xOrigin: number;
  xIncrement: number;
  channelName: string;
  unit: string;
  frameString: string;
  waveformType: number;
  bufferType: number;
  payloadOffset: number;
}

interface TimeAxisGroup {
  pointCount: number;
  xOrigin: number;
  xIncrement: number;
  waveforms: ParsedWaveform[];
}

interface ParsedContainer {
  version: ContainerVersion;
  waveformCount: number;
  waveforms: ParsedWaveform[];
  instrumentModel: string;
  serialNumber: string;
}

const UNIT_NAMES: Readonly<Record<number, string>> = {
  0: '',
  1: 'V',
  2: 's',
  3: '',
  4: 'A',
  5: 'dB',
  6: 'Hz'
};

function scopeError(code: ScopeImportFailureCode, message: string, fileName: string): never {
  throw new ScopeImportError(code, message, {
    format: FORMAT,
    fileNames: [fileName]
  });
}

function isContainerVersion(value: string): value is ContainerVersion {
  return value === '01' || value === '03' || value === '10';
}

function supportLevel(version: ContainerVersion): ScopeSupportLevel {
  return version === '10' ? 'verified' : 'layout-tested';
}

function unitName(code: number, context: string, fileName: string): string {
  const unit = UNIT_NAMES[code];
  if (unit === undefined) {
    scopeError('unsupported-variant', `${context} uses unsupported unit code ${code}.`, fileName);
  }
  return unit;
}

function channelName(label: string, waveformIndex: number): string {
  const cleaned = label.trim().toUpperCase();
  if (cleaned.startsWith('CH')) return cleaned;
  if (/^\d+$/.test(cleaned)) return `CH${cleaned}`;
  return cleaned || `Waveform ${waveformIndex + 1}`;
}

function frameParts(frameString: string): { model: string; serial: string } {
  const cleaned = frameString.trim();
  const separator = cleaned.indexOf(':');
  if (separator < 0) return { model: cleaned, serial: '' };
  return {
    model: cleaned.slice(0, separator).trim(),
    serial: cleaned.slice(separator + 1).trim()
  };
}

function reportProgress(request: ScopeImportRequest, progress: number, stage: string): void {
  request.onProgress?.(progress, stage);
  throwIfCancelled(request.signal);
}

function validateTimeFields(
  reader: CheckedReader,
  headerOffset: number,
  pointCount: number,
  waveformIndex: number,
  fileName: string
): { xOrigin: number; xIncrement: number } {
  requireFinite(
    reader.f32(headerOffset + 20, true, `Keysight waveform ${waveformIndex} display range`),
    `Keysight waveform ${waveformIndex} display range`,
    FORMAT
  );
  requireFinite(
    reader.f64(headerOffset + 24, true, `Keysight waveform ${waveformIndex} display origin`),
    `Keysight waveform ${waveformIndex} display origin`,
    FORMAT
  );
  const xIncrement = requireFinite(
    reader.f64(headerOffset + 32, true, `Keysight waveform ${waveformIndex} X increment`),
    `Keysight waveform ${waveformIndex} X increment`,
    FORMAT
  );
  const xOrigin = requireFinite(
    reader.f64(headerOffset + 40, true, `Keysight waveform ${waveformIndex} X origin`),
    `Keysight waveform ${waveformIndex} X origin`,
    FORMAT
  );
  if (xIncrement <= 0) {
    scopeError('invalid-header', `Keysight waveform ${waveformIndex} X increment must be positive.`, fileName);
  }
  const finalOffset = requireFinite(
    (pointCount - 1) * xIncrement,
    `Keysight waveform ${waveformIndex} time span`,
    FORMAT
  );
  requireFinite(xOrigin + finalOffset, `Keysight waveform ${waveformIndex} final time`, FORMAT);
  return { xOrigin, xIncrement };
}

function validateWaveformKind(
  waveformType: number,
  bufferCount: number,
  waveformIndex: number,
  fileName: string
): void {
  if (waveformType === 2) {
    scopeError(
      'unsupported-variant',
      `Keysight waveform ${waveformIndex} is peak-detect data; minimum/maximum pairs are not yet supported.`,
      fileName
    );
  }
  if (waveformType === 6) {
    scopeError(
      'unsupported-variant',
      `Keysight waveform ${waveformIndex} is a logic record; logic and digital records are not supported.`,
      fileName
    );
  }
  if (waveformType !== 1 && waveformType !== 3) {
    scopeError(
      'unsupported-variant',
      `Keysight waveform ${waveformIndex} has unsupported waveform type ${waveformType}.`,
      fileName
    );
  }
  if (bufferCount === 0) {
    scopeError('invalid-header', `Keysight waveform ${waveformIndex} declares no data buffer.`, fileName);
  }
  if (bufferCount !== 1) {
    scopeError(
      'unsupported-variant',
      `Keysight waveform ${waveformIndex} declares ${bufferCount} buffers; multi-buffer and peak-detect records are not yet supported.`,
      fileName
    );
  }
}

function validateBufferKind(bufferType: number, bytesPerPoint: number, waveformIndex: number, fileName: string): void {
  if (bufferType === 2 || bufferType === 3) {
    scopeError(
      'unsupported-variant',
      `Keysight waveform ${waveformIndex} contains a peak-detect minimum/maximum buffer.`,
      fileName
    );
  }
  if (bufferType === 4 || bufferType === 5 || bufferType === 6) {
    scopeError(
      'unsupported-variant',
      `Keysight waveform ${waveformIndex} contains logic, digital, or count data (buffer type ${bufferType}).`,
      fileName
    );
  }
  if (bufferType !== 1) {
    scopeError(
      'unsupported-variant',
      `Keysight waveform ${waveformIndex} has unsupported buffer type ${bufferType}.`,
      fileName
    );
  }
  if (bytesPerPoint !== 4) {
    scopeError(
      'unsupported-variant',
      `Keysight waveform ${waveformIndex} analogue buffer uses ${bytesPerPoint} bytes per point; only pre-calibrated float32 data is supported.`,
      fileName
    );
  }
}

function parseWaveform(
  reader: CheckedReader,
  offset: number,
  waveformIndex: number,
  version: ContainerVersion,
  fileName: string
): { waveform: ParsedWaveform; nextOffset: number } {
  const context = `Keysight waveform ${waveformIndex}`;
  const headerSize = reader.u32(offset, true, `${context} header size`);
  if (headerSize < MIN_WAVEFORM_HEADER_BYTES) {
    scopeError(
      'invalid-header',
      `${context} header is ${headerSize} bytes; at least ${MIN_WAVEFORM_HEADER_BYTES} bytes are required.`,
      fileName
    );
  }
  reader.requireRange(offset, headerSize, `${context} declared header`);

  const waveformType = reader.u32(offset + 4, true, `${context} type`);
  const bufferCount = reader.u32(offset + 8, true, `${context} buffer count`);
  const pointCount = reader.u32(offset + 12, true, `${context} point count`);
  const timeTag = requireFinite(reader.f64(offset + 128, true, `${context} time tag`), `${context} time tag`, FORMAT);
  const segmentIndex = reader.u32(offset + 136, true, `${context} segment index`);

  if (segmentIndex !== 0 || Math.abs(timeTag) > 1e-15) {
    scopeError(
      'unsupported-variant',
      `${context} is segmented (segment index ${segmentIndex}, time tag ${timeTag}); segmented captures are not yet supported.`,
      fileName
    );
  }
  validateWaveformKind(waveformType, bufferCount, waveformIndex, fileName);
  validateRecordShape(pointCount, 1, 0, FORMAT);

  const xUnits = reader.u32(offset + 48, true, `${context} X unit`);
  if (xUnits !== 2) {
    scopeError(
      'unsupported-variant',
      `${context} horizontal unit code is ${xUnits}; only seconds are supported.`,
      fileName
    );
  }
  const yUnitCode = reader.u32(offset + 52, true, `${context} Y unit`);
  const unit = unitName(yUnitCode, context, fileName);
  const { xOrigin, xIncrement } = validateTimeFields(reader, offset, pointCount, waveformIndex, fileName);
  const frameString = reader.ascii(offset + 88, 24, `${context} instrument frame`).trim();
  const label = reader.ascii(offset + 112, 16, `${context} label`);

  const dataHeaderOffset = reader.checkedSum([offset, headerSize], `${context} data-header offset`);
  const minimumDataHeaderSize = version === '03' ? DATA_HEADER_BYTES_64 : DATA_HEADER_BYTES_32;
  const dataHeaderSize = reader.u32(dataHeaderOffset, true, `${context} data-header size`);
  if (dataHeaderSize < minimumDataHeaderSize) {
    scopeError(
      'invalid-header',
      `${context} data header is ${dataHeaderSize} bytes; version ${version} requires at least ${minimumDataHeaderSize}.`,
      fileName
    );
  }
  reader.requireRange(dataHeaderOffset, dataHeaderSize, `${context} declared data header`);

  const bufferType = reader.u16(dataHeaderOffset + 4, true, `${context} buffer type`);
  const bytesPerPoint = reader.u16(dataHeaderOffset + 6, true, `${context} bytes per point`);
  const bufferSize =
    version === '03'
      ? reader.u64(dataHeaderOffset + 8, true, `${context} buffer byte count`)
      : reader.u32(dataHeaderOffset + 8, true, `${context} buffer byte count`);
  validateBufferKind(bufferType, bytesPerPoint, waveformIndex, fileName);

  const expectedBufferSize = reader.checkedProduct(pointCount, bytesPerPoint, `${context} point byte count`);
  if (bufferSize !== expectedBufferSize) {
    scopeError(
      'length-mismatch',
      `${context} declares ${bufferSize} buffer bytes, but ${pointCount} float32 points require ${expectedBufferSize}.`,
      fileName
    );
  }

  const payloadOffset = reader.checkedSum([dataHeaderOffset, dataHeaderSize], `${context} payload offset`);
  reader.requireRange(payloadOffset, bufferSize, `${context} sample buffer`);
  const nextOffset = reader.checkedSum([payloadOffset, bufferSize], `${context} ending offset`);

  return {
    waveform: {
      waveformIndex,
      pointCount,
      xOrigin,
      xIncrement,
      channelName: channelName(label, waveformIndex),
      unit,
      frameString,
      waveformType,
      bufferType,
      payloadOffset
    },
    nextOffset
  };
}

function parseContainer(reader: CheckedReader, request: ScopeImportRequest): ParsedContainer {
  const fileName = request.primary.name;
  reader.requireRange(0, 4, 'Keysight AGxx cookie');
  const cookie = reader.ascii(0, 4, 'Keysight AGxx cookie');
  if (!cookie.startsWith('AG')) {
    scopeError('unrecognised-format', `${fileName} does not contain a Keysight/Agilent AGxx cookie.`, fileName);
  }
  const version = cookie.slice(2);
  if (!isContainerVersion(version)) {
    scopeError('unsupported-variant', `${fileName} uses unsupported Keysight/Agilent container ${cookie}.`, fileName);
  }

  const fileHeaderSize = version === '03' ? FILE_HEADER_BYTES_64 : FILE_HEADER_BYTES_32;
  reader.requireRange(0, fileHeaderSize, `Keysight AG${version} file header`);
  const declaredFileSize =
    version === '03'
      ? reader.u64(4, true, 'Keysight AG03 declared file size')
      : reader.u32(4, true, `Keysight AG${version} declared file size`);
  if (declaredFileSize !== reader.bytes.byteLength) {
    scopeError(
      'length-mismatch',
      `Keysight AG${version} declares ${declaredFileSize} file bytes, but the source contains ${reader.bytes.byteLength}.`,
      fileName
    );
  }

  const waveformCount = reader.u32(version === '03' ? 12 : 8, true, `Keysight AG${version} waveform count`);
  if (waveformCount === 0) {
    scopeError('invalid-header', 'Keysight file declares no waveforms.', fileName);
  }
  if (waveformCount > ScopeImportLimits.maxRecords) {
    scopeError(
      'decode-budget-exceeded',
      `Keysight file declares ${waveformCount} waveforms; the import limit is ${ScopeImportLimits.maxRecords}.`,
      fileName
    );
  }

  const waveforms: ParsedWaveform[] = [];
  let offset = fileHeaderSize;
  let instrumentModel = 'Keysight';
  let serialNumber = '';
  for (let waveformIndex = 0; waveformIndex < waveformCount; waveformIndex += 1) {
    throwIfCancelled(request.signal);
    const parsed = parseWaveform(reader, offset, waveformIndex, version, fileName);
    waveforms.push(parsed.waveform);
    offset = parsed.nextOffset;

    const parts = frameParts(parsed.waveform.frameString);
    if (parts.model) instrumentModel = parts.model;
    if (parts.serial) serialNumber = parts.serial;
    if (waveformIndex % 32 === 0 || waveformIndex + 1 === waveformCount) {
      reportProgress(
        request,
        0.05 + (0.2 * (waveformIndex + 1)) / waveformCount,
        'Validating Keysight waveform headers'
      );
    }
  }
  if (offset !== reader.bytes.byteLength) {
    scopeError(
      'length-mismatch',
      `Keysight waveform records end at byte ${offset}, but the source ends at byte ${reader.bytes.byteLength}.`,
      fileName
    );
  }

  return {
    version,
    waveformCount,
    waveforms,
    instrumentModel,
    serialNumber
  };
}

function groupWaveforms(waveforms: ParsedWaveform[], fileName: string): TimeAxisGroup[] {
  const groups: TimeAxisGroup[] = [];
  const channelNames = new Set<string>();
  for (const waveform of waveforms) {
    if (channelNames.has(waveform.channelName)) {
      scopeError(
        'unsupported-variant',
        `Keysight channel ${waveform.channelName} appears more than once; repeated/segmented channel records are unsupported.`,
        fileName
      );
    }
    channelNames.add(waveform.channelName);
    let group = groups.find(
      (candidate) =>
        candidate.pointCount === waveform.pointCount &&
        candidate.xOrigin === waveform.xOrigin &&
        candidate.xIncrement === waveform.xIncrement
    );
    if (!group) {
      group = {
        pointCount: waveform.pointCount,
        xOrigin: waveform.xOrigin,
        xIncrement: waveform.xIncrement,
        waveforms: []
      };
      groups.push(group);
    }
    if (group.waveforms.some((candidate) => candidate.channelName === waveform.channelName)) {
      scopeError(
        'unsupported-variant',
        `Multiple Keysight waveforms on one time axis map to ${waveform.channelName}; repeated channel records require segmented-capture support.`,
        fileName
      );
    }
    group.waveforms.push(waveform);
  }
  return groups;
}

function validateDecodeBudget(reader: CheckedReader, groups: TimeAxisGroup[], fileName: string): number {
  let totalChannelSamples = 0;
  let predictedDecodedBytes = 0;
  for (const group of groups) {
    validateRecordShape(group.pointCount, group.waveforms.length, 0, FORMAT);
    const groupChannelSamples = reader.checkedProduct(
      group.pointCount,
      group.waveforms.length,
      'Keysight group channel-sample count'
    );
    totalChannelSamples = reader.checkedSum(
      [totalChannelSamples, groupChannelSamples],
      'Keysight total channel-sample count'
    );
    const timeBytes = reader.checkedProduct(
      group.pointCount,
      Float64Array.BYTES_PER_ELEMENT,
      'Keysight time-axis bytes'
    );
    const channelBytes = reader.checkedProduct(
      groupChannelSamples,
      Float64Array.BYTES_PER_ELEMENT + Uint8Array.BYTES_PER_ELEMENT + 1,
      'Keysight decoded channel bytes'
    );
    predictedDecodedBytes = reader.checkedSum(
      [predictedDecodedBytes, timeBytes, channelBytes],
      'Keysight decoded working set'
    );
  }
  if (totalChannelSamples > ScopeImportLimits.maxTotalChannelSamples) {
    scopeError(
      'decode-budget-exceeded',
      `Keysight import contains ${totalChannelSamples} channel samples; the limit is ${ScopeImportLimits.maxTotalChannelSamples}.`,
      fileName
    );
  }
  if (predictedDecodedBytes > ScopeImportLimits.maxDecodedBytes) {
    scopeError(
      'decode-budget-exceeded',
      `Keysight import requires approximately ${predictedDecodedBytes} decoded bytes; the limit is ${ScopeImportLimits.maxDecodedBytes}.`,
      fileName
    );
  }
  return totalChannelSamples;
}

function buildTimeAxis(group: TimeAxisGroup, signal?: AbortSignal): Float64Array {
  const timeSeconds = new Float64Array(group.pointCount);
  for (let index = 0; index < group.pointCount; index += 1) {
    if (index % CANCELLATION_STRIDE === 0) throwIfCancelled(signal);
    timeSeconds[index] = requireFinite(
      group.xOrigin + index * group.xIncrement,
      `Keysight time sample ${index}`,
      FORMAT
    );
  }
  return timeSeconds;
}

function decodeChannel(
  reader: CheckedReader,
  waveform: ParsedWaveform,
  request: ScopeImportRequest,
  completedSamples: number,
  totalSamples: number
): ImportedScopeChannel {
  const values = new Float64Array(waveform.pointCount);
  const invalidMask = new Uint8Array(waveform.pointCount);
  for (let index = 0; index < waveform.pointCount; index += 1) {
    if (index % CANCELLATION_STRIDE === 0) {
      reportProgress(
        request,
        0.25 + (0.7 * (completedSamples + index)) / totalSamples,
        `Decoding ${waveform.channelName}`
      );
    }
    const value = reader.f32(
      waveform.payloadOffset + index * Float32Array.BYTES_PER_ELEMENT,
      true,
      `Keysight waveform ${waveform.waveformIndex} sample ${index}`
    );
    values[index] = value;
    if (!Number.isFinite(value)) invalidMask[index] = 1;
  }
  return {
    name: waveform.channelName,
    values,
    unit: waveform.unit,
    sourceUnit: waveform.unit,
    sourceToSiScale: 1,
    invalidMask,
    calibrationSource: 'Keysight AGxx pre-calibrated little-endian float32 samples'
  };
}

function decodeValidatedContainer(
  reader: CheckedReader,
  container: ParsedContainer,
  request: ScopeImportRequest
): ImportedWaveformRecord[] {
  const groups = groupWaveforms(container.waveforms, request.primary.name);
  if (groups.length > ScopeImportLimits.maxRecords) {
    scopeError(
      'decode-budget-exceeded',
      `Keysight import contains ${groups.length} time-axis groups; the limit is ${ScopeImportLimits.maxRecords}.`,
      request.primary.name
    );
  }
  const totalSamples = validateDecodeBudget(reader, groups, request.primary.name);
  reportProgress(request, 0.25, 'Decoding Keysight analogue waveforms');

  const warnings: string[] = [];
  if (container.version !== '10') {
    warnings.push(`AG${container.version} container support is layout-tested with synthetic fixtures only.`);
  }
  if (groups.length > 1) {
    warnings.push('Channels with different X origins or increments were kept in separate waveform records.');
  }

  const records: ImportedWaveformRecord[] = [];
  let completedSamples = 0;
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    throwIfCancelled(request.signal);
    const group = groups[groupIndex];
    const timeSeconds = buildTimeAxis(group, request.signal);
    const channels: ImportedScopeChannel[] = [];
    for (const waveform of group.waveforms) {
      channels.push(decodeChannel(reader, waveform, request, completedSamples, totalSamples));
      completedSamples += waveform.pointCount;
    }

    const waveformTypes = new Set(group.waveforms.map((waveform) => waveform.waveformType));
    const bufferTypes = new Set(group.waveforms.map((waveform) => waveform.bufferType));
    const metadata: Record<string, string | number | boolean | null> = {
      reader: 'SignalForge native checked decoder',
      brand: 'Keysight',
      parser: 'agilent_agxx_bin',
      container_version: container.version,
      instrument_model: container.instrumentModel,
      serial_number: container.serialNumber,
      firmware_version: 'unknown',
      waveform_count: container.waveformCount,
      time_axis_group_count: groups.length,
      channel_count: channels.length,
      sample_count: group.pointCount,
      x_origin: group.xOrigin,
      x_increment: group.xIncrement,
      waveform_type: waveformTypes.size === 1 ? group.waveforms[0].waveformType : 'mixed',
      buffer_type: bufferTypes.size === 1 ? group.waveforms[0].bufferType : 'mixed',
      pre_calibrated_samples: true
    };
    if (groups.length > 1) metadata.record_kind = 'per-channel-time-axis-group';

    records.push({
      sourceFormat: FORMAT,
      supportLevel: supportLevel(container.version),
      timeSeconds,
      channels,
      frameIndex: groupIndex,
      metadata,
      warnings: warnings.slice()
    });
  }
  reportProgress(request, 1, 'Keysight waveform import complete');
  return records;
}

function decode(request: ScopeImportRequest): ImportedWaveformRecord[] {
  throwIfCancelled(request.signal);
  reportProgress(request, 0, 'Validating Keysight AGxx container');
  const reader = new CheckedReader(request.primary.bytes, FORMAT);
  const container = parseContainer(reader, request);
  return decodeValidatedContainer(reader, container, request);
}

export function decodeKeysightAgxx(request: ScopeImportRequest): ImportedWaveformRecord[] {
  try {
    return decode(request);
  } catch (error) {
    if (error instanceof ScopeImportError && (error.fileNames.length === 0 || error.format === undefined)) {
      throw new ScopeImportError(error.code, error.message, {
        format: error.format ?? FORMAT,
        fileNames: error.fileNames.length > 0 ? error.fileNames.slice() : [request.primary.name],
        cause: error
      });
    }
    throw error;
  }
}
