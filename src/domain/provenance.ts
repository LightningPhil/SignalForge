import { AnalysisExclusionMask, QualityFlag } from '../data/quality';

export type HashSource = string | Blob | ArrayBuffer | ArrayBufferView;

export interface SourceFingerprintInput {
  bytes: HashSource;
  name?: string | null;
  size?: number;
  lastModified?: number | null;
}

export interface SourceFingerprint {
  name: string | null;
  size: number;
  lastModified: number | null;
  sha256: string;
}

export interface RecipeSelection {
  i0: number | null;
  i1: number | null;
  xMin?: number | null;
  xMax?: number | null;
}

export interface ProcessingRecipeInput {
  columnId?: string | null;
  sourceMode: string;
  isMath?: boolean;
  pipeline?: unknown;
  pipelineReport?: unknown;
  firDesigns?: unknown;
  mathDefinitions?: unknown;
  repairHistory?: unknown;
  repairCursor?: number;
  traceConfig?: unknown;
}

export interface ProcessingRecipePayload {
  kind: 'signalforge-processing-recipe';
  schemaVersion: 1;
  source: {
    columnId: string | null;
    mode: string;
    isMath: boolean;
  };
  pipeline: unknown;
  pipelineReport: unknown;
  firDesigns: unknown;
  mathDefinitions: unknown;
  repairHistory: unknown;
  repairCursor: number;
  traceConfig: unknown;
}

export interface AnalysisRecipeInput {
  config: unknown;
  selection?: RecipeSelection | null;
  series?: unknown;
}

export interface AnalysisRecipePayload {
  kind: 'signalforge-analysis-recipe';
  schemaVersion: 1;
  config: unknown;
  selection: RecipeSelection | null;
  series: unknown;
}

export type QualityFlagName = Exclude<keyof typeof QualityFlag, 'None'>;

export interface QualitySummary {
  selection: { i0: number | null; i1: number | null };
  totalSampleCount: number;
  selectedSampleCount: number;
  cleanSampleCount: number;
  flaggedSampleCount: number;
  analysisExcludedSampleCount: number;
  counts: Record<QualityFlagName, number>;
}

export interface WarningBag {
  warnings?: readonly string[] | null;
}

export type WarningSource = WarningBag | readonly string[] | null | undefined;

export interface SystemWarningSource extends WarningBag {
  delay?: WarningSource;
  frf?: WarningSource;
}

export interface PipelineWarningSource extends WarningBag {
  steps?: readonly WarningSource[];
}

export interface LimitationSources {
  measurements?: WarningSource;
  events?: WarningSource;
  spectral?: WarningSource;
  system?: SystemWarningSource | null;
  pipeline?: WarningSource | readonly WarningSource[] | PipelineWarningSource;
}

/**
 * JSON.stringify-compatible canonical serialization with recursively sorted
 * object keys. Unsupported object properties are omitted and unsupported array
 * entries become null, matching native JSON semantics.
 */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();

  const serialize = (candidate: unknown, key: string): string | undefined => {
    if (candidate === null) return 'null';

    switch (typeof candidate) {
      case 'string':
      case 'boolean':
        return JSON.stringify(candidate);
      case 'number':
        return Number.isFinite(candidate) ? JSON.stringify(candidate) : 'null';
      case 'bigint':
        throw new TypeError('BigInt values are not JSON-serializable.');
      case 'undefined':
      case 'function':
      case 'symbol':
        return undefined;
      case 'object':
        break;
    }

    const object = candidate as object;
    const tag = Object.prototype.toString.call(object);
    if (tag === '[object Number]' || tag === '[object String]' || tag === '[object Boolean]') {
      return serialize((object as { valueOf(): unknown }).valueOf(), key);
    }
    if (tag === '[object BigInt]') {
      throw new TypeError('BigInt values are not JSON-serializable.');
    }

    const withToJson = object as { toJSON?: (propertyKey: string) => unknown };
    if (typeof withToJson.toJSON === 'function') {
      if (ancestors.has(object)) throw new TypeError('Cannot canonicalize a circular structure.');
      ancestors.add(object);
      try {
        const replacement = withToJson.toJSON(key);
        if (replacement !== object) return serialize(replacement, key);
      } finally {
        ancestors.delete(object);
      }
    }

    if (ancestors.has(object)) throw new TypeError('Cannot canonicalize a circular structure.');
    ancestors.add(object);
    try {
      if (Array.isArray(object)) {
        const entries = Array.from(
          { length: object.length },
          (_, index) => serialize(object[index], String(index)) ?? 'null'
        );
        return `[${entries.join(',')}]`;
      }

      const entries: string[] = [];
      const record = object as Record<string, unknown>;
      for (const property of Object.keys(record).sort()) {
        const serialized = serialize(record[property], property);
        if (serialized !== undefined) entries.push(`${JSON.stringify(property)}:${serialized}`);
      }
      return `{${entries.join(',')}}`;
    } finally {
      ancestors.delete(object);
    }
  };

  const serialized = serialize(value, '');
  if (serialized === undefined) {
    throw new TypeError('The root value is not JSON-serializable.');
  }
  return serialized;
}

export const stableStringify = canonicalJson;
export const canonicalStringify = canonicalJson;

function sourcePayload(source: HashSource | { bytes: HashSource }): HashSource {
  if (
    typeof source === 'string' ||
    source instanceof ArrayBuffer ||
    ArrayBuffer.isView(source) ||
    (typeof Blob !== 'undefined' && source instanceof Blob)
  ) {
    return source;
  }
  return (source as { bytes: HashSource }).bytes;
}

async function toBytes(source: HashSource): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof source === 'string') return new TextEncoder().encode(source);
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    return new Uint8Array(await source.arrayBuffer());
  }
  if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(0));
  if (ArrayBuffer.isView(source)) {
    return Uint8Array.from(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
  }
  throw new TypeError('SHA-256 source must be text, a Blob, an ArrayBuffer, or an ArrayBuffer view.');
}

async function digestBytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto SHA-256 is unavailable in this runtime.');
  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(source: HashSource | { bytes: HashSource }): Promise<string> {
  return digestBytes(await toBytes(sourcePayload(source)));
}

export async function hashCanonicalJson(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

export const sourceSha256 = sha256Hex;
export const hashSource = sha256Hex;

export async function buildSourceFingerprint(input: SourceFingerprintInput): Promise<SourceFingerprint> {
  const bytes = await toBytes(input.bytes);
  return {
    name: input.name ?? null,
    size: Number.isFinite(input.size) && (input.size as number) >= 0 ? (input.size as number) : bytes.byteLength,
    lastModified: Number.isFinite(input.lastModified) ? (input.lastModified as number) : null,
    sha256: await digestBytes(bytes)
  };
}

function canonicalCopy(value: unknown): unknown {
  return JSON.parse(canonicalJson(value)) as unknown;
}

export function buildProcessingRecipePayload(input: ProcessingRecipeInput): ProcessingRecipePayload {
  return {
    kind: 'signalforge-processing-recipe',
    schemaVersion: 1,
    source: {
      columnId: input.columnId ?? null,
      mode: input.sourceMode,
      isMath: input.isMath === true
    },
    pipeline: canonicalCopy(input.pipeline ?? []),
    pipelineReport: canonicalCopy(input.pipelineReport ?? []),
    firDesigns: canonicalCopy(input.firDesigns ?? []),
    mathDefinitions: canonicalCopy(input.mathDefinitions ?? []),
    repairHistory: canonicalCopy(input.repairHistory ?? []),
    repairCursor: Number.isInteger(input.repairCursor) && (input.repairCursor as number) >= 0 ? input.repairCursor! : 0,
    traceConfig: canonicalCopy(input.traceConfig ?? null)
  };
}

export function buildAnalysisRecipePayload(input: AnalysisRecipeInput): AnalysisRecipePayload {
  return {
    kind: 'signalforge-analysis-recipe',
    schemaVersion: 1,
    config: canonicalCopy(input.config === undefined ? {} : input.config),
    selection: canonicalCopy(input.selection ?? null) as RecipeSelection | null,
    series: canonicalCopy(input.series ?? null)
  };
}

const QUALITY_FLAGS = Object.entries(QualityFlag).filter(
  (entry): entry is [QualityFlagName, number] => entry[0] !== 'None' && entry[1] !== QualityFlag.None
);

function selectedBounds(length: number, selection: RecipeSelection | null | undefined): { start: number; end: number } {
  if (length === 0) return { start: 0, end: -1 };
  if (
    !selection ||
    selection.i0 === null ||
    selection.i1 === null ||
    !Number.isFinite(selection.i0) ||
    !Number.isFinite(selection.i1)
  ) {
    return { start: 0, end: length - 1 };
  }
  const first = Math.max(0, Math.min(length - 1, Math.trunc(selection.i0)));
  const second = Math.max(0, Math.min(length - 1, Math.trunc(selection.i1)));
  return { start: Math.min(first, second), end: Math.max(first, second) };
}

export function buildQualitySummary(
  quality: ArrayLike<number>,
  selection: RecipeSelection | null = null
): QualitySummary {
  const totalSampleCount = Math.max(0, Math.trunc(Number(quality.length) || 0));
  const { start, end } = selectedBounds(totalSampleCount, selection);
  const counts = Object.fromEntries(QUALITY_FLAGS.map(([name]) => [name, 0])) as Record<QualityFlagName, number>;
  let cleanSampleCount = 0;
  let flaggedSampleCount = 0;
  let analysisExcludedSampleCount = 0;

  for (let index = start; index <= end; index += 1) {
    const mask = Number(quality[index]) || QualityFlag.None;
    if (mask === QualityFlag.None) cleanSampleCount += 1;
    else flaggedSampleCount += 1;
    if ((mask & AnalysisExclusionMask) !== 0) analysisExcludedSampleCount += 1;
    for (const [name, flag] of QUALITY_FLAGS) {
      if ((mask & flag) !== 0) counts[name] += 1;
    }
  }

  const selectedSampleCount = end >= start ? end - start + 1 : 0;
  return {
    selection: {
      i0: selectedSampleCount > 0 ? start : null,
      i1: selectedSampleCount > 0 ? end : null
    },
    totalSampleCount,
    selectedSampleCount,
    cleanSampleCount,
    flaggedSampleCount,
    analysisExcludedSampleCount,
    counts
  };
}

export const summarizeQuality = buildQualitySummary;

export function deduplicateWarnings(warnings: readonly unknown[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const warning of warnings) {
    if (typeof warning !== 'string') continue;
    const normalized = warning.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

function warningsFrom(source: WarningSource): readonly string[] {
  if (!source) return [];
  if (Array.isArray(source)) return source;
  return (source as WarningBag).warnings ?? [];
}

export function collectLimitations(sources: LimitationSources): string[] {
  const warnings: unknown[] = [
    ...warningsFrom(sources.measurements),
    ...warningsFrom(sources.events),
    ...warningsFrom(sources.spectral)
  ];

  if (sources.system) {
    warnings.push(
      ...warningsFrom(sources.system),
      ...warningsFrom(sources.system.delay),
      ...warningsFrom(sources.system.frf)
    );
  }

  const pipeline = sources.pipeline;
  if (Array.isArray(pipeline)) {
    if (pipeline.every((entry) => typeof entry === 'string')) warnings.push(...pipeline);
    else {
      for (const step of pipeline as readonly WarningSource[]) warnings.push(...warningsFrom(step));
    }
  } else if (pipeline) {
    warnings.push(...warningsFrom(pipeline as WarningSource));
    const steps = (pipeline as PipelineWarningSource).steps;
    if (steps) {
      for (const step of steps) warnings.push(...warningsFrom(step));
    }
  }

  return deduplicateWarnings(warnings);
}
