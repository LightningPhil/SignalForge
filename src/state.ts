import { Config } from './config';
import { buildQualityMasks, classifyQuality, cloneQualityMasks, parseNumericValue, QualityFlag } from './data/quality';
import { analyzeTimebase } from './processing/sampling';
import { timeScaleToSeconds } from './units/units';
import type {
  AnalysisConfig,
  AnalysisEvent,
  AnalysisSelection,
  AnalysisUiState,
  AppConfig,
  AppData,
  ComposerState,
  ComposerTrace,
  ComposerView,
  CsvRow,
  CsvValue,
  DataRepairRecord,
  DataSourceRecord,
  FilterStep,
  FilterType,
  FftZeroPad,
  MathDefinition,
  MultiView,
  TraceConfig,
  UiState,
  ViewRange
} from './types';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function numericColumns(rows: CsvRow[], headers: string[]): Record<string, Float64Array> {
  return Object.fromEntries(
    headers.map((header) => [header, Float64Array.from(rows, (row) => parseNumericValue(row[header]) ?? Number.NaN)])
  );
}

function minimumValidNyquist(time: number[]): number | null {
  let minimum = Infinity;
  let cursor = 0;
  while (cursor < time.length) {
    while (cursor < time.length && !Number.isFinite(time[cursor])) cursor += 1;
    if (cursor >= time.length) break;
    const start = cursor;
    cursor += 1;
    while (cursor < time.length && Number.isFinite(time[cursor]) && time[cursor] > time[cursor - 1]) {
      cursor += 1;
    }
    if (cursor - start >= 2) {
      const analysis = analyzeTimebase(time.slice(start, cursor));
      if (analysis.valid) minimum = Math.min(minimum, analysis.sampleRate / 2);
    }
  }
  return Number.isFinite(minimum) ? minimum : null;
}

const defaultKeys = Config.defaults as unknown as Record<string, Partial<FilterStep>>;
export interface StateDataChange {
  kind: 'append' | 'repair' | 'undo' | 'redo';
  columnIds: string[];
}

const dataChangeListeners = new Set<(change: StateDataChange) => void>();
const traceConfigListeners = new Set<(columnId: string, config: TraceConfig) => void>();
const dataReplaceListeners = new Set<() => void>();

export const State = {
  data: {
    original: Object.freeze([]),
    raw: [],
    originalColumns: {},
    columns: {},
    headers: [],
    processed: [],
    processedQuality: new Uint16Array(0),
    pipelineReport: [],
    firDesigns: [],
    timeColumn: null,
    dataColumn: null,
    originalQuality: {},
    quality: {},
    repairHistory: [],
    repairCursor: 0,
    source: null,
    generation: 0
  } as AppData,

  multiViews: [] as MultiView[],
  composer: { views: {} } as ComposerState,
  traceConfigs: {} as Record<string, TraceConfig>,
  config: clone(Config) as AppConfig,
  ui: {
    selectedStepId: null,
    activeMultiViewId: null,
    viewRanges: {},
    analysis: { selection: null, events: [], activeEventIndex: 0 }
  } as UiState,

  onDataChange(listener: (change: StateDataChange) => void): () => void {
    dataChangeListeners.add(listener);
    return () => dataChangeListeners.delete(listener);
  },

  notifyDataChange(kind: StateDataChange['kind'], columnIds: string[]): void {
    this.data.generation += 1;
    const unique = [...new Set(columnIds)];
    dataChangeListeners.forEach((listener) => listener({ kind, columnIds: unique }));
  },

  onTraceConfigChange(listener: (columnId: string, config: TraceConfig) => void): () => void {
    traceConfigListeners.add(listener);
    return () => traceConfigListeners.delete(listener);
  },

  onDataReplace(listener: () => void): () => void {
    dataReplaceListeners.add(listener);
    return () => dataReplaceListeners.delete(listener);
  },

  setData(raw: CsvRow[], headers: string[], source: DataSourceRecord | null = null, notifyReplacement = true): void {
    const resolvedHeaders = headers.slice();
    const working = raw.map((row) => ({ ...row }));
    this.data.original = Object.freeze(raw.map((row) => Object.freeze({ ...row })));
    this.data.raw = working;
    this.data.originalColumns = numericColumns(raw, resolvedHeaders);
    this.data.columns = numericColumns(working, resolvedHeaders);
    this.data.headers = resolvedHeaders;
    this.data.timeColumn = resolvedHeaders.length > 0 ? resolvedHeaders[0] : null;
    this.data.dataColumn = headers.find((h) => h !== this.data.timeColumn) || null;
    this.data.processed = [];
    this.data.processedQuality = new Uint16Array(0);
    this.data.pipelineReport = [];
    this.data.firDesigns = [];
    this.data.originalQuality = buildQualityMasks(raw, resolvedHeaders, this.data.timeColumn);
    this.data.quality = cloneQualityMasks(this.data.originalQuality);
    this.data.repairHistory = [];
    this.data.repairCursor = 0;
    this.data.source = source ? { ...source, bytes: source.bytes.slice() } : null;
    this.data.generation += 1;
    this.multiViews = [];
    this.ui.activeMultiViewId = null;
    this.ui.viewRanges = {};
    this.composer = { views: {} };
    this.traceConfigs = {};
    this.config.mathDefinitions = [];
    this.resetAnalysisUi();
    if (notifyReplacement) dataReplaceListeners.forEach((listener) => listener());
  },

  restoreDataSnapshot(
    original: CsvRow[],
    working: CsvRow[],
    headers: string[],
    options: {
      originalQuality?: Record<string, Uint16Array>;
      quality?: Record<string, Uint16Array>;
      repairHistory?: DataRepairRecord[];
      repairCursor?: number;
      source?: DataSourceRecord | null;
    } = {}
  ): void {
    this.setData(original, headers, options.source || null, false);
    this.data.raw = working.map((row) => ({ ...row }));
    this.data.columns = numericColumns(this.data.raw, this.data.headers);
    if (options.originalQuality) {
      this.data.originalQuality = {
        ...this.data.originalQuality,
        ...cloneQualityMasks(options.originalQuality)
      };
    }
    if (options.quality) {
      this.data.quality = { ...this.data.quality, ...cloneQualityMasks(options.quality) };
    }
    this.data.repairHistory = structuredClone(options.repairHistory || []);
    this.data.repairCursor = Math.max(
      0,
      Math.min(options.repairCursor ?? this.data.repairHistory.length, this.data.repairHistory.length)
    );
    this.refreshTimeQuality(true);
    this.refreshTimeQuality(false);
  },

  refreshTimeQuality(original = false): void {
    const timeColumn = this.data.timeColumn;
    if (!timeColumn) return;
    const rows = original ? this.data.original : this.data.raw;
    const masks = original ? this.data.originalQuality : this.data.quality;
    const mask = masks[timeColumn] || new Uint16Array(rows.length);
    let previous = -Infinity;
    for (let index = 0; index < rows.length; index += 1) {
      mask[index] &= ~QualityFlag.NonMonotonicTime;
      const current = parseNumericValue(rows[index]?.[timeColumn]);
      if (current === null) continue;
      if (!(current > previous)) mask[index] |= QualityFlag.NonMonotonicTime;
      previous = current;
    }
    masks[timeColumn] = mask;
  },

  appendDataRows(rows: CsvRow[]): void {
    if (rows.length === 0) return;
    const appended = rows.map((row) => ({ ...row }));
    const originalAppend = rows.map((row) => Object.freeze({ ...row }));
    const previousLength = this.data.raw.length;
    this.data.raw = [...this.data.raw, ...appended];
    this.data.original = Object.freeze([...this.data.original, ...originalAppend]);
    this.data.originalColumns = numericColumns(
      this.data.original.map((row) => ({ ...row })),
      this.data.headers
    );
    this.data.columns = numericColumns(this.data.raw, this.data.headers);
    for (const header of this.data.headers) {
      const previousOriginalMask = this.data.originalQuality[header] || new Uint16Array(previousLength);
      const nextOriginalMask = new Uint16Array(this.data.raw.length);
      nextOriginalMask.set(previousOriginalMask);
      const previousMask = this.data.quality[header] || new Uint16Array(previousLength);
      const nextMask = new Uint16Array(this.data.raw.length);
      nextMask.set(previousMask);
      for (let index = 0; index < appended.length; index += 1) {
        const originalFlag = classifyQuality(appended[index][header]);
        nextOriginalMask[previousLength + index] = originalFlag;
        nextMask[previousLength + index] = originalFlag | QualityFlag.UserEdited;
      }
      this.data.originalQuality[header] = nextOriginalMask;
      this.data.quality[header] = nextMask;
    }
    this.refreshTimeQuality(true);
    this.refreshTimeQuality(false);
    this.data.processed = [];
    this.data.processedQuality = new Uint16Array(0);
    this.data.pipelineReport = [];
    this.data.firDesigns = [];
    this.notifyDataChange('append', this.data.headers);
  },

  applyDataChanges(
    label: string,
    updates: Array<{ rowIndex: number; columnId: string; value: CsvValue; quality?: number }>
  ): DataRepairRecord | null {
    const changes = updates
      .filter(
        (update) =>
          Number.isInteger(update.rowIndex) &&
          update.rowIndex >= 0 &&
          update.rowIndex < this.data.raw.length &&
          this.data.headers.includes(update.columnId)
      )
      .map((update) => {
        const row = this.data.raw[update.rowIndex];
        const qualityMask = this.data.quality[update.columnId] || new Uint16Array(this.data.raw.length);
        this.data.quality[update.columnId] = qualityMask;
        return {
          rowIndex: update.rowIndex,
          columnId: update.columnId,
          before: row[update.columnId],
          after: update.value,
          qualityBefore: qualityMask[update.rowIndex] || QualityFlag.None,
          qualityAfter: update.quality ?? classifyQuality(update.value) | QualityFlag.UserEdited
        };
      })
      .filter((change) => change.before !== change.after || change.qualityBefore !== change.qualityAfter);

    if (changes.length === 0) return null;
    if (this.data.repairCursor < this.data.repairHistory.length) {
      this.data.repairHistory = this.data.repairHistory.slice(0, this.data.repairCursor);
    }
    const record: DataRepairRecord = {
      id: `repair-${Date.now()}-${this.data.repairHistory.length}`,
      label,
      timestamp: new Date().toISOString(),
      changes
    };
    for (const change of changes) {
      this.data.raw[change.rowIndex] = {
        ...this.data.raw[change.rowIndex],
        [change.columnId]: change.after
      };
      this.data.columns[change.columnId][change.rowIndex] = parseNumericValue(change.after) ?? Number.NaN;
      this.data.quality[change.columnId][change.rowIndex] = change.qualityAfter;
    }
    this.data.repairHistory.push(record);
    this.data.repairCursor = this.data.repairHistory.length;
    this.refreshTimeQuality(false);
    this.data.processed = [];
    this.data.processedQuality = new Uint16Array(0);
    this.data.pipelineReport = [];
    this.data.firDesigns = [];
    this.notifyDataChange(
      'repair',
      changes.map((change) => change.columnId)
    );
    return record;
  },

  undoDataRepair(): DataRepairRecord | null {
    if (this.data.repairCursor <= 0) return null;
    const record = this.data.repairHistory[this.data.repairCursor - 1];
    for (const change of record.changes) {
      this.data.raw[change.rowIndex] = {
        ...this.data.raw[change.rowIndex],
        [change.columnId]: change.before
      };
      this.data.columns[change.columnId][change.rowIndex] = parseNumericValue(change.before) ?? Number.NaN;
      this.data.quality[change.columnId][change.rowIndex] = change.qualityBefore;
    }
    this.data.repairCursor -= 1;
    this.refreshTimeQuality(false);
    this.data.processed = [];
    this.data.processedQuality = new Uint16Array(0);
    this.data.pipelineReport = [];
    this.data.firDesigns = [];
    this.notifyDataChange(
      'undo',
      record.changes.map((change) => change.columnId)
    );
    return record;
  },

  redoDataRepair(): DataRepairRecord | null {
    if (this.data.repairCursor >= this.data.repairHistory.length) return null;
    const record = this.data.repairHistory[this.data.repairCursor];
    for (const change of record.changes) {
      this.data.raw[change.rowIndex] = {
        ...this.data.raw[change.rowIndex],
        [change.columnId]: change.after
      };
      this.data.columns[change.columnId][change.rowIndex] = parseNumericValue(change.after) ?? Number.NaN;
      this.data.quality[change.columnId][change.rowIndex] = change.qualityAfter;
    }
    this.data.repairCursor += 1;
    this.refreshTimeQuality(false);
    this.data.processed = [];
    this.data.processedQuality = new Uint16Array(0);
    this.data.pipelineReport = [];
    this.data.firDesigns = [];
    this.notifyDataChange(
      'redo',
      record.changes.map((change) => change.columnId)
    );
    return record;
  },

  ensureAnalysisConfig(): AnalysisConfig {
    const defaults = Config.analysis;
    const current = this.config.analysis || ({} as Partial<AnalysisConfig>);
    let zeroPad: FftZeroPad = current.fftZeroPad ?? defaults.fftZeroPad;
    if ((current.fftZeroPad as unknown) === true) zeroPad = 'nextPow2';
    if ((current.fftZeroPad as unknown) === false) zeroPad = 'none';

    this.config.analysis = {
      ...defaults,
      ...current,
      fftZeroPad: zeroPad,
      trigger: { ...defaults.trigger, ...(current.trigger || {}) }
    };
    return this.config.analysis;
  },

  ensureAnalysisUi(): AnalysisUiState {
    if (!this.ui.analysis) {
      this.ui.analysis = { selection: null, events: [], activeEventIndex: 0 };
    }
    if (!Array.isArray(this.ui.analysis.events)) this.ui.analysis.events = [];
    if (typeof this.ui.analysis.activeEventIndex !== 'number') this.ui.analysis.activeEventIndex = 0;
    return this.ui.analysis;
  },

  resetAnalysisUi(): void {
    this.ui.analysis = { selection: null, events: [], activeEventIndex: 0 };
  },

  setAnalysisSelection(selection: AnalysisSelection | null): void {
    this.ensureAnalysisUi();
    this.ui.analysis.selection = selection ? { ...selection } : null;
  },

  getAnalysisSelection(): AnalysisSelection | null {
    return this.ensureAnalysisUi().selection;
  },

  setAnalysisEvents(events: AnalysisEvent[] = []): void {
    const ui = this.ensureAnalysisUi();
    ui.events = Array.isArray(events) ? events.slice() : [];
    ui.activeEventIndex = Math.min(ui.activeEventIndex, Math.max(0, ui.events.length - 1));
  },

  getAnalysisEvents(): AnalysisEvent[] {
    return this.ensureAnalysisUi().events;
  },

  setActiveEventIndex(idx = 0): number {
    const ui = this.ensureAnalysisUi();
    const clamped = Math.max(0, Math.min(idx, Math.max(0, ui.events.length - 1)));
    ui.activeEventIndex = clamped;
    return clamped;
  },

  getActiveEvent(): AnalysisEvent | null {
    const ui = this.ensureAnalysisUi();
    if (!ui.events.length) return null;
    const idx = Math.max(0, Math.min(ui.activeEventIndex, ui.events.length - 1));
    return ui.events[idx];
  },

  createNullFilterStep(): FilterStep {
    return { id: 'null-filter', type: 'nullFilter', enabled: true };
  },

  normalizePipeline(pipeline: FilterStep[] | null | undefined): FilterStep[] {
    const steps = Array.isArray(pipeline) ? pipeline : [];
    if (steps.length === 0) return [this.createNullFilterStep()];
    return steps;
  },

  ensurePipelineStored(columnId: string | null, pipelineRef: FilterStep[]): FilterStep[] {
    const normalized = this.normalizePipeline(pipelineRef);
    if (normalized !== pipelineRef) {
      if (this.isGlobalScope() || !columnId) {
        this.config.pipeline = normalized;
      } else {
        if (!this.config.columnPipelines) this.config.columnPipelines = {};
        this.config.columnPipelines[columnId] = normalized;
      }
    }
    return normalized;
  },

  isGlobalScope(): boolean {
    return this.config.pipelineScope !== false;
  },

  getActiveColumnId(): string | null {
    return this.data.dataColumn;
  },

  getViewKeyFor(columnId: string | null = null, multiViewId: string | null = null): string | null {
    if (multiViewId) return `mv:${multiViewId}`;
    const col = columnId || this.data.dataColumn;
    return col ? `col:${col}` : null;
  },

  getActiveViewKey(): string | null {
    return this.getViewKeyFor(this.data.dataColumn, this.ui.activeMultiViewId);
  },

  setViewRangeForKey(key: string | null, range: ViewRange | null | undefined): void {
    if (!key) return;
    if (!this.ui.viewRanges) this.ui.viewRanges = {};
    if (range === undefined) return;
    if (range === null) {
      this.ui.viewRanges[key] = null;
      return;
    }
    this.ui.viewRanges[key] = {
      x: range.x ?? null,
      y: range.y ?? null
    };
  },

  getViewRangeForKey(key: string | null): ViewRange | null | undefined {
    if (!key || !this.ui.viewRanges) return undefined;
    return this.ui.viewRanges[key];
  },

  clearViewRangeForKey(key: string | null): void {
    if (!key || !this.ui.viewRanges) return;
    delete this.ui.viewRanges[key];
  },

  clonePipeline(pipeline?: FilterStep[] | null): FilterStep[] {
    return clone(pipeline || []);
  },

  getPipelineForColumn(columnId?: string | null): FilterStep[] {
    if (this.isGlobalScope()) {
      return this.ensurePipelineStored(null, this.config.pipeline);
    }

    if (!this.config.columnPipelines) this.config.columnPipelines = {};
    const resolved = columnId || this.getActiveColumnId();
    if (!resolved) return this.ensurePipelineStored(null, this.config.pipeline);

    if (!this.config.columnPipelines[resolved]) {
      this.config.columnPipelines[resolved] = this.clonePipeline(this.config.pipeline);
    }

    return this.ensurePipelineStored(resolved, this.config.columnPipelines[resolved]);
  },

  getPipeline(): FilterStep[] {
    return this.getPipelineForColumn(this.getActiveColumnId());
  },

  getTraceConfig(columnId: string | null = null): TraceConfig {
    const resolved = columnId || this.getActiveColumnId();
    if (!resolved) return { xOffset: 0 };
    if (!this.traceConfigs) this.traceConfigs = {};
    if (!this.traceConfigs[resolved]) this.traceConfigs[resolved] = { xOffset: 0 };
    return this.traceConfigs[resolved];
  },

  updateTraceConfig(columnId: string | null, params: Partial<TraceConfig> = {}): void {
    const resolved = columnId || this.getActiveColumnId();
    if (!resolved) return;
    const config = this.getTraceConfig(resolved);
    Object.assign(config, params);
    traceConfigListeners.forEach((listener) => listener(resolved, { ...config }));
  },

  setPipelineForColumn(columnId: string | null, pipeline: FilterStep[]): void {
    const cloned = this.clonePipeline(this.normalizePipeline(pipeline));
    if (this.isGlobalScope()) {
      this.config.pipeline = cloned;
      return;
    }
    const resolved = columnId || this.getActiveColumnId();
    if (!resolved) {
      this.config.pipeline = cloned;
      return;
    }
    if (!this.config.columnPipelines) this.config.columnPipelines = {};
    this.config.columnPipelines[resolved] = cloned;
  },

  setPipelineScope(isGlobal: boolean, columnIds: string[] = []): void {
    const desired = !!isGlobal;
    const activePipeline = this.clonePipeline(this.getPipeline());

    if (desired) {
      this.config.pipeline = activePipeline;
      const keys = columnIds.length > 0 ? columnIds : Object.keys(this.config.columnPipelines || {});
      if (!this.config.columnPipelines) this.config.columnPipelines = {};
      keys.forEach((col) => {
        this.config.columnPipelines[col] = this.clonePipeline(activePipeline);
      });
    } else {
      if (!this.config.columnPipelines) this.config.columnPipelines = {};
      const targets = columnIds.length > 0 ? columnIds : Object.keys(this.config.columnPipelines);
      const seed = this.clonePipeline(this.config.pipeline);
      targets.forEach((col) => {
        this.config.columnPipelines[col] = this.clonePipeline(seed);
      });
      const activeCol = this.getActiveColumnId();
      if (activeCol && !this.config.columnPipelines[activeCol]) {
        this.config.columnPipelines[activeCol] = this.clonePipeline(seed);
      }
    }

    this.config.pipelineScope = desired;
  },

  addStep(type: FilterType): FilterStep {
    const pipeline = this.getPipeline();
    if (pipeline.length === 1 && pipeline[0].type === 'nullFilter') {
      pipeline.pop();
    }

    const newStep: FilterStep = {
      id: `step-${Date.now()}`,
      type,
      enabled: true,
      ...(type === 'nullFilter' ? {} : defaultKeys[type] || {})
    };

    const frequencyTypes = new Set<FilterType>([
      'lowPassFFT',
      'highPassFFT',
      'notchFFT',
      'firLowPass',
      'firHighPass',
      'firBandPass',
      'firBandStop',
      'butterworthLowPass',
      'butterworthHighPass',
      'butterworthBandPass',
      'iirNotch',
      'iirComb'
    ]);
    const timeColumn = this.data.timeColumn;
    if (frequencyTypes.has(type) && timeColumn && this.data.columns[timeColumn]?.length) {
      const scale = timeScaleToSeconds(timeColumn);
      const time = Array.from(this.data.columns[timeColumn], (value) => value * scale);
      const nyquist = minimumValidNyquist(time);
      if (nyquist !== null) {
        if (
          type === 'lowPassFFT' ||
          type === 'highPassFFT' ||
          type === 'firLowPass' ||
          type === 'firHighPass' ||
          type === 'butterworthLowPass' ||
          type === 'butterworthHighPass'
        ) {
          if (!(Number(newStep.cutoffFreq) > 0 && Number(newStep.cutoffFreq) < nyquist)) {
            newStep.cutoffFreq = nyquist * 0.25;
          }
        } else {
          if (!(Number(newStep.centerFreq) > 0 && Number(newStep.centerFreq) < nyquist)) {
            newStep.centerFreq = nyquist * 0.25;
          }
          const center = newStep.centerFreq as number;
          const maximumBandwidth = 2 * Math.min(center, nyquist - center) * 0.8;
          if (!(Number(newStep.bandwidth) > 0 && Number(newStep.bandwidth) < maximumBandwidth)) {
            newStep.bandwidth = Math.min(center * 0.1, maximumBandwidth);
          }
          if (type === 'iirComb') {
            const maximumHarmonics = Math.max(1, Math.floor((nyquist - (newStep.bandwidth as number) / 2) / center));
            newStep.harmonicCount = Math.min(newStep.harmonicCount || 1, maximumHarmonics);
          }
        }
        if (type === 'firLowPass' || type === 'firHighPass') {
          const maximumTransition =
            type === 'firLowPass' ? nyquist - (newStep.cutoffFreq as number) : (newStep.cutoffFreq as number);
          if (!(Number(newStep.transitionWidth) > 0 && Number(newStep.transitionWidth) < maximumTransition)) {
            newStep.transitionWidth = maximumTransition * 0.25;
          }
        }
        if (type === 'firBandPass' || type === 'firBandStop') {
          const center = newStep.centerFreq as number;
          const halfBandwidth = (newStep.bandwidth as number) / 2;
          const maximumTransition = Math.min(center - halfBandwidth, nyquist - center - halfBandwidth);
          if (!(Number(newStep.transitionWidth) > 0 && Number(newStep.transitionWidth) < maximumTransition)) {
            newStep.transitionWidth = maximumTransition * 0.25;
          }
        }
      }
    }

    pipeline.push(newStep);
    this.ui.selectedStepId = newStep.id;
    return newStep;
  },

  removeStep(id: string): void {
    this.setPipelineForColumn(
      this.getActiveColumnId(),
      this.getPipeline().filter((s) => s.id !== id)
    );
    if (this.ui.selectedStepId === id) this.ui.selectedStepId = null;
  },

  moveStep(id: string, direction: number): void {
    const pipeline = this.getPipeline();
    const idx = pipeline.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= pipeline.length) return;
    const temp = pipeline[idx];
    pipeline[idx] = pipeline[newIdx];
    pipeline[newIdx] = temp;
  },

  updateStepParams(id: string, params: Partial<FilterStep>): void {
    const step = this.getPipeline().find((s) => s.id === id);
    if (step) Object.assign(step, params);
  },

  getSelectedStep(): FilterStep | undefined {
    return this.getPipeline().find((s) => s.id === this.ui.selectedStepId);
  },

  addMultiView(name: string | null = null, activeColumnIds: string[] = []): MultiView {
    const view: MultiView = {
      id: `mv-${Date.now()}`,
      name: name || `Multi View ${this.multiViews.length + 1}`,
      activeColumnIds: [...new Set(activeColumnIds)]
    };
    this.multiViews.push(view);
    this.syncComposerForView(view.id, view.activeColumnIds);
    return view;
  },

  removeMultiView(id: string): void {
    this.multiViews = this.multiViews.filter((v) => v.id !== id);
    if (this.ui.activeMultiViewId === id) this.ui.activeMultiViewId = null;
    this.clearViewRangeForKey(this.getViewKeyFor(null, id));
    this.removeComposerView(id);
  },

  toggleColumnInMultiView(viewId: string, columnId: string): void {
    const view = this.multiViews.find((v) => v.id === viewId);
    if (!view || !columnId) return;
    const idx = view.activeColumnIds.indexOf(columnId);
    if (idx === -1) view.activeColumnIds.push(columnId);
    else view.activeColumnIds.splice(idx, 1);
    this.syncComposerForView(viewId, view.activeColumnIds);
  },

  getComposerKey(viewId: string | null = null): string {
    if (viewId) return `mv:${viewId}`;
    return `single:${this.data.dataColumn || 'default'}`;
  },

  getActiveComposerColumns(): string[] {
    if (this.ui.activeMultiViewId) {
      const view = this.multiViews.find((v) => v.id === this.ui.activeMultiViewId);
      return view ? [...view.activeColumnIds] : [];
    }
    return this.data.dataColumn ? [this.data.dataColumn] : [];
  },

  syncComposerForView(viewId: string | null = null, columns: string[] = []): ComposerView {
    const cols = Array.isArray(columns) ? columns : [];
    if (!this.composer || !this.composer.views) this.composer = { views: {} };
    const key = this.getComposerKey(viewId);
    if (!this.composer.views[key]) this.composer.views[key] = { traces: [] };
    const composer = this.composer.views[key];
    const uniqueCols = [...new Set(cols)];
    if (uniqueCols.length === 0 && composer.traces.length === 0) return composer;
    composer.traces = uniqueCols.map((col) => {
      const existing = composer.traces.find((t) => t.columnId === col);
      this.getTraceConfig(col);
      return existing ? { ...existing } : { columnId: col };
    });
    return composer;
  },

  removeComposerView(viewId: string | null = null): void {
    if (!this.composer || !this.composer.views) return;
    delete this.composer.views[this.getComposerKey(viewId)];
  },

  updateComposerTrace(
    viewId: string | null,
    columnId: string,
    params: Partial<ComposerTrace & { xOffset?: number }> = {}
  ): void {
    if (!columnId) return;
    const columns = viewId
      ? this.multiViews.find((v) => v.id === viewId)?.activeColumnIds || []
      : this.getActiveComposerColumns();
    const composer = this.syncComposerForView(viewId, columns);
    const trace = composer.traces.find((t) => t.columnId === columnId);
    if (trace && Object.prototype.hasOwnProperty.call(params, 'xOffset')) {
      this.updateTraceConfig(columnId, { xOffset: params.xOffset || 0 });
    } else if (trace) {
      Object.assign(trace, params);
    }
  },

  getComposer(viewId: string | null = null): ComposerView {
    return this.syncComposerForView(viewId, this.getActiveComposerColumns());
  },

  addMathDefinition(def: MathDefinition): void {
    if (!this.config.mathDefinitions) this.config.mathDefinitions = [];
    this.config.mathDefinitions = this.config.mathDefinitions.filter((d) => d.name !== def.name);
    this.config.mathDefinitions.push(def);
  },

  removeMathDefinition(name: string): void {
    if (!this.config.mathDefinitions) this.config.mathDefinitions = [];
    this.config.mathDefinitions = this.config.mathDefinitions.filter((d) => d.name !== name);
    if (this.config.columnPipelines?.[name]) delete this.config.columnPipelines[name];
    if (this.traceConfigs?.[name]) delete this.traceConfigs[name];

    if (this.data.dataColumn === name) this.removeComposerView(null);
    else if (this.composer?.views) delete this.composer.views[`single:${name}`];

    this.multiViews.forEach((view) => {
      view.activeColumnIds = view.activeColumnIds.filter((id) => id !== name);
      this.syncComposerForView(view.id, view.activeColumnIds);
    });

    this.clearViewRangeForKey(this.getViewKeyFor(name, null));
    if (this.data.dataColumn === name) this.data.dataColumn = null;
  },

  getMathDefinition(name: string | null | undefined): MathDefinition | null {
    if (!name || !this.config.mathDefinitions) return null;
    return this.config.mathDefinitions.find((d) => d.name === name) || null;
  }
};
