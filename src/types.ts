export type ThemeName = 'light' | 'dark';

export type FilterType =
  | 'nullFilter'
  | 'movingAverage'
  | 'savitzkyGolay'
  | 'median'
  | 'iir'
  | 'gaussian'
  | 'startStopNorm'
  | 'lowPassFFT'
  | 'highPassFFT'
  | 'notchFFT';

export type SourceMode = 'raw' | 'filtered';

export type ViewMode = 'time' | 'fft' | 'spectrogram';

export type FftWindowType =
  | 'hann'
  | 'hamming'
  | 'blackman'
  | 'blackman-harris'
  | 'flattop'
  | 'kaiser'
  | 'rectangular';

export type FftDetrend = 'none' | 'removeMean' | 'linear';

export type FftZeroPad = 'none' | 'nextPow2' | 'factor';

export type FftView = 'magnitude' | 'phase' | 'both';

export type FftSource = 'auto' | 'raw' | 'filtered';

export type MeasurementPreset = 'general' | 'power' | 'pulsed';

export type TriggerType = 'level' | 'edge' | 'pulse' | 'runt';

export type TriggerDirection = 'rising' | 'falling' | 'either';

export type TriggerSource = 'raw' | 'filtered' | 'math' | 'derivative';

export type AxisFormat =
  | 'decimal'
  | 'scientific'
  | 'integer'
  | 'currency'
  | 'percentage'
  | 'datetime'
  | 'engineering';

export interface FilterStep {
  id: string;
  type: FilterType;
  enabled: boolean;
  windowSize?: number;
  polyOrder?: number;
  iterations?: number;
  alpha?: number;
  sigma?: number;
  kernelSize?: number;
  startLength?: number;
  endLength?: number;
  decayLength?: number;
  startOffset?: number;
  autoOffset?: boolean;
  autoOffsetPoints?: number;
  applyStart?: boolean;
  applyEnd?: boolean;
  cutoffFreq?: number;
  centerFreq?: number;
  bandwidth?: number;
  slope?: number;
  qFactor?: number;
}

export interface GraphSettings {
  title: string;
  xAxisTitle: string;
  yAxisTitle: string;
  xAxisFormat: AxisFormat;
  yAxisFormat: AxisFormat;
  currencySymbol: string;
  significantFigures: number;
  logScaleY: boolean;
  showDifferential: boolean;
  showGrid: boolean;
  showFreqDomain: boolean;
  viewMode?: ViewMode;
  showRaw: boolean;
  rawOpacity: number;
  enableDownsampling: boolean;
  maxDisplayPoints: number;
  useScientificNotation?: boolean;
}

export interface ThemeColors {
  raw: string;
  filtered: string;
  diffRaw: string;
  diffFilt: string;
  transfer: string;
}

export interface ColorConfig {
  light: ThemeColors;
  dark: ThemeColors;
  raw?: string;
  filtered?: string;
  diffRaw?: string;
  diffFilt?: string;
  transfer?: string;
}

export interface FilterDefaults {
  movingAverage: { windowSize: number };
  savitzkyGolay: { windowSize: number; polyOrder: number; iterations: number };
  median: { windowSize: number };
  iir: { alpha: number };
  gaussian: { sigma: number; kernelSize: number };
  startStopNorm: {
    startLength: number;
    endLength: number;
    startOffset: number;
    autoOffset: boolean;
    autoOffsetPoints: number;
    applyStart: boolean;
    applyEnd: boolean;
  };
  lowPassFFT: { cutoffFreq: number; slope: number; qFactor: number };
  highPassFFT: { cutoffFreq: number; slope: number; qFactor: number };
  notchFFT: { centerFreq: number; bandwidth: number };
}

export interface AppLimits {
  previewLines: number;
  maxGridRows: number;
}

export interface DisplayCalibration {
  pixelsPerCm: number;
}

export interface MathVariable {
  columnId: string;
  symbol: string;
  sourceMode?: SourceMode;
  applyXOffset?: boolean;
}

export interface MathDefinition {
  name: string;
  expression: string;
  variables: MathVariable[];
}

export interface AnalysisSelection {
  xMin: number | null;
  xMax: number | null;
  i0: number | null;
  i1: number | null;
}

export interface AnalysisEvent {
  index: number | null;
  time: number | null;
  type: string;
  metadata: Record<string, unknown>;
}

export interface AnalysisTrigger {
  enabled: boolean;
  type: TriggerType;
  direction: TriggerDirection;
  threshold: number;
  hysteresis: number;
  slopeThreshold: number;
  minWidth: number;
  maxWidth: number;
  highThreshold: number;
  lowThreshold: number;
  source: TriggerSource;
  selectionOnly: boolean;
}

export interface AnalysisConfig {
  enabled: boolean;
  selectionOnly: boolean;
  impedanceOhms: number;
  fftWindow: FftWindowType;
  fftZeroPad: FftZeroPad;
  fftZeroPadFactor: number;
  fftDetrend: FftDetrend;
  fftView: FftView;
  fftPeakCount: number;
  fftPeakProminence: number;
  fftShowHarmonics: boolean;
  fftHarmonicCount: number;
  fftHarmonicFundamental: number | null;
  fftSource: FftSource;
  spectrogramWindow: FftWindowType;
  spectrogramSize: number;
  spectrogramOverlap: number;
  spectrogramMaxPoints: number;
  spectrogramFreqMin: number;
  spectrogramFreqMax: number | null;
  spectrogramSource: FftSource;
  showEvents: boolean;
  systemSelectionOnly: boolean;
  systemMaxLagSeconds: number | null;
  systemInput: string;
  systemOutput: string;
  measurementPreset: MeasurementPreset;
  trigger: AnalysisTrigger;
}

export interface AnalysisUiState {
  selection: AnalysisSelection | null;
  events: AnalysisEvent[];
  activeEventIndex: number;
}

export interface AnalysisSeries {
  rawX: number[];
  rawY: number[];
  filteredY: number[] | null;
  seriesName: string;
  columnId?: string;
  isMath: boolean;
}

export interface SpectrumMeta {
  fs: number;
  deltaF: number;
  nyquist: number;
  coherentGain: number;
  enbw: number;
  medianDt?: number;
}

export interface SpectrumResult {
  freq: number[];
  magnitude: number[];
  linearMagnitude: number[];
  phase: number[];
  warnings: string[];
  meta: SpectrumMeta;
  re: Float64Array;
  im: Float64Array;
  length: number;
}

export interface AppConfig {
  settingsVersion?: number;
  graph: GraphSettings;
  pipelineScope: boolean;
  columnPipelines: Record<string, FilterStep[]>;
  pipeline: FilterStep[];
  defaults: FilterDefaults;
  colors: ColorConfig;
  limits: AppLimits;
  displayCalibration: DisplayCalibration;
  mathDefinitions?: MathDefinition[];
  analysis: AnalysisConfig;
}

export interface MultiView {
  id: string;
  name: string;
  activeColumnIds: string[];
}

export interface ComposerTrace {
  columnId: string;
  yOffset?: number;
}

export interface ComposerView {
  traces: ComposerTrace[];
}

export interface ComposerState {
  views: Record<string, ComposerView>;
}

export interface TraceConfig {
  xOffset: number;
}

export interface ViewRange {
  x: [number, number] | null;
  y: [number, number] | null;
}

export interface UiState {
  selectedStepId: string | null;
  activeMultiViewId: string | null;
  viewRanges: Record<string, ViewRange | null>;
  analysis: AnalysisUiState;
}

export type CsvValue = string | number | boolean | null | undefined;

export type CsvRow = Record<string, CsvValue>;

export interface AppData {
  raw: CsvRow[];
  headers: string[];
  processed: number[];
  timeColumn: string | null;
  dataColumn: string | null;
}

export interface SeriesPair {
  rawX: number[];
  rawY: number[];
}

export interface ColumnSeries {
  columnId: string;
  rawY: number[];
  filteredY: number[] | null;
  time: number[];
  isMath: boolean;
}

export interface PlotSeries {
  columnId: string;
  rawY: number[];
  filteredY: number[] | null;
  time?: number[];
  isMath?: boolean;
}

export interface WorkspaceSnapshot {
  multiViews?: MultiView[];
  composer?: ComposerState;
  traceConfigs?: Record<string, TraceConfig>;
  viewRanges?: Record<string, ViewRange | null>;
  activeMultiViewId?: string | null;
  dataColumn?: string | null;
}

export interface SettingsPayload extends AppConfig {
  workspace?: WorkspaceSnapshot;
}

export interface AxisFormatOptions {
  tickformat?: string;
  exponentformat?: string;
  showexponent?: string;
  tickprefix?: string;
  type?: string;
  hoverformat?: string;
}

export interface PlotStyling {
  paperBg: string;
  plotBg: string;
  fontColor: string;
  gridColor: string;
}

export interface RenderOptions {
  isMath?: boolean;
  seriesName?: string;
}

export interface ImageExportOptions {
  theme?: ThemeName | 'current' | string;
  transparent?: boolean;
  widthCm?: number;
  heightCm?: number;
  useWindowSize?: boolean;
}

export interface MathValidation {
  ok: boolean;
  errors: string[];
}

export interface MathResult {
  values: number[];
  time: number[];
}

export interface ResolveMode {
  sourceMode?: SourceMode;
  applyXOffset?: boolean;
}

export interface ComposerAlignment {
  adjustedRawY: number[];
  adjustedFilteredY: number[];
  xOffset: number;
  yOffset: number;
}

export interface FrequencyAxis {
  axis: number[];
  binWidth: number;
  nBins: number;
}
