import { QualityFlag } from '../../src/data/quality.ts';

const UINT32_RANGE = 0x1_0000_0000;
const CANONICAL_NAN = 0x7ff8_0000_0000_0000n;

export interface SeededRng {
  nextUint32(): number;
  uniform(): number;
  normal(): number;
}

export interface PulseComponent {
  kind: 'pulse';
  startSeconds: number;
  widthSeconds: number;
  amplitude: number;
  riseSeconds?: number;
  fallSeconds?: number;
}

export interface RingingComponent {
  kind: 'ringing';
  startSeconds: number;
  amplitude: number;
  frequencyHz: number;
  decaySeconds: number;
  phaseRadians?: number;
  endSeconds?: number;
}

export interface WhiteNoiseComponent {
  kind: 'whiteNoise';
  sigma: number;
}

export interface ClipComponent {
  kind: 'clip';
  minimum: number;
  maximum: number;
}

export interface NanGapComponent {
  kind: 'nanGap';
  startIndex: number;
  endIndex: number;
}

export type SyntheticComponent =
  PulseComponent | RingingComponent | WhiteNoiseComponent | ClipComponent | NanGapComponent;

export interface SyntheticRecord {
  name: string;
  time: Float64Array;
  values: Float64Array;
  quality: Uint16Array;
}

export interface SyntheticRecordOptions {
  name: string;
  time: Float64Array;
  seed: number;
  baseline?: number;
  components: readonly SyntheticComponent[];
}

export interface AnalyticByteBudget {
  sampleCount: number;
  channelCount: number;
  timeBytes: number;
  valueBytes: number;
  qualityBytes: number;
  totalBytes: number;
}

function requireLength(length: number): number {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error('Synthetic sample length must be a non-negative safe integer.');
  }
  return length;
}

function requireSampleRate(sampleRate: number): number {
  if (!Number.isFinite(sampleRate) || !(sampleRate > 0)) {
    throw new Error('Synthetic sample rate must be finite and positive.');
  }
  return sampleRate;
}

/**
 * Mulberry32 with a cached Box-Muller transform. The uniform stream is specified entirely with
 * 32-bit integer arithmetic, while normal draws remain deterministic for a given JS runtime.
 */
export function createSeededRng(seed: number): SeededRng {
  let state = Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 0;
  let spareNormal: number | null = null;

  const nextUint32 = () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  };
  const uniform = () => (nextUint32() + 0.5) / UINT32_RANGE;
  const normal = () => {
    if (spareNormal !== null) {
      const value = spareNormal;
      spareNormal = null;
      return value;
    }
    const magnitude = Math.sqrt(-2 * Math.log(uniform()));
    const angle = 2 * Math.PI * uniform();
    spareNormal = magnitude * Math.sin(angle);
    return magnitude * Math.cos(angle);
  };

  return { nextUint32, uniform, normal };
}

export function uniformTimebase(length: number, sampleRate: number, startSeconds = 0): Float64Array {
  const count = requireLength(length);
  const rate = requireSampleRate(sampleRate);
  if (!Number.isFinite(startSeconds)) throw new Error('Synthetic start time must be finite.');
  return Float64Array.from({ length: count }, (_, index) => startSeconds + index / rate);
}

export function jitteredTimebase(
  length: number,
  sampleRate: number,
  rng: SeededRng,
  jitterFraction = 0.02,
  startSeconds = 0
): Float64Array {
  const count = requireLength(length);
  const rate = requireSampleRate(sampleRate);
  if (!Number.isFinite(jitterFraction) || jitterFraction < 0 || jitterFraction >= 1) {
    throw new Error('Timebase jitter fraction must be finite and in [0, 1).');
  }
  if (!Number.isFinite(startSeconds)) throw new Error('Synthetic start time must be finite.');

  const time = new Float64Array(count);
  if (count === 0) return time;
  time[0] = startSeconds;
  const nominalDt = 1 / rate;
  for (let index = 1; index < count; index += 1) {
    const intervalScale = 1 + jitterFraction * (2 * rng.uniform() - 1);
    time[index] = time[index - 1] + nominalDt * intervalScale;
  }
  return time;
}

export function addPulse(time: ArrayLike<number>, values: Float64Array, component: PulseComponent): void {
  const rise = Math.max(0, component.riseSeconds ?? 0);
  const fall = Math.max(0, component.fallSeconds ?? rise);
  if (!(component.widthSeconds > 0) || !Number.isFinite(component.amplitude)) {
    throw new Error('Pulse width must be positive and amplitude must be finite.');
  }
  if (rise + fall > component.widthSeconds) {
    throw new Error('Pulse rise and fall durations cannot exceed its width.');
  }

  const length = Math.min(time.length, values.length);
  for (let index = 0; index < length; index += 1) {
    const elapsed = Number(time[index]) - component.startSeconds;
    if (elapsed < 0 || elapsed >= component.widthSeconds) continue;
    const risingScale = rise > 0 && elapsed < rise ? elapsed / rise : 1;
    const fallingScale =
      fall > 0 && elapsed > component.widthSeconds - fall ? (component.widthSeconds - elapsed) / fall : 1;
    values[index] += component.amplitude * Math.max(0, Math.min(risingScale, fallingScale));
  }
}

export function addRinging(time: ArrayLike<number>, values: Float64Array, component: RingingComponent): void {
  if (!(component.frequencyHz > 0) || !(component.decaySeconds > 0) || !Number.isFinite(component.amplitude)) {
    throw new Error('Ringing frequency and decay must be positive and amplitude must be finite.');
  }
  const phase = component.phaseRadians ?? 0;
  const length = Math.min(time.length, values.length);
  for (let index = 0; index < length; index += 1) {
    const elapsed = Number(time[index]) - component.startSeconds;
    if (elapsed < 0 || (component.endSeconds !== undefined && Number(time[index]) > component.endSeconds)) continue;
    values[index] +=
      component.amplitude *
      Math.exp(-elapsed / component.decaySeconds) *
      Math.cos(2 * Math.PI * component.frequencyHz * elapsed + phase);
  }
}

export function addWhiteNoise(values: Float64Array, sigma: number, rng: SeededRng): void {
  if (!Number.isFinite(sigma) || sigma < 0) throw new Error('White-noise sigma must be finite and non-negative.');
  for (let index = 0; index < values.length; index += 1) values[index] += sigma * rng.normal();
}

export function clipSignal(values: Float64Array, quality: Uint16Array, minimum: number, maximum: number): number {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || !(minimum < maximum)) {
    throw new Error('Clipping bounds must be finite and increasing.');
  }
  let clipped = 0;
  for (let index = 0; index < Math.min(values.length, quality.length); index += 1) {
    if (values[index] < minimum) {
      values[index] = minimum;
      quality[index] |= QualityFlag.Clipped;
      clipped += 1;
    } else if (values[index] > maximum) {
      values[index] = maximum;
      quality[index] |= QualityFlag.Clipped;
      clipped += 1;
    }
  }
  return clipped;
}

export function insertNanGap(values: Float64Array, quality: Uint16Array, startIndex: number, endIndex: number): void {
  const start = Math.max(0, Math.floor(startIndex));
  const end = Math.min(values.length, quality.length, Math.max(start, Math.floor(endIndex)));
  for (let index = start; index < end; index += 1) {
    values[index] = Number.NaN;
    quality[index] |= QualityFlag.Missing;
  }
}

export function composeSyntheticRecord(options: SyntheticRecordOptions): SyntheticRecord {
  const values = new Float64Array(options.time.length);
  values.fill(options.baseline ?? 0);
  const quality = new Uint16Array(options.time.length);
  const rng = createSeededRng(options.seed);

  for (const component of options.components) {
    switch (component.kind) {
      case 'pulse':
        addPulse(options.time, values, component);
        break;
      case 'ringing':
        addRinging(options.time, values, component);
        break;
      case 'whiteNoise':
        addWhiteNoise(values, component.sigma, rng);
        break;
      case 'clip':
        clipSignal(values, quality, component.minimum, component.maximum);
        break;
      case 'nanGap':
        insertNanGap(values, quality, component.startIndex, component.endIndex);
        break;
    }
  }
  return { name: options.name, time: options.time, values, quality };
}

export function countQuality(mask: ArrayLike<number>, flag: number): number {
  let count = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if ((Number(mask[index]) & flag) !== 0) count += 1;
  }
  return count;
}

/**
 * Stable semantic Float64 checksum. Finite non-integers are quantized to 13 significant digits so
 * harmless libm/V8 last-bit differences do not look like scientific regressions. NaN payloads and
 * signed zero are canonicalized and bytes are always little-endian.
 */
export function checksumFloat64(values: ArrayLike<number>): string {
  let laneA = 0x811c_9dc5;
  let laneB = 0x9e37_79b9;
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const update = (byte: number) => {
    laneA = Math.imul(laneA ^ byte, 0x0100_0193) >>> 0;
    laneB = Math.imul(laneB ^ byte, 0x27d4_eb2d) >>> 0;
  };

  view.setBigUint64(0, BigInt(values.length), true);
  for (const byte of bytes) update(byte);
  for (let index = 0; index < values.length; index += 1) {
    const value = Number(values[index]);
    if (Number.isNaN(value)) view.setBigUint64(0, CANONICAL_NAN, true);
    else {
      const normalized = Object.is(value, -0) ? 0 : Number.isInteger(value) ? value : Number(value.toPrecision(13));
      view.setFloat64(0, normalized, true);
    }
    for (const byte of bytes) update(byte);
  }
  return `${laneA.toString(16).padStart(8, '0')}${laneB.toString(16).padStart(8, '0')}`;
}

export function analyticByteBudget(sampleCount: number, channelCount = 1): AnalyticByteBudget {
  const samples = requireLength(sampleCount);
  const channels = requireLength(channelCount);
  const timeBytes = samples * Float64Array.BYTES_PER_ELEMENT;
  const valueBytes = samples * channels * Float64Array.BYTES_PER_ELEMENT;
  const qualityBytes = samples * channels * Uint16Array.BYTES_PER_ELEMENT;
  return {
    sampleCount: samples,
    channelCount: channels,
    timeBytes,
    valueBytes,
    qualityBytes,
    totalBytes: timeBytes + valueBytes + qualityBytes
  };
}

export function recordPayloadBytes(record: SyntheticRecord): number {
  return record.time.byteLength + record.values.byteLength + record.quality.byteLength;
}
