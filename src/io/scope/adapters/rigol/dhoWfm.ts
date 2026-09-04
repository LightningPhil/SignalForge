import { CheckedReader, ScopeImportLimits } from '../../limits';
import type { ImportedWaveformRecord, ScopeImportRequest } from '../../types';
import {
  assertExactLength,
  assertSignature,
  assertZeroRange,
  buildRecords,
  checkLoopCancellation,
  checkpoint,
  cleanAscii,
  finiteField,
  importFailure,
  positiveFiniteField,
  safeI64,
  validateChannelPlans,
  type ChannelTiming,
  type DecodedRigolChannel
} from './common';

const FILE_HEADER_BYTES = 24;
const BLOCK_HEADER_BYTES = 12;
const DATA_HEADER_BYTES = 40;
const MAX_BLOCKS = 4096;
const MAX_BLOCK_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_METADATA_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_INFLATE_RATIO = 128;
const DHO800_TICK_SECONDS = 8e-10;
const ADC_MIDPOINT = 32768;

interface BlockDescriptor {
  id: number;
  type: number;
  decompressedSize: number;
  compressedSize: number;
  rawSize: number;
  contentOffset: number;
}

interface DecodedBlock extends BlockDescriptor {
  content: Uint8Array;
}

interface Calibration {
  scale: number;
  center: number;
  offset: number;
}

interface DhoChannelPlan extends ChannelTiming {
  channelNumber: number;
  calibration: Calibration;
}

async function inflateExact(
  compressed: Uint8Array,
  expectedSize: number,
  request: ScopeImportRequest
): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    importFailure(
      'unsupported-variant',
      'This browser cannot decode compressed Rigol DHO800 metadata because DecompressionStream is unavailable.',
      'rigol-wfm',
      request
    );
  }

  let streamReader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    const source = new Blob([Uint8Array.from(compressed)]).stream();
    streamReader = source
      .pipeThrough(new DecompressionStream('deflate'))
      .getReader() as ReadableStreamDefaultReader<Uint8Array>;
  } catch (cause) {
    importFailure(
      'invalid-header',
      'Rigol DHO800 metadata deflate stream could not be created.',
      'rigol-wfm',
      request,
      cause
    );
  }

  const output = new Uint8Array(expectedSize);
  let written = 0;
  while (true) {
    checkpoint(request);
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await streamReader.read();
    } catch (cause) {
      importFailure(
        'invalid-header',
        'Rigol DHO800 metadata contains an invalid deflate stream.',
        'rigol-wfm',
        request,
        cause
      );
    }
    if (result.done) break;
    const chunk = result.value;
    if (chunk.byteLength > expectedSize || written > expectedSize - chunk.byteLength) {
      void streamReader.cancel();
      importFailure(
        'length-mismatch',
        'Rigol DHO800 metadata expanded beyond its declared size.',
        'rigol-wfm',
        request
      );
    }
    output.set(chunk, written);
    written += chunk.byteLength;
  }
  if (written !== expectedSize) {
    importFailure(
      'length-mismatch',
      `Rigol DHO800 metadata expanded to ${written} bytes instead of ${expectedSize}.`,
      'rigol-wfm',
      request
    );
  }
  return output;
}

function parseBlockDescriptors(
  reader: CheckedReader,
  request: ScopeImportRequest
): {
  descriptors: BlockDescriptor[];
  blocksEnd: number;
  aggregateOutputBytes: number;
} {
  const descriptors: BlockDescriptor[] = [];
  let offset = FILE_HEADER_BYTES;
  let aggregateOutputBytes = 0;
  let blocksEnd = -1;

  for (let blockIndex = 0; blockIndex < MAX_BLOCKS; blockIndex += 1) {
    reader.requireRange(offset, BLOCK_HEADER_BYTES, 'Rigol DHO800 metadata block header');
    const id = reader.u16(offset, true, 'Rigol DHO800 metadata block id');
    const type = reader.u16(offset + 2, true, 'Rigol DHO800 metadata block type');
    const decompressedSize = reader.u16(offset + 4, true, 'Rigol DHO800 metadata decompressed size');
    const compressedSize = reader.u16(offset + 6, true, 'Rigol DHO800 metadata compressed size');
    const rawSize = reader.u16(offset + 8, true, 'Rigol DHO800 metadata stored size');
    const reserved = reader.u16(offset + 10, true, 'Rigol DHO800 metadata reserved field');
    const terminator = rawSize === 0 && compressedSize === 0;
    if (terminator) {
      if (id !== 0 || type !== 0 || decompressedSize !== 0 || reserved !== 0) {
        importFailure('invalid-header', 'Rigol DHO800 metadata terminator is malformed.', 'rigol-wfm', request);
      }
      blocksEnd = reader.checkedSum([offset, BLOCK_HEADER_BYTES], 'Rigol DHO800 metadata terminator extent');
      break;
    }
    if (
      reserved !== 0 ||
      decompressedSize === 0 ||
      compressedSize === 0 ||
      rawSize === 0 ||
      compressedSize > rawSize ||
      compressedSize > decompressedSize
    ) {
      importFailure(
        'invalid-header',
        `Rigol DHO800 metadata block ${blockIndex + 1} has inconsistent sizes or flags.`,
        'rigol-wfm',
        request
      );
    }
    if (decompressedSize > MAX_BLOCK_OUTPUT_BYTES) {
      importFailure(
        'decode-budget-exceeded',
        `Rigol DHO800 metadata block declares ${decompressedSize} output bytes.`,
        'rigol-wfm',
        request
      );
    }
    if (decompressedSize > compressedSize && decompressedSize > compressedSize * MAX_INFLATE_RATIO) {
      importFailure(
        'decode-budget-exceeded',
        `Rigol DHO800 metadata block exceeds the ${MAX_INFLATE_RATIO}:1 deflate ratio cap.`,
        'rigol-wfm',
        request
      );
    }
    aggregateOutputBytes = reader.checkedSum(
      [aggregateOutputBytes, decompressedSize],
      'Rigol DHO800 aggregate metadata output'
    );
    if (aggregateOutputBytes > MAX_METADATA_OUTPUT_BYTES || aggregateOutputBytes > ScopeImportLimits.maxDecodedBytes) {
      importFailure(
        'decode-budget-exceeded',
        `Rigol DHO800 metadata declares ${aggregateOutputBytes} aggregate output bytes.`,
        'rigol-wfm',
        request
      );
    }
    const contentOffset = reader.checkedSum([offset, BLOCK_HEADER_BYTES], 'Rigol DHO800 metadata content offset');
    reader.requireRange(contentOffset, rawSize, 'Rigol DHO800 metadata content');
    assertZeroRange(
      reader,
      contentOffset + compressedSize,
      rawSize - compressedSize,
      `Rigol DHO800 metadata block ${blockIndex + 1} padding`,
      request
    );
    descriptors.push({
      id,
      type,
      decompressedSize,
      compressedSize,
      rawSize,
      contentOffset
    });
    offset = reader.checkedSum([contentOffset, rawSize], 'Rigol DHO800 metadata block extent');
  }

  if (blocksEnd < 0) {
    importFailure(
      descriptors.length >= MAX_BLOCKS ? 'decode-budget-exceeded' : 'truncated-file',
      descriptors.length >= MAX_BLOCKS
        ? `Rigol DHO800 metadata exceeds ${MAX_BLOCKS} blocks.`
        : 'Rigol DHO800 metadata has no complete terminator.',
      'rigol-wfm',
      request
    );
  }
  if (descriptors.length === 0) {
    importFailure('invalid-header', 'Rigol DHO800 file contains no metadata blocks.', 'rigol-wfm', request);
  }
  return { descriptors, blocksEnd, aggregateOutputBytes };
}

async function decodeBlocks(
  reader: CheckedReader,
  request: ScopeImportRequest,
  descriptors: readonly BlockDescriptor[]
): Promise<DecodedBlock[]> {
  const blocks: DecodedBlock[] = [];
  for (let index = 0; index < descriptors.length; index += 1) {
    checkpoint(request, 0.08 + (0.37 * index) / descriptors.length, 'Decoding Rigol DHO800 metadata');
    const descriptor = descriptors[index];
    const compressed = reader.bytes.subarray(
      descriptor.contentOffset,
      descriptor.contentOffset + descriptor.compressedSize
    );
    const content =
      descriptor.compressedSize === descriptor.decompressedSize
        ? compressed
        : await inflateExact(compressed, descriptor.decompressedSize, request);
    if (content.byteLength !== descriptor.decompressedSize) {
      importFailure(
        'length-mismatch',
        `Rigol DHO800 metadata block ${index + 1} does not match its declared output size.`,
        'rigol-wfm',
        request
      );
    }
    blocks.push({ ...descriptor, content });
  }
  return blocks;
}

function extractCalibrations(blocks: readonly DecodedBlock[], request: ScopeImportRequest): Map<number, Calibration> {
  const calibrations = new Map<number, Calibration>();
  for (const block of blocks) {
    if (block.type !== 5 || block.id < 1 || block.id > 4) continue;
    if (calibrations.has(block.id)) {
      importFailure(
        'invalid-header',
        `Rigol DHO800 repeats calibration block for CH${block.id}.`,
        'rigol-wfm',
        request
      );
    }
    const payload = new CheckedReader(block.content, 'rigol-wfm');
    payload.requireRange(0, 42, `Rigol DHO800 CH${block.id} calibration`);
    const scaleNumerator = safeI64(payload, 1, `Rigol DHO800 CH${block.id} scale numerator`);
    const scale = scaleNumerator / 7_500_000_000_000;
    const center = -payload.i32(38, true, `Rigol DHO800 CH${block.id} voltage centre`) / 1e9;
    const offset = center - scale * ADC_MIDPOINT;
    positiveFiniteField(payload, scale, `Rigol DHO800 CH${block.id} volts per code`, request);
    finiteField(payload, center, `Rigol DHO800 CH${block.id} voltage centre`);
    finiteField(payload, offset, `Rigol DHO800 CH${block.id} voltage offset`);
    calibrations.set(block.id, { scale, center, offset });
  }
  return calibrations;
}

function hardwareModel(blocks: readonly DecodedBlock[]): string {
  for (const block of blocks) {
    const text = cleanAscii(new TextDecoder('ascii').decode(block.content));
    const match = /(?:DHO|HDO)8[0-9A-Z-]*/i.exec(text);
    if (match) return match[0];
  }
  return '';
}

function triggerPositionPercent(blocks: readonly DecodedBlock[], request: ScopeImportRequest): number {
  const block = blocks.find((candidate) => candidate.id === 282);
  if (!block || block.content.byteLength < 16) {
    importFailure(
      'unsupported-variant',
      'Rigol DHO800 trigger position metadata is unavailable; the time origin cannot be reconstructed safely.',
      'rigol-wfm',
      request
    );
  }
  const reader = new CheckedReader(block.content, 'rigol-wfm');
  const percent = reader.u32(12, true, 'Rigol DHO800 trigger position percent');
  if (percent !== 50) {
    importFailure(
      'unsupported-variant',
      `Rigol DHO800 trigger position ${percent}% is not supported until its time-origin equation is fixture-verified.`,
      'rigol-wfm',
      request
    );
  }
  return percent;
}

export async function decodeDhoWfm(
  request: ScopeImportRequest,
  reader: CheckedReader
): Promise<ImportedWaveformRecord[]> {
  checkpoint(request, 0.01, 'Reading Rigol DHO800 WFM blocks');
  assertSignature(reader, [0x02, 0x00, 0x00, 0x00], 'Rigol DHO800 WFM signature', request);
  reader.requireRange(0, FILE_HEADER_BYTES + BLOCK_HEADER_BYTES, 'Rigol DHO800 WFM opening structures');

  const parsed = parseBlockDescriptors(reader, request);
  const hasDho800Calibration = parsed.descriptors.some((block) => block.type === 5 && block.id >= 1 && block.id <= 4);
  if (!hasDho800Calibration) {
    if (parsed.descriptors.some((block) => block.type === 9 && block.id >= 1 && block.id <= 4)) {
      importFailure(
        'unsupported-variant',
        'Rigol DHO1000 WFM is not fixture-backed by this adapter.',
        'rigol-wfm',
        request
      );
    }
    importFailure('invalid-header', 'Rigol DHO800 WFM has no channel calibration blocks.', 'rigol-wfm', request);
  }

  const blocks = await decodeBlocks(reader, request, parsed.descriptors);
  const calibrations = extractCalibrations(blocks, request);
  const triggerPercent = triggerPositionPercent(blocks, request);
  let dataHeaderOffset = parsed.blocksEnd;
  while (dataHeaderOffset < reader.bytes.byteLength && reader.bytes[dataHeaderOffset] === 0) {
    checkLoopCancellation(request, dataHeaderOffset);
    dataHeaderOffset += 1;
  }
  reader.requireRange(dataHeaderOffset, DATA_HEADER_BYTES, 'Rigol DHO800 data header');
  const totalSamples = reader.u64(dataHeaderOffset, true, 'Rigol DHO800 total interleaved sample count');
  const points = reader.u32(dataHeaderOffset + 24, true, 'Rigol DHO800 samples per channel');
  const repeatedPoints = reader.u32(dataHeaderOffset + 28, true, 'Rigol DHO800 repeated samples per channel');
  if (points === 0 || points !== repeatedPoints || totalSamples % points !== 0) {
    importFailure(
      'length-mismatch',
      'Rigol DHO800 sample-count fields do not describe complete interleaved channels.',
      'rigol-wfm',
      request
    );
  }
  const channelCount = totalSamples / points;
  if (!Number.isSafeInteger(channelCount) || channelCount < 1 || channelCount > 4) {
    importFailure(
      'unsupported-variant',
      `Rigol DHO800 analogue channel count ${channelCount} is not supported.`,
      'rigol-wfm',
      request
    );
  }
  const tickCount = reader.u32(dataHeaderOffset + 16, true, 'Rigol DHO800 sample-interval ticks');
  if (tickCount === 0 || tickCount > 1_000_000_000) {
    importFailure(
      'invalid-header',
      'Rigol DHO800 sample-interval ticks are outside the supported range.',
      'rigol-wfm',
      request
    );
  }
  const timeStep = tickCount * DHO800_TICK_SECONDS;
  finiteField(reader, timeStep, 'Rigol DHO800 sample interval');
  const dataOffset = reader.checkedSum([dataHeaderOffset, DATA_HEADER_BYTES], 'Rigol DHO800 sample offset');
  const payloadBytes = reader.checkedProduct(totalSamples, 2, 'Rigol DHO800 uint16 payload size');
  const expectedLength = reader.checkedSum([dataOffset, payloadBytes], 'Rigol DHO800 file extent');
  assertExactLength(reader, expectedLength, 'Rigol DHO800 file extent', request);

  const plans: DhoChannelPlan[] = [];
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const calibration = calibrations.get(channelIndex + 1);
    if (!calibration) {
      importFailure(
        'invalid-header',
        `Rigol DHO800 has samples for CH${channelIndex + 1} but no matching calibration.`,
        'rigol-wfm',
        request
      );
    }
    plans.push({
      channelNumber: channelIndex + 1,
      calibration,
      sampleCount: points,
      timeStart: -points * (triggerPercent / 100) * timeStep,
      timeStep
    });
  }
  validateChannelPlans(reader, request, plans, parsed.aggregateOutputBytes);

  const channels: DecodedRigolChannel[] = plans.map((plan, channelIndex) => {
    const values = new Float64Array(points);
    for (let sampleIndex = 0; sampleIndex < points; sampleIndex += 1) {
      checkLoopCancellation(request, sampleIndex);
      const interleavedIndex = reader.checkedSum(
        [reader.checkedProduct(sampleIndex, channelCount, 'Rigol DHO800 interleaved sample index'), channelIndex],
        'Rigol DHO800 channel sample index'
      );
      const sampleOffset = reader.checkedSum(
        [dataOffset, reader.checkedProduct(interleavedIndex, 2, 'Rigol DHO800 sample byte offset')],
        'Rigol DHO800 sample address'
      );
      const raw = reader.view.getUint16(sampleOffset, true);
      values[sampleIndex] = Math.fround(plan.calibration.scale * raw + plan.calibration.offset);
    }
    checkpoint(request, 0.55 + (0.35 * (channelIndex + 1)) / plans.length, 'De-interleaving Rigol DHO800 channels');
    return {
      name: `CH${plan.channelNumber}`,
      values,
      unit: '',
      sourceUnit: '',
      sourceToSiScale: 1,
      calibrationSource: 'Rigol DHO800 uint16 scale/offset calibration (7.5e12 scale denominator)',
      sampleCount: points,
      timeStart: plan.timeStart,
      timeStep: plan.timeStep
    };
  });

  const model = hardwareModel(blocks);
  const records = buildRecords(
    request,
    'rigol-wfm',
    {
      brand: 'Rigol',
      family: 'DHO800',
      parser: 'dho1000',
      instrument_model: 'DHO800',
      hardware_model: model || null,
      firmware_version: 'unknown',
      metadata_block_count: blocks.length,
      trigger_position_percent: triggerPercent
    },
    channels
  );
  checkpoint(request, 1, 'Rigol DHO800 WFM decoded');
  return records;
}
