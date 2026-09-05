import { authoritativeAnnotation, type Annotation } from '../domain/session';
import type { AnalysisSelection } from '../types';

export interface RegionMarkerBinding {
  kind: 'region-marker';
  markerName: string;
}

export interface MarkerPairBinding {
  kind: 'marker-pair';
  startMarker: string;
  endMarker: string;
}

export interface ExplicitTimeBinding {
  kind: 'times';
  startTime: number;
  endTime: number;
}

export interface ExplicitIndexBinding {
  kind: 'indices';
  startIndex: number;
  endIndex: number;
}

export interface PlotSelectionBinding {
  kind: 'selection';
}

export type RegionBinding =
  RegionMarkerBinding | MarkerPairBinding | ExplicitTimeBinding | ExplicitIndexBinding | PlotSelectionBinding;

export type PlotSelection = Pick<AnalysisSelection, 'xMin' | 'xMax' | 'i0' | 'i1'>;

export interface RegionResolutionOptions {
  annotations?: readonly Annotation[];
  selection?: PlotSelection | null;
  timingOffsetSeconds?: number;
}

export interface ResolvedRegion {
  resolved: true;
  startTime: number;
  endTime: number;
  startIndex: number;
  endIndex: number;
  annotationIds: string[];
  warnings: string[];
}

export type UnresolvedRegionReason =
  | 'empty-time-array'
  | 'invalid-time-array'
  | 'non-monotonic-time-array'
  | 'invalid-timing-offset'
  | 'invalid-binding'
  | 'missing-selection'
  | 'missing-annotation'
  | 'invalid-annotation';

export interface UnresolvedRegion {
  resolved: false;
  reason: UnresolvedRegionReason;
  message: string;
  annotationIds: string[];
  warnings: string[];
}

export type RegionResolution = ResolvedRegion | UnresolvedRegion;

function unresolved(
  reason: UnresolvedRegionReason,
  message: string,
  annotationIds: string[] = [],
  warnings: string[] = []
): UnresolvedRegion {
  return { resolved: false, reason, message, annotationIds, warnings };
}

function appendWarning(warnings: string[], warning: string): void {
  if (!warnings.includes(warning)) warnings.push(warning);
}

function nearestIndex(time: ArrayLike<number>, targetTime: number): number {
  let low = 0;
  let high = time.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Number(time[middle]) < targetTime) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return 0;
  const before = low - 1;
  return targetTime - Number(time[before]) <= Number(time[low]) - targetTime ? before : low;
}

function sampleTime(time: ArrayLike<number>, index: number, timingOffsetSeconds: number): number {
  return Number(time[index]) + timingOffsetSeconds;
}

function resolveTimeBounds(
  time: ArrayLike<number>,
  timingOffsetSeconds: number,
  firstTime: number,
  secondTime: number,
  annotationIds: string[],
  warnings: string[]
): ResolvedRegion {
  let startTarget = firstTime;
  let endTarget = secondTime;
  if (startTarget > endTarget) {
    [startTarget, endTarget] = [endTarget, startTarget];
    appendWarning(warnings, 'Region bounds were reversed and have been ordered by time.');
  }

  const axisStart = sampleTime(time, 0, timingOffsetSeconds);
  const axisEnd = sampleTime(time, time.length - 1, timingOffsetSeconds);
  if (startTarget < axisStart || endTarget > axisEnd) {
    appendWarning(warnings, 'Region bounds outside the time array were clamped to the nearest endpoint.');
  }

  const startIndex = nearestIndex(time, startTarget - timingOffsetSeconds);
  const endIndex = nearestIndex(time, endTarget - timingOffsetSeconds);
  return {
    resolved: true,
    startTime: sampleTime(time, startIndex, timingOffsetSeconds),
    endTime: sampleTime(time, endIndex, timingOffsetSeconds),
    startIndex,
    endIndex,
    annotationIds,
    warnings
  };
}

function resolveIndexBounds(
  time: ArrayLike<number>,
  timingOffsetSeconds: number,
  firstIndex: number,
  secondIndex: number,
  annotationIds: string[],
  warnings: string[]
): ResolvedRegion {
  let startIndex = firstIndex;
  let endIndex = secondIndex;
  if (startIndex > endIndex) {
    [startIndex, endIndex] = [endIndex, startIndex];
    appendWarning(warnings, 'Region bounds were reversed and have been ordered by time.');
  }

  const lastIndex = time.length - 1;
  const clampedStart = Math.max(0, Math.min(lastIndex, startIndex));
  const clampedEnd = Math.max(0, Math.min(lastIndex, endIndex));
  if (clampedStart !== startIndex || clampedEnd !== endIndex) {
    appendWarning(warnings, 'Region indices outside the time array were clamped.');
  }
  return {
    resolved: true,
    startTime: sampleTime(time, clampedStart, timingOffsetSeconds),
    endTime: sampleTime(time, clampedEnd, timingOffsetSeconds),
    startIndex: clampedStart,
    endIndex: clampedEnd,
    annotationIds,
    warnings
  };
}

function annotationIds(annotations: Array<Annotation | null>): string[] {
  const ids: string[] = [];
  annotations.forEach((annotation) => {
    if (annotation && !ids.includes(annotation.id)) ids.push(annotation.id);
  });
  return ids;
}

function validateTimeArray(time: ArrayLike<number>, timingOffsetSeconds: number): UnresolvedRegion | null {
  if (!Number.isFinite(timingOffsetSeconds)) {
    return unresolved('invalid-timing-offset', 'The timing offset must be finite.');
  }
  if (time.length === 0) {
    return unresolved('empty-time-array', 'The region cannot be resolved against an empty time array.');
  }

  let previous = Number(time[0]);
  if (!Number.isFinite(previous) || !Number.isFinite(previous + timingOffsetSeconds)) {
    return unresolved('invalid-time-array', 'Every timestamp and offset timestamp must be finite.');
  }
  for (let index = 1; index < time.length; index += 1) {
    const current = Number(time[index]);
    if (!Number.isFinite(current) || !Number.isFinite(current + timingOffsetSeconds)) {
      return unresolved('invalid-time-array', 'Every timestamp and offset timestamp must be finite.');
    }
    if (current <= previous) {
      return unresolved('non-monotonic-time-array', 'The time array must be strictly increasing.');
    }
    previous = current;
  }
  return null;
}

export function resolveRegionBinding(
  binding: RegionBinding,
  time: ArrayLike<number>,
  options: RegionResolutionOptions = {}
): RegionResolution {
  const timingOffsetSeconds = options.timingOffsetSeconds ?? 0;
  const invalidTime = validateTimeArray(time, timingOffsetSeconds);
  if (invalidTime) return invalidTime;

  const annotations = Array.from(options.annotations ?? []);
  const warnings: string[] = [];

  switch (binding.kind) {
    case 'region-marker': {
      if (!binding.markerName) {
        return unresolved('invalid-binding', 'A region marker name is required.');
      }
      const annotation = authoritativeAnnotation(annotations, binding.markerName);
      if (!annotation) {
        return unresolved('missing-annotation', `No authoritative "${binding.markerName}" annotation is available.`);
      }
      const ids = annotationIds([annotation]);
      if (
        annotation.kind !== 'region' ||
        !Number.isFinite(annotation.startTime) ||
        !Number.isFinite(annotation.endTime)
      ) {
        return unresolved(
          'invalid-annotation',
          `Authoritative annotation "${binding.markerName}" is not a finite region.`,
          ids
        );
      }
      return resolveTimeBounds(
        time,
        timingOffsetSeconds,
        annotation.startTime,
        annotation.endTime as number,
        ids,
        warnings
      );
    }

    case 'marker-pair': {
      if (!binding.startMarker || !binding.endMarker) {
        return unresolved('invalid-binding', 'Both marker names are required.');
      }
      const startMarker = authoritativeAnnotation(annotations, binding.startMarker);
      const endMarker = authoritativeAnnotation(annotations, binding.endMarker);
      const ids = annotationIds([startMarker, endMarker]);
      if (!startMarker || !endMarker) {
        const missing = [
          !startMarker ? `"${binding.startMarker}"` : null,
          !endMarker ? `"${binding.endMarker}"` : null
        ].filter((name): name is string => name !== null);
        return unresolved(
          'missing-annotation',
          `No authoritative annotation is available for ${missing.join(' and ')}.`,
          ids
        );
      }
      if (
        startMarker.kind !== 'marker' ||
        endMarker.kind !== 'marker' ||
        !Number.isFinite(startMarker.startTime) ||
        !Number.isFinite(endMarker.startTime)
      ) {
        return unresolved('invalid-annotation', 'Both authoritative annotations must be finite markers.', ids);
      }
      return resolveTimeBounds(time, timingOffsetSeconds, startMarker.startTime, endMarker.startTime, ids, warnings);
    }

    case 'times':
      if (!Number.isFinite(binding.startTime) || !Number.isFinite(binding.endTime)) {
        return unresolved('invalid-binding', 'Explicit region times must be finite.');
      }
      return resolveTimeBounds(time, timingOffsetSeconds, binding.startTime, binding.endTime, [], warnings);

    case 'indices':
      if (!Number.isInteger(binding.startIndex) || !Number.isInteger(binding.endIndex)) {
        return unresolved('invalid-binding', 'Explicit region indices must be integers.');
      }
      return resolveIndexBounds(time, timingOffsetSeconds, binding.startIndex, binding.endIndex, [], warnings);

    case 'selection': {
      const selection = options.selection;
      if (selection && Number.isFinite(selection.xMin) && Number.isFinite(selection.xMax)) {
        return resolveTimeBounds(
          time,
          timingOffsetSeconds,
          selection.xMin as number,
          selection.xMax as number,
          [],
          warnings
        );
      }
      if (selection && Number.isInteger(selection.i0) && Number.isInteger(selection.i1)) {
        appendWarning(warnings, 'Selection times were unavailable; selection indices were used.');
        return resolveIndexBounds(
          time,
          timingOffsetSeconds,
          selection.i0 as number,
          selection.i1 as number,
          [],
          warnings
        );
      }
      return unresolved(
        'missing-selection',
        'No complete plot selection is available; the processing step was bypassed.',
        [],
        warnings
      );
    }
  }
}
