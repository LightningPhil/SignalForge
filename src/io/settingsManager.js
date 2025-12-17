import { State } from '../state.js';
import { Config } from '../config.js';

const CURRENT_VERSION = 2;

function mergeAnalysisDefaults(analysis = {}) {
    const defaults = Config.analysis || {};
    const merged = {
        ...defaults,
        ...analysis,
        trigger: { ...(defaults.trigger || {}), ...(analysis.trigger || {}) }
    };
    if (!merged.measurementPreset) merged.measurementPreset = defaults.measurementPreset || 'general';
    return merged;
}

/**
 * Settings Persistence Module
 * Handles Save/Load of configuration to LocalStorage and JSON files.
 */
export const SettingsManager = {
    
    const_STORAGE_KEY: 'csv_filter_settings',

    getSerializableConfig() {
        const base = JSON.parse(JSON.stringify(State.config));
        base.settingsVersion = CURRENT_VERSION;
        base.analysis = mergeAnalysisDefaults(base.analysis || {});
        if (!State.isGlobalScope()) {
            base.pipeline = JSON.parse(JSON.stringify(State.getPipeline()));
        }
        base.pipelineScope = State.config.pipelineScope !== false;
        base.columnPipelines = State.config.columnPipelines || {};
        return base;
    },

    // --- Browser Memory (LocalStorage) ---

    saveToBrowser() {
        try {
            const payload = JSON.stringify(this.getSerializableConfig());
            localStorage.setItem(this.const_STORAGE_KEY, payload);
            alert("Settings saved to Browser Memory.");
        } catch (e) {
            console.error(e);
            alert("Failed to save settings to browser (Quota exceeded?).");
        }
    },

    loadFromBrowser() {
        try {
            const payload = localStorage.getItem(this.const_STORAGE_KEY);
            if (!payload) return false;
            return this.applySettings(payload);
        } catch (e) {
            console.error(e);
            return false;
        }
    },

    // --- File System (JSON) ---

    downloadSettings() {
        // Pretty print JSON (2 spaces)
        const payload = JSON.stringify(this.getSerializableConfig(), null, 2);
        const blob = new Blob([payload], { type: 'application/json' });
        
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'filter_settings.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    },

    uploadSettings(file, onComplete) {
        const reader = new FileReader();
        reader.onload = (e) => {
            const success = this.applySettings(e.target.result);
            if(success) {
                if (onComplete) onComplete();
            }
        };
        reader.readAsText(file);
    },

    // --- Internal Logic ---

    /**
     * Parses JSON and updates the global State.config
     */
    applySettings(jsonString) {
        try {
            const newConfig = JSON.parse(jsonString);

            // Basic Schema Validation
            if (!newConfig.graph || (!newConfig.pipeline && !newConfig.columnPipelines)) {
                throw new Error("Invalid settings file structure.");
            }

            const migrated = this.migrateConfig(newConfig);
            const merged = {
                ...State.config,
                ...migrated,
                pipeline: migrated.pipeline || State.config.pipeline,
                columnPipelines: migrated.columnPipelines || {},
                pipelineScope: migrated.pipelineScope !== undefined
                    ? migrated.pipelineScope
                    : State.config.pipelineScope !== undefined
                        ? State.config.pipelineScope
                        : true
            };

            State.config = merged;
            State.ensureAnalysisConfig();
            return true;
        } catch (e) {
            alert("Error loading settings: " + e.message);
            return false;
        }
    },

    migrateConfig(config) {
        const cloned = JSON.parse(JSON.stringify(config));
        const version = cloned.settingsVersion || 1;
        cloned.analysis = mergeAnalysisDefaults(cloned.analysis || {});
        if (version < CURRENT_VERSION) {
            cloned.settingsVersion = CURRENT_VERSION;
        } else {
            cloned.settingsVersion = version;
        }
        return cloned;
    }
};