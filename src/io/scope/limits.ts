import { ScopeImportError, type ScopeFormat } from './types';

export const ScopeImportLimits = {
  maxFileBytes: 64 * 1024 * 1024,
  maxXmlBytes: 16 * 1024 * 1024,
  maxDecodedBytes: 192 * 1024 * 1024,
  maxTotalChannelSamples: 3_000_000,
  maxSamplesPerChannel: 3_000_000,
  maxChannels: 4,
  maxRecords: 10_000,
  maxMetadataStringBytes: 4096
} as const;

export class CheckedReader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly format?: ScopeFormat;

  constructor(bytes: Uint8Array, format?: ScopeFormat) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.format = format;
    if (bytes.byteLength > ScopeImportLimits.maxFileBytes) {
      throw new ScopeImportError(
        'decode-budget-exceeded',
        `Source is ${bytes.byteLength} bytes; the per-file limit is ${ScopeImportLimits.maxFileBytes} bytes.`,
        { format }
      );
    }
  }

  requireRange(offset: number, length: number, context: string): void {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset > this.bytes.byteLength - length
    ) {
      throw new ScopeImportError('truncated-file', `${context} exceeds the source bounds.`, {
        format: this.format
      });
    }
  }

  checkedProduct(left: number, right: number, context: string): number {
    if (
      !Number.isSafeInteger(left) ||
      !Number.isSafeInteger(right) ||
      left < 0 ||
      right < 0 ||
      (left !== 0 && right > Math.floor(Number.MAX_SAFE_INTEGER / left))
    ) {
      throw new ScopeImportError('invalid-header', `${context} overflows safe integer precision.`, {
        format: this.format
      });
    }
    return left * right;
  }

  checkedSum(values: number[], context: string): number {
    let total = 0;
    for (const value of values) {
      if (!Number.isSafeInteger(value) || value < 0 || total > Number.MAX_SAFE_INTEGER - value) {
        throw new ScopeImportError('invalid-header', `${context} overflows safe integer precision.`, {
          format: this.format
        });
      }
      total += value;
    }
    return total;
  }

  u8(offset: number, context = 'uint8'): number {
    this.requireRange(offset, 1, context);
    return this.view.getUint8(offset);
  }

  i8(offset: number, context = 'int8'): number {
    this.requireRange(offset, 1, context);
    return this.view.getInt8(offset);
  }

  u16(offset: number, littleEndian: boolean, context = 'uint16'): number {
    this.requireRange(offset, 2, context);
    return this.view.getUint16(offset, littleEndian);
  }

  i16(offset: number, littleEndian: boolean, context = 'int16'): number {
    this.requireRange(offset, 2, context);
    return this.view.getInt16(offset, littleEndian);
  }

  u32(offset: number, littleEndian: boolean, context = 'uint32'): number {
    this.requireRange(offset, 4, context);
    return this.view.getUint32(offset, littleEndian);
  }

  i32(offset: number, littleEndian: boolean, context = 'int32'): number {
    this.requireRange(offset, 4, context);
    return this.view.getInt32(offset, littleEndian);
  }

  f32(offset: number, littleEndian: boolean, context = 'float32'): number {
    this.requireRange(offset, 4, context);
    return this.view.getFloat32(offset, littleEndian);
  }

  f64(offset: number, littleEndian: boolean, context = 'float64'): number {
    this.requireRange(offset, 8, context);
    return this.view.getFloat64(offset, littleEndian);
  }

  u64(offset: number, littleEndian: boolean, context = 'uint64'): number {
    this.requireRange(offset, 8, context);
    const value = this.view.getBigUint64(offset, littleEndian);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ScopeImportError('invalid-header', `${context} exceeds safe integer precision.`, {
        format: this.format
      });
    }
    return Number(value);
  }

  ascii(offset: number, length: number, context = 'text'): string {
    this.requireRange(offset, length, context);
    return new TextDecoder('ascii').decode(this.bytes.subarray(offset, offset + length)).replace(/\0.*$/s, '');
  }
}

export function validateRecordShape(
  sampleCount: number,
  channelCount: number,
  temporaryBytes: number,
  format: ScopeFormat
): void {
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 1 || sampleCount > ScopeImportLimits.maxSamplesPerChannel) {
    throw new ScopeImportError(
      sampleCount > ScopeImportLimits.maxSamplesPerChannel ? 'decode-budget-exceeded' : 'invalid-header',
      `Sample count ${sampleCount} is outside the supported range.`,
      { format }
    );
  }
  if (!Number.isSafeInteger(channelCount) || channelCount < 1 || channelCount > ScopeImportLimits.maxChannels) {
    throw new ScopeImportError('unsupported-variant', `Analogue channel count ${channelCount} is unsupported.`, {
      format
    });
  }
  const totalSamples = sampleCount * channelCount;
  if (!Number.isSafeInteger(totalSamples) || totalSamples > ScopeImportLimits.maxTotalChannelSamples) {
    throw new ScopeImportError(
      'decode-budget-exceeded',
      `Decoded channel-sample count ${totalSamples} exceeds the limit.`,
      {
        format
      }
    );
  }
  const predictedBytes = sampleCount * 8 + totalSamples * 10 + temporaryBytes;
  if (!Number.isSafeInteger(predictedBytes) || predictedBytes > ScopeImportLimits.maxDecodedBytes) {
    throw new ScopeImportError(
      'decode-budget-exceeded',
      `Predicted decoded working set ${predictedBytes} bytes exceeds ${ScopeImportLimits.maxDecodedBytes} bytes.`,
      { format }
    );
  }
}

export function requireFinite(value: number, context: string, format: ScopeFormat): number {
  if (!Number.isFinite(value)) {
    throw new ScopeImportError('invalid-header', `${context} must be finite.`, { format });
  }
  return value;
}
