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

export interface AppConfig {
  graph: GraphSettings;
  pipelineScope: boolean;
  columnPipelines: Record<string, FilterStep[]>;
  pipeline: FilterStep[];
  defaults: FilterDefaults;
  colors: ColorConfig;
  limits: AppLimits;
  displayCalibration: DisplayCalibration;
  mathDefinitions?: MathDefinition[];
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
