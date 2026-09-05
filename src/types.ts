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
  | 'notchFFT'
  | 'firLowPass'
  | 'firHighPass'
  | 'firBandPass'
  | 'firBandStop'
  | 'butterworthLowPass'
  | 'butterworthHighPass'
  | 'butterworthBandPass'
  | 'iirNotch'
  | 'iirComb'
  | 'hampel'
  | 'waveletDenoise'
  | 'baselineSubtract'
  | 'timeGate'
  | 'artifactBlank'
  | 'referenceSubtract';

export type RegionBindingMode = 'region-marker' | 'marker-pair' | 'times' | 'indices' | 'selection';

export type SourceMode = 'raw' | 'filtered';

export type ViewMode = 'time' | 'fft' | 'spectrogram';

export type FftWindowType = 'hann' | 'hamming' | 'blackman' | 'blackman-harris' | 'flattop' | 'kaiser' | 'rectangular';

export type FftDetrend = 'none' | 'removeMean' | 'linear';

export type FftZeroPad = 'none' | 'nextPow2' | 'factor';

export type FftView = 'magnitude' | 'phase' | 'both';

export type FftSource = 'auto' | 'raw' | 'filtered';

export type MeasurementPreset = 'general' | 'power' | 'pulsed';

export type TriggerType = 'level' | 'edge' | 'pulse' | 'runt';

export type TriggerDirection = 'rising' | 'falling' | 'either';

export type TriggerSource = 'raw' | 'filtered' | 'math' | 'derivative';

export type AxisFormat = 'decimal' | 'scientific' | 'integer' | 'currency' | 'percentage' | 'datetime' | 'engineering';

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
  startOffset?: number;
  autoOffset?: boolean;
  autoOffsetPoints?: number;
  applyStart?: boolean;
  applyEnd?: boolean;
  cutoffFreq?: number;
  centerFreq?: number;
  bandwidth?: number;
  transitionWidth?: number;
  passbandRippleDb?: number;
  stopbandAttenuationDb?: number;
  slope?: number;
  order?: number;
  processingMode?: 'causal' | 'zero-phase';
  harmonicCount?: number;
  thresholdSigma?: number;
  waveletLevels?: number;
  waveletThreshold?: number;
  regionMode?: RegionBindingMode;
  regionMarker?: string;
  startMarker?: string;
  endMarker?: string;
  regionStartTime?: number;
  regionEndTime?: number;
  regionStartIndex?: number;
  regionEndIndex?: number;
  baselineEstimator?: 'mean' | 'median' | 'trimmed-mean';
  artifactMode?: 'missing' | 'interpolate';
  referenceColumnId?: string;
  referenceScale?: number;
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
  showResidual: boolean;
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
  lowPassFFT: { cutoffFreq: number; slope: number };
  highPassFFT: { cutoffFreq: number; slope: number };
  notchFFT: { centerFreq: number; bandwidth: number };
  firLowPass: {
    cutoffFreq: number;
    transitionWidth: number;
    passbandRippleDb: number;
    stopbandAttenuationDb: number;
    processingMode: 'causal' | 'zero-phase';
  };
  firHighPass: {
    cutoffFreq: number;
    transitionWidth: number;
    passbandRippleDb: number;
    stopbandAttenuationDb: number;
    processingMode: 'causal' | 'zero-phase';
  };
  firBandPass: {
    centerFreq: number;
    bandwidth: number;
    transitionWidth: number;
    passbandRippleDb: number;
    stopbandAttenuationDb: number;
    processingMode: 'causal' | 'zero-phase';
  };
  firBandStop: {
    centerFreq: number;
    bandwidth: number;
    transitionWidth: number;
    passbandRippleDb: number;
    stopbandAttenuationDb: number;
    processingMode: 'causal' | 'zero-phase';
  };
  butterworthLowPass: { cutoffFreq: number; order: number; processingMode: 'causal' | 'zero-phase' };
  butterworthHighPass: { cutoffFreq: number; order: number; processingMode: 'causal' | 'zero-phase' };
  butterworthBandPass: {
    centerFreq: number;
    bandwidth: number;
    order: number;
    processingMode: 'causal' | 'zero-phase';
  };
  iirNotch: { centerFreq: number; bandwidth: number; processingMode: 'causal' | 'zero-phase' };
  iirComb: {
    centerFreq: number;
    bandwidth: number;
    harmonicCount: number;
    processingMode: 'causal' | 'zero-phase';
  };
  hampel: { windowSize: number; thresholdSigma: number };
  waveletDenoise: { waveletLevels: number; waveletThreshold?: number };
  baselineSubtract: {
    regionMode: RegionBindingMode;
    regionMarker: string;
    startMarker: string;
    endMarker: string;
    regionStartTime: number;
    regionEndTime: number;
    regionStartIndex: number;
    regionEndIndex: number;
    baselineEstimator: 'mean' | 'median' | 'trimmed-mean';
  };
  timeGate: {
    regionMode: RegionBindingMode;
    regionMarker: string;
    startMarker: string;
    endMarker: string;
    regionStartTime: number;
    regionEndTime: number;
    regionStartIndex: number;
    regionEndIndex: number;
  };
  artifactBlank: {
    regionMode: RegionBindingMode;
    regionMarker: string;
    startMarker: string;
    endMarker: string;
    regionStartTime: number;
    regionEndTime: number;
    regionStartIndex: number;
    regionEndIndex: number;
    artifactMode: 'missing' | 'interpolate';
  };
  referenceSubtract: { referenceColumnId: string; referenceScale: number };
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
  minSeparation: number;
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
  rawQuality: Uint16Array;
  filteredY: number[] | null;
  filteredQuality: Uint16Array | null;
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
  enbwHz: number;
  windowPower: number;
  sampleCount: number;
  fftLength: number;
  resampled: boolean;
  medianDt?: number;
  /** Half-width of the analysis window's spectral main lobe, in unpadded record bins. */
  mainLobeHalfWidthBins?: number;
}

export interface SpectrumResult {
  freq: number[];
  magnitude: number[];
  linearMagnitude: number[];
  psd: number[];
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

export type QualityMasks = Record<string, Uint16Array>;

export interface DataSourceRecord {
  name: string;
  text: string;
  bytes: Uint8Array;
  size: number;
  lastModified: number | null;
}

export interface DataCellChange {
  rowIndex: number;
  columnId: string;
  before: CsvValue;
  after: CsvValue;
  qualityBefore: number;
  qualityAfter: number;
}

export interface DataRepairRecord {
  id: string;
  label: string;
  timestamp: string;
  changes: DataCellChange[];
}

export interface PipelineStepReport {
  stepId: string;
  type: FilterType;
  changedSamples: number;
  totalSamples: number;
  warnings?: string[];
  effectiveParameters?: Record<string, string | number | boolean | null>;
}

export interface SerializedFirDesign {
  stepId: string;
  sampleRate: number;
  specificationKey: string;
  coefficients: number[];
  processingMode: 'causal' | 'zero-phase';
}

export interface AppData {
  original: ReadonlyArray<Readonly<CsvRow>>;
  raw: CsvRow[];
  originalColumns: Record<string, Float64Array>;
  columns: Record<string, Float64Array>;
  headers: string[];
  processed: number[];
  processedQuality: Uint16Array;
  pipelineReport: PipelineStepReport[];
  firDesigns: SerializedFirDesign[];
  timeColumn: string | null;
  dataColumn: string | null;
  originalQuality: QualityMasks;
  quality: QualityMasks;
  repairHistory: DataRepairRecord[];
  repairCursor: number;
  source: DataSourceRecord | null;
  /** Monotonic counter bumped whenever the working grid is replaced, appended to or repaired. */
  generation: number;
}

export interface SeriesPair {
  rawX: number[];
  rawY: number[];
}

export interface ColumnSeries {
  columnId: string;
  rawY: number[];
  rawQuality: Uint16Array;
  filteredY: number[] | null;
  filteredQuality: Uint16Array | null;
  time: number[];
  isMath: boolean;
}

export interface PlotSeries {
  columnId: string;
  rawY: number[];
  rawQuality?: Uint16Array;
  filteredY: number[] | null;
  filteredQuality?: Uint16Array | null;
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
  rawQuality?: Uint16Array;
  filteredQuality?: Uint16Array | null;
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
  /** Non-blocking notes, e.g. the number of NaN samples a guard or a missing input produced. */
  warnings?: string[];
}

export interface MathResult {
  values: number[];
  time: number[];
  /** Union of the input columns' quality flags (shifted with any applied x-offset) plus Processed. */
  quality?: Uint16Array;
  /** Set when evaluation failed; `values` is empty in that case. */
  error?: string;
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
