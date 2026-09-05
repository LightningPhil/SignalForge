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

const KNOWN_TOP_LEVEL_KEYS = new Set([
  'settingsVersion',
  'graph',
  'pipelineScope',
  'columnPipelines',
  'pipeline',
  'defaults',
  'colors',
  'limits',
  'displayCalibration',
  'mathDefinitions',
  'analysis',
  'workspace'
]);

const AXIS_FORMATS = new Set(['decimal', 'scientific', 'integer', 'currency', 'percentage', 'datetime', 'engineering']);
const VIEW_MODES = new Set(['time', 'fft', 'spectrogram']);
const FFT_WINDOWS = new Set(['hann', 'hamming', 'blackman', 'blackman-harris', 'flattop', 'kaiser', 'rectangular']);
const FFT_ZERO_PAD = new Set(['none', 'nextPow2', 'factor']);
const FFT_DETREND = new Set(['none', 'removeMean', 'linear']);
const FFT_VIEW = new Set(['magnitude', 'phase', 'both']);
const FFT_SOURCE = new Set(['auto', 'raw', 'filtered']);
const MEASUREMENT_PRESETS = new Set(['general', 'power', 'pulsed']);
const TRIGGER_TYPES = new Set(['level', 'edge', 'pulse', 'runt']);
const TRIGGER_DIRECTIONS = new Set(['rising', 'falling', 'either']);
const TRIGGER_SOURCES = new Set(['raw', 'filtered', 'math', 'derivative']);
const COLOR_KEYS = new Set(['raw', 'filtered', 'diffRaw', 'diffFilt', 'transfer']);
const COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

type Check = (value: unknown, path: string) => void;

const isBoolean: Check = (value, path) => {
  if (typeof value !== 'boolean') throw new Error(`${path} must be true or false.`);
};
const isBoundedString =
  (maxLength = 200): Check =>
  (value, path) => {
    if (typeof value !== 'string' || value.length > maxLength) {
      throw new Error(`${path} must be a string of at most ${maxLength} characters.`);
    }
  };
const isFiniteNumber =
  (minimum = -Infinity, maximum = Infinity): Check =>
  (value, path) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
      throw new Error(`${path} must be a finite number between ${minimum} and ${maximum}.`);
    }
  };
const isInteger =
  (minimum: number, maximum: number): Check =>
  (value, path) => {
    if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
      throw new Error(`${path} must be an integer between ${minimum} and ${maximum}.`);
    }
  };
const isEnum =
  (allowed: Set<string>): Check =>
  (value, path) => {
    if (typeof value !== 'string' || !allowed.has(value)) {
      throw new Error(`${path} must be one of: ${[...allowed].join(', ')}.`);
    }
  };
const orNull =
  (check: Check): Check =>
  (value, path) => {
    if (value !== null) check(value, path);
  };

/** Validates every present key of `value` against `schema`; unknown keys are rejected. */
function checkRecord(value: unknown, schema: Record<string, Check>, path: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  for (const [key, entry] of Object.entries(value)) {
    const check = schema[key];
    if (!check || key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new Error(`${path}.${key} is not a recognised setting.`);
    }
    if (entry !== undefined) check(entry, `${path}.${key}`);
  }
}

const GRAPH_SCHEMA: Record<string, Check> = {
  title: isBoundedString(500),
  xAxisTitle: isBoundedString(500),
  yAxisTitle: isBoundedString(500),
  xAxisFormat: isEnum(AXIS_FORMATS),
  yAxisFormat: isEnum(AXIS_FORMATS),
  currencySymbol: isBoundedString(8),
  significantFigures: isInteger(1, 16),
  logScaleY: isBoolean,
  showDifferential: isBoolean,
  showResidual: isBoolean,
  showGrid: isBoolean,
  showFreqDomain: isBoolean,
  viewMode: isEnum(VIEW_MODES),
  showRaw: isBoolean,
  rawOpacity: isFiniteNumber(0, 1),
  enableDownsampling: isBoolean,
  maxDisplayPoints: isInteger(100, 10_000_000),
  useScientificNotation: isBoolean
};

const TRIGGER_SCHEMA: Record<string, Check> = {
  enabled: isBoolean,
  type: isEnum(TRIGGER_TYPES),
  direction: isEnum(TRIGGER_DIRECTIONS),
  threshold: isFiniteNumber(),
  hysteresis: isFiniteNumber(0),
  slopeThreshold: isFiniteNumber(0),
  minWidth: isFiniteNumber(0),
  maxWidth: (value, path) => {
    // Infinity is allowed here: it is the "no upper bound" default and JSON encodes it as null.
    if (value === null || value === Infinity) return;
    isFiniteNumber(0)(value, path);
  },
  minSeparation: isFiniteNumber(0),
  highThreshold: isFiniteNumber(),
  lowThreshold: isFiniteNumber(),
  source: isEnum(TRIGGER_SOURCES),
  selectionOnly: isBoolean
};

const ANALYSIS_SCHEMA: Record<string, Check> = {
  enabled: isBoolean,
  selectionOnly: isBoolean,
  impedanceOhms: isFiniteNumber(Number.MIN_VALUE),
  fftWindow: isEnum(FFT_WINDOWS),
  fftZeroPad: (value, path) => {
    // Settings saved before v4 stored this as a boolean; ensureAnalysisConfig() maps it to the enum.
    if (typeof value === 'boolean') return;
    isEnum(FFT_ZERO_PAD)(value, path);
  },
  fftZeroPadFactor: isInteger(1, 64),
  fftDetrend: isEnum(FFT_DETREND),
  fftView: isEnum(FFT_VIEW),
  fftPeakCount: isInteger(0, 1000),
  fftPeakProminence: isFiniteNumber(0, 1),
  fftShowHarmonics: isBoolean,
  fftHarmonicCount: isInteger(0, 1000),
  fftHarmonicFundamental: orNull(isFiniteNumber(0)),
  fftSource: isEnum(FFT_SOURCE),
  spectrogramWindow: isEnum(FFT_WINDOWS),
  spectrogramSize: isInteger(8, 1 << 20),
  spectrogramOverlap: isFiniteNumber(0, 0.99),
  spectrogramMaxPoints: isInteger(100, 100_000_000),
  spectrogramFreqMin: isFiniteNumber(0),
  spectrogramFreqMax: orNull(isFiniteNumber(0)),
  spectrogramSource: isEnum(FFT_SOURCE),
  showEvents: isBoolean,
  systemSelectionOnly: isBoolean,
  systemMaxLagSeconds: orNull(isFiniteNumber(0)),
  systemInput: isBoundedString(500),
  systemOutput: isBoundedString(500),
  measurementPreset: isEnum(MEASUREMENT_PRESETS),
  trigger: (value, path) => checkRecord(value, TRIGGER_SCHEMA, path)
};

const THEME_COLOR_SCHEMA: Record<string, Check> = Object.fromEntries(
  [...COLOR_KEYS].map((key) => [
    key,
    (value: unknown, path: string) => {
      if (typeof value !== 'string' || !COLOR_PATTERN.test(value)) {
        throw new Error(`${path} must be a hex colour such as #0047AB.`);
      }
    }
  ])
);

const COLOR_SCHEMA: Record<string, Check> = {
  ...THEME_COLOR_SCHEMA,
  light: (value, path) => checkRecord(value, THEME_COLOR_SCHEMA, path),
  dark: (value, path) => checkRecord(value, THEME_COLOR_SCHEMA, path)
};

const LIMITS_SCHEMA: Record<string, Check> = {
  previewLines: isInteger(1, 100_000),
  maxGridRows: isInteger(1, 10_000_000)
};

const DISPLAY_CALIBRATION_SCHEMA: Record<string, Check> = {
  pixelsPerCm: isFiniteNumber(1, 10_000)
};

const MATH_VARIABLE_SCHEMA: Record<string, Check> = {
  columnId: isBoundedString(500),
  symbol: (value, path) => {
    if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(value)) {
      throw new Error(`${path} must be an identifier of at most 32 characters.`);
    }
  },
  sourceMode: isEnum(new Set(['raw', 'filtered'])),
  applyXOffset: isBoolean
};

function checkMathDefinitions(value: unknown, path: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 1000) throw new Error(`${path} must be an array of at most 1000 items.`);
  value.forEach((definition, index) => {
    checkRecord(
      definition,
      {
        name: isBoundedString(200),
        expression: isBoundedString(10_000),
        variables: (variables, variablesPath) => {
          if (!Array.isArray(variables) || variables.length > 64) {
            throw new Error(`${variablesPath} must be an array of at most 64 variables.`);
          }
          variables.forEach((variable, variableIndex) =>
            checkRecord(variable, MATH_VARIABLE_SCHEMA, `${variablesPath}[${variableIndex}]`)
          );
        }
      },
      `${path}[${index}]`
    );
    if (!isRecord(definition) || typeof definition.name !== 'string' || typeof definition.expression !== 'string') {
      throw new Error(`${path}[${index}] needs a name and an expression.`);
    }
  });
}

const TRACE_CONFIG_SCHEMA: Record<string, Check> = { xOffset: isFiniteNumber() };

function checkRange(value: unknown, path: string): void {
  if (value === null) return;
  if (!Array.isArray(value) || value.length !== 2 || !value.every((entry) => Number.isFinite(entry))) {
    throw new Error(`${path} must be null or a pair of finite numbers.`);
  }
}

function checkKeyedRecord(value: unknown, path: string, check: Check, maxEntries = 10_000): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  const entries = Object.entries(value);
  if (entries.length > maxEntries) throw new Error(`${path} has too many entries.`);
  for (const [key, entry] of entries) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype' || key.length > 500) {
      throw new Error(`${path} contains an invalid key.`);
    }
    check(entry, `${path}.${key}`);
  }
}

const WORKSPACE_SCHEMA: Record<string, Check> = {
  multiViews: (value, path) => {
    if (!Array.isArray(value) || value.length > 1000) throw new Error(`${path} must be an array of views.`);
    value.forEach((view, index) => {
      checkRecord(
        view,
        {
          id: isBoundedString(200),
          name: isBoundedString(500),
          activeColumnIds: (ids, idsPath) => {
            if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || id.length > 500)) {
              throw new Error(`${idsPath} must be an array of column names.`);
            }
          }
        },
        `${path}[${index}]`
      );
      if (!isRecord(view) || typeof view.id !== 'string' || !Array.isArray(view.activeColumnIds)) {
        throw new Error(`${path}[${index}] needs an id and activeColumnIds.`);
      }
    });
  },
  composer: (value, path) =>
    checkRecord(
      value,
      {
        views: (views, viewsPath) =>
          checkKeyedRecord(views, viewsPath, (view, viewPath) => {
            checkRecord(
              view,
              {
                traces: (traces, tracesPath) => {
                  if (!Array.isArray(traces) || traces.length > 1000) {
                    throw new Error(`${tracesPath} must be an array of traces.`);
                  }
                  traces.forEach((trace, traceIndex) => {
                    checkRecord(
                      trace,
                      { columnId: isBoundedString(500), yOffset: isFiniteNumber() },
                      `${tracesPath}[${traceIndex}]`
                    );
                    if (!isRecord(trace) || typeof trace.columnId !== 'string') {
                      throw new Error(`${tracesPath}[${traceIndex}] needs a columnId.`);
                    }
                  });
                }
              },
              viewPath
            );
            if (!isRecord(view) || !Array.isArray(view.traces)) throw new Error(`${viewPath} needs traces.`);
          })
      },
      path
    ),
  traceConfigs: (value, path) =>
    checkKeyedRecord(value, path, (config, configPath) => checkRecord(config, TRACE_CONFIG_SCHEMA, configPath)),
  viewRanges: (value, path) =>
    checkKeyedRecord(value, path, (range, rangePath) => {
      if (range === null) return;
      checkRecord(range, { x: checkRange, y: checkRange }, rangePath);
    }),
  activeMultiViewId: orNull(isBoundedString(200)),
  dataColumn: orNull(isBoundedString(500))
};

/**
 * Validates an imported settings payload against the complete schema. Every top-level key must be
 * known, every enum must be a supported value and every number must be finite and within range, so
 * a hand-edited or hostile file cannot put the application into an unrepresentable state.
 */
export function validateSettingsPayload(payload: unknown): SettingsPayload {
  if (!isRecord(payload)) throw new Error('Settings file must contain a JSON object.');
  for (const key of Object.keys(payload)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) throw new Error(`"${key}" is not a recognised settings section.`);
  }
  if (!payload.graph || (!payload.pipeline && !payload.columnPipelines)) {
    throw new Error('Invalid settings file structure.');
  }
  if (payload.settingsVersion !== undefined) isInteger(0, 1000)(payload.settingsVersion, 'settingsVersion');
  checkRecord(payload.graph, GRAPH_SCHEMA, 'graph');
  if (payload.pipelineScope !== undefined) isBoolean(payload.pipelineScope, 'pipelineScope');
  checkRecord(payload.colors, COLOR_SCHEMA, 'colors');
  checkRecord(payload.limits, LIMITS_SCHEMA, 'limits');
  checkRecord(payload.displayCalibration, DISPLAY_CALIBRATION_SCHEMA, 'displayCalibration');
  checkRecord(payload.analysis, ANALYSIS_SCHEMA, 'analysis');
  checkMathDefinitions(payload.mathDefinitions, 'mathDefinitions');
  checkRecord(payload.workspace, WORKSPACE_SCHEMA, 'workspace');
  if (payload.pipeline !== undefined && !Array.isArray(payload.pipeline)) {
    throw new Error('pipeline must be an array of filter steps.');
  }
  if (payload.columnPipelines !== undefined && !isRecord(payload.columnPipelines)) {
    throw new Error('columnPipelines must be an object.');
  }
  return payload as unknown as SettingsPayload;
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
      const newConfig = validateSettingsPayload(JSON.parse(jsonString));

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
        limits: { ...State.config.limits, ...(incomingConfig.limits || {}) },
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
        settingsVersion: 5,
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
      State.clearPipelineHistory();
      this.applyWorkspace(workspace);
      State.ensureAnalysisConfig();
      return true;
    } catch (e) {
      alert(`Error loading settings: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }
};
