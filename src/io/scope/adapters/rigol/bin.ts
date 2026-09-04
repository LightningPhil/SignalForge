import { ScopeImportLimits, type CheckedReader } from '../../limits';
import type { ImportedWaveformRecord, ScopeImportRequest } from '../../types';
import {
  assertExactLength,
  assertSignature,
  buildRecords,
  checkpoint,
  cleanAscii,
  decodeFloat32Payload,
  finiteField,
  importFailure,
  positiveFiniteField,
  unitFromBinCode,
  validateChannelPlans,
  type ChannelTiming,
  type DecodedRigolChannel
} from './common';

interface BinChannelPlan extends ChannelTiming {
  name: string;
  unit: string;
  payloadOffset: number;
  model: string;
  serial: string;
}

interface ParsedModel {
  model: string;
  serial: string;
}

function splitModel(value: string): ParsedModel {
  const separator = value.indexOf(':');
  return separator < 0
    ? { model: value.trim(), serial: '' }
    : {
        model: value.slice(0, separator).trim(),
        serial: value.slice(separator + 1).trim()
      };
}

function waveformCount(request: ScopeImportRequest, count: number, family: string): number {
  if (count < 1 || count > ScopeImportLimits.maxChannels) {
    importFailure(
      count > ScopeImportLimits.maxChannels ? 'decode-budget-exceeded' : 'invalid-header',
      `${family} waveform count ${count} is outside the supported analogue range.`,
      'rigol-bin',
      request
    );
  }
  return count;
}

function requireOrdinaryAnalogue(
  request: ScopeImportRequest,
  waveformType: number,
  bufferType: number,
  bytesPerPoint: number,
  label: string,
  family: string
): void {
  if (waveformType === 6 || bufferType === 5 || bufferType === 6 || /^LA/i.test(label)) {
    importFailure('unsupported-variant', `${family} logic records are not supported.`, 'rigol-bin', request);
  }
  if (waveformType !== 1 || bufferType !== 1 || bytesPerPoint !== 4) {
    importFailure(
      'unsupported-variant',
      `${family} waveform type ${waveformType}, buffer type ${bufferType}, and ${bytesPerPoint}-byte samples are not an ordinary analogue float32 record.`,
      'rigol-bin',
      request
    );
  }
}

function validateCommonWaveformHeader(
  reader: CheckedReader,
  request: ScopeImportRequest,
  offset: number,
  family: string
): {
  points: number;
  timeStart: number;
  timeStep: number;
  unit: string;
  frame: ParsedModel;
  label: string;
} {
  const points = reader.u32(offset + 12, true, `${family} point count`);
  if (reader.u32(offset + 8, true, `${family} buffer count`) !== 1) {
    importFailure('unsupported-variant', `${family} multi-buffer records are not supported.`, 'rigol-bin', request);
  }
  if (reader.u32(offset + 16, true, `${family} segmented count`) !== 0) {
    importFailure('unsupported-variant', `${family} segmented records are not supported.`, 'rigol-bin', request);
  }
  finiteField(reader, reader.f32(offset + 20, true, `${family} display range`), `${family} display range`);
  finiteField(reader, reader.f64(offset + 24, true, `${family} display origin`), `${family} display origin`);
  const timeStep = positiveFiniteField(
    reader,
    reader.f64(offset + 32, true, `${family} sample interval`),
    `${family} sample interval`,
    request
  );
  const xOrigin = finiteField(reader, reader.f64(offset + 40, true, `${family} X origin`), `${family} X origin`);
  if (reader.u32(offset + 48, true, `${family} X unit`) !== 2) {
    importFailure('unsupported-variant', `${family} X axis is not encoded in seconds.`, 'rigol-bin', request);
  }
  const unit = unitFromBinCode(reader, reader.u32(offset + 52, true, `${family} Y unit`), `${family} Y unit`, request);
  const frame = splitModel(cleanAscii(reader.ascii(offset + 88, 24, `${family} model and serial`)));
  const label = cleanAscii(reader.ascii(offset + 112, 16, `${family} channel label`));
  return { points, timeStart: -xOrigin, timeStep, unit, frame, label };
}

function decodeBinPlans(
  reader: CheckedReader,
  request: ScopeImportRequest,
  plans: readonly BinChannelPlan[],
  family: string
): DecodedRigolChannel[] {
  return plans.map((plan, index) => {
    const decoded = decodeFloat32Payload(
      reader,
      request,
      plan.payloadOffset,
      plan.sampleCount,
      `${family} ${plan.name} samples`
    );
    checkpoint(request, 0.25 + (0.6 * (index + 1)) / plans.length, `Decoding ${family} channels`);
    return {
      name: plan.name,
      values: decoded.values,
      ...(decoded.invalidMask ? { invalidMask: decoded.invalidMask } : {}),
      unit: plan.unit,
      sourceUnit: plan.unit,
      sourceToSiScale: 1,
      calibrationSource: `${family} calibrated little-endian float32 samples`,
      sampleCount: plan.sampleCount,
      timeStart: plan.timeStart,
      timeStep: plan.timeStep
    };
  });
}

function requireUniqueNames(request: ScopeImportRequest, plans: readonly BinChannelPlan[], family: string): void {
  const names = new Set<string>();
  for (const plan of plans) {
    const key = plan.name.toUpperCase();
    if (names.has(key)) {
      importFailure(
        'unsupported-variant',
        `${family} repeats analogue channel label "${plan.name}".`,
        'rigol-bin',
        request
      );
    }
    names.add(key);
  }
}

export function decodeMso5000Bin(request: ScopeImportRequest, reader: CheckedReader): ImportedWaveformRecord[] {
  checkpoint(request, 0.02, 'Reading Rigol MSO5000 BIN header');
  assertSignature(reader, [0x52, 0x47, 0x30, 0x31], 'Rigol RG01 signature', request);
  reader.requireRange(0, 16, 'Rigol RG01 file header and first waveform size');
  const firstHeaderSize = reader.u32(12, true, 'Rigol RG01 waveform-header size');
  if (firstHeaderSize === 128) {
    importFailure(
      'unsupported-variant',
      'Rigol MSO7000/8000 RG01 files are provisional and are not supported.',
      'rigol-bin',
      request
    );
  }
  if (firstHeaderSize !== 140) {
    importFailure(
      'unsupported-variant',
      `Rigol RG01 waveform-header size ${firstHeaderSize} is not the MSO5000 layout.`,
      'rigol-bin',
      request
    );
  }

  const version = cleanAscii(reader.ascii(2, 2, 'Rigol MSO5000 file version'));
  if (version !== '01') {
    importFailure(
      'unsupported-variant',
      `Rigol MSO5000 BIN version "${version || 'unknown'}" is not supported.`,
      'rigol-bin',
      request
    );
  }
  const declaredFileSize = reader.u32(4, true, 'Rigol MSO5000 declared file size');
  const count = waveformCount(request, reader.u32(8, true, 'Rigol MSO5000 waveform count'), 'Rigol MSO5000');
  let cursor = 12;
  let repeatedHeaderBytes = 0;
  const plans: BinChannelPlan[] = [];
  let instrumentModel = '';
  let serialNumber = '';

  for (let waveformIndex = 0; waveformIndex < count; waveformIndex += 1) {
    checkpoint(request, 0.05 + (0.15 * waveformIndex) / count, 'Validating Rigol MSO5000 records');
    reader.requireRange(cursor, 140, `Rigol MSO5000 waveform ${waveformIndex + 1} header`);
    const headerSize = reader.u32(cursor, true, `Rigol MSO5000 waveform ${waveformIndex + 1} header size`);
    if (headerSize !== 140) {
      importFailure(
        'unsupported-variant',
        `Rigol MSO5000 waveform ${waveformIndex + 1} has unsupported header size ${headerSize}.`,
        'rigol-bin',
        request
      );
    }
    const common = validateCommonWaveformHeader(reader, request, cursor, `Rigol MSO5000 waveform ${waveformIndex + 1}`);
    if (common.label && !/^CH\s*[1-4]$/i.test(common.label)) {
      importFailure(
        'unsupported-variant',
        `Rigol MSO5000 record label "${common.label}" is not an analogue channel.`,
        'rigol-bin',
        request
      );
    }
    if (common.frame.model && !/^(?:MSO|DS)5/i.test(common.frame.model)) {
      importFailure(
        'unsupported-variant',
        `Rigol RG01 model "${common.frame.model}" is not in the MSO5000 family.`,
        'rigol-bin',
        request
      );
    }
    if (instrumentModel && common.frame.model && common.frame.model !== instrumentModel) {
      importFailure(
        'invalid-header',
        'Rigol MSO5000 waveform headers disagree on the instrument model.',
        'rigol-bin',
        request
      );
    }
    instrumentModel ||= common.frame.model;
    serialNumber ||= common.frame.serial;
    const waveformType = reader.u32(cursor + 4, true, `Rigol MSO5000 waveform ${waveformIndex + 1} type`);
    finiteField(
      reader,
      reader.f64(cursor + 128, true, `Rigol MSO5000 waveform ${waveformIndex + 1} time tag`),
      `Rigol MSO5000 waveform ${waveformIndex + 1} time tag`
    );
    if (reader.u32(cursor + 136, true, 'Rigol MSO5000 segment index') !== 1) {
      importFailure('unsupported-variant', 'Rigol MSO5000 segmented records are not supported.', 'rigol-bin', request);
    }
    cursor = reader.checkedSum([cursor, headerSize], 'Rigol MSO5000 data-header offset');
    reader.requireRange(cursor, 12, `Rigol MSO5000 waveform ${waveformIndex + 1} data header`);
    const dataHeaderSize = reader.u32(cursor, true, `Rigol MSO5000 waveform ${waveformIndex + 1} data-header size`);
    if (dataHeaderSize !== 12) {
      importFailure(
        'unsupported-variant',
        `Rigol MSO5000 data-header size ${dataHeaderSize} is not supported.`,
        'rigol-bin',
        request
      );
    }
    const bufferType = reader.u16(cursor + 4, true, `Rigol MSO5000 waveform ${waveformIndex + 1} buffer type`);
    const bytesPerPoint = reader.u16(cursor + 6, true, `Rigol MSO5000 waveform ${waveformIndex + 1} bytes per point`);
    requireOrdinaryAnalogue(request, waveformType, bufferType, bytesPerPoint, common.label, 'Rigol MSO5000');
    const bufferSize = reader.u32(cursor + 8, true, `Rigol MSO5000 waveform ${waveformIndex + 1} buffer size`);
    const expectedBufferSize = reader.checkedProduct(common.points, 4, 'Rigol MSO5000 float32 payload size');
    if (bufferSize !== expectedBufferSize) {
      importFailure(
        'length-mismatch',
        `Rigol MSO5000 waveform ${waveformIndex + 1} buffer size does not match its point count.`,
        'rigol-bin',
        request
      );
    }
    const payloadOffset = reader.checkedSum([cursor, dataHeaderSize], 'Rigol MSO5000 sample offset');
    reader.requireRange(payloadOffset, bufferSize, `Rigol MSO5000 waveform ${waveformIndex + 1} samples`);
    plans.push({
      name: common.label || `CH${waveformIndex + 1}`,
      unit: common.unit,
      payloadOffset,
      model: common.frame.model,
      serial: common.frame.serial,
      sampleCount: common.points,
      timeStart: common.timeStart,
      timeStep: common.timeStep
    });
    if (waveformIndex > 0) {
      repeatedHeaderBytes = reader.checkedSum(
        [repeatedHeaderBytes, headerSize, dataHeaderSize],
        'Rigol MSO5000 repeated-header bytes'
      );
    }
    cursor = reader.checkedSum([payloadOffset, bufferSize], 'Rigol MSO5000 waveform extent');
  }

  assertExactLength(reader, cursor, 'Rigol MSO5000 parsed extent', request);
  const quirkFileSize = reader.bytes.byteLength - repeatedHeaderBytes;
  if (declaredFileSize !== reader.bytes.byteLength && declaredFileSize !== quirkFileSize) {
    importFailure(
      'length-mismatch',
      `Rigol MSO5000 declared file size ${declaredFileSize} is inconsistent with its record headers.`,
      'rigol-bin',
      request
    );
  }
  requireUniqueNames(request, plans, 'Rigol MSO5000');
  validateChannelPlans(reader, request, plans);
  const channels = decodeBinPlans(reader, request, plans, 'Rigol MSO5000');
  const records = buildRecords(
    request,
    'rigol-bin',
    {
      brand: 'Rigol',
      family: 'MSO5000',
      parser: 'bin5000',
      instrument_model: instrumentModel || 'MSO5000',
      serial_number: serialNumber || null,
      firmware_version: version
    },
    channels
  );
  checkpoint(request, 1, 'Rigol MSO5000 BIN decoded');
  return records;
}

export function decodeDhoBin(request: ScopeImportRequest, reader: CheckedReader): ImportedWaveformRecord[] {
  checkpoint(request, 0.02, 'Reading Rigol DHO800 BIN header');
  assertSignature(reader, [0x52, 0x47, 0x30, 0x33], 'Rigol RG03 signature', request);
  reader.requireRange(0, 16, 'Rigol DHO800 BIN file header');
  const version = cleanAscii(reader.ascii(2, 2, 'Rigol DHO800 BIN version'));
  if (version !== '03') {
    importFailure(
      'unsupported-variant',
      `Rigol DHO BIN version "${version || 'unknown'}" is not supported.`,
      'rigol-bin',
      request
    );
  }
  const declaredFileSize = reader.u64(4, true, 'Rigol DHO800 declared file size');
  assertExactLength(reader, declaredFileSize, 'Rigol DHO800 declared file extent', request);
  const count = waveformCount(request, reader.u32(12, true, 'Rigol DHO800 waveform count'), 'Rigol DHO800');
  let cursor = 16;
  const plans: BinChannelPlan[] = [];
  let hardwareModel = '';
  let serialNumber = '';

  for (let waveformIndex = 0; waveformIndex < count; waveformIndex += 1) {
    checkpoint(request, 0.05 + (0.15 * waveformIndex) / count, 'Validating Rigol DHO800 records');
    reader.requireRange(cursor, 140, `Rigol DHO800 waveform ${waveformIndex + 1} header`);
    const headerSize = reader.u32(cursor, true, `Rigol DHO800 waveform ${waveformIndex + 1} header size`);
    if (headerSize !== 140) {
      importFailure(
        'unsupported-variant',
        `Rigol DHO800 waveform-header size ${headerSize} is not supported.`,
        'rigol-bin',
        request
      );
    }
    const common = validateCommonWaveformHeader(reader, request, cursor, `Rigol DHO800 waveform ${waveformIndex + 1}`);
    if (common.label && !/^CH\s*[1-4]$/i.test(common.label)) {
      importFailure(
        'unsupported-variant',
        `Rigol DHO800 record label "${common.label}" is not an analogue channel.`,
        'rigol-bin',
        request
      );
    }
    if (!/^(?:DHO|HDO)8/i.test(common.frame.model)) {
      if (/^(?:DHO|HDO)1/i.test(common.frame.model)) {
        importFailure(
          'unsupported-variant',
          'Rigol DHO1000 BIN is not fixture-backed by this adapter.',
          'rigol-bin',
          request
        );
      }
      importFailure(
        'unsupported-variant',
        `Rigol RG03 model "${common.frame.model || 'unknown'}" is not a DHO800 model.`,
        'rigol-bin',
        request
      );
    }
    if (hardwareModel && common.frame.model !== hardwareModel) {
      importFailure(
        'invalid-header',
        'Rigol DHO800 waveform headers disagree on the instrument model.',
        'rigol-bin',
        request
      );
    }
    hardwareModel ||= common.frame.model;
    serialNumber ||= common.frame.serial;
    const waveformType = reader.u32(cursor + 4, true, `Rigol DHO800 waveform ${waveformIndex + 1} type`);
    cursor = reader.checkedSum([cursor, headerSize], 'Rigol DHO800 data-header offset');
    reader.requireRange(cursor, 16, `Rigol DHO800 waveform ${waveformIndex + 1} data header`);
    const dataHeaderSize = reader.u32(cursor, true, `Rigol DHO800 waveform ${waveformIndex + 1} data-header size`);
    if (dataHeaderSize !== 16) {
      importFailure(
        'unsupported-variant',
        `Rigol DHO800 data-header size ${dataHeaderSize} is not supported.`,
        'rigol-bin',
        request
      );
    }
    const bufferType = reader.u16(cursor + 4, true, `Rigol DHO800 waveform ${waveformIndex + 1} buffer type`);
    const bytesPerPoint = reader.u16(cursor + 6, true, `Rigol DHO800 waveform ${waveformIndex + 1} bytes per point`);
    requireOrdinaryAnalogue(request, waveformType, bufferType, bytesPerPoint, common.label, 'Rigol DHO800');
    const bufferSize = reader.u64(cursor + 8, true, `Rigol DHO800 waveform ${waveformIndex + 1} buffer size`);
    const expectedBufferSize = reader.checkedProduct(common.points, 4, 'Rigol DHO800 float32 payload size');
    if (bufferSize !== expectedBufferSize) {
      importFailure(
        'length-mismatch',
        `Rigol DHO800 waveform ${waveformIndex + 1} buffer size does not match its point count.`,
        'rigol-bin',
        request
      );
    }
    const payloadOffset = reader.checkedSum([cursor, dataHeaderSize], 'Rigol DHO800 sample offset');
    reader.requireRange(payloadOffset, bufferSize, `Rigol DHO800 waveform ${waveformIndex + 1} samples`);
    plans.push({
      name: common.label || `CH${waveformIndex + 1}`,
      unit: common.unit,
      payloadOffset,
      model: common.frame.model,
      serial: common.frame.serial,
      sampleCount: common.points,
      timeStart: common.timeStart,
      timeStep: common.timeStep
    });
    cursor = reader.checkedSum([payloadOffset, bufferSize], 'Rigol DHO800 waveform extent');
  }

  assertExactLength(reader, cursor, 'Rigol DHO800 parsed extent', request);
  requireUniqueNames(request, plans, 'Rigol DHO800');
  validateChannelPlans(reader, request, plans);
  const channels = decodeBinPlans(reader, request, plans, 'Rigol DHO800');
  const records = buildRecords(
    request,
    'rigol-bin',
    {
      brand: 'Rigol',
      family: 'DHO800',
      parser: 'dho1000',
      instrument_model: 'DHO800 (BIN)',
      hardware_model: hardwareModel,
      serial_number: serialNumber || null,
      firmware_version: version
    },
    channels
  );
  checkpoint(request, 1, 'Rigol DHO800 BIN decoded');
  return records;
}
