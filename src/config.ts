import type { AppConfig } from './types';

export const Config: AppConfig = {
  settingsVersion: 5,
  graph: {
    title: 'Signal Analysis',
    xAxisTitle: 'Time',
    yAxisTitle: 'Amplitude',
    xAxisFormat: 'scientific',
    yAxisFormat: 'scientific',
    currencySymbol: '£',
    significantFigures: 3,
    logScaleY: false,
    showDifferential: false,
    showResidual: false,
    showGrid: true,
    showFreqDomain: false,
    viewMode: 'time',
    showRaw: true,
    rawOpacity: 0.5,
    enableDownsampling: false,
    maxDisplayPoints: 20000
  },
  pipelineScope: true,
  columnPipelines: {},
  pipeline: [{ id: 'null-filter', type: 'nullFilter', enabled: true }],
  defaults: {
    movingAverage: { windowSize: 5 },
    savitzkyGolay: { windowSize: 21, polyOrder: 2, iterations: 1 },
    median: { windowSize: 5 },
    iir: { alpha: 0.1 },
    gaussian: { sigma: 1.0, kernelSize: 5 },
    startStopNorm: {
      startLength: 50,
      endLength: 50,
      startOffset: 0,
      autoOffset: false,
      autoOffsetPoints: 200,
      applyStart: true,
      applyEnd: true
    },
    lowPassFFT: { cutoffFreq: 100000000, slope: 12 },
    highPassFFT: { cutoffFreq: 100000000, slope: 12 },
    notchFFT: { centerFreq: 100000000, bandwidth: 1000000 },
    firLowPass: {
      cutoffFreq: 100000000,
      transitionWidth: 20000000,
      passbandRippleDb: 0.1,
      stopbandAttenuationDb: 80,
      processingMode: 'zero-phase'
    },
    firHighPass: {
      cutoffFreq: 1000000,
      transitionWidth: 200000,
      passbandRippleDb: 0.1,
      stopbandAttenuationDb: 80,
      processingMode: 'zero-phase'
    },
    firBandPass: {
      centerFreq: 10000000,
      bandwidth: 5000000,
      transitionWidth: 1000000,
      passbandRippleDb: 0.1,
      stopbandAttenuationDb: 80,
      processingMode: 'zero-phase'
    },
    firBandStop: {
      centerFreq: 50000000,
      bandwidth: 1000000,
      transitionWidth: 500000,
      passbandRippleDb: 0.1,
      stopbandAttenuationDb: 80,
      processingMode: 'zero-phase'
    },
    butterworthLowPass: { cutoffFreq: 100000000, order: 4, processingMode: 'zero-phase' },
    butterworthHighPass: { cutoffFreq: 1000000, order: 4, processingMode: 'zero-phase' },
    butterworthBandPass: {
      centerFreq: 10000000,
      bandwidth: 5000000,
      order: 4,
      processingMode: 'zero-phase'
    },
    iirNotch: { centerFreq: 50000000, bandwidth: 1000000, processingMode: 'zero-phase' },
    iirComb: {
      centerFreq: 50,
      bandwidth: 2,
      harmonicCount: 10,
      processingMode: 'zero-phase'
    },
    hampel: { windowSize: 7, thresholdSigma: 3 },
    waveletDenoise: { waveletLevels: 4 },
    baselineSubtract: {
      regionMode: 'selection',
      regionMarker: '',
      startMarker: '',
      endMarker: '',
      regionStartTime: 0,
      regionEndTime: 1,
      regionStartIndex: 0,
      regionEndIndex: 1,
      baselineEstimator: 'median'
    },
    timeGate: {
      regionMode: 'selection',
      regionMarker: '',
      startMarker: '',
      endMarker: '',
      regionStartTime: 0,
      regionEndTime: 1,
      regionStartIndex: 0,
      regionEndIndex: 1
    },
    artifactBlank: {
      regionMode: 'selection',
      regionMarker: '',
      startMarker: '',
      endMarker: '',
      regionStartTime: 0,
      regionEndTime: 1,
      regionStartIndex: 0,
      regionEndIndex: 1,
      artifactMode: 'missing'
    },
    referenceSubtract: { referenceColumnId: '', referenceScale: 1 }
  },
  colors: {
    light: {
      raw: '#888888',
      filtered: '#0047AB',
      diffRaw: '#888888',
      diffFilt: '#0047AB',
      transfer: '#00bcd4'
    },
    dark: {
      raw: '#888888',
      filtered: '#ff9800',
      diffRaw: '#888888',
      diffFilt: '#ff9800',
      transfer: '#00bcd4'
    }
  },
  limits: {
    previewLines: 100,
    maxGridRows: 1000
  },
  displayCalibration: {
    pixelsPerCm: 96 / 2.54
  },
  analysis: {
    enabled: true,
    selectionOnly: true,
    impedanceOhms: 50,
    fftWindow: 'hann',
    fftZeroPad: 'nextPow2',
    fftZeroPadFactor: 2,
    fftDetrend: 'removeMean',
    fftView: 'magnitude',
    fftPeakCount: 5,
    fftPeakProminence: 0.02,
    fftShowHarmonics: false,
    fftHarmonicCount: 5,
    fftHarmonicFundamental: null,
    fftSource: 'auto',
    spectrogramWindow: 'hann',
    spectrogramSize: 512,
    spectrogramOverlap: 0.5,
    spectrogramMaxPoints: 40000,
    spectrogramFreqMin: 0,
    spectrogramFreqMax: null,
    spectrogramSource: 'auto',
    showEvents: true,
    systemSelectionOnly: true,
    systemMaxLagSeconds: null,
    systemInput: 'auto',
    systemOutput: 'auto',
    measurementPreset: 'general',
    trigger: {
      enabled: true,
      type: 'level',
      direction: 'rising',
      threshold: 0,
      hysteresis: 0,
      slopeThreshold: 0,
      minWidth: 0,
      maxWidth: 1,
      minSeparation: 0,
      highThreshold: 1,
      lowThreshold: 0,
      source: 'raw',
      selectionOnly: true
    }
  }
};
