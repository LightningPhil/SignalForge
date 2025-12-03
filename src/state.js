import { Config } from './config.js';

/**
 * State Management Singleton
 */
export const State = {
    // Data Storage
    data: {
        raw: [],
        headers: [],
        processed: [],
        timeColumn: null,
        dataColumn: null
    },

    // Multi-View tabs
    multiViews: [],

    // Composer views (per tab/multi-view)
    composer: { views: {} },

    // Trace-level configuration shared across tabs/views
    traceConfigs: {},

    // Configuration
    config: JSON.parse(JSON.stringify(Config)),

    // Runtime state
    ui: {
        selectedStepId: null,
        activeMultiViewId: null
    },

    // Reference / static traces
    referenceTraces: [],
    referenceVisibility: {},

    // Methods
    setData(raw, headers) {
        this.data.raw = raw;
        this.data.headers = headers;
        
        if (!this.data.timeColumn && headers.length > 0) this.data.timeColumn = headers[0];
        if (!this.data.dataColumn && headers.length > 1) this.data.dataColumn = headers[1];

        this.data.processed = [];

        this.multiViews = [];
        this.ui.activeMultiViewId = null;

        this.composer = { views: {} };
        this.traceConfigs = {};

        this.referenceTraces = [];
        this.referenceVisibility = {};
        
        // Reset Math definitions on new file load?
        // Usually yes, as columns might change.
        this.config.mathDefinitions = [];
    },

    addReferenceTrace({ name, x, y }) {
        if (!Array.isArray(x) || !Array.isArray(y) || x.length === 0 || y.length === 0) return null;
        const length = Math.min(x.length, y.length);
        const trace = {
            id: `ref-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            name: name || 'Reference',
            x: x.slice(0, length),
            y: y.slice(0, length)
        };
        this.referenceTraces.push(trace);

        const viewId = this.ui.activeMultiViewId || null;
        this.setReferenceVisibility(viewId, trace.id, true);
        return trace;
    },

    clearReferenceTraces() {
        this.referenceTraces = [];
        this.referenceVisibility = {};
    },

    getReferenceVisibilityKey(viewId = null) {
        return viewId ? `mv:${viewId}` : 'main';
    },

    ensureReferenceVisibility(viewId = null) {
        const key = this.getReferenceVisibilityKey(viewId);
        if (!this.referenceVisibility[key]) this.referenceVisibility[key] = [];
        return this.referenceVisibility[key];
    },

    isReferenceVisible(viewId = null, refId = '') {
        if (!refId) return false;
        const list = this.referenceVisibility[this.getReferenceVisibilityKey(viewId)];
        return Array.isArray(list) ? list.includes(refId) : false;
    },

    setReferenceVisibility(viewId = null, refId = '', enabled = true) {
        if (!refId) return;
        const list = this.ensureReferenceVisibility(viewId);
        const idx = list.indexOf(refId);
        if (enabled && idx === -1) list.push(refId);
        if (!enabled && idx !== -1) list.splice(idx, 1);
    },

    // --- Pipeline Management ---

    createNullFilterStep() {
        return { id: 'null-filter', type: 'nullFilter', enabled: true };
    },

    normalizePipeline(pipeline) {
        const steps = Array.isArray(pipeline) ? pipeline : [];
        if (steps.length === 0) return [this.createNullFilterStep()];
        return steps;
    },

    ensurePipelineStored(columnId, pipelineRef) {
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

    isGlobalScope() {
        return this.config.pipelineScope !== false;
    },

    getActiveColumnId() {
        return this.data.dataColumn;
    },

    clonePipeline(pipeline) {
        return JSON.parse(JSON.stringify(pipeline || []));
    },

    getPipelineForColumn(columnId) {
        if (this.isGlobalScope()) {
            return this.ensurePipelineStored(null, this.config.pipeline);
        }

        if (!this.config.columnPipelines) this.config.columnPipelines = {};

        if (!columnId) columnId = this.getActiveColumnId();
        if (!columnId) return this.ensurePipelineStored(null, this.config.pipeline);

        if (!this.config.columnPipelines[columnId]) {
            this.config.columnPipelines[columnId] = this.clonePipeline(this.config.pipeline);
        }

        return this.ensurePipelineStored(columnId, this.config.columnPipelines[columnId]);
    },

    getPipeline() {
        return this.getPipelineForColumn(this.getActiveColumnId());
    },

    getTraceConfig(columnId = null) {
        if (!columnId) columnId = this.getActiveColumnId();
        if (!columnId) return { xOffset: 0 };

        if (!this.traceConfigs) this.traceConfigs = {};
        if (!this.traceConfigs[columnId]) {
            this.traceConfigs[columnId] = { xOffset: 0 };
        }

        return this.traceConfigs[columnId];
    },

    updateTraceConfig(columnId, params = {}) {
        if (!columnId) columnId = this.getActiveColumnId();
        if (!columnId) return;

        const cfg = this.getTraceConfig(columnId);
        Object.assign(cfg, params);
    },

    setPipelineForColumn(columnId, pipeline) {
        const normalized = this.normalizePipeline(pipeline);
        const cloned = this.clonePipeline(normalized);

        if (this.isGlobalScope()) {
            this.config.pipeline = cloned;
            return;
        }

        if (!columnId) columnId = this.getActiveColumnId();
        if (!columnId) {
            this.config.pipeline = cloned;
            return;
        }

        if (!this.config.columnPipelines) this.config.columnPipelines = {};
        this.config.columnPipelines[columnId] = cloned;
    },

    setPipelineScope(isGlobal, columnIds = []) {
        const desired = !!isGlobal;
        const activePipeline = this.clonePipeline(this.getPipeline());

        if (desired) {
            // Sync every stored pipeline to the active one
            this.config.pipeline = activePipeline;
            const keys = columnIds.length > 0
                ? columnIds
                : Object.keys(this.config.columnPipelines || {});

            if (!this.config.columnPipelines) this.config.columnPipelines = {};
            keys.forEach((col) => {
                this.config.columnPipelines[col] = this.clonePipeline(activePipeline);
            });
        } else {
            // Seed per-column pipelines from the current global pipeline
            if (!this.config.columnPipelines) this.config.columnPipelines = {};
            const targets = columnIds.length > 0
                ? columnIds
                : Object.keys(this.config.columnPipelines);

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

    addStep(type) {
        const pipeline = this.getPipeline();

        if (pipeline.length === 1 && pipeline[0].type === 'nullFilter') {
            pipeline.pop();
        }

        const newStep = {
            id: 'step-' + Date.now(),
            type: type,
            enabled: true,
            ...Config.defaults[type]
        };

        pipeline.push(newStep);
        this.ui.selectedStepId = newStep.id;
        return newStep;
    },

    removeStep(id) {
        const columnId = this.getActiveColumnId();
        const pipeline = this.getPipeline().filter(s => s.id !== id);
        this.setPipelineForColumn(columnId, pipeline);

        if (this.ui.selectedStepId === id) {
            this.ui.selectedStepId = null;
        }
    },

    moveStep(id, direction) {
        const pipeline = this.getPipeline();
        const idx = pipeline.findIndex(s => s.id === id);
        if (idx === -1) return;

        const newIdx = idx + direction;
        if (newIdx < 0 || newIdx >= pipeline.length) return;

        const temp = pipeline[idx];
        pipeline[idx] = pipeline[newIdx];
        pipeline[newIdx] = temp;
    },

    updateStepParams(id, params) {
        const step = this.getPipeline().find(s => s.id === id);
        if (step) {
            Object.assign(step, params);
        }
    },

    getSelectedStep() {
        return this.getPipeline().find(s => s.id === this.ui.selectedStepId);
    },

    // --- Multi-View Management ---

    addMultiView(name = null, activeColumnIds = []) {
        const view = {
            id: `mv-${Date.now()}`,
            name: name || `Multi View ${this.multiViews.length + 1}`,
            activeColumnIds: [...new Set(activeColumnIds)]
        };
        this.multiViews.push(view);
        this.syncComposerForView(view.id, view.activeColumnIds);
        return view;
    },

    removeMultiView(id) {
        this.multiViews = this.multiViews.filter((v) => v.id !== id);
        if (this.ui.activeMultiViewId === id) {
            this.ui.activeMultiViewId = null;
        }
        this.removeComposerView(id);
    },

    toggleColumnInMultiView(viewId, columnId) {
        const view = this.multiViews.find((v) => v.id === viewId);
        if (!view || !columnId) return;

        const idx = view.activeColumnIds.indexOf(columnId);
        if (idx === -1) {
            view.activeColumnIds.push(columnId);
        } else {
            view.activeColumnIds.splice(idx, 1);
        }

        this.syncComposerForView(viewId, view.activeColumnIds);
    },

    // --- Composer Management ---

    getComposerKey(viewId = null) {
        if (viewId) return `mv:${viewId}`;
        const activeCol = this.data.dataColumn || 'default';
        return `single:${activeCol}`;
    },

    getActiveComposerColumns() {
        if (this.ui.activeMultiViewId) {
            const view = this.multiViews.find((v) => v.id === this.ui.activeMultiViewId);
            return view ? [...view.activeColumnIds] : [];
        }
        return this.data.dataColumn ? [this.data.dataColumn] : [];
    },

    syncComposerForView(viewId = null, columns = []) {
        if (!Array.isArray(columns)) columns = [];
        if (!this.composer || !this.composer.views) this.composer = { views: {} };

        const key = this.getComposerKey(viewId);
        if (!this.composer.views[key]) {
            this.composer.views[key] = { traces: [] };
        }

        const composer = this.composer.views[key];
        const uniqueCols = [...new Set(columns)];
        if (uniqueCols.length === 0 && composer.traces.length === 0) return composer;

        composer.traces = uniqueCols.map((col) => {
            const existing = composer.traces.find((t) => t.columnId === col);
            this.getTraceConfig(col);
            return existing ? { ...existing } : { columnId: col };
        });

        return composer;
    },

    removeComposerView(viewId = null) {
        if (!this.composer || !this.composer.views) return;
        const key = this.getComposerKey(viewId);
        delete this.composer.views[key];
    },

    updateComposerTrace(viewId, columnId, params = {}) {
        if (!columnId) return;
        const columns = viewId ? (this.multiViews.find((v) => v.id === viewId)?.activeColumnIds || []) : this.getActiveComposerColumns();
        const composer = this.syncComposerForView(viewId, columns);
        const trace = composer.traces.find((t) => t.columnId === columnId);
        if (trace && Object.prototype.hasOwnProperty.call(params, 'xOffset')) {
            this.updateTraceConfig(columnId, { xOffset: params.xOffset });
        } else if (trace) {
            Object.assign(trace, params);
        }
    },

    getComposer(viewId = null) {
        return this.syncComposerForView(viewId, this.getActiveComposerColumns());
    },

    // --- Math Management ---
    
    addMathDefinition(def) {
        if(!this.config.mathDefinitions) this.config.mathDefinitions = [];
        // Remove existing with same name to allow overwrite/update
        this.config.mathDefinitions = this.config.mathDefinitions.filter(d => d.name !== def.name);
        this.config.mathDefinitions.push(def);
    },

    removeMathDefinition(name) {
        if (!this.config.mathDefinitions) this.config.mathDefinitions = [];
        this.config.mathDefinitions = this.config.mathDefinitions.filter((d) => d.name !== name);

        if (this.config.columnPipelines && this.config.columnPipelines[name]) {
            delete this.config.columnPipelines[name];
        }

        if (this.traceConfigs && this.traceConfigs[name]) {
            delete this.traceConfigs[name];
        }

        if (this.composer?.views && this.composer.views[name]) {
            delete this.composer.views[name];
        }

        if (this.data.dataColumn === name) {
            this.data.dataColumn = null;
        }
    },

    getMathDefinition(name) {
        if(!this.config.mathDefinitions) return null;
        return this.config.mathDefinitions.find(d => d.name === name);
    }
};