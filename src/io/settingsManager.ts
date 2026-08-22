import { State } from '../state';
import type { SettingsPayload, WorkspaceSnapshot } from '../types';
import { downloadText } from './download';

const STORAGE_KEY = 'csv_filter_settings';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export const SettingsManager = {
  storageKey: STORAGE_KEY,

  getSerializableConfig(): SettingsPayload {
    const base = clone(State.config) as SettingsPayload;
    delete base.workspace;
    if (!State.isGlobalScope()) base.pipeline = clone(State.getPipeline());
    base.pipelineScope = State.config.pipelineScope !== false;
    base.columnPipelines = State.config.columnPipelines || {};
    base.workspace = {
      multiViews: clone(State.multiViews),
      composer: clone(State.composer),
      traceConfigs: clone(State.traceConfigs),
      viewRanges: clone(State.ui.viewRanges),
      activeMultiViewId: State.ui.activeMultiViewId || null,
      dataColumn: State.data.dataColumn || null
    };
    return base;
  },

  applyWorkspace(workspace?: WorkspaceSnapshot): void {
    if (!workspace) return;
    if (Array.isArray(workspace.multiViews)) State.multiViews = workspace.multiViews;
    if (workspace.composer) State.composer = workspace.composer;
    if (workspace.traceConfigs) State.traceConfigs = workspace.traceConfigs;
    if (workspace.viewRanges) State.ui.viewRanges = workspace.viewRanges;
    if (Object.prototype.hasOwnProperty.call(workspace, 'activeMultiViewId')) {
      State.ui.activeMultiViewId = workspace.activeMultiViewId || null;
    }
    if (workspace.dataColumn) State.data.dataColumn = workspace.dataColumn;
  },

  saveToBrowser(): void {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.getSerializableConfig()));
      alert('Settings saved to Browser Memory.');
    } catch (e) {
      console.error(e);
      alert('Failed to save settings to browser (Quota exceeded?).');
    }
  },

  loadFromBrowser(): boolean {
    try {
      const payload = localStorage.getItem(this.storageKey);
      if (!payload) return false;
      return this.applySettings(payload);
    } catch (e) {
      console.error(e);
      return false;
    }
  },

  downloadSettings(): void {
    downloadText(JSON.stringify(this.getSerializableConfig(), null, 2), 'filter_settings.json', 'application/json');
  },

  uploadSettings(file: File, onComplete?: () => void): void {
    const reader = new FileReader();
    reader.onload = (e) => {
      if (this.applySettings(String(e.target?.result || '')) && onComplete) onComplete();
    };
    reader.readAsText(file);
  },

  applySettings(jsonString: string): boolean {
    try {
      const newConfig = JSON.parse(jsonString) as SettingsPayload;
      if (!newConfig.graph || (!newConfig.pipeline && !newConfig.columnPipelines)) {
        throw new Error('Invalid settings file structure.');
      }

      const { workspace, ...incomingConfig } = newConfig;
      const currentColors = State.config.colors || {};
      const incomingColors = incomingConfig.colors || {};

      State.config = {
        ...State.config,
        ...incomingConfig,
        graph: { ...State.config.graph, ...(incomingConfig.graph || {}) },
        colors: {
          ...currentColors,
          ...incomingColors,
          light: { ...currentColors.light, ...incomingColors.light },
          dark: { ...currentColors.dark, ...incomingColors.dark }
        },
        defaults: { ...State.config.defaults, ...(incomingConfig.defaults || {}) },
        displayCalibration: {
          ...State.config.displayCalibration,
          ...(incomingConfig.displayCalibration || {})
        },
        pipeline: incomingConfig.pipeline || State.config.pipeline,
        columnPipelines: incomingConfig.columnPipelines || {},
        pipelineScope: incomingConfig.pipelineScope !== undefined
          ? incomingConfig.pipelineScope
          : State.config.pipelineScope !== undefined
            ? State.config.pipelineScope
            : true
      };
      delete (State.config as SettingsPayload).workspace;
      this.applyWorkspace(workspace);
      return true;
    } catch (e) {
      alert(`Error loading settings: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }
};
