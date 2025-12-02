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

    estimateTimeStep(rawXOverride = null) {
        const xValues = Array.isArray(rawXOverride)
            ? rawXOverride
            : (this.data.timeColumn && Array.isArray(this.data.raw)
                ? this.data.raw.map((row) => parseFloat(row[this.data.timeColumn]))
                : []);

        if (!xValues || xValues.length < 2) return null;

        const limit = Math.min(xValues.length - 1, 1000);
        const deltas = [];
        for (let i = 0; i < limit; i++) {
            const diff = parseFloat(xValues[i + 1]) - parseFloat(xValues[i]);
            if (Number.isFinite(diff) && diff !== 0) deltas.push(Math.abs(diff));
        }

        if (deltas.length === 0) return null;

        deltas.sort((a, b) => a - b);
        const mid = Math.floor(deltas.length / 2);
        return deltas.length % 2 !== 0
            ? deltas[mid]
            : (deltas[mid - 1] + deltas[mid]) / 2;
    },

    // Multi-View tabs
    multiViews: [],

    // Composer views (per tab/multi-view)
    composer: { views: {} },

    // Configuration
    config: JSON.parse(JSON.stringify(Config)),

    // Runtime state
    ui: {
        selectedStepId: null,
        activeMultiViewId: null
    },

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
        
        // Reset Math definitions on new file load? 
        // Usually yes, as columns might change.
        this.config.mathDefinitions = [];
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
            this.composer.views[key] = { traces: [], waterfallMode: false, waterfallSpacing: 0 };
        }

        const composer = this.composer.views[key];
        const uniqueCols = [...new Set(columns)];
        if (uniqueCols.length === 0 && composer.traces.length === 0) return composer;

        composer.traces = uniqueCols.map((col) => {
            const existing = composer.traces.find((t) => t.columnId === col);
            return existing ? { ...existing } : { columnId: col, timeOffset: 0, yOffset: 0 };
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
        if (trace) Object.assign(trace, params);
    },

    setComposerWaterfall(viewId, enabled) {
        const composer = this.syncComposerForView(viewId, this.getActiveComposerColumns());
        composer.waterfallMode = !!enabled;
    },

    setComposerWaterfallSpacing(viewId, spacing) {
        const composer = this.syncComposerForView(viewId, this.getActiveComposerColumns());
        composer.waterfallSpacing = Number.isFinite(spacing) ? spacing : 0;
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

    getMathDefinition(name) {
        if(!this.config.mathDefinitions) return null;
        return this.config.mathDefinitions.find(d => d.name === name);
    }
};