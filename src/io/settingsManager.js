import { State } from '../state.js';

/**
 * Settings Persistence Module
 * Handles Save/Load of configuration to LocalStorage and JSON files.
 */
export const SettingsManager = {
    
    const_STORAGE_KEY: 'csv_filter_settings',

    // --- Browser Memory (LocalStorage) ---

    saveToBrowser() {
        try {
            const payload = JSON.stringify(State.config);
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
        const payload = JSON.stringify(State.config, null, 2);
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
            if (newConfig.graph && newConfig.filter) {
                State.config = newConfig;
                return true;
            } else {
                throw new Error("Invalid settings file structure.");
            }
        } catch (e) {
            alert("Error loading settings: " + e.message);
            return false;
        }
    }
};