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

    // Configuration
    config: JSON.parse(JSON.stringify(Config)), 

    // Runtime state 
    ui: {
        selectedStepId: null 
    },

    // Methods
    setData(raw, headers) {
        this.data.raw = raw;
        this.data.headers = headers;
        
        if (!this.data.timeColumn && headers.length > 0) this.data.timeColumn = headers[0];
        if (!this.data.dataColumn && headers.length > 1) this.data.dataColumn = headers[1];

        this.data.processed = [];
        
        // Reset Math definitions on new file load? 
        // Usually yes, as columns might change.
        this.config.mathDefinitions = [];
    },

    // --- Pipeline Management ---

    addStep(type) {
        const newStep = {
            id: 'step-' + Date.now(),
            type: type,
            enabled: true,
            ...Config.defaults[type] 
        };
        this.config.pipeline.push(newStep);
        this.ui.selectedStepId = newStep.id;
        return newStep;
    },

    removeStep(id) {
        this.config.pipeline = this.config.pipeline.filter(s => s.id !== id);
        if (this.ui.selectedStepId === id) {
            this.ui.selectedStepId = null;
        }
    },

    moveStep(id, direction) {
        const idx = this.config.pipeline.findIndex(s => s.id === id);
        if (idx === -1) return;

        const newIdx = idx + direction;
        if (newIdx < 0 || newIdx >= this.config.pipeline.length) return;

        const temp = this.config.pipeline[idx];
        this.config.pipeline[idx] = this.config.pipeline[newIdx];
        this.config.pipeline[newIdx] = temp;
    },

    updateStepParams(id, params) {
        const step = this.config.pipeline.find(s => s.id === id);
        if (step) {
            Object.assign(step, params);
        }
    },

    getSelectedStep() {
        return this.config.pipeline.find(s => s.id === this.ui.selectedStepId);
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