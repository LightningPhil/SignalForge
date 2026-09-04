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

interface ZChannelPlan extends ChannelTiming {
  channelNumber: number;
  lane: number;
  stride: number;
  yScale: number;
  yOffset: number;
  unit: string;
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

export function decodeDs1000Z(request: ScopeImportRequest, reader: CheckedReader): ImportedWaveformRecord[] {
  checkpoint(request, 0.02, 'Reading Rigol DS1000Z header');
  assertSignature(reader, [0x01, 0xff, 0xff, 0xff], 'Rigol DS1000Z signature', request);
  reader.requireRange(0, 280, 'Rigol DS1000Z headers');

  const secondaryMagic = reader.u16(4, true, 'Rigol DS1000Z secondary signature');
  if (secondaryMagic !== 0xa5a5 && secondaryMagic !== 0xa5a6) {
    importFailure('invalid-header', 'Rigol DS1000Z secondary signature is invalid.', 'rigol-wfm', request);
  }
  if (reader.u16(6, true, 'Rigol DS1000Z file-header size') !== 0x38) {
    importFailure(
      'unsupported-variant',
      'Rigol DS1000Z file-header layout is not the fixture-backed 0x38 variant.',
      'rigol-wfm',
      request
    );
  }
  assertBytes(reader, 48, [0x01, 0x00], 'Rigol DS1000Z block marker', request);
  if (reader.u16(84, true, 'Rigol DS1000Z waveform-header size') !== 0xd8) {
    importFailure('unsupported-variant', 'Rigol DS1000Z waveform-header size is not supported.', 'rigol-wfm', request);
  }

  const model = cleanAscii(reader.ascii(8, 20, 'Rigol DS1000Z model'));
  if (!/^(?:DS|MSO)1/i.test(model)) {
    importFailure(
      'unsupported-variant',
      `Rigol 1000Z signature carries unsupported model "${model || 'unknown'}".`,
      'rigol-wfm',
      request
    );
  }
  const firmware = cleanAscii(reader.ascii(28, 20, 'Rigol DS1000Z firmware'));
  const enabledMask = reader.u8(88, 'Rigol DS1000Z channel mask');
  if ((enabledMask & 0xf0) !== 0) {
    importFailure(
      'unsupported-variant',
      'Rigol DS1000Z channel mask contains unsupported non-analogue bits.',
      'rigol-wfm',
      request
    );
  }
  const enabledFlags = [0, 1, 2, 3].map((channelIndex) => (enabledMask & (1 << channelIndex)) !== 0);
  const channelCount = enabledFlags.filter(Boolean).length;
  if (channelCount === 0) {
    importFailure(
      'unsupported-variant',
      'Rigol DS1000Z file contains no enabled analogue channels.',
      'rigol-wfm',
      request
    );
  }
  if (reader.u32(108, true, 'Rigol DS1000Z logic offset') !== 0) {
    importFailure(
      'unsupported-variant',
      'Rigol DS1000Z logic-analyser records are not supported.',
      'rigol-wfm',
      request
    );
  }

  requireKnownEnum(
    reader,
    reader.u8(112, 'Rigol DS1000Z acquisition mode'),
    [0, 1, 2, 3],
    'Rigol DS1000Z acquisition mode',
    request
  );
  if (reader.u8(114, 'Rigol DS1000Z sample mode') !== 0) {
    importFailure(
      'unsupported-variant',
      'Rigol DS1000Z non-standard sample mode is not supported.',
      'rigol-wfm',
      request
    );
  }
  const timeMode = reader.u8(115, 'Rigol DS1000Z time mode');
  requireKnownEnum(reader, timeMode, [0, 1, 2], 'Rigol DS1000Z time mode', request);
  if (timeMode !== 0) {
    importFailure(
      'unsupported-variant',
      'Rigol DS1000Z XY and roll records need dedicated timing support.',
      'rigol-wfm',
      request
    );
  }

  const memoryDepth = reader.u32(116, true, 'Rigol DS1000Z memory depth');
  const stride = channelCount === 3 ? 4 : channelCount;
  if (memoryDepth === 0 || memoryDepth % stride !== 0) {
    importFailure(
      'length-mismatch',
      'Rigol DS1000Z memory depth is not divisible by its channel stride.',
      'rigol-wfm',
      request
    );
  }
  const points = memoryDepth / stride;
  const sampleRateGhz = positiveFiniteField(
    reader,
    reader.f32(120, true, 'Rigol DS1000Z sample rate'),
    'Rigol DS1000Z sample rate',
    request
  );
  const secondsPerPoint = 1 / (sampleRateGhz * 1e9);
  const timeOffset = safeI64(reader, 72, 'Rigol DS1000Z time offset') * 1e-12;
  finiteField(reader, reader.u64(64, true, 'Rigol DS1000Z time scale') * 1e-12, 'Rigol DS1000Z time scale');

  const setupSize = reader.u32(248, true, 'Rigol DS1000Z setup size');
  const setupOffset = reader.u32(252, true, 'Rigol DS1000Z setup offset');
  const horizontalSize = reader.u32(256, true, 'Rigol DS1000Z horizontal size');
  const horizontalOffset = reader.u32(260, true, 'Rigol DS1000Z horizontal offset');
  reader.requireRange(setupOffset, setupSize, 'Rigol DS1000Z setup block');
  reader.requireRange(horizontalOffset, horizontalSize, 'Rigol DS1000Z horizontal block');
  const dataStart = reader.checkedSum([horizontalOffset, horizontalSize], 'Rigol DS1000Z data offset');
  if (setupOffset > dataStart || setupSize > dataStart - setupOffset || horizontalOffset > dataStart) {
    importFailure('invalid-header', 'Rigol DS1000Z metadata blocks overlap the waveform data.', 'rigol-wfm', request);
  }
  const expectedLength = reader.checkedSum([dataStart, memoryDepth], 'Rigol DS1000Z file extent');
  assertExactLength(reader, expectedLength, 'Rigol DS1000Z file extent', request);
  for (let channelIndex = 0; channelIndex < 4; channelIndex += 1) {
    if (
      enabledFlags[channelIndex] &&
      reader.u32(92 + channelIndex * 4, true, `Rigol DS1000Z CH${channelIndex + 1} offset`) !== dataStart
    ) {
      importFailure(
        'length-mismatch',
        `Rigol DS1000Z CH${channelIndex + 1} offset does not match the interleaved payload.`,
        'rigol-wfm',
        request
      );
    }
  }

  const plans: ZChannelPlan[] = [];
  let enabledRank = 0;
  for (let channelIndex = 0; channelIndex < 4; channelIndex += 1) {
    if (!enabledFlags[channelIndex]) continue;
    const headerOffset = 124 + channelIndex * 28;
    const headerEnabled = strictFlag(
      reader,
      request,
      reader.u8(headerOffset, `Rigol DS1000Z CH${channelIndex + 1} header flag`),
      `Rigol DS1000Z CH${channelIndex + 1} header flag`
    );
    if (!headerEnabled) {
      importFailure(
        'length-mismatch',
        `Rigol DS1000Z CH${channelIndex + 1} mask and channel header disagree.`,
        'rigol-wfm',
        request
      );
    }
    couplingFromCode(
      reader,
      reader.u8(headerOffset + 1, `Rigol DS1000Z CH${channelIndex + 1} coupling`),
      `Rigol DS1000Z CH${channelIndex + 1} coupling`,
      request
    );
    requireKnownEnum(
      reader,
      reader.u8(headerOffset + 2, `Rigol DS1000Z CH${channelIndex + 1} bandwidth`),
      [0, 1],
      `Rigol DS1000Z CH${channelIndex + 1} bandwidth`,
      request
    );
    probeRatioFromCode(
      reader,
      reader.u8(headerOffset + 4, `Rigol DS1000Z CH${channelIndex + 1} probe ratio`),
      `Rigol DS1000Z CH${channelIndex + 1} probe ratio`,
      request
    );
    const displayScale = positiveFiniteField(
      reader,
      reader.f32(headerOffset + 8, true, `Rigol DS1000Z CH${channelIndex + 1} scale`),
      `Rigol DS1000Z CH${channelIndex + 1} scale`,
      request
    );
    const shift = finiteField(
      reader,
      reader.f32(headerOffset + 12, true, `Rigol DS1000Z CH${channelIndex + 1} shift`),
      `Rigol DS1000Z CH${channelIndex + 1} shift`
    );
    const inverted = strictFlag(
      reader,
      request,
      reader.u8(headerOffset + 16, `Rigol DS1000Z CH${channelIndex + 1} invert flag`),
      `Rigol DS1000Z CH${channelIndex + 1} invert flag`
    );
    const unit = unitFromLegacyCode(
      reader,
      reader.u8(headerOffset + 17, `Rigol DS1000Z CH${channelIndex + 1} unit`),
      `Rigol DS1000Z CH${channelIndex + 1} unit`,
      request
    );
    const voltsPerDivision = inverted ? -displayScale : displayScale;
    const verticalBias =
      firmware === '00.04.04.SP3' && channelCount === 2 ? (shift < 0 ? voltsPerDivision / 5 : 0) : voltsPerDivision;
    const yScale = -voltsPerDivision / 20;
    const yOffset = shift - verticalBias;
    finiteField(
      reader,
      yScale * (127 - 255) - yOffset,
      `Rigol DS1000Z CH${channelIndex + 1} calibrated lower endpoint`
    );
    finiteField(reader, yScale * 127 - yOffset, `Rigol DS1000Z CH${channelIndex + 1} calibrated upper endpoint`);
    const lane = stride === 1 ? 0 : stride === 2 ? (enabledRank === 0 ? 1 : 0) : 3 - channelIndex;
    plans.push({
      channelNumber: channelIndex + 1,
      lane,
      stride,
      yScale,
      yOffset,
      unit,
      sampleCount: points,
      timeStart: timeOffset - (points * secondsPerPoint) / 2,
      timeStep: secondsPerPoint
    });
    enabledRank += 1;
  }

  validateChannelPlans(reader, request, plans);
  const channels: DecodedRigolChannel[] = plans.map((plan, planIndex) => {
    const values = new Float64Array(plan.sampleCount);
    for (let index = 0; index < plan.sampleCount; index += 1) {
      checkLoopCancellation(request, index);
      const raw = reader.bytes[dataStart + plan.lane + index * plan.stride];
      values[index] = plan.yScale * (127 - raw) - plan.yOffset;
    }
    checkpoint(request, 0.25 + (0.6 * (planIndex + 1)) / plans.length, 'De-interleaving Rigol DS1000Z channels');
    return {
      name: `CH${plan.channelNumber}`,
      values,
      unit: plan.unit,
      sourceUnit: plan.unit,
      sourceToSiScale: 1,
      calibrationSource: 'Rigol DS1000Z signed -V/div/20 calibration with ADC reference 127 and firmware bias',
      sampleCount: plan.sampleCount,
      timeStart: plan.timeStart,
      timeStep: plan.timeStep
    };
  });

  const records = buildRecords(
    request,
    'rigol-wfm',
    {
      brand: 'Rigol',
      family: 'DS1000Z',
      parser: 'wfm1000z',
      instrument_model: model,
      firmware_version: firmware || 'unknown',
      interleave_stride: stride
    },
    channels
  );
  checkpoint(request, 1, 'Rigol DS1000Z decoded');
  return records;
}
