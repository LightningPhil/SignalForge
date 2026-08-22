import { Config } from './config';
import type {
  AppConfig,
  AppData,
  ComposerState,
  ComposerTrace,
  ComposerView,
  CsvRow,
  FilterStep,
  FilterType,
  MathDefinition,
  MultiView,
  TraceConfig,
  UiState,
  ViewRange
} from './types';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const defaultKeys = Config.defaults as unknown as Record<string, Partial<FilterStep>>;

export const State = {
  data: {
    raw: [],
    headers: [],
    processed: [],
    timeColumn: null,
    dataColumn: null
  } as AppData,

  multiViews: [] as MultiView[],
  composer: { views: {} } as ComposerState,
  traceConfigs: {} as Record<string, TraceConfig>,
  config: clone(Config) as AppConfig,
  ui: {
    selectedStepId: null,
    activeMultiViewId: null,
    viewRanges: {}
  } as UiState,

  setData(raw: CsvRow[], headers: string[]): void {
    this.data.raw = raw;
    this.data.headers = headers;
    this.data.timeColumn = headers.length > 0 ? headers[0] : null;
    this.data.dataColumn = headers.find((h) => h !== this.data.timeColumn) || null;
    this.data.processed = [];
    this.multiViews = [];
    this.ui.activeMultiViewId = null;
    this.ui.viewRanges = {};
    this.composer = { views: {} };
    this.traceConfigs = {};
    this.config.mathDefinitions = [];
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
    Object.assign(this.getTraceConfig(resolved), params);
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

    pipeline.push(newStep);
    this.ui.selectedStepId = newStep.id;
    return newStep;
  },

  removeStep(id: string): void {
    this.setPipelineForColumn(this.getActiveColumnId(), this.getPipeline().filter((s) => s.id !== id));
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

  updateComposerTrace(viewId: string | null, columnId: string, params: Partial<ComposerTrace & { xOffset?: number }> = {}): void {
    if (!columnId) return;
    const columns = viewId
      ? (this.multiViews.find((v) => v.id === viewId)?.activeColumnIds || [])
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
