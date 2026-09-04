import { CheckedReader, ScopeImportLimits, requireFinite, validateRecordShape } from '../limits';
import {
  ScopeImportError,
  throwIfCancelled,
  type ImportedWaveformRecord,
  type ScopeImportFailureCode,
  type ScopeImportRequest
} from '../types';

const FORMAT = 'tektronix-wfm' as const;
const STATIC_HEADER_BYTES = 78;
const WFM003_MAIN_HEADER_END = 838;
const WFM003_UPDATE_OFFSET = 784;
const WFM003_CURVE_OFFSET = 808;
const UPDATE_SPEC_BYTES = 24;
const CURVE_OBJECT_BYTES = 30;
const FILE_CHECKSUM_BYTES = 8;
const MIN_REPORTED_WAVEFORM_HEADER_BYTES = 512;
const CANCELLATION_CHECK_INTERVAL = 16_384;

interface CurveObject {
  prechargeStart: number;
  dataStart: number;
  postchargeStart: number;
  postchargeStop: number;
  end: number;
}

interface UpdateSpec {
  realPointOffset: number;
  triggerTimeOffset: number;
  fractionalSecond: number;
  gmtSecond: number;
}

interface UnitConversion {
  sourceUnit: string;
  unit: string;
  scale: number;
}

interface SampleFormat {
  name: string;
  width: number;
}

function fail(code: ScopeImportFailureCode, message: string, fileName: string): never {
  throw new ScopeImportError(code, message, {
    format: FORMAT,
    fileNames: [fileName]
  });
}

function cleanText(value: string): string {
  let cleaned = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code >= 32 && code !== 127) cleaned += character;
  }
  return cleaned.trim();
}

function verticalUnit(rawUnit: string): UnitConversion {
  const sourceUnit = cleanText(rawUnit) || 'V';
  const normalised = sourceUnit.replace(/[μµ]/g, 'u');
  const aliases: Record<string, string> = {
    volt: 'V',
    volts: 'V',
    amp: 'A',
    amps: 'A',
    ampere: 'A',
    amperes: 'A',
    ohm: 'Ω',
    Ohm: 'Ω'
  };
  const aliased = aliases[normalised] ?? normalised;
  const directUnits: Record<string, string> = {
    V: 'V',
    A: 'A',
    Hz: 'Hz',
    Ω: 'Ω'
  };
  const direct = directUnits[aliased];
  if (direct) return { sourceUnit, unit: direct, scale: 1 };

  const match = /^([pnumkMG])(V|A|Hz|ohm|Ohm|Ω)$/.exec(aliased);
  if (!match) return { sourceUnit, unit: sourceUnit, scale: 1 };
  const prefixScales: Record<string, number> = {
    p: 1e-12,
    n: 1e-9,
    u: 1e-6,
    m: 1e-3,
    k: 1e3,
    M: 1e6,
    G: 1e9
  };
  const base = aliases[match[2]] ?? match[2];
  return {
    sourceUnit,
    unit: directUnits[base] ?? base,
    scale: prefixScales[match[1]]
  };
}

function timeUnitScale(
  rawUnit: string,
  fileName: string
): {
  sourceUnit: string;
  scale: number;
} {
  const sourceUnit = cleanText(rawUnit) || 's';
  const normalised = sourceUnit.replace(/[μµ]/g, 'u').toLowerCase();
  const scales: Record<string, number> = {
    s: 1,
    sec: 1,
    second: 1,
    seconds: 1,
    ms: 1e-3,
    msec: 1e-3,
    millisecond: 1e-3,
    milliseconds: 1e-3,
    us: 1e-6,
    usec: 1e-6,
    microsecond: 1e-6,
    microseconds: 1e-6,
    ns: 1e-9,
    nsec: 1e-9,
    nanosecond: 1e-9,
    nanoseconds: 1e-9,
    ps: 1e-12,
    psec: 1e-12,
    picosecond: 1e-12,
    picoseconds: 1e-12
  };
  const scale = scales[normalised];
  if (scale === undefined) {
    fail(
      'unsupported-variant',
      `Tektronix WFM implicit dimension uses unsupported horizontal unit "${sourceUnit}".`,
      fileName
    );
  }
  return { sourceUnit, scale };
}

function sampleFormat(code: number, fileName: string): SampleFormat {
  switch (code) {
    case 0:
      return { name: 'int16', width: 2 };
    case 1:
      return { name: 'int32', width: 4 };
    case 2:
      return { name: 'uint32', width: 4 };
    case 4:
      return { name: 'float32', width: 4 };
    case 5:
      return { name: 'float64', width: 8 };
    case 6:
      return { name: 'uint8', width: 1 };
    case 7:
      return { name: 'int8', width: 1 };
    case 3:
      return fail(
        'unsupported-variant',
        'Tektronix WFM uint64 samples cannot be represented losslessly by the importer.',
        fileName
      );
    default:
      return fail('unsupported-variant', `Tektronix WFM explicit sample format ${code} is unsupported.`, fileName);
  }
}

function readCurveObject(reader: CheckedReader, offset: number): CurveObject {
  reader.requireRange(offset, CURVE_OBJECT_BYTES, 'Tektronix WFM curve object');
  return {
    prechargeStart: reader.u32(offset + 10, true, 'curve precharge start'),
    dataStart: reader.u32(offset + 14, true, 'curve data start'),
    postchargeStart: reader.u32(offset + 18, true, 'curve postcharge start'),
    postchargeStop: reader.u32(offset + 22, true, 'curve postcharge stop'),
    end: reader.u32(offset + 26, true, 'curve-buffer end')
  };
}

function readUpdateSpec(reader: CheckedReader, offset: number): UpdateSpec {
  reader.requireRange(offset, UPDATE_SPEC_BYTES, 'Tektronix WFM update specification');
  return {
    realPointOffset: reader.u32(offset, true, 'real-point offset'),
    triggerTimeOffset: reader.f64(offset + 4, true, 'trigger time offset'),
    fractionalSecond: reader.f64(offset + 12, true, 'fractional trigger second'),
    gmtSecond: reader.i32(offset + 20, true, 'trigger GMT second')
  };
}

function sameCurveExtent(left: CurveObject, right: CurveObject): boolean {
  return (
    left.prechargeStart === right.prechargeStart &&
    left.dataStart === right.dataStart &&
    left.postchargeStart === right.postchargeStart &&
    left.postchargeStop === right.postchargeStop &&
    left.end === right.end
  );
}

function rawSample(view: DataView, offset: number, formatCode: number): number {
  switch (formatCode) {
    case 0:
      return view.getInt16(offset, true);
    case 1:
      return view.getInt32(offset, true);
    case 2:
      return view.getUint32(offset, true);
    case 4:
      return view.getFloat32(offset, true);
    case 5:
      return view.getFloat64(offset, true);
    case 6:
      return view.getUint8(offset);
    case 7:
      return view.getInt8(offset);
    default:
      return Number.NaN;
  }
}

function decode(request: ScopeImportRequest): ImportedWaveformRecord[] {
  const fileName = request.primary.name;
  throwIfCancelled(request.signal);
  request.onProgress?.(0, 'Validating Tektronix WFM');

  const reader = new CheckedReader(request.primary.bytes, FORMAT);
  reader.requireRange(0, STATIC_HEADER_BYTES, 'Tektronix WFM static header');

  const byteOrder = reader.u16(0, true, 'Tektronix byte-order marker');
  if (byteOrder === 0xf0f0) {
    fail('unsupported-variant', 'Big-endian Tektronix WFM files are not supported.', fileName);
  }
  if (byteOrder !== 0x0f0f) {
    fail('invalid-header', 'Tektronix WFM byte-order marker is invalid.', fileName);
  }

  const version = reader.ascii(2, 8, 'Tektronix WFM version marker');
  if (version === ':WFM#001' || version === ':WFM#002') {
    fail(
      'unsupported-variant',
      `Tektronix ${version.slice(1)} files are not supported; only little-endian WFM#003 is accepted.`,
      fileName
    );
  }
  if (version !== ':WFM#003') {
    fail('unsupported-variant', `Tektronix WFM version marker "${cleanText(version)}" is unsupported.`, fileName);
  }

  const byteCountDigits = reader.u8(10, 'Tektronix EOF digit count');
  const bytesToEof = reader.i32(11, true, 'Tektronix bytes-to-EOF field');
  if (byteCountDigits < 1 || byteCountDigits > 9 || bytesToEof <= 0 || String(bytesToEof).length !== byteCountDigits) {
    fail('invalid-header', 'Tektronix WFM EOF length fields are inconsistent.', fileName);
  }
  const declaredEof = reader.checkedSum([15, bytesToEof], 'Tektronix declared EOF');
  reader.requireRange(0, declaredEof, 'Tektronix WFM declared EOF extent');

  const bytesPerPoint = reader.u8(15, 'Tektronix bytes per point');
  const curveBufferOffset = reader.i32(16, true, 'Tektronix curve-buffer offset');
  const additionalFrameCount = reader.u32(72, true, 'Tektronix additional FastFrame count');
  const reportedHeaderBytes = reader.u16(76, true, 'Tektronix waveform-header size');
  if (
    reportedHeaderBytes < MIN_REPORTED_WAVEFORM_HEADER_BYTES ||
    curveBufferOffset < STATIC_HEADER_BYTES ||
    reportedHeaderBytes > curveBufferOffset - STATIC_HEADER_BYTES
  ) {
    fail('invalid-header', 'Tektronix WFM waveform-header size or curve-buffer offset is invalid.', fileName);
  }

  const frameCount = reader.checkedSum([additionalFrameCount, 1], 'Tektronix frame count');
  if (frameCount > ScopeImportLimits.maxRecords) {
    fail(
      'decode-budget-exceeded',
      `Tektronix WFM contains ${frameCount} frames; the record limit is ${ScopeImportLimits.maxRecords}.`,
      fileName
    );
  }

  const extraUpdateBytes = reader.checkedProduct(
    additionalFrameCount,
    UPDATE_SPEC_BYTES,
    'Tektronix FastFrame update-specification extent'
  );
  const extraCurveBytes = reader.checkedProduct(
    additionalFrameCount,
    CURVE_OBJECT_BYTES,
    'Tektronix FastFrame curve-object extent'
  );
  const expectedCurveBufferOffset = reader.checkedSum(
    [WFM003_MAIN_HEADER_END, extraUpdateBytes, extraCurveBytes],
    'Tektronix FastFrame metadata extent'
  );
  if (curveBufferOffset !== expectedCurveBufferOffset) {
    fail(
      'length-mismatch',
      `Tektronix curve buffer begins at ${curveBufferOffset}, but the declared FastFrame metadata ends at ${expectedCurveBufferOffset}.`,
      fileName
    );
  }
  reader.requireRange(STATIC_HEADER_BYTES, curveBufferOffset - STATIC_HEADER_BYTES, 'Tektronix WFM waveform header');

  const setType = reader.i32(78, true, 'Tektronix waveform set type');
  const waveformCount = reader.u32(82, true, 'Tektronix waveform count');
  const updateSpecCount = reader.u32(110, true, 'Tektronix update-specification count');
  const implicitDimensionCount = reader.u32(114, true, 'Tektronix implicit-dimension count');
  const explicitDimensionCount = reader.u32(118, true, 'Tektronix explicit-dimension count');
  const dataType = reader.i32(122, true, 'Tektronix waveform data type');
  const curveReferenceCount = reader.u32(142, true, 'Tektronix curve-reference count');
  const requestedFastFrames = reader.u32(146, true, 'Tektronix requested FastFrame count');
  const acquiredFastFrames = reader.u32(150, true, 'Tektronix acquired FastFrame count');
  const summaryFrameType = reader.u16(154, true, 'Tektronix summary-frame type');

  if (setType !== 0 && setType !== 1) {
    fail('unsupported-variant', `Tektronix waveform set type ${setType} is unsupported.`, fileName);
  }
  if (waveformCount !== 1 || updateSpecCount !== 1 || curveReferenceCount !== 1) {
    fail('unsupported-variant', 'Only one-curve Tektronix WFM waveform sets are supported.', fileName);
  }
  if (implicitDimensionCount !== 1 || explicitDimensionCount !== 1) {
    fail('unsupported-variant', 'Tektronix XY, IQ, and multidimensional waveform sets are not supported.', fileName);
  }
  if (dataType !== 2) {
    fail(
      'unsupported-variant',
      `Tektronix waveform data type ${dataType} is not an ordinary analogue vector.`,
      fileName
    );
  }
  if (summaryFrameType !== 0) {
    fail('unsupported-variant', 'Tektronix average and envelope summary frames are not supported.', fileName);
  }
  if (setType === 0) {
    if (additionalFrameCount !== 0 || requestedFastFrames !== 0 || acquiredFastFrames !== 0) {
      fail('length-mismatch', 'Tektronix single-waveform frame counts are inconsistent.', fileName);
    }
  } else if (acquiredFastFrames !== frameCount || requestedFastFrames < acquiredFastFrames) {
    fail('length-mismatch', 'Tektronix FastFrame counts disagree with the stored frame records.', fileName);
  }

  const verticalScale = requireFinite(
    reader.f64(168, true, 'explicit-dimension scale'),
    'Tektronix vertical scale',
    FORMAT
  );
  const verticalOffset = requireFinite(
    reader.f64(176, true, 'explicit-dimension offset'),
    'Tektronix vertical offset',
    FORMAT
  );
  if (verticalScale === 0) {
    fail('invalid-header', 'Tektronix vertical scale must be non-zero.', fileName);
  }
  const verticalUnits = verticalUnit(reader.ascii(188, 20, 'explicit-dimension units'));
  const formatCode = reader.i32(240, true, 'Tektronix explicit sample format');
  const storageType = reader.i32(244, true, 'Tektronix explicit storage type');
  if (storageType !== 0) {
    fail(
      'unsupported-variant',
      `Tektronix min/max, histogram, and matrix storage type ${storageType} is unsupported.`,
      fileName
    );
  }
  const format = sampleFormat(formatCode, fileName);
  if (bytesPerPoint !== format.width) {
    fail(
      'invalid-header',
      `Tektronix ${format.name} samples require ${format.width} bytes per point, not ${bytesPerPoint}.`,
      fileName
    );
  }

  const horizontalScale = requireFinite(
    reader.f64(488, true, 'implicit-dimension scale'),
    'Tektronix horizontal scale',
    FORMAT
  );
  const horizontalOffset = requireFinite(
    reader.f64(496, true, 'implicit-dimension offset'),
    'Tektronix horizontal offset',
    FORMAT
  );
  if (horizontalScale <= 0) {
    fail('invalid-header', 'Tektronix horizontal sample interval must be positive.', fileName);
  }
  const sampleCount = reader.u32(504, true, 'Tektronix record length');
  const horizontalUnits = timeUnitScale(reader.ascii(508, 20, 'implicit-dimension units'), fileName);
  const realPointSpacing = reader.u32(760, true, 'Tektronix real-point spacing');
  const sweepType = reader.i32(764, true, 'Tektronix sweep type');
  const baseType = reader.i32(768, true, 'Tektronix time-base type');
  if (realPointSpacing !== 1 || sweepType < 0 || sweepType > 2 || baseType !== 0) {
    fail(
      'unsupported-variant',
      'Tektronix WFM uses an unsupported interpolated, invalid, or spectral time base.',
      fileName
    );
  }

  validateRecordShape(sampleCount, 1, 0, FORMAT);
  const expectedValidBytes = reader.checkedProduct(sampleCount, bytesPerPoint, 'Tektronix valid curve extent');

  const updates: UpdateSpec[] = [readUpdateSpec(reader, WFM003_UPDATE_OFFSET)];
  const curves: CurveObject[] = [readCurveObject(reader, WFM003_CURVE_OFFSET)];
  const additionalCurveOffset = reader.checkedSum(
    [WFM003_MAIN_HEADER_END, extraUpdateBytes],
    'Tektronix additional curve-object offset'
  );
  for (let index = 0; index < additionalFrameCount; index += 1) {
    throwIfCancelled(request.signal);
    updates.push(readUpdateSpec(reader, WFM003_MAIN_HEADER_END + index * UPDATE_SPEC_BYTES));
    curves.push(readCurveObject(reader, additionalCurveOffset + index * CURVE_OBJECT_BYTES));
  }

  const firstCurve = curves[0];
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const curve = curves[frameIndex];
    const update = updates[frameIndex];
    if (
      curve.prechargeStart > curve.dataStart ||
      curve.dataStart > curve.postchargeStart ||
      curve.postchargeStart > curve.postchargeStop ||
      curve.postchargeStop > curve.end ||
      curve.end === 0
    ) {
      fail('invalid-header', `Tektronix frame ${frameIndex} has unordered curve offsets.`, fileName);
    }
    if (
      curve.prechargeStart % bytesPerPoint !== 0 ||
      curve.dataStart % bytesPerPoint !== 0 ||
      curve.postchargeStart % bytesPerPoint !== 0 ||
      curve.postchargeStop % bytesPerPoint !== 0 ||
      curve.end % bytesPerPoint !== 0
    ) {
      fail('invalid-header', `Tektronix frame ${frameIndex} curve offsets are not sample-aligned.`, fileName);
    }
    if (curve.postchargeStart - curve.dataStart !== expectedValidBytes) {
      fail(
        'length-mismatch',
        `Tektronix frame ${frameIndex} curve extent does not contain the declared ${sampleCount} samples.`,
        fileName
      );
    }
    if (frameIndex > 0 && !sameCurveExtent(firstCurve, curve)) {
      fail('length-mismatch', `Tektronix frame ${frameIndex} curve extents differ from frame 0.`, fileName);
    }
    requireFinite(update.triggerTimeOffset, `Tektronix frame ${frameIndex} trigger offset`, FORMAT);
    requireFinite(update.fractionalSecond, `Tektronix frame ${frameIndex} fractional timestamp`, FORMAT);
    if (
      update.realPointOffset > (curve.postchargeStop - curve.prechargeStart) / bytesPerPoint ||
      update.triggerTimeOffset < 0 ||
      update.triggerTimeOffset >= 1 ||
      update.fractionalSecond < 0 ||
      update.fractionalSecond >= 1
    ) {
      fail('invalid-header', `Tektronix frame ${frameIndex} update specification is invalid.`, fileName);
    }
    if (sweepType !== 0 && curve.postchargeStop !== curve.end) {
      fail('length-mismatch', `Tektronix frame ${frameIndex} has an unexpected non-roll curve-buffer tail.`, fileName);
    }
  }

  const totalCurveBytes = reader.checkedProduct(frameCount, firstCurve.end, 'Tektronix combined curve-buffer extent');
  const expectedEof = reader.checkedSum(
    [curveBufferOffset, totalCurveBytes, FILE_CHECKSUM_BYTES],
    'Tektronix curve data and checksum extent'
  );
  if (declaredEof !== expectedEof) {
    fail(
      'length-mismatch',
      `Tektronix declared EOF is ${declaredEof}, but the complete frame set ends at ${expectedEof}.`,
      fileName
    );
  }
  reader.requireRange(
    curveBufferOffset,
    totalCurveBytes + FILE_CHECKSUM_BYTES,
    'Tektronix curve data and file checksum'
  );
  // Real Tektronix exports (including the redistributable fixtures) carry a short vendor tail after the
  // declared EOF/file checksum. The declared extents are decoded exactly and the tail is disclosed, never read.
  const trailingBytes = reader.bytes.byteLength - declaredEof;
  const fileWarnings =
    trailingBytes > 0
      ? [
          `${trailingBytes} byte(s) after the declared Tektronix EOF were ignored; only the declared frame set was decoded.`
        ]
      : [];

  const totalSamples = reader.checkedProduct(frameCount, sampleCount, 'Tektronix decoded sample count');
  if (totalSamples > ScopeImportLimits.maxTotalChannelSamples) {
    fail(
      'decode-budget-exceeded',
      `Tektronix WFM would decode ${totalSamples} channel samples; the limit is ${ScopeImportLimits.maxTotalChannelSamples}.`,
      fileName
    );
  }
  const predictedDecodedBytes = reader.checkedProduct(totalSamples, 18, 'Tektronix decoded working set');
  if (predictedDecodedBytes > ScopeImportLimits.maxDecodedBytes) {
    fail(
      'decode-budget-exceeded',
      `Tektronix WFM would require approximately ${predictedDecodedBytes} decoded bytes; the limit is ${ScopeImportLimits.maxDecodedBytes}.`,
      fileName
    );
  }

  const sampleIntervalSeconds = requireFinite(
    horizontalScale * horizontalUnits.scale,
    'Tektronix sample interval in seconds',
    FORMAT
  );
  const timeStartSeconds = requireFinite(
    horizontalOffset * horizontalUnits.scale,
    'Tektronix time origin in seconds',
    FORMAT
  );
  requireFinite(timeStartSeconds + (sampleCount - 1) * sampleIntervalSeconds, 'Tektronix final sample time', FORMAT);

  const valueScale = requireFinite(verticalScale * verticalUnits.scale, 'Tektronix vertical scale in SI units', FORMAT);
  const valueOffset = requireFinite(
    verticalOffset * verticalUnits.scale,
    'Tektronix vertical offset in SI units',
    FORMAT
  );
  const waveformLabel = cleanText(reader.ascii(40, 32, 'Tektronix waveform label'));
  const channelName = waveformLabel || 'Waveform';
  const fastframe = setType === 1;
  const triggerIndex = -timeStartSeconds / sampleIntervalSeconds;
  const records: ImportedWaveformRecord[] = [];

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    throwIfCancelled(request.signal);
    const curve = curves[frameIndex];
    const update = updates[frameIndex];
    const frameBufferOffset = reader.checkedSum(
      [curveBufferOffset, frameIndex * firstCurve.end],
      `Tektronix frame ${frameIndex} buffer offset`
    );
    const dataOffset = reader.checkedSum(
      [frameBufferOffset, curve.dataStart],
      `Tektronix frame ${frameIndex} data offset`
    );
    reader.requireRange(dataOffset, expectedValidBytes, `Tektronix frame ${frameIndex} sample data`);

    const timeSeconds = new Float64Array(sampleCount);
    const values = new Float64Array(sampleCount);
    const invalidMask = new Uint8Array(sampleCount);
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      if (sampleIndex % CANCELLATION_CHECK_INTERVAL === 0) {
        throwIfCancelled(request.signal);
      }
      timeSeconds[sampleIndex] = timeStartSeconds + sampleIndex * sampleIntervalSeconds;
      const raw = rawSample(reader.view, dataOffset + sampleIndex * bytesPerPoint, formatCode);
      const value = raw * valueScale + valueOffset;
      values[sampleIndex] = value;
      if (!Number.isFinite(value)) invalidMask[sampleIndex] = 1;
    }

    const timestamp =
      update.gmtSecond === 0 && update.fractionalSecond === 0 ? null : update.gmtSecond + update.fractionalSecond;
    records.push({
      sourceFormat: FORMAT,
      supportLevel: 'verified',
      timeSeconds,
      channels: [
        {
          name: channelName,
          values,
          unit: verticalUnits.unit,
          sourceUnit: verticalUnits.sourceUnit,
          sourceToSiScale: verticalUnits.scale,
          invalidMask,
          calibrationSource: 'Tektronix WFM#003 explicit dimension: SI value = raw sample × scale + offset'
        }
      ],
      frameIndex,
      metadata: {
        reader: 'signalforge-native-tek-wfm',
        version: 'WFM#003',
        sample_format: format.name,
        record_length: sampleCount,
        sample_interval_s: sampleIntervalSeconds,
        trigger_index: Number.isFinite(triggerIndex) ? triggerIndex : null,
        source_x_unit: horizontalUnits.sourceUnit,
        source_y_unit: verticalUnits.sourceUnit,
        fastframe,
        frame_count: frameCount,
        requested_fast_frames: requestedFastFrames,
        acquired_fast_frames: acquiredFastFrames,
        real_point_offset: update.realPointOffset,
        trigger_time_offset: update.triggerTimeOffset,
        trigger_timestamp_s: Number.isFinite(timestamp) ? timestamp : null
      },
      warnings: frameIndex === 0 ? [...fileWarnings] : []
    });
    request.onProgress?.(
      (frameIndex + 1) / frameCount,
      fastframe ? 'Decoding Tektronix FastFrame' : 'Decoding Tektronix waveform'
    );
  }

  return records;
}

export function decodeTekWfm(request: ScopeImportRequest): ImportedWaveformRecord[] {
  try {
    return decode(request);
  } catch (error) {
    if (error instanceof ScopeImportError && error.fileNames.length === 0) {
      throw new ScopeImportError(error.code, error.message, {
        format: error.format ?? FORMAT,
        fileNames: [request.primary.name],
        cause: error
      });
    }
    throw error;
  }
}
