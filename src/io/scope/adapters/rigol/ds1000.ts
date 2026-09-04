import type { CheckedReader } from '../../limits';
import type { ImportedWaveformRecord, ScopeImportRequest } from '../../types';
import {
  assertBytes,
  assertExactLength,
  assertSignature,
  buildRecords,
  checkLoopCancellation,
  checkedEnd,
  checkpoint,
  cleanAscii,
  finiteField,
  importFailure,
  positiveFiniteField,
  requireKnownEnum,
  safeI64,
  validateChannelPlans,
  type ChannelTiming,
  type DecodedRigolChannel
} from './common';

interface ByteChannelPlan extends ChannelTiming {
  channelNumber: number;
  rawOffset: number;
  scale: number;
  offset: number;
  referenceCode: number;
  unit: string;
  calibrationSource: string;
}

function strictFlag(reader: CheckedReader, request: ScopeImportRequest, value: number, context: string): boolean {
  if (value !== 0 && value !== 1) {
    importFailure(
      'invalid-header',
      `${context} must be encoded as zero or one.`,
      reader.format || 'rigol-wfm',
      request
    );
  }
  return value === 1;
}

function decodeBytePlans(
  reader: CheckedReader,
  request: ScopeImportRequest,
  plans: readonly ByteChannelPlan[]
): DecodedRigolChannel[] {
  return plans.map((plan, planIndex) => {
    reader.requireRange(plan.rawOffset, plan.sampleCount, `Rigol CH${plan.channelNumber} samples`);
    finiteField(
      reader,
      plan.scale * (plan.referenceCode - 255) - plan.offset,
      `Rigol CH${plan.channelNumber} calibrated lower endpoint`
    );
    finiteField(
      reader,
      plan.scale * plan.referenceCode - plan.offset,
      `Rigol CH${plan.channelNumber} calibrated upper endpoint`
    );
    const values = new Float64Array(plan.sampleCount);
    for (let index = 0; index < plan.sampleCount; index += 1) {
      checkLoopCancellation(request, index);
      values[index] = plan.scale * (plan.referenceCode - reader.bytes[plan.rawOffset + index]) - plan.offset;
    }
    checkpoint(request, 0.2 + (0.65 * (planIndex + 1)) / plans.length, 'Decoding Rigol analogue channels');
    return {
      name: `CH${plan.channelNumber}`,
      values,
      unit: plan.unit,
      sourceUnit: plan.unit,
      sourceToSiScale: 1,
      calibrationSource: plan.calibrationSource,
      sampleCount: plan.sampleCount,
      timeStart: plan.timeStart,
      timeStep: plan.timeStep
    };
  });
}

function validateActiveCount(
  reader: CheckedReader,
  request: ScopeImportRequest,
  declared: number,
  actual: number,
  family: string
): void {
  if (declared !== actual) {
    importFailure(
      'length-mismatch',
      `${family} declares ${declared} active channels, but ${actual} channel headers are enabled.`,
      reader.format || 'rigol-wfm',
      request
    );
  }
}

export function decodeDs1000B(request: ScopeImportRequest, reader: CheckedReader): ImportedWaveformRecord[] {
  checkpoint(request, 0.02, 'Reading Rigol DS1000B header');
  assertSignature(reader, [0xa5, 0xa5, 0xa4, 0x01], 'Rigol DS1000B signature', request);
  reader.requireRange(0, 420, 'Rigol DS1000B header');

  // Fixture-backed DS1000B captures reserve a fixed 0xa000-byte region after
  // the 420-byte header. Only enabled channel slots are waveform data.
  assertExactLength(reader, 420 + 0xa000, 'Rigol DS1000B file extent', request);

  const embeddedModel = cleanAscii(reader.ascii(4, 8, 'Rigol DS1000B model'));
  const points = reader.u32(60, true, 'Rigol DS1000B point count');
  const declaredChannels = reader.u8(64, 'Rigol DS1000B active-channel count');
  const sampleRate = positiveFiniteField(
    reader,
    reader.f32(180, true, 'Rigol DS1000B sample rate'),
    'Rigol DS1000B sample rate',
    request
  );
  const timeOffset = safeI64(reader, 172, 'Rigol DS1000B time offset') * 1e-12;
  finiteField(reader, reader.u64(164, true, 'Rigol DS1000B time scale') * 1e-12, 'Rigol DS1000B time scale');
  requireKnownEnum(
    reader,
    reader.u8(222, 'Rigol DS1000B trigger mode'),
    [0, 1, 2, 3, 4, 5, 6],
    'Rigol DS1000B trigger mode',
    request
  );
  requireKnownEnum(
    reader,
    reader.u8(224, 'Rigol DS1000B trigger source'),
    [0, 1, 2, 3, 5, 7],
    'Rigol DS1000B trigger source',
    request
  );

  const secondsPerPoint = 1 / sampleRate;
  const halfWindow = (points * secondsPerPoint) / 2;
  const timeStart = timeOffset - halfWindow;
  const timeStep = points > 1 ? (points * secondsPerPoint) / (points - 1) : secondsPerPoint;
  const plans: ByteChannelPlan[] = [];

  for (let channelIndex = 0; channelIndex < 4; channelIndex += 1) {
    const headerOffset = 68 + channelIndex * 24;
    const enabled = strictFlag(
      reader,
      request,
      reader.u8(headerOffset + 14, `Rigol DS1000B CH${channelIndex + 1} enabled flag`),
      `Rigol DS1000B CH${channelIndex + 1} enabled flag`
    );
    const inverted = strictFlag(
      reader,
      request,
      reader.u8(headerOffset + 15, `Rigol DS1000B CH${channelIndex + 1} invert flag`),
      `Rigol DS1000B CH${channelIndex + 1} invert flag`
    );
    if (!enabled) continue;

    const probe = positiveFiniteField(
      reader,
      reader.f32(headerOffset + 8, true, `Rigol DS1000B CH${channelIndex + 1} probe ratio`),
      `Rigol DS1000B CH${channelIndex + 1} probe ratio`,
      request
    );
    const measuredScale = reader.i32(headerOffset + 16, true, `Rigol DS1000B CH${channelIndex + 1} measured scale`);
    if (measuredScale === 0) {
      importFailure(
        'invalid-header',
        `Rigol DS1000B CH${channelIndex + 1} has a zero vertical scale.`,
        'rigol-wfm',
        request
      );
    }
    const voltsPerDivision = (inverted ? -1 : 1) * 1e-6 * measuredScale * probe;
    const voltsPerCode = voltsPerDivision / 25;
    const verticalOffset =
      reader.i16(headerOffset + 20, true, `Rigol DS1000B CH${channelIndex + 1} measured shift`) * voltsPerCode;
    const calibratedOffset = verticalOffset + 1.12 * voltsPerDivision;
    finiteField(reader, calibratedOffset, `Rigol DS1000B CH${channelIndex + 1} vertical offset`);
    const rawOffset = reader.checkedSum(
      [420, reader.checkedProduct(channelIndex, points, 'Rigol DS1000B channel offset')],
      'Rigol DS1000B channel data offset'
    );
    checkedEnd(reader, rawOffset, points, `Rigol DS1000B CH${channelIndex + 1} samples`);
    plans.push({
      channelNumber: channelIndex + 1,
      rawOffset,
      scale: voltsPerCode,
      offset: calibratedOffset,
      referenceCode: 127,
      unit: 'V',
      calibrationSource: 'Rigol DS1000B signed V/div/25 calibration, ADC reference 127 and 1.12-division bias',
      sampleCount: points,
      timeStart,
      timeStep
    });
  }

  validateActiveCount(reader, request, declaredChannels, plans.length, 'Rigol DS1000B');
  validateChannelPlans(reader, request, plans);
  const channels = decodeBytePlans(reader, request, plans);
  const records = buildRecords(
    request,
    'rigol-wfm',
    {
      brand: 'Rigol',
      family: 'DS1000B',
      parser: 'wfm1000b',
      instrument_model: 'DS1000B',
      embedded_model: embeddedModel || null,
      firmware_version: 'unknown'
    },
    channels
  );
  checkpoint(request, 1, 'Rigol DS1000B decoded');
  return records;
}

export function decodeDs1000C(request: ScopeImportRequest, reader: CheckedReader): ImportedWaveformRecord[] {
  checkpoint(request, 0.02, 'Reading Rigol DS1000C header');
  reader.requireRange(0, 145, 'Rigol DS1000C header');
  const leadingByte = reader.u8(0, 'Rigol DS1000C leading byte');
  if (leadingByte !== 0xa1 && leadingByte !== 0xa5) {
    importFailure('invalid-header', 'Rigol DS1000C leading byte is not supported.', 'rigol-wfm', request);
  }
  assertBytes(reader, 1, [0xa5, 0x00, 0x00], 'Rigol DS1000C signature', request);

  const points = reader.u32(28, true, 'Rigol DS1000C point count');
  const declaredChannels = reader.u8(32, 'Rigol DS1000C active-channel count');
  const sampleRate = positiveFiniteField(
    reader,
    reader.f32(100, true, 'Rigol DS1000C sample rate'),
    'Rigol DS1000C sample rate',
    request
  );
  const timeOffset = safeI64(reader, 92, 'Rigol DS1000C time offset') * 1e-12;
  finiteField(reader, reader.u64(84, true, 'Rigol DS1000C time scale') * 1e-12, 'Rigol DS1000C time scale');
  requireKnownEnum(
    reader,
    reader.u8(142, 'Rigol DS1000C trigger mode'),
    [0, 1, 2, 3, 4, 5, 6],
    'Rigol DS1000C trigger mode',
    request
  );
  requireKnownEnum(
    reader,
    reader.u8(144, 'Rigol DS1000C trigger source'),
    [0, 1, 2, 3, 5, 7],
    'Rigol DS1000C trigger source',
    request
  );

  const secondsPerPoint = 1 / sampleRate;
  const halfWindow = (points * secondsPerPoint) / 2;
  const timeStart = timeOffset - halfWindow;
  const timeStep = points > 1 ? (points * secondsPerPoint) / (points - 1) : secondsPerPoint;
  const dataStart = leadingByte === 0xa5 ? 272 : 256;
  let rawOffset = dataStart;
  const plans: ByteChannelPlan[] = [];

  for (let channelIndex = 0; channelIndex < 2; channelIndex += 1) {
    const headerOffset = 36 + channelIndex * 24;
    const enabled = strictFlag(
      reader,
      request,
      reader.u8(headerOffset + 13, `Rigol DS1000C CH${channelIndex + 1} enabled flag`),
      `Rigol DS1000C CH${channelIndex + 1} enabled flag`
    );
    const inverted = strictFlag(
      reader,
      request,
      reader.u8(headerOffset + 14, `Rigol DS1000C CH${channelIndex + 1} invert flag`),
      `Rigol DS1000C CH${channelIndex + 1} invert flag`
    );
    if (!enabled) continue;

    const probe = positiveFiniteField(
      reader,
      reader.f32(headerOffset + 8, true, `Rigol DS1000C CH${channelIndex + 1} probe ratio`),
      `Rigol DS1000C CH${channelIndex + 1} probe ratio`,
      request
    );
    const measuredScale = reader.i32(headerOffset + 16, true, `Rigol DS1000C CH${channelIndex + 1} measured scale`);
    if (measuredScale === 0) {
      importFailure(
        'invalid-header',
        `Rigol DS1000C CH${channelIndex + 1} has a zero vertical scale.`,
        'rigol-wfm',
        request
      );
    }
    const voltsPerDivision = (inverted ? -1 : 1) * 1e-6 * measuredScale * probe;
    const voltsPerCode = voltsPerDivision / 25;
    const verticalOffset =
      reader.i16(headerOffset + 20, true, `Rigol DS1000C CH${channelIndex + 1} measured shift`) * voltsPerCode;
    checkedEnd(reader, rawOffset, points, `Rigol DS1000C CH${channelIndex + 1} samples`);
    plans.push({
      channelNumber: channelIndex + 1,
      rawOffset,
      scale: voltsPerCode,
      offset: verticalOffset,
      referenceCode: 125,
      unit: 'V',
      calibrationSource: 'Rigol DS1000C signed V/div/25 calibration with ADC reference 125',
      sampleCount: points,
      timeStart,
      timeStep
    });
    rawOffset = reader.checkedSum([rawOffset, points], 'Rigol DS1000C payload extent');
  }

  validateActiveCount(reader, request, declaredChannels, plans.length, 'Rigol DS1000C');
  assertExactLength(reader, rawOffset, 'Rigol DS1000C file extent', request);
  validateChannelPlans(reader, request, plans);
  const channels = decodeBytePlans(reader, request, plans);
  const records = buildRecords(
    request,
    'rigol-wfm',
    {
      brand: 'Rigol',
      family: 'DS1000C',
      parser: 'wfm1000c',
      instrument_model: 'DS1000C',
      firmware_version: 'unknown'
    },
    channels
  );
  checkpoint(request, 1, 'Rigol DS1000C decoded');
  return records;
}

export function decodeDs1000E(request: ScopeImportRequest, reader: CheckedReader): ImportedWaveformRecord[] {
  checkpoint(request, 0.02, 'Reading Rigol DS1000D/E header');
  assertSignature(reader, [0xa5, 0xa5, 0x00, 0x00], 'Rigol DS1000D/E signature', request);
  reader.requireRange(0, 276, 'Rigol DS1000D/E header');

  const logicEnabled = (reader.u8(120, 'Rigol DS1000D/E logic flags') & 1) !== 0;
  if (logicEnabled) {
    importFailure(
      'unsupported-variant',
      'Rigol DS1000D/E logic-analyser records are not supported.',
      'rigol-wfm',
      request
    );
  }

  const memoryDepth1 = reader.u32(28, true, 'Rigol DS1000D/E CH1 memory depth');
  const declaredChannels = reader.u8(32, 'Rigol DS1000D/E active-channel count');
  const rollStop = reader.u32(20, true, 'Rigol DS1000D/E rolling stop');
  const skip = rollStop === 0 ? 0 : reader.checkedSum([rollStop, 2], 'Rigol rolling padding');
  const sampleRate = positiveFiniteField(
    reader,
    reader.f32(100, true, 'Rigol DS1000D/E sample rate'),
    'Rigol DS1000D/E sample rate',
    request
  );
  const secondsPerPoint = 1 / sampleRate;
  const timeOffset1 = safeI64(reader, 112, 'Rigol DS1000D/E CH1 time offset') * 1e-12;
  finiteField(reader, safeI64(reader, 104, 'Rigol DS1000D/E CH1 time scale') * 1e-12, 'Rigol DS1000D/E CH1 time scale');
  const triggerMode = reader.u8(142, 'Rigol DS1000D/E trigger mode');
  requireKnownEnum(reader, triggerMode, [0, 1, 2, 3, 4, 5, 6], 'Rigol DS1000D/E trigger mode', request);

  const enabledFlags = [0, 1].map((channelIndex) => {
    const headerOffset = 34 + channelIndex * 24;
    return strictFlag(
      reader,
      request,
      reader.u8(headerOffset + 15, `Rigol DS1000D/E CH${channelIndex + 1} enabled flag`),
      `Rigol DS1000D/E CH${channelIndex + 1} enabled flag`
    );
  });
  validateActiveCount(reader, request, declaredChannels, enabledFlags.filter(Boolean).length, 'Rigol DS1000D/E');

  const memoryDepth2Raw = reader.u32(232, true, 'Rigol DS1000D/E CH2 memory depth');
  const memoryDepths = [memoryDepth1, enabledFlags[1] && memoryDepth2Raw === 0 ? memoryDepth1 : memoryDepth2Raw];
  const timeOffset2 = triggerMode === 4 ? safeI64(reader, 264, 'Rigol DS1000D/E CH2 time offset') * 1e-12 : timeOffset1;
  if (triggerMode === 4) {
    finiteField(
      reader,
      safeI64(reader, 256, 'Rigol DS1000D/E CH2 time scale') * 1e-12,
      'Rigol DS1000D/E CH2 time scale'
    );
  }

  let rawOffset = 276;
  const plans: ByteChannelPlan[] = [];
  for (let channelIndex = 0; channelIndex < 2; channelIndex += 1) {
    if (!enabledFlags[channelIndex]) continue;
    const memoryDepth = memoryDepths[channelIndex];
    if (memoryDepth <= skip) {
      importFailure(
        'invalid-header',
        `Rigol DS1000D/E CH${channelIndex + 1} rolling padding consumes the waveform.`,
        'rigol-wfm',
        request
      );
    }
    const sampleCount = memoryDepth - skip;
    checkedEnd(reader, rawOffset, memoryDepth, `Rigol DS1000D/E CH${channelIndex + 1} stored samples`);
    const headerOffset = 34 + channelIndex * 24;
    const inverted = strictFlag(
      reader,
      request,
      reader.u8(headerOffset + 16, `Rigol DS1000D/E CH${channelIndex + 1} invert flag`),
      `Rigol DS1000D/E CH${channelIndex + 1} invert flag`
    );
    const probe = positiveFiniteField(
      reader,
      reader.f32(headerOffset + 10, true, `Rigol DS1000D/E CH${channelIndex + 1} probe ratio`),
      `Rigol DS1000D/E CH${channelIndex + 1} probe ratio`,
      request
    );
    const measuredScale = reader.i32(headerOffset + 18, true, `Rigol DS1000D/E CH${channelIndex + 1} measured scale`);
    if (measuredScale === 0) {
      importFailure(
        'invalid-header',
        `Rigol DS1000D/E CH${channelIndex + 1} has a zero vertical scale.`,
        'rigol-wfm',
        request
      );
    }
    // This layout stores a positive ADC scale even when the display inversion
    // flag changes the signed V/div metadata.
    const voltsPerCode = (1e-6 * measuredScale * probe) / 25;
    finiteField(
      reader,
      (inverted ? -1 : 1) * 1e-6 * measuredScale * probe,
      `Rigol DS1000D/E CH${channelIndex + 1} volts per division`
    );
    const verticalOffset =
      reader.i16(headerOffset + 22, true, `Rigol DS1000D/E CH${channelIndex + 1} measured shift`) * voltsPerCode;
    const channelTimeOffset = channelIndex === 0 ? timeOffset1 : timeOffset2;
    plans.push({
      channelNumber: channelIndex + 1,
      rawOffset,
      scale: voltsPerCode,
      offset: verticalOffset,
      referenceCode: 125,
      unit: 'V',
      calibrationSource: 'Rigol DS1000D/E positive measured-scale/25 calibration with ADC reference 125',
      sampleCount,
      timeStart: channelTimeOffset - (memoryDepth * secondsPerPoint) / 2,
      timeStep: secondsPerPoint
    });
    rawOffset = reader.checkedSum([rawOffset, memoryDepth], 'Rigol DS1000D/E payload extent');
  }

  assertExactLength(reader, rawOffset, 'Rigol DS1000D/E file extent', request);
  validateChannelPlans(reader, request, plans);
  const channels = decodeBytePlans(reader, request, plans);
  const records = buildRecords(
    request,
    'rigol-wfm',
    {
      brand: 'Rigol',
      family: 'DS1000D/E',
      parser: 'wfm1000e',
      instrument_model: 'DS1000E',
      firmware_version: 'unknown',
      rolling_padding_samples: skip
    },
    channels
  );
  checkpoint(request, 1, 'Rigol DS1000D/E decoded');
  return records;
}
