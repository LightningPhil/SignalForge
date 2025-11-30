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
        
        // Reset Math definitions on new file load? 
        // Usually yes, as columns might change.
        this.config.mathDefinitions = [];
    },

    // --- Pipeline Management ---

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
            return this.config.pipeline;
        }

        if (!this.config.columnPipelines) this.config.columnPipelines = {};

        if (!columnId) columnId = this.getActiveColumnId();
        if (!columnId) return this.config.pipeline;

        if (!this.config.columnPipelines[columnId]) {
            this.config.columnPipelines[columnId] = this.clonePipeline(this.config.pipeline);
        }

        return this.config.columnPipelines[columnId];
    },

    getPipeline() {
        return this.getPipelineForColumn(this.getActiveColumnId());
    },

    setPipelineForColumn(columnId, pipeline) {
        const cloned = this.clonePipeline(pipeline);

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
        return view;
    },

    removeMultiView(id) {
        this.multiViews = this.multiViews.filter((v) => v.id !== id);
        if (this.ui.activeMultiViewId === id) {
            this.ui.activeMultiViewId = null;
        }
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