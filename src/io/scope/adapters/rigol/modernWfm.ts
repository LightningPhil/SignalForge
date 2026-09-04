import type { CheckedReader } from '../../limits';
import type { ImportedWaveformRecord, ScopeImportRequest } from '../../types';
import {
  assertBytes,
  assertExactLength,
  assertSignature,
  buildRecords,
  checkLoopCancellation,
  checkpoint,
  cleanAscii,
  couplingFromCode,
  finiteField,
  importFailure,
  positiveFiniteField,
  probeRatioFromCode,
  requireKnownEnum,
  safeI64,
  unitFromLegacyCode,
  validateChannelPlans,
  type ChannelTiming,
  type DecodedRigolChannel
} from './common';

interface ModernChannel {
  channelNumber: number;
  enabled: boolean;
  scale: number;
  offset: number;
  unit: string;
}

interface ModernPlan extends ChannelTiming, ModernChannel {
  rawOffset: number;
  alternateRawOffset?: number;
}

function strictBoolean(reader: CheckedReader, request: ScopeImportRequest, value: number, context: string): boolean {
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

function channelMask(reader: CheckedReader, request: ScopeImportRequest): boolean[] {
  const mask = reader.u8(64, 'Rigol analogue channel mask');
  if ((mask & 0xf0) !== 0) {
    importFailure(
      'unsupported-variant',
      'Rigol channel mask contains unsupported non-analogue bits.',
      'rigol-wfm',
      request
    );
  }
  const flags = [0, 1, 2, 3].map((index) => (mask & (1 << index)) !== 0);
  if (!flags.some(Boolean)) {
    importFailure('unsupported-variant', 'Rigol WFM file contains no enabled analogue channels.', 'rigol-wfm', request);
  }
  return flags;
}

function parseDs2000Channel(
  reader: CheckedReader,
  request: ScopeImportRequest,
  channelIndex: number,
  maskEnabled: boolean
): ModernChannel {
  const offset = 120 + channelIndex * 28;
  const enabledRaw = reader.u8(offset, `Rigol DS2000 CH${channelIndex + 1} enabled flag`);
  const enabled = enabledRaw !== 0;
  if (enabled !== maskEnabled) {
    importFailure(
      'length-mismatch',
      `Rigol DS2000 CH${channelIndex + 1} mask and channel header disagree.`,
      'rigol-wfm',
      request
    );
  }
  if (!enabled) {
    return {
      channelNumber: channelIndex + 1,
      enabled: false,
      scale: 0,
      offset: 0,
      unit: ''
    };
  }
  const coupling = reader.u8(offset + 1, `Rigol DS2000 CH${channelIndex + 1} coupling`) >> 6;
  couplingFromCode(reader, coupling, `Rigol DS2000 CH${channelIndex + 1} coupling`, request);
  requireKnownEnum(
    reader,
    reader.u8(offset + 2, `Rigol DS2000 CH${channelIndex + 1} bandwidth`),
    [0, 1, 2, 3, 4],
    `Rigol DS2000 CH${channelIndex + 1} bandwidth`,
    request
  );
  requireKnownEnum(
    reader,
    reader.u8(offset + 3, `Rigol DS2000 CH${channelIndex + 1} probe type`),
    [0, 1],
    `Rigol DS2000 CH${channelIndex + 1} probe type`,
    request
  );
  probeRatioFromCode(
    reader,
    reader.u8(offset + 4, `Rigol DS2000 CH${channelIndex + 1} probe ratio`),
    `Rigol DS2000 CH${channelIndex + 1} probe ratio`,
    request
  );
  requireKnownEnum(
    reader,
    reader.u8(offset + 7, `Rigol DS2000 CH${channelIndex + 1} impedance`),
    [0, 1],
    `Rigol DS2000 CH${channelIndex + 1} impedance`,
    request
  );

  const voltsPerDivision = positiveFiniteField(
    reader,
    reader.f32(offset + 8, true, `Rigol DS2000 CH${channelIndex + 1} scale`),
    `Rigol DS2000 CH${channelIndex + 1} scale`,
    request
  );
  const verticalOffset = finiteField(
    reader,
    reader.f32(offset + 12, true, `Rigol DS2000 CH${channelIndex + 1} offset`),
    `Rigol DS2000 CH${channelIndex + 1} offset`
  );
  const legacyLayout = enabledRaw === 1;
  const invertedRaw = reader.u8(offset + (legacyLayout ? 16 : 17), `Rigol DS2000 CH${channelIndex + 1} invert flag`);
  const inverted = strictBoolean(reader, request, invertedRaw, `Rigol DS2000 CH${channelIndex + 1} invert flag`);
  const unitCode = reader.u8(offset + (legacyLayout ? 17 : 16), `Rigol DS2000 CH${channelIndex + 1} unit`);
  const unit = unitFromLegacyCode(reader, unitCode, `Rigol DS2000 CH${channelIndex + 1} unit`, request);
  return {
    channelNumber: channelIndex + 1,
    enabled,
    // DS2000 stores increasing voltage with increasing ADC code. The common
    // equation below is scale*(127-code)-offset, hence this family sign.
    scale: -((inverted ? -1 : 1) * voltsPerDivision) / 25,
    offset: verticalOffset,
    unit
  };
}

function parseDs4000Channel(
  reader: CheckedReader,
  request: ScopeImportRequest,
  channelIndex: number,
  maskEnabled: boolean,
  divisor: number
): ModernChannel {
  const offset = 124 + channelIndex * 28;
  const enabled = reader.u8(offset, `Rigol DS4000 CH${channelIndex + 1} enabled flag`) !== 0;
  if (enabled !== maskEnabled) {
    importFailure(
      'length-mismatch',
      `Rigol DS4000 CH${channelIndex + 1} mask and channel header disagree.`,
      'rigol-wfm',
      request
    );
  }
  if (!enabled) {
    return {
      channelNumber: channelIndex + 1,
      enabled: false,
      scale: 0,
      offset: 0,
      unit: ''
    };
  }
  couplingFromCode(
    reader,
    reader.u8(offset + 1, `Rigol DS4000 CH${channelIndex + 1} coupling`),
    `Rigol DS4000 CH${channelIndex + 1} coupling`,
    request
  );
  requireKnownEnum(
    reader,
    reader.u8(offset + 2, `Rigol DS4000 CH${channelIndex + 1} bandwidth`),
    [0, 1, 2, 3, 4],
    `Rigol DS4000 CH${channelIndex + 1} bandwidth`,
    request
  );
  requireKnownEnum(
    reader,
    reader.u8(offset + 3, `Rigol DS4000 CH${channelIndex + 1} probe type`),
    [0, 1],
    `Rigol DS4000 CH${channelIndex + 1} probe type`,
    request
  );
  probeRatioFromCode(
    reader,
    reader.u8(offset + 4, `Rigol DS4000 CH${channelIndex + 1} probe ratio`),
    `Rigol DS4000 CH${channelIndex + 1} probe ratio`,
    request
  );
  requireKnownEnum(
    reader,
    reader.u8(offset + 7, `Rigol DS4000 CH${channelIndex + 1} impedance`),
    [0, 1],
    `Rigol DS4000 CH${channelIndex + 1} impedance`,
    request
  );
  const voltsPerDivision = positiveFiniteField(
    reader,
    reader.f32(offset + 8, true, `Rigol DS4000 CH${channelIndex + 1} scale`),
    `Rigol DS4000 CH${channelIndex + 1} scale`,
    request
  );
  const verticalOffset = finiteField(
    reader,
    reader.f32(offset + 12, true, `Rigol DS4000 CH${channelIndex + 1} offset`),
    `Rigol DS4000 CH${channelIndex + 1} offset`
  );
  const inverted = strictBoolean(
    reader,
    request,
    reader.u8(offset + 16, `Rigol DS4000 CH${channelIndex + 1} invert flag`),
    `Rigol DS4000 CH${channelIndex + 1} invert flag`
  );
  const unit = unitFromLegacyCode(
    reader,
    reader.u8(offset + 17, `Rigol DS4000 CH${channelIndex + 1} unit`),
    `Rigol DS4000 CH${channelIndex + 1} unit`,
    request
  );
  return {
    channelNumber: channelIndex + 1,
    enabled,
    scale: -((inverted ? -1 : 1) * voltsPerDivision) / divisor,
    offset: verticalOffset,
    unit
  };
}

function decodeModernPlans(
  reader: CheckedReader,
  request: ScopeImportRequest,
  plans: readonly ModernPlan[],
  calibrationSource: string
): DecodedRigolChannel[] {
  return plans.map((plan, planIndex) => {
    finiteField(
      reader,
      plan.scale * (127 - 255) - plan.offset,
      `Rigol CH${plan.channelNumber} calibrated lower endpoint`
    );
    finiteField(reader, plan.scale * 127 - plan.offset, `Rigol CH${plan.channelNumber} calibrated upper endpoint`);
    const values = new Float64Array(plan.sampleCount);
    for (let index = 0; index < plan.sampleCount; index += 1) {
      checkLoopCancellation(request, index);
      let raw: number;
      if (plan.alternateRawOffset === undefined) {
        raw = reader.bytes[plan.rawOffset + index];
      } else {
        raw =
          index % 2 === 0
            ? reader.bytes[plan.rawOffset + index / 2]
            : reader.bytes[plan.alternateRawOffset + (index - 1) / 2];
      }
      values[index] = plan.scale * (127 - raw) - plan.offset;
    }
    checkpoint(request, 0.25 + (0.6 * (planIndex + 1)) / plans.length, 'Decoding Rigol WFM channels');
    return {
      name: `CH${plan.channelNumber}`,
      values,
      unit: plan.unit,
      sourceUnit: plan.unit,
      sourceToSiScale: 1,
      calibrationSource,
      sampleCount: plan.sampleCount,
      timeStart: plan.timeStart,
      timeStep: plan.timeStep
    };
  });
}

export function decodeDs2000(request: ScopeImportRequest, reader: CheckedReader): ImportedWaveformRecord[] {
  checkpoint(request, 0.02, 'Reading Rigol DS2000 header');
  assertSignature(reader, [0xa5, 0xa5, 0x38, 0x00], 'Rigol DS2000 signature', request);
  reader.requireRange(0, 396, 'Rigol DS2000 header');
  const embeddedModel = cleanAscii(reader.ascii(4, 20, 'Rigol DS2000 model'));
  if (!/^(?:DS|MSO)2/i.test(embeddedModel)) {
    importFailure(
      'unsupported-variant',
      `Rigol DS2000 layout carries unsupported model "${embeddedModel || 'unknown'}".`,
      'rigol-wfm',
      request
    );
  }
  const firmware = cleanAscii(reader.ascii(24, 20, 'Rigol DS2000 firmware'));
  assertBytes(reader, 44, [0x01, 0x00], 'Rigol DS2000 block marker', request);
  if (reader.u16(60, true, 'Rigol DS2000 structure size') !== 420) {
    importFailure(
      'unsupported-variant',
      'Rigol DS2000 structure size is not the fixture-backed 420-byte layout.',
      'rigol-wfm',
      request
    );
  }

  const enabledFlags = channelMask(reader, request);
  const interwovenByte = reader.u8(65, 'Rigol DS2000 interwoven flags');
  if ((interwovenByte & 0xfe) !== 0) {
    importFailure(
      'unsupported-variant',
      'Rigol DS2000 interwoven flags contain unsupported bits.',
      'rigol-wfm',
      request
    );
  }
  const interwoven = (interwovenByte & 1) !== 0;
  requireKnownEnum(
    reader,
    reader.u16(84, true, 'Rigol DS2000 acquisition mode'),
    [0, 1, 2, 3],
    'Rigol DS2000 acquisition mode',
    request
  );
  const timeMode = reader.u16(102, true, 'Rigol DS2000 time mode');
  requireKnownEnum(reader, timeMode, [0, 1, 2], 'Rigol DS2000 time mode', request);
  if (timeMode !== 0) {
    importFailure(
      'unsupported-variant',
      'Rigol DS2000 XY and roll records need dedicated timing support.',
      'rigol-wfm',
      request
    );
  }

  const settings = [0, 1, 2, 3].map((index) => parseDs2000Channel(reader, request, index, enabledFlags[index]));
  const offsets = [0, 1, 2, 3].map((index) =>
    reader.u32(68 + index * 4, true, `Rigol DS2000 CH${index + 1} data offset`)
  );
  const sampleRate = positiveFiniteField(
    reader,
    reader.f32(96, true, 'Rigol DS2000 sample rate'),
    'Rigol DS2000 sample rate',
    request
  );
  const secondsPerPoint = 1 / sampleRate;
  finiteField(reader, reader.u64(104, true, 'Rigol DS2000 time scale') * 1e-12, 'Rigol DS2000 time scale');
  const storedTimeOffset = safeI64(reader, 112, 'Rigol DS2000 time offset') * 1e-12;
  const zPointOffset = reader.u32(248, true, 'Rigol DS2000 valid-point offset');
  const effectiveTimeOffset =
    (embeddedModel.startsWith('DS2A') && firmware === '00.03.00.01.03' ? 0 : storedTimeOffset) +
    zPointOffset * secondsPerPoint;
  const storageDepth = reader.u32(244, true, 'Rigol DS2000 storage depth');
  const waveformLength = reader.u32(252, true, 'Rigol DS2000 waveform length');
  if (storageDepth === 0 || waveformLength === 0) {
    importFailure(
      'invalid-header',
      'Rigol DS2000 storage depth and waveform length must be non-zero.',
      'rigol-wfm',
      request
    );
  }
  const setupLength = reader.u32(232, true, 'Rigol DS2000 setup length');
  const setupOffset = reader.u32(236, true, 'Rigol DS2000 setup offset');
  const waveformBlockOffset = reader.u32(240, true, 'Rigol DS2000 waveform-block offset');
  if (setupOffset < 56) {
    importFailure('invalid-header', 'Rigol DS2000 setup offset precedes the file header.', 'rigol-wfm', request);
  }
  const setupStart = setupOffset - 56;
  reader.requireRange(setupStart, setupLength, 'Rigol DS2000 setup block');
  const storedOffsets = interwoven
    ? offsets.slice(0, 2)
    : offsets.filter((offset, index) => enabledFlags[index] && offset > 0);
  const firstStoredOffset = Math.min(...storedOffsets);
  if (reader.checkedSum([setupStart, setupLength], 'Rigol DS2000 setup extent') > firstStoredOffset) {
    importFailure('invalid-header', 'Rigol DS2000 setup data overlaps the waveform blocks.', 'rigol-wfm', request);
  }

  const commonTiming = {
    timeStart: effectiveTimeOffset - (storageDepth * secondsPerPoint) / 2,
    timeStep: secondsPerPoint
  };
  const plans: ModernPlan[] = [];
  if (interwoven) {
    const enabled = settings.filter((channel) => channel.enabled);
    if (enabled.length !== 1 || waveformLength % 2 !== 0 || offsets[0] === 0 || offsets[1] === 0) {
      importFailure(
        'unsupported-variant',
        'Rigol DS2000 interwoven records require one analogue channel and two equal ADC lanes.',
        'rigol-wfm',
        request
      );
    }
    const laneLength = waveformLength / 2;
    const blockStride = offsets[1] - offsets[0];
    if (offsets[0] <= waveformBlockOffset || blockStride <= laneLength) {
      importFailure(
        'invalid-header',
        'Rigol DS2000 interwoven waveform-block extents are inconsistent.',
        'rigol-wfm',
        request
      );
    }
    const expectedFileLength = reader.checkedSum(
      [waveformBlockOffset, reader.checkedProduct(2, blockStride, 'Rigol DS2000 interwoven block bytes')],
      'Rigol DS2000 file extent'
    );
    assertExactLength(reader, expectedFileLength, 'Rigol DS2000 file extent', request);
    const firstLane = reader.checkedSum([offsets[0], zPointOffset], 'Rigol DS2000 first interwoven lane offset');
    const secondLane = reader.checkedSum([offsets[1], zPointOffset], 'Rigol DS2000 second interwoven lane offset');
    reader.requireRange(firstLane, laneLength, 'Rigol DS2000 first interwoven ADC lane');
    reader.requireRange(secondLane, laneLength, 'Rigol DS2000 second interwoven ADC lane');
    if (firstLane < secondLane + laneLength && secondLane < firstLane + laneLength) {
      importFailure('invalid-header', 'Rigol DS2000 interwoven ADC lanes overlap.', 'rigol-wfm', request);
    }
    plans.push({
      ...enabled[0],
      ...commonTiming,
      sampleCount: waveformLength,
      rawOffset: firstLane,
      alternateRawOffset: secondLane
    });
  } else {
    if (waveformLength !== storageDepth) {
      importFailure(
        'length-mismatch',
        `Rigol DS2000 non-interwoven waveform length ${waveformLength} does not match storage depth ${storageDepth}.`,
        'rigol-wfm',
        request
      );
    }
    for (let channelIndex = 0; channelIndex < 4; channelIndex += 1) {
      const setting = settings[channelIndex];
      if (!setting.enabled) continue;
      if (offsets[channelIndex] === 0) {
        importFailure(
          'length-mismatch',
          `Rigol DS2000 CH${channelIndex + 1} is enabled without a data offset.`,
          'rigol-wfm',
          request
        );
      }
      const rawOffset = reader.checkedSum(
        [offsets[channelIndex], zPointOffset],
        `Rigol DS2000 CH${channelIndex + 1} sample offset`
      );
      reader.requireRange(rawOffset, waveformLength, `Rigol DS2000 CH${channelIndex + 1} samples`);
      plans.push({
        ...setting,
        ...commonTiming,
        sampleCount: waveformLength,
        rawOffset
      });
    }
    for (let left = 0; left < plans.length; left += 1) {
      const leftStart = plans[left].rawOffset;
      const leftEnd = reader.checkedSum([leftStart, waveformLength], 'Rigol DS2000 channel range end');
      for (let right = left + 1; right < plans.length; right += 1) {
        const rightStart = plans[right].rawOffset;
        const rightEnd = reader.checkedSum([rightStart, waveformLength], 'Rigol DS2000 channel range end');
        if (leftStart < rightEnd && rightStart < leftEnd) {
          importFailure(
            'invalid-header',
            `Rigol DS2000 CH${plans[left].channelNumber} and CH${plans[right].channelNumber} sample ranges overlap.`,
            'rigol-wfm',
            request
          );
        }
      }
    }
  }

  validateChannelPlans(reader, request, plans, interwoven ? waveformLength : 0);
  const channels = decodeModernPlans(
    reader,
    request,
    plans,
    'Rigol DS2000 signed V/div/25 calibration with increasing-code polarity and ADC reference 127'
  );
  const records = buildRecords(
    request,
    'rigol-wfm',
    {
      brand: 'Rigol',
      family: 'DS2000',
      parser: 'wfm2000',
      instrument_model: 'DS2000',
      embedded_model: embeddedModel,
      serial_number: embeddedModel,
      firmware_version: firmware || 'unknown',
      interwoven
    },
    channels
  );
  checkpoint(request, 1, 'Rigol DS2000 decoded');
  return records;
}

export function decodeDs4000(request: ScopeImportRequest, reader: CheckedReader): ImportedWaveformRecord[] {
  checkpoint(request, 0.02, 'Reading Rigol DS4000 header');
  assertSignature(reader, [0xa5, 0xa5, 0x38, 0x00], 'Rigol DS4000 signature', request);
  reader.requireRange(0, 603, 'Rigol DS4000 header');
  const embeddedModel = cleanAscii(reader.ascii(4, 20, 'Rigol DS4000 model'));
  if (!/^(?:DS|MSO)4/i.test(embeddedModel)) {
    importFailure(
      'unsupported-variant',
      `Rigol DS4000 layout carries unsupported model "${embeddedModel || 'unknown'}".`,
      'rigol-wfm',
      request
    );
  }
  const firmware = cleanAscii(reader.ascii(24, 20, 'Rigol DS4000 firmware'));
  const enabledFlags = channelMask(reader, request);
  const channelCount = enabledFlags.filter(Boolean).length;
  const memoryDepth1 = reader.u32(96, true, 'Rigol DS4000 primary memory depth');
  const memoryDepth2 = reader.u32(260, true, 'Rigol DS4000 secondary memory depth');
  const memoryDepth = reader.u32(268, true, 'Rigol DS4000 waveform depth');
  if (memoryDepth === 0 || memoryDepth1 !== memoryDepth || memoryDepth2 !== memoryDepth) {
    importFailure('length-mismatch', 'Rigol DS4000 memory-depth fields do not agree.', 'rigol-wfm', request);
  }
  const totalSamples = reader.u32(480, true, 'Rigol DS4000 total sample count');
  if (totalSamples !== reader.checkedProduct(memoryDepth, channelCount, 'Rigol DS4000 total samples')) {
    importFailure(
      'length-mismatch',
      'Rigol DS4000 total sample count does not match its enabled channels.',
      'rigol-wfm',
      request
    );
  }
  requireKnownEnum(
    reader,
    reader.u8(500, 'Rigol DS4000 memory-depth type'),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    'Rigol DS4000 memory-depth type',
    request
  );

  const bytesPerChannel1 = reader.u32(308, true, 'Rigol DS4000 channel-block size 1');
  const bytesPerChannel2 = reader.u32(312, true, 'Rigol DS4000 channel-block size 2');
  if (bytesPerChannel1 < memoryDepth || bytesPerChannel2 < memoryDepth) {
    importFailure(
      'length-mismatch',
      'Rigol DS4000 channel blocks are shorter than the waveform depth.',
      'rigol-wfm',
      request
    );
  }
  const positions = [0, 1, 2, 3].map((index) =>
    reader.u32(68 + index * 4, true, `Rigol DS4000 CH${index + 1} data offset`)
  );
  const activePositions = positions.filter((position, index) => enabledFlags[index] && position > 0);
  if (activePositions.length !== channelCount) {
    importFailure('length-mismatch', 'Rigol DS4000 enabled-channel offsets are incomplete.', 'rigol-wfm', request);
  }
  for (let left = 0; left < activePositions.length; left += 1) {
    for (let right = left + 1; right < activePositions.length; right += 1) {
      if (
        activePositions[left] < activePositions[right] + memoryDepth &&
        activePositions[right] < activePositions[left] + memoryDepth
      ) {
        importFailure('invalid-header', 'Rigol DS4000 analogue channel sample ranges overlap.', 'rigol-wfm', request);
      }
    }
  }
  const firstDataOffset = Math.min(...activePositions);
  if (firstDataOffset < 603) {
    importFailure('invalid-header', 'Rigol DS4000 waveform data overlaps its header.', 'rigol-wfm', request);
  }
  reader.requireRange(597, firstDataOffset - 597, 'Rigol DS4000 setup block');

  const sampleRate = positiveFiniteField(
    reader,
    reader.f32(100, true, 'Rigol DS4000 sample rate'),
    'Rigol DS4000 sample rate',
    request
  );
  const secondsPerPoint = 1 / sampleRate;
  const topLevelTimeScale = reader.u64(108, true, 'Rigol DS4000 time scale');
  const nestedTimeScale = reader.u32(544, true, 'Rigol DS4000 nested time scale');
  if (topLevelTimeScale !== nestedTimeScale) {
    importFailure('length-mismatch', 'Rigol DS4000 time-scale fields do not agree.', 'rigol-wfm', request);
  }
  finiteField(reader, topLevelTimeScale * 1e-12, 'Rigol DS4000 time scale');
  const timeOffset = safeI64(reader, 568, 'Rigol DS4000 time offset') * 1e-12;
  const divisor = embeddedModel.charAt(2) === '2' ? 25 : 32;
  const settings = [0, 1, 2, 3].map((index) =>
    parseDs4000Channel(reader, request, index, enabledFlags[index], divisor)
  );
  const plans: ModernPlan[] = [];
  for (let channelIndex = 0; channelIndex < 4; channelIndex += 1) {
    const setting = settings[channelIndex];
    if (!setting.enabled) continue;
    reader.requireRange(positions[channelIndex], memoryDepth, `Rigol DS4000 CH${channelIndex + 1} samples`);
    plans.push({
      ...setting,
      sampleCount: memoryDepth,
      rawOffset: positions[channelIndex],
      timeStart: timeOffset - (memoryDepth * secondsPerPoint) / 2,
      timeStep: secondsPerPoint
    });
  }

  validateChannelPlans(reader, request, plans);
  const channels = decodeModernPlans(
    reader,
    request,
    plans,
    `Rigol DS4000 signed V/div/${divisor} calibration with increasing-code polarity and ADC reference 127`
  );
  const records = buildRecords(
    request,
    'rigol-wfm',
    {
      brand: 'Rigol',
      family: 'DS4000',
      parser: 'wfm4000',
      instrument_model: 'DS4000',
      embedded_model: embeddedModel,
      serial_number: embeddedModel,
      firmware_version: firmware || 'unknown',
      vertical_code_divisor: divisor
    },
    channels
  );
  checkpoint(request, 1, 'Rigol DS4000 decoded');
  return records;
}
