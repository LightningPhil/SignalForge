import { Config } from '../config';
import { State } from '../state';
import type { FilterDefaults, FilterStep, FilterType, SettingsPayload, WorkspaceSnapshot } from '../types';
import { validateFilterStep } from '../processing/filter';
import { downloadText } from './download';

const STORAGE_KEY = 'csv_filter_settings';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeImportedFilterStep(value: unknown, defaults: FilterDefaults): FilterStep {
  if (!isRecord(value)) throw new Error('Filter step must be an object.');
  const raw = { ...value };
  delete raw.qFactor;
  if (raw.type === 'gaussian' && raw.kernelSize === undefined && raw.windowSize !== undefined) {
    raw.kernelSize = raw.windowSize;
  }
  if (raw.type === 'gaussian') delete raw.windowSize;
  if (raw.type === 'startStopNorm' && raw.decayLength !== undefined) {
    if (raw.startLength === undefined) raw.startLength = raw.decayLength;
    if (raw.endLength === undefined) raw.endLength = raw.decayLength;
  }
  delete raw.decayLength;

  const type = raw.type as FilterType;
  const perTypeDefaults =
    typeof type === 'string' && Object.prototype.hasOwnProperty.call(defaults, type)
      ? (defaults as unknown as Record<string, Record<string, unknown>>)[type]
      : {};
  const normalized = {
    ...perTypeDefaults,
    ...raw,
    enabled: raw.enabled ?? true
  } as FilterStep;
  validateFilterStep(normalized);
  return normalized;
}

function normalizeImportedDefaults(value: unknown): FilterDefaults {
  if (value !== undefined && !isRecord(value)) throw new Error('Filter defaults must be an object.');
  const incoming = (value || {}) as Record<string, unknown>;
  const knownTypes = new Set(Object.keys(Config.defaults));
  const unexpected = Object.keys(incoming).filter((type) => !knownTypes.has(type));
  if (unexpected.length > 0) throw new Error(`Unsupported filter default type(s): ${unexpected.join(', ')}.`);

  const normalized = clone(Config.defaults);
  for (const type of knownTypes) {
    const overrides = incoming[type];
    if (overrides !== undefined && !isRecord(overrides)) {
      throw new Error(`${type} defaults must be an object.`);
    }
    const step = normalizeImportedFilterStep(
      {
        id: `default-${type}`,
        type,
        enabled: true,
        ...(overrides || {})
      },
      normalized
    );
    const parameters = { ...step } as Record<string, unknown>;
    delete parameters.id;
    delete parameters.type;
    delete parameters.enabled;
    (normalized as unknown as Record<string, Record<string, unknown>>)[type] = parameters;
  }
  return normalized;
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
      const normalizedDefaults = normalizeImportedDefaults(incomingConfig.defaults);
      const normalizedPipeline = (incomingConfig.pipeline || []).map((step) =>
        normalizeImportedFilterStep(step, normalizedDefaults)
      );
      const normalizedColumnPipelines = Object.fromEntries(
        Object.entries(incomingConfig.columnPipelines || {}).map(([column, pipeline]) => {
          if (!Array.isArray(pipeline)) throw new Error(`Pipeline for ${column} must be an array.`);
          return [column, pipeline.map((step) => normalizeImportedFilterStep(step, normalizedDefaults))];
        })
      );
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
        defaults: normalizedDefaults,
        displayCalibration: {
          ...State.config.displayCalibration,
          ...(incomingConfig.displayCalibration || {})
        },
        analysis: {
          ...State.config.analysis,
          ...(incomingConfig.analysis || {}),
          trigger: {
            ...(State.config.analysis?.trigger || {}),
            ...(incomingConfig.analysis?.trigger || {})
          }
        },
        settingsVersion: 4,
        pipeline: normalizedPipeline.length > 0 ? normalizedPipeline : State.config.pipeline,
        columnPipelines: normalizedColumnPipelines,
        pipelineScope:
          incomingConfig.pipelineScope !== undefined
            ? incomingConfig.pipelineScope
            : State.config.pipelineScope !== undefined
              ? State.config.pipelineScope
              : true
      };
      delete (State.config as SettingsPayload).workspace;
      this.applyWorkspace(workspace);
      State.ensureAnalysisConfig();
      return true;
    } catch (e) {
      alert(`Error loading settings: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }
};
