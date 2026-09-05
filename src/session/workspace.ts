import {
  createAnnotation,
  createSession,
  createShot,
  type Annotation,
  type ReviewStatus,
  type Session,
  type SessionAnalysisResult,
  type Shot
} from '../domain/session';
import { sessionRepository } from '../persistence/sessionRepository';
import { parseNumericValue, QualityFlag } from '../data/quality';
import { State, type StateDataChange } from '../state';
import type { CsvRow, DataRepairRecord } from '../types';
import { toNumber } from '../app/utils';
import { getTimeArray } from '../app/traceData';
import { timeScaleToSeconds } from '../units/units';

type WorkspaceListener = (session: Session | null, shot: Shot | null) => void;
export type SessionSaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

function headerUnit(header: string): string {
  return header.match(/(?:\(|\[)\s*([^\])]+)\s*(?:\)|\])\s*$/)?.[1] || '';
}

function cloneConfig(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(State.config)) as Record<string, unknown>;
}

/**
 * Indices of a channel's timestamps that can anchor an interpolation: finite and strictly increasing.
 * Missing or non-monotonic timestamps are skipped so they cannot corrupt a binary search, and the
 * samples they belong to are simply unavailable as interpolation anchors.
 */
function usableTimeIndices(time: Float64Array): Int32Array {
  const indices: number[] = [];
  let previous = -Infinity;
  for (let index = 0; index < time.length; index += 1) {
    const stamp = time[index];
    if (!Number.isFinite(stamp) || !(stamp > previous)) continue;
    indices.push(index);
    previous = stamp;
  }
  return Int32Array.from(indices);
}

/** Position of the last usable anchor whose timestamp is <= target, or -1 when target precedes the record. */
function anchorBefore(time: Float64Array, anchors: Int32Array, target: number): number {
  let lower = 0;
  let upper = anchors.length - 1;
  if (anchors.length === 0 || target < time[anchors[0]]) return -1;
  while (upper - lower > 1) {
    const middle = Math.floor((lower + upper) / 2);
    if (time[anchors[middle]] <= target) lower = middle;
    else upper = middle;
  }
  return time[anchors[upper]] <= target ? upper : lower;
}

function interpolateChannel(time: Float64Array, values: Float64Array, target: number, anchors?: Int32Array): number {
  const usable = anchors ?? usableTimeIndices(time);
  if (!Number.isFinite(target) || usable.length === 0) return Number.NaN;
  if (target < time[usable[0]] || target > time[usable[usable.length - 1]]) return Number.NaN;
  const position = anchorBefore(time, usable, target);
  const lower = usable[position];
  if (target === time[lower]) return values[lower];
  if (position + 1 >= usable.length) return Number.NaN;
  const upper = usable[position + 1];
  const interval = time[upper] - time[lower];
  return interval > 0
    ? values[lower] + (values[upper] - values[lower]) * ((target - time[lower]) / interval)
    : Number.NaN;
}

function sameTimebase(left: Float64Array, right: Float64Array): boolean {
  // NaN timestamps (missing cells) are the same timestamp on both sides of a shared grid.
  return (
    left.length === right.length &&
    left.every((time, index) => time === right[index] || (Number.isNaN(time) && Number.isNaN(right[index])))
  );
}

function alignQuality(sourceTime: Float64Array, quality: Uint16Array, targetTime: Float64Array): Uint16Array {
  if (sameTimebase(sourceTime, targetTime)) return quality.slice(0, targetTime.length);
  const aligned = new Uint16Array(targetTime.length);
  const anchors = usableTimeIndices(sourceTime);
  for (let targetIndex = 0; targetIndex < targetTime.length; targetIndex += 1) {
    const target = targetTime[targetIndex];
    if (
      !Number.isFinite(target) ||
      anchors.length === 0 ||
      target < sourceTime[anchors[0]] ||
      target > sourceTime[anchors[anchors.length - 1]]
    ) {
      aligned[targetIndex] = QualityFlag.Missing | QualityFlag.Interpolated;
      continue;
    }
    const position = anchorBefore(sourceTime, anchors, target);
    const left = anchors[position];
    const right = anchors[Math.min(anchors.length - 1, position + 1)];
    aligned[targetIndex] =
      (quality[left] || QualityFlag.None) | (quality[right] || QualityFlag.None) | QualityFlag.Interpolated;
  }
  return aligned;
}

function appendFloat64(base: Float64Array, additions: ArrayLike<number>): Float64Array {
  const result = new Float64Array(base.length + additions.length);
  result.set(base);
  result.set(Float64Array.from(additions), base.length);
  return result;
}

function appendUint16(base: Uint16Array, additions: ArrayLike<number>): Uint16Array {
  const result = new Uint16Array(base.length + additions.length);
  result.set(base);
  result.set(Uint16Array.from(additions), base.length);
  return result;
}

export const SessionWorkspace = {
  activeSession: null as Session | null,
  activeShotId: null as string | null,
  persistenceError: null as string | null,
  saveState: 'idle' as SessionSaveState,
  lastSavedAt: null as string | null,
  saveGeneration: 0,
  hydratingShot: false,
  listeners: new Set<WorkspaceListener>(),

  onChange(listener: WorkspaceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  },

  notify(): void {
    const shot = this.getActiveShot();
    this.listeners.forEach((listener) => listener(this.activeSession, shot));
  },

  setSaveState(saveState: SessionSaveState): void {
    this.saveState = saveState;
    if (saveState === 'saved') this.lastSavedAt = new Date().toISOString();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('signalforge:save-state', {
          detail: { state: this.saveState, savedAt: this.lastSavedAt, error: this.persistenceError }
        })
      );
    }
  },

  scheduleSave(): void {
    if (!this.activeSession) return;
    const session = this.activeSession;
    const generation = ++this.saveGeneration;
    this.persistenceError = null;
    this.setSaveState('pending');
    sessionRepository.scheduleAutosave(
      session,
      500,
      (error) => {
        if (this.activeSession !== session || this.saveGeneration !== generation) return;
        this.persistenceError = error.message;
        this.setSaveState('error');
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('signalforge:persistence-error', { detail: this.persistenceError }));
        }
        this.notify();
      },
      () => {
        if (this.activeSession === session && this.saveGeneration === generation) this.setSaveState('saved');
      },
      () => {
        if (this.activeSession === session && this.saveGeneration === generation) this.setSaveState('saving');
      }
    );
  },

  create(name: string): Session {
    this.saveGeneration += 1;
    this.activeSession = createSession(name);
    this.activeSession.processingRecipe = cloneConfig();
    this.activeShotId = null;
    this.lastSavedAt = null;
    this.setSaveState('idle');
    this.notify();
    return this.activeSession;
  },

  setActive(session: Session, shotId: string | null = null): void {
    this.saveGeneration += 1;
    const previous = this.activeSession;
    if (previous && previous !== session && previous.id === session.id) {
      // Reloading the same session from storage replaces the in-memory copy; a pending autosave of the
      // old object would otherwise land after the reload and make the fresh copy a stale revision.
      sessionRepository.cancelAutosave(previous.id);
    }
    this.activeSession = session;
    this.persistenceError = null;
    this.setSaveState('saved');
    this.activeShotId = shotId || session.shots[0]?.id || null;
    const shot = this.getActiveShot();
    if (shot?.channels.length) this.openShot(shot.id);
    else this.notify();
  },

  detachActiveShot(): void {
    this.activeShotId = null;
    this.notify();
  },

  getActiveShot(): Shot | null {
    return this.activeSession?.shots.find((shot) => shot.id === this.activeShotId) || null;
  },

  captureCurrentData(name?: string): Shot {
    if (!this.activeSession) this.create('SignalForge session');
    if (!State.data.raw.length || !State.data.timeColumn) throw new Error('Load waveform data before creating a shot.');
    const session = this.activeSession as Session;
    const shot = createShot(
      name || State.data.source?.name || `Shot ${session.shots.length + 1}`,
      session.shots.length + 1
    );
    const timeColumn = State.data.timeColumn;
    const time = Float64Array.from(getTimeArray());
    const originalTimeScale = timeScaleToSeconds(timeColumn);
    const originalTime = Float64Array.from(
      State.data.originalColumns[timeColumn] || [],
      (value) => value * originalTimeScale
    );
    const originalTimeTokens: Record<number, string | boolean | null> = {};
    State.data.original.forEach((row, index) => {
      const value = row[timeColumn];
      if (parseNumericValue(value) === null) {
        originalTimeTokens[index] = typeof value === 'number' ? String(value) : (value ?? null);
      }
    });
    const sourceFileId = State.data.source ? `source-${crypto.randomUUID()}` : undefined;
    const sampleInterval = this.medianDt(Array.from(time));
    for (const header of State.data.headers) {
      if (header === timeColumn) continue;
      if (header === 'Time') {
        throw new Error(
          'A data column named "Time" cannot be captured into a shot because "Time" is the reserved working time column; rename the column first.'
        );
      }
      const values =
        State.data.columns[header]?.slice() || Float64Array.from(State.data.raw, (row) => toNumber(row[header]));
      let hasFinite = false;
      for (const value of values) {
        if (Number.isFinite(value)) {
          hasFinite = true;
          break;
        }
      }
      if (!hasFinite) continue;
      const originalValueTokens: Record<number, string | boolean | null> = {};
      State.data.original.forEach((row, index) => {
        const value = row[header];
        if (parseNumericValue(value) === null) {
          originalValueTokens[index] = typeof value === 'number' ? String(value) : (value ?? null);
        }
      });
      shot.channels.push({
        id: `channel-${crypto.randomUUID()}`,
        name: header,
        unit: headerUnit(header),
        timeUnit: 's',
        time: time.slice(),
        originalTime: originalTime.slice(),
        originalTimeTokens: { ...originalTimeTokens },
        originalValues: State.data.originalColumns[header]?.slice() || values.slice(),
        originalValueTokens,
        values,
        originalQuality: State.data.originalQuality[header]?.slice() || new Uint16Array(values.length),
        quality: State.data.quality[header]?.slice() || new Uint16Array(values.length),
        calibration: { scale: 1, offset: 0, source: 'Captured from current workspace.' },
        timingOffsetSeconds: (State.getTraceConfig(header).xOffset || 0) * sampleInterval,
        sourceFileId
      });
    }
    if (State.data.source) {
      shot.sourceFiles.push({
        id: sourceFileId as string,
        name: State.data.source.name,
        size: State.data.source.size,
        lastModified: State.data.source.lastModified,
        adapterId: 'legacy-csv-import',
        bytes: State.data.source.bytes.slice(),
        metadata: {},
        warnings: []
      });
    }
    shot.repairHistory = this.exportRepairHistory(timeColumn);
    shot.repairCursor = State.data.repairCursor;
    session.shots.push(shot);
    session.updatedAt = new Date().toISOString();
    this.activeShotId = shot.id;
    this.scheduleSave();
    this.notify();
    return shot;
  },

  openShot(shotId: string): void {
    if (!this.activeSession) return;
    const shot = this.activeSession.shots.find((candidate) => candidate.id === shotId);
    if (!shot || shot.channels.length === 0) return;
    const referenceTime = shot.channels[0].time;
    const originalReferenceTime = shot.channels[0].originalTime || referenceTime;
    const length = referenceTime.length;
    const headers = ['Time', ...shot.channels.map((channel) => channel.name)];
    // Per-channel alignment decisions are made once, not per row.
    const workingPlan = shot.channels.map((channel) => {
      const shared = sameTimebase(channel.time, referenceTime);
      return { channel, shared, anchors: shared ? null : usableTimeIndices(channel.time) };
    });
    const originalPlan = shot.channels.map((channel) => {
      const channelTime = channel.originalTime || channel.time;
      const shared = sameTimebase(channelTime, originalReferenceTime);
      return {
        channel,
        channelTime,
        channelValues: channel.originalValues || channel.values,
        shared,
        anchors: shared ? null : usableTimeIndices(channelTime)
      };
    });
    const workingRows: CsvRow[] = Array.from({ length }, (_, index) => {
      const timestamp = referenceTime[index];
      const row: CsvRow = { Time: timestamp };
      workingPlan.forEach(({ channel, shared, anchors }) => {
        row[channel.name] = shared
          ? channel.values[index]
          : interpolateChannel(channel.time, channel.values, timestamp, anchors ?? undefined);
      });
      return row;
    });
    const originalRows: CsvRow[] = Array.from({ length }, (_, index) => {
      const timestamp = originalReferenceTime[index];
      const firstChannel = shot.channels[0];
      const row: CsvRow = {
        Time: Object.prototype.hasOwnProperty.call(firstChannel.originalTimeTokens || {}, index)
          ? firstChannel.originalTimeTokens?.[index]
          : timestamp
      };
      originalPlan.forEach(({ channel, channelTime, channelValues, shared, anchors }) => {
        row[channel.name] = shared
          ? Object.prototype.hasOwnProperty.call(channel.originalValueTokens || {}, index)
            ? channel.originalValueTokens?.[index]
            : channelValues[index]
          : interpolateChannel(channelTime, channelValues, timestamp, anchors ?? undefined);
      });
      return row;
    });
    const originalQuality: Record<string, Uint16Array> = {};
    const quality: Record<string, Uint16Array> = {};
    shot.channels.forEach((channel) => {
      const channelOriginalTime = channel.originalTime || channel.time;
      originalQuality[channel.name] = alignQuality(
        channelOriginalTime,
        channel.originalQuality || channel.quality,
        originalReferenceTime
      );
      quality[channel.name] = alignQuality(channel.time, channel.quality, referenceTime);
    });
    let sourceFile = shot.sourceFiles.find((candidate) => candidate.bytes);
    if (!sourceFile && this.activeSession) {
      const sharedIds = new Set(
        shot.sourceFiles
          .map((candidate) => candidate.metadata.sharedSourceId)
          .filter((value): value is string => typeof value === 'string' && value.length > 0)
      );
      sourceFile = this.activeSession.shots
        .flatMap((candidate) => candidate.sourceFiles)
        .find((candidate) => sharedIds.has(candidate.id) && candidate.bytes);
    }
    const source = sourceFile?.bytes
      ? {
          name: sourceFile.name,
          text:
            sourceFile.adapterId === 'delimited-text'
              ? new TextDecoder('utf-8', { fatal: false }).decode(sourceFile.bytes)
              : '',
          bytes: sourceFile.bytes.slice(),
          size: sourceFile.size,
          lastModified: sourceFile.lastModified
        }
      : null;
    State.restoreDataSnapshot(originalRows, workingRows, headers, {
      originalQuality,
      quality,
      repairHistory: shot.repairHistory,
      repairCursor: shot.repairCursor,
      source
    });
    const dt = this.medianDt(Array.from(referenceTime));
    this.hydratingShot = true;
    try {
      shot.channels.forEach((channel) => {
        State.updateTraceConfig(channel.name, {
          xOffset: dt > 0 ? channel.timingOffsetSeconds / dt : 0
        });
      });
    } finally {
      this.hydratingShot = false;
    }
    this.activeShotId = shot.id;
    this.notify();
  },

  syncActiveShotFromState(change: StateDataChange): void {
    const shot = this.getActiveShot();
    const timeColumn = State.data.timeColumn;
    if (!shot || !timeColumn || !State.data.raw.length) return;
    const time = Float64Array.from(getTimeArray());
    const changed = new Set(change.columnIds);
    if (change.kind === 'append') {
      const projectionStart = Math.min(shot.channels[0]?.time.length || 0, State.data.raw.length);
      const workingTimeAdditions = time.slice(projectionStart);
      const originalTimeScale = timeScaleToSeconds(timeColumn);
      const originalTimeAdditions = Float64Array.from(
        State.data.originalColumns[timeColumn]?.slice(projectionStart) || [],
        (value) => value * originalTimeScale
      );
      for (const channel of shot.channels) {
        if (!changed.has(channel.name)) continue;
        const workingValues = State.data.columns[channel.name]?.slice(projectionStart) || new Float64Array(0);
        const originalValues = State.data.originalColumns[channel.name]?.slice(projectionStart) || new Float64Array(0);
        const workingQuality =
          State.data.quality[channel.name]?.slice(projectionStart) || new Uint16Array(workingValues.length);
        const originalQuality =
          State.data.originalQuality[channel.name]?.slice(projectionStart) || new Uint16Array(originalValues.length);
        const originalBaseLength = channel.originalValues?.length || channel.values.length;
        const workingTimeBase = channel.time.slice();
        const workingValuesBase = channel.values.slice();
        const originalTimeBase = (channel.originalTime || channel.time).slice();
        const originalValuesBase = (channel.originalValues || channel.values).slice();
        const originalQualityBase = (channel.originalQuality || channel.quality).slice();
        const acceptedPositions: number[] = [];
        let lastWorkingTime = channel.time[channel.time.length - 1] ?? -Infinity;
        let lastOriginalTime = originalTimeBase[originalTimeBase.length - 1] ?? -Infinity;
        const additionCount = Math.min(workingTimeAdditions.length, originalTimeAdditions.length);
        for (let index = 0; index < additionCount; index += 1) {
          const workingTimestamp = workingTimeAdditions[index];
          const originalTimestamp = originalTimeAdditions[index];
          if (workingTimestamp > lastWorkingTime && originalTimestamp > lastOriginalTime) {
            acceptedPositions.push(index);
            lastWorkingTime = workingTimestamp;
            lastOriginalTime = originalTimestamp;
          }
        }
        const select = (values: ArrayLike<number>) =>
          Float64Array.from(acceptedPositions, (position) => Number(values[position]));
        const selectQuality = (values: ArrayLike<number>) =>
          Uint16Array.from(acceptedPositions, (position) => Number(values[position]));
        channel.time = appendFloat64(channel.time, select(workingTimeAdditions));
        channel.values = appendFloat64(channel.values, select(workingValues));
        channel.quality = appendUint16(channel.quality, selectQuality(workingQuality));
        channel.originalTime = appendFloat64(originalTimeBase, select(originalTimeAdditions));
        channel.originalValues = appendFloat64(originalValuesBase, select(originalValues));
        channel.originalQuality = appendUint16(originalQualityBase, selectQuality(originalQuality));
        if (acceptedPositions.length !== additionCount) {
          const warning =
            'One or more appended projection rows were not added to an independent channel because their timestamps were not monotonic.';
          shot.metadata.appendWarning = warning;
          const accepted = new Set(acceptedPositions);
          for (let position = 0; position < additionCount; position += 1) {
            if (accepted.has(position)) continue;
            const rowIndex = projectionStart + position;
            const replacement = interpolateChannel(workingTimeBase, workingValuesBase, workingTimeAdditions[position]);
            State.data.raw[rowIndex] = {
              ...State.data.raw[rowIndex],
              [channel.name]: replacement
            };
            State.data.columns[channel.name][rowIndex] = replacement;
            State.data.quality[channel.name][rowIndex] =
              QualityFlag.Interpolated | (Number.isFinite(replacement) ? QualityFlag.None : QualityFlag.Missing);
            // The parsed original token stays untouched; only its quality records that this sample sits on a
            // timestamp the independent channel could not accept. The working grid carries the interpolation.
            State.data.originalQuality[channel.name][rowIndex] |= QualityFlag.NonMonotonicTime;
          }
          // The working grid changed after the append notification; invalidate memoised series.
          State.data.generation += 1;
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('signalforge:data-warning', { detail: warning }));
          }
        }
        const tokens = { ...(channel.originalValueTokens || {}) };
        acceptedPositions.forEach((position, acceptedIndex) => {
          const index = projectionStart + position;
          const value = State.data.original[index]?.[channel.name];
          if (parseNumericValue(value) === null) {
            tokens[originalBaseLength + acceptedIndex] = typeof value === 'number' ? String(value) : (value ?? null);
          }
        });
        channel.originalValueTokens = tokens;
        const timeTokens = { ...(channel.originalTimeTokens || {}) };
        acceptedPositions.forEach((position, acceptedIndex) => {
          const index = projectionStart + position;
          const value = State.data.original[index]?.[timeColumn];
          if (parseNumericValue(value) === null) {
            timeTokens[originalBaseLength + acceptedIndex] =
              typeof value === 'number' ? String(value) : (value ?? null);
          }
        });
        channel.originalTimeTokens = timeTokens;
      }
      shot.repairHistory = this.exportRepairHistory(timeColumn);
      shot.repairCursor = State.data.repairCursor;
      // Appended samples extend every channel, so results computed on the old extent are stale.
      this.invalidateResults(() => true);
      this.touchShot(false);
      this.notify();
      return;
    }
    if (changed.has(timeColumn) && shot.channels[0]) {
      // Every channel that shared the reference grid before the repair follows the repaired timebase;
      // independently sampled channels keep their own timestamps.
      const previousReferenceTime = shot.channels[0].time;
      const sharedReference = shot.channels.filter((channel) => sameTimebase(channel.time, previousReferenceTime));
      for (const channel of sharedReference) channel.time = time.slice();
    }
    for (const channel of shot.channels) {
      if (!changed.has(channel.name)) continue;
      const values = State.data.columns[channel.name];
      if (!values) continue;
      const projectedQuality = State.data.quality[channel.name]?.slice() || new Uint16Array(values.length);
      if (sameTimebase(channel.time, time)) {
        channel.values = values.slice();
        channel.quality = projectedQuality;
      } else {
        channel.values = Float64Array.from(channel.time, (timestamp) => interpolateChannel(time, values, timestamp));
        channel.quality = alignQuality(time, projectedQuality, channel.time);
      }
    }
    shot.repairHistory = this.exportRepairHistory(timeColumn);
    shot.repairCursor = State.data.repairCursor;
    this.invalidateResults((result) =>
      result.provenance.sourceChannelIds.some((channelId) =>
        shot.channels.some(
          (channel) => channel.id === channelId && (changed.has(channel.name) || changed.has(timeColumn))
        )
      )
    );
    this.touchShot(false);
    this.notify();
  },

  /** Repair history in session terms: the working time column is always called `Time` in a shot. */
  exportRepairHistory(timeColumn: string): DataRepairRecord[] {
    return structuredClone(State.data.repairHistory).map((record) => ({
      ...record,
      changes: record.changes.map((change) => ({
        ...change,
        columnId: change.columnId === timeColumn ? 'Time' : change.columnId
      }))
    }));
  },

  /**
   * Drops only the analysis results the predicate selects, using their provenance, so an unrelated
   * marker or channel edit leaves other results intact.
   */
  invalidateResults(predicate: (result: SessionAnalysisResult) => boolean): void {
    const shot = this.getActiveShot();
    if (!shot) return;
    const remaining = shot.analysisResults.filter((result) => !predicate(result));
    if (remaining.length !== shot.analysisResults.length) shot.analysisResults = remaining;
  },

  previousShot(): Shot | null {
    return this.stepShot(-1);
  },

  nextShot(): Shot | null {
    return this.stepShot(1);
  },

  stepShot(direction: number): Shot | null {
    if (!this.activeSession?.shots.length) return null;
    const current = Math.max(
      0,
      this.activeSession.shots.findIndex((shot) => shot.id === this.activeShotId)
    );
    const next = (current + direction + this.activeSession.shots.length) % this.activeSession.shots.length;
    const shot = this.activeSession.shots[next];
    this.openShot(shot.id);
    return shot;
  },

  addMarker(name: string, time: number, options: Partial<Annotation> = {}): Annotation {
    const shot = this.getActiveShot();
    if (!shot) throw new Error('Select a shot before adding a marker.');
    const marker = createAnnotation(name, time, options);
    shot.annotations.push(marker);
    // A brand-new marker cannot be referenced by an existing result's provenance, unless a batch
    // recipe addressed it by name; only results bound to that name are stale.
    this.invalidateMarkerResults(marker);
    this.touchShot(false);
    this.notify();
    return marker;
  },

  /** Invalidates results whose provenance references the annotation (by id or by region marker name). */
  invalidateMarkerResults(marker: Pick<Annotation, 'id' | 'name'>): void {
    this.invalidateResults(
      (result) =>
        result.provenance.annotationIds.includes(marker.id) ||
        (result.type === 'pulse-power' && this.resultUsesMarkerName(result, marker.name))
    );
    const markerBoundPipeline = State.getPipeline().some(
      (step) =>
        step.enabled !== false &&
        (step.regionMarker === marker.name || step.startMarker === marker.name || step.endMarker === marker.name)
    );
    if (markerBoundPipeline) {
      State.data.processed = [];
      State.data.processedQuality = new Uint16Array(0);
      State.data.pipelineReport = [];
      State.data.firDesigns = [];
    }
  },

  resultUsesMarkerName(result: SessionAnalysisResult, name: string): boolean {
    const shot = this.getActiveShot();
    if (!shot) return false;
    return shot.annotations.some(
      (annotation) => annotation.name === name && result.provenance.annotationIds.includes(annotation.id)
    );
  },

  touchShot(invalidateResults = false): void {
    const shot = this.getActiveShot();
    if (!shot) return;
    shot.updatedAt = new Date().toISOString();
    if (invalidateResults) shot.analysisResults = [];
    if (this.activeSession) {
      this.activeSession.updatedAt = shot.updatedAt;
      this.scheduleSave();
    }
  },

  /**
   * Notes and review status are stored and autosaved without a workspace-wide notification: notes
   * are edited keystroke by keystroke and re-rendering the workspace would destroy the textarea.
   */
  updateShot(patch: { notes?: string; reviewStatus?: ReviewStatus }, options: { silent?: boolean } = {}): void {
    const shot = this.getActiveShot();
    if (!shot) return;
    if (patch.notes !== undefined) shot.notes = patch.notes;
    if (patch.reviewStatus !== undefined) shot.reviewStatus = patch.reviewStatus;
    this.touchShot(false);
    if (!options.silent) this.notify();
  },

  async save(): Promise<Session | null> {
    if (!this.activeSession) return null;
    const session = this.activeSession;
    const generation = ++this.saveGeneration;
    sessionRepository.cancelAutosave(session.id);
    try {
      this.setSaveState('saving');
      const saved = await sessionRepository.save(session);
      if (this.activeSession !== session || this.saveGeneration !== generation) return saved;
      this.activeSession = saved;
      this.persistenceError = null;
      this.setSaveState('saved');
      this.notify();
      return this.activeSession;
    } catch (error) {
      if (this.activeSession !== session || this.saveGeneration !== generation) throw error;
      this.persistenceError = error instanceof Error ? error.message : String(error);
      this.setSaveState('error');
      this.notify();
      throw error;
    }
  },

  medianDt(time: number[]): number {
    const deltas: number[] = [];
    for (let index = 1; index < time.length; index += 1) {
      const delta = time[index] - time[index - 1];
      if (delta > 0 && Number.isFinite(delta)) deltas.push(delta);
    }
    deltas.sort((left, right) => left - right);
    return deltas.length ? deltas[Math.floor(deltas.length / 2)] : 0;
  }
};

State.onDataChange((change) => SessionWorkspace.syncActiveShotFromState(change));
State.onDataReplace(() => SessionWorkspace.detachActiveShot());
State.onTraceConfigChange((columnId, config) => {
  if (SessionWorkspace.hydratingShot) return;
  const channel = SessionWorkspace.getActiveShot()?.channels.find((candidate) => candidate.name === columnId);
  if (!channel) return;
  channel.timingOffsetSeconds = config.xOffset * SessionWorkspace.medianDt(Array.from(channel.time));
  // Only results that consumed this channel depend on its timing offset.
  SessionWorkspace.invalidateResults((result) => result.provenance.sourceChannelIds.includes(channel.id));
  SessionWorkspace.touchShot(false);
  SessionWorkspace.notify();
});
