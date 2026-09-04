import { CheckedReader, ScopeImportLimits, requireFinite, validateRecordShape } from '../../limits';
import {
  ScopeImportError,
  throwIfCancelled,
  type ImportedScopeChannel,
  type ImportedWaveformRecord,
  type ScopeFormat,
  type ScopeImportFailureCode,
  type ScopeImportRequest
} from '../../types';

// The layouts and equations here are an independent, checked-reader port of
// the BSD-3-Clause RigolWFM format schemas and normalisers in reference-material.

const CANCEL_CHECK_MASK = 0x3fff;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export interface ChannelTiming {
  sampleCount: number;
  timeStart: number;
  timeStep: number;
}

export interface DecodedRigolChannel extends ChannelTiming {
  name: string;
  values: Float64Array;
  unit: string;
  sourceUnit: string;
  sourceToSiScale: number;
  invalidMask?: Uint8Array;
  calibrationSource: string;
}

export interface FloatPayload {
  values: Float64Array;
  invalidMask?: Uint8Array;
}

export function importFailure(
  code: ScopeImportFailureCode,
  message: string,
  format: ScopeFormat,
  request: ScopeImportRequest,
  cause?: unknown
): never {
  throw new ScopeImportError(code, message, {
    format,
    fileNames: [request.primary.name],
    cause
  });
}

export function assertSignature(
  reader: CheckedReader,
  expected: readonly number[],
  context: string,
  request: ScopeImportRequest
): void {
  reader.requireRange(0, expected.length, context);
  for (let index = 0; index < expected.length; index += 1) {
    if (reader.bytes[index] !== expected[index]) {
      importFailure(
        'invalid-header',
        `${context} does not match the selected Rigol format.`,
        reader.format || 'rigol-wfm',
        request
      );
    }
  }
}

export function assertBytes(
  reader: CheckedReader,
  offset: number,
  expected: readonly number[],
  context: string,
  request: ScopeImportRequest
): void {
  reader.requireRange(offset, expected.length, context);
  for (let index = 0; index < expected.length; index += 1) {
    if (reader.bytes[offset + index] !== expected[index]) {
      importFailure(
        'invalid-header',
        `${context} contains an unsupported value.`,
        reader.format || 'rigol-wfm',
        request
      );
    }
  }
}

export function assertZeroRange(
  reader: CheckedReader,
  offset: number,
  length: number,
  context: string,
  request: ScopeImportRequest
): void {
  reader.requireRange(offset, length, context);
  for (let index = offset; index < offset + length; index += 1) {
    if (reader.bytes[index] !== 0) {
      importFailure(
        'invalid-header',
        `${context} must contain only zero padding.`,
        reader.format || 'rigol-wfm',
        request
      );
    }
  }
}

export function assertExactLength(
  reader: CheckedReader,
  expectedLength: number,
  context: string,
  request: ScopeImportRequest
): void {
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 0) {
    importFailure(
      'invalid-header',
      `${context} overflows safe integer precision.`,
      reader.format || 'rigol-wfm',
      request
    );
  }
  if (reader.bytes.byteLength !== expectedLength) {
    importFailure(
      'length-mismatch',
      `${context} declares ${expectedLength} bytes, but the source has ${reader.bytes.byteLength}.`,
      reader.format || 'rigol-wfm',
      request
    );
  }
}

export function safeI64(reader: CheckedReader, offset: number, context: string): number {
  reader.requireRange(offset, 8, context);
  const value = reader.view.getBigInt64(offset, true);
  if (value < -MAX_SAFE_BIGINT || value > MAX_SAFE_BIGINT) {
    throw new ScopeImportError('invalid-header', `${context} exceeds safe integer precision.`, {
      format: reader.format
    });
  }
  return Number(value);
}

export function finiteField(reader: CheckedReader, value: number, context: string): number {
  return requireFinite(value, context, reader.format || 'rigol-wfm');
}

export function positiveFiniteField(
  reader: CheckedReader,
  value: number,
  context: string,
  request: ScopeImportRequest
): number {
  finiteField(reader, value, context);
  if (!(value > 0)) {
    importFailure('invalid-header', `${context} must be greater than zero.`, reader.format || 'rigol-wfm', request);
  }
  return value;
}

export function requireKnownEnum(
  reader: CheckedReader,
  value: number,
  allowed: readonly number[],
  context: string,
  request: ScopeImportRequest
): void {
  if (!allowed.includes(value)) {
    importFailure(
      'unsupported-variant',
      `${context} value ${value} is not supported.`,
      reader.format || 'rigol-wfm',
      request
    );
  }
}

export function checkedEnd(reader: CheckedReader, offset: number, length: number, context: string): number {
  reader.requireRange(offset, length, context);
  return reader.checkedSum([offset, length], `${context} end`);
}

export function checkpoint(request: ScopeImportRequest, progress?: number, stage?: string): void {
  throwIfCancelled(request.signal);
  if (progress !== undefined && stage !== undefined) {
    request.onProgress?.(Math.max(0, Math.min(1, progress)), stage);
  }
}

export function checkLoopCancellation(request: ScopeImportRequest, index: number): void {
  if ((index & CANCEL_CHECK_MASK) === 0) throwIfCancelled(request.signal);
}

export function unitFromLegacyCode(
  reader: CheckedReader,
  code: number,
  context: string,
  request: ScopeImportRequest
): string {
  requireKnownEnum(reader, code, [0, 1, 2, 3], context, request);
  return code === 0 ? 'W' : code === 1 ? 'A' : code === 2 ? 'V' : '';
}

export function unitFromBinCode(
  reader: CheckedReader,
  code: number,
  context: string,
  request: ScopeImportRequest
): string {
  requireKnownEnum(reader, code, [0, 1, 3, 4, 5, 6], context, request);
  return code === 1 ? 'V' : code === 4 ? 'A' : code === 5 ? 'dB' : code === 6 ? 'Hz' : '';
}

export function couplingFromCode(
  reader: CheckedReader,
  code: number,
  context: string,
  request: ScopeImportRequest
): string {
  requireKnownEnum(reader, code, [0, 1, 2], context, request);
  return code === 0 ? 'DC' : code === 1 ? 'AC' : 'GND';
}

export function probeRatioFromCode(
  reader: CheckedReader,
  code: number,
  context: string,
  request: ScopeImportRequest
): number {
  const ratios = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000] as const;
  requireKnownEnum(
    reader,
    code,
    ratios.map((_, index) => index),
    context,
    request
  );
  return ratios[code];
}

export function validateChannelPlans(
  reader: CheckedReader,
  request: ScopeImportRequest,
  plans: readonly ChannelTiming[],
  temporaryBytes = 0
): void {
  const format = reader.format || 'rigol-wfm';
  if (plans.length === 0) {
    importFailure(
      'unsupported-variant',
      'The Rigol file contains no supported enabled analogue channels.',
      format,
      request
    );
  }
  if (plans.length > ScopeImportLimits.maxChannels) {
    importFailure(
      'decode-budget-exceeded',
      `The Rigol file contains ${plans.length} analogue channels; the limit is ${ScopeImportLimits.maxChannels}.`,
      format,
      request
    );
  }
  if (!Number.isSafeInteger(temporaryBytes) || temporaryBytes < 0) {
    importFailure('invalid-header', 'Rigol temporary-byte accounting is invalid.', format, request);
  }

  const timingGroups: ChannelTiming[][] = [];
  let totalSamples = 0;
  for (const plan of plans) {
    finiteField(reader, plan.timeStart, 'Rigol first-sample time');
    positiveFiniteField(reader, plan.timeStep, 'Rigol sample interval', request);
    const finalTime = plan.timeStart + (plan.sampleCount - 1) * plan.timeStep;
    finiteField(reader, finalTime, 'Rigol final-sample time');
    totalSamples = reader.checkedSum([totalSamples, plan.sampleCount], 'Rigol channel samples');
    let group = timingGroups.find(
      (candidate) =>
        candidate[0].sampleCount === plan.sampleCount &&
        candidate[0].timeStart === plan.timeStart &&
        candidate[0].timeStep === plan.timeStep
    );
    if (!group) {
      group = [];
      timingGroups.push(group);
    }
    group.push(plan);
  }

  if (totalSamples > ScopeImportLimits.maxTotalChannelSamples) {
    importFailure(
      'decode-budget-exceeded',
      `Decoded Rigol channel-sample count ${totalSamples} exceeds the limit.`,
      format,
      request
    );
  }

  let timeSamples = 0;
  for (const group of timingGroups) {
    validateRecordShape(group[0].sampleCount, group.length, 0, format);
    timeSamples = reader.checkedSum([timeSamples, group[0].sampleCount], 'Rigol time-axis samples');
  }
  const predictedBytes = reader.checkedSum(
    [
      reader.checkedProduct(timeSamples, 8, 'Rigol time-axis bytes'),
      reader.checkedProduct(totalSamples, 10, 'Rigol channel working bytes'),
      temporaryBytes
    ],
    'Rigol decoded working set'
  );
  if (predictedBytes > ScopeImportLimits.maxDecodedBytes) {
    importFailure(
      'decode-budget-exceeded',
      `Predicted Rigol working set ${predictedBytes} bytes exceeds ${ScopeImportLimits.maxDecodedBytes} bytes.`,
      format,
      request
    );
  }
}

export function decodeFloat32Payload(
  reader: CheckedReader,
  request: ScopeImportRequest,
  offset: number,
  sampleCount: number,
  context: string
): FloatPayload {
  const byteLength = reader.checkedProduct(sampleCount, 4, `${context} byte length`);
  reader.requireRange(offset, byteLength, context);
  const values = new Float64Array(sampleCount);
  let invalidMask: Uint8Array | undefined;
  for (let index = 0; index < sampleCount; index += 1) {
    checkLoopCancellation(request, index);
    const value = reader.view.getFloat32(offset + index * 4, true);
    values[index] = value;
    if (!Number.isFinite(value)) {
      invalidMask ||= new Uint8Array(sampleCount);
      invalidMask[index] = 1;
    }
  }
  return { values, invalidMask };
}

function timeAxis(request: ScopeImportRequest, sampleCount: number, timeStart: number, timeStep: number): Float64Array {
  const result = new Float64Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    checkLoopCancellation(request, index);
    result[index] = timeStart + index * timeStep;
  }
  return result;
}

export function buildRecords(
  request: ScopeImportRequest,
  format: 'rigol-wfm' | 'rigol-bin',
  metadata: Record<string, string | number | boolean | null>,
  channels: readonly DecodedRigolChannel[]
): ImportedWaveformRecord[] {
  const groups: DecodedRigolChannel[][] = [];
  for (const channel of channels) {
    let group = groups.find(
      (candidate) =>
        candidate[0].sampleCount === channel.sampleCount &&
        candidate[0].timeStart === channel.timeStart &&
        candidate[0].timeStep === channel.timeStep
    );
    if (!group) {
      group = [];
      groups.push(group);
    }
    group.push(channel);
  }

  return groups.map((group, frameIndex) => {
    checkpoint(request);
    const first = group[0];
    const importedChannels: ImportedScopeChannel[] = group.map((channel) => ({
      name: channel.name,
      values: channel.values,
      unit: channel.unit,
      sourceUnit: channel.sourceUnit,
      sourceToSiScale: channel.sourceToSiScale,
      ...(channel.invalidMask ? { invalidMask: channel.invalidMask } : {}),
      calibrationSource: channel.calibrationSource
    }));
    return {
      sourceFormat: format,
      supportLevel: 'verified',
      timeSeconds: timeAxis(request, first.sampleCount, first.timeStart, first.timeStep),
      channels: importedChannels,
      frameIndex,
      metadata: {
        ...metadata,
        time_axis_group_count: groups.length,
        ...(groups.length > 1 ? { record_kind: 'per-channel-time-axis-group' } : {})
      },
      warnings: []
    };
  });
}

export function cleanAscii(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, '').trim();
}
