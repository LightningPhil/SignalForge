import type { DataRepairRecord } from '../types';

export type ReviewStatus = 'unreviewed' | 'in-progress' | 'accepted' | 'excluded';
export type AnnotationKind = 'marker' | 'region';
export type AnnotationSource = 'manual' | 'suggested';
export type SuggestionState = 'pending' | 'accepted' | 'rejected';

export interface SessionMetadata {
  operator?: string;
  facility?: string;
  campaign?: string;
  description?: string;
  [key: string]: string | number | boolean | null | undefined;
}

export interface SourceFileRecord {
  id: string;
  name: string;
  size: number;
  lastModified: number | null;
  adapterId: string;
  checksum?: string;
  bytes?: Uint8Array;
  metadata: Record<string, string | number | boolean | null>;
  warnings: string[];
}

export interface ChannelCalibration {
  scale: number;
  offset: number;
  source?: string;
}

export interface SessionChannel {
  id: string;
  name: string;
  unit: string;
  sourceUnit?: string;
  sourceToSiScale?: number;
  sourceFormat?: string;
  timeUnit: string;
  time: Float64Array;
  originalTime?: Float64Array;
  originalValues?: Float64Array;
  originalValueTokens?: Record<number, string | boolean | null>;
  originalTimeTokens?: Record<number, string | boolean | null>;
  values: Float64Array;
  originalQuality?: Uint16Array;
  quality: Uint16Array;
  calibration: ChannelCalibration;
  probe?: string;
  timingOffsetSeconds: number;
  sourceFileId?: string;
}

export interface Annotation {
  id: string;
  name: string;
  kind: AnnotationKind;
  startTime: number;
  endTime?: number;
  source: AnnotationSource;
  suggestionState?: SuggestionState;
  snapMode?: 'none' | 'sample' | 'slope' | 'curvature' | 'change-point';
  channelId?: string;
  author?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AnalysisProvenance {
  sourceChannelIds: string[];
  processingRecipeHash: string;
  annotationIds: string[];
  warnings: string[];
  applicationVersion: string;
  appliedDelaySeconds?: number;
  createdAt: string;
}

export interface SessionAnalysisResult {
  id: string;
  type: string;
  values: Record<string, number | string | boolean | null>;
  units: Record<string, string>;
  provenance: AnalysisProvenance;
}

export interface Shot {
  id: string;
  name: string;
  sequence: number | null;
  metadata: Record<string, string | number | boolean | null>;
  sourceFiles: SourceFileRecord[];
  channels: SessionChannel[];
  annotations: Annotation[];
  analysisResults: SessionAnalysisResult[];
  repairHistory: DataRepairRecord[];
  repairCursor: number;
  reviewStatus: ReviewStatus;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  name: string;
  metadata: SessionMetadata;
  importProfileId: string | null;
  processingRecipe: Record<string, unknown>;
  shots: Shot[];
  createdAt: string;
  updatedAt: string;
  schemaVersion: number;
}

function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function createSession(name = 'Untitled session'): Session {
  const now = new Date().toISOString();
  return {
    id: id('session'),
    name,
    metadata: {},
    importProfileId: null,
    processingRecipe: {},
    shots: [],
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1
  };
}

export function createShot(name: string, sequence: number | null = null): Shot {
  const now = new Date().toISOString();
  return {
    id: id('shot'),
    name,
    sequence,
    metadata: {},
    sourceFiles: [],
    channels: [],
    annotations: [],
    analysisResults: [],
    repairHistory: [],
    repairCursor: 0,
    reviewStatus: 'unreviewed',
    notes: '',
    createdAt: now,
    updatedAt: now
  };
}

export function createAnnotation(
  name: string,
  startTime: number,
  options: Partial<Omit<Annotation, 'id' | 'name' | 'startTime' | 'createdAt' | 'updatedAt'>> = {}
): Annotation {
  const now = new Date().toISOString();
  return {
    id: id('annotation'),
    name,
    kind: options.kind || 'marker',
    startTime,
    endTime: options.endTime,
    source: options.source || 'manual',
    suggestionState: options.source === 'suggested' ? options.suggestionState || 'pending' : 'accepted',
    snapMode: options.snapMode || 'none',
    channelId: options.channelId,
    author: options.author,
    createdAt: now,
    updatedAt: now
  };
}

export function authoritativeAnnotation(annotations: Annotation[], name: string): Annotation | null {
  const candidates = annotations.filter(
    (annotation) =>
      annotation.name === name && (annotation.source === 'manual' || annotation.suggestionState === 'accepted')
  );
  return candidates.find((annotation) => annotation.source === 'manual') || candidates[0] || null;
}
