import type { FilterStep, FilterType, PipelineStepReport, SerializedFirDesign } from '../types';
import { QualityFlag } from '../data/quality';
import { FFT } from './fft';
import {
  applyFir,
  computeFirResponse,
  designKaiserFir,
  estimateKaiserFirTapCount,
  FIR_UNIFORM_TOLERANCE,
  type FirDesign,
  type FirSpecification
} from './fir';
import {
  applyIirCascade,
  computeFilterResponse,
  designButterworth,
  designButterworthBandPass,
  designCombNotch,
  designNotch,
  iirPaddingPlan,
  type Biquad,
  type FilterResponse
} from './iir';
import { hampelDeglitch, waveletDenoiseHaar } from './noise';
import {
  analyzeTimebase,
  estimateSampleRate,
  frequencyBinWidth,
  interpolateLinearToTimebase,
  resampleLinear
} from './sampling';

type GainKind = FilterStep['type'] | 'lowpass' | 'highpass' | 'notch';
const savitzkyGolayWeightCache = new Map<string, number[]>();
const firFilterTypes = new Set<FilterType>(['firLowPass', 'firHighPass', 'firBandPass', 'firBandStop']);
const supportedFilterTypes = new Set<string>([
  'nullFilter',
  'movingAverage',
  'savitzkyGolay',
  'median',
  'iir',
  'gaussian',
  'startStopNorm',
  'lowPassFFT',
  'highPassFFT',
  'notchFFT',
  'firLowPass',
  'firHighPass',
  'firBandPass',
  'firBandStop',
  'butterworthLowPass',
  'butterworthHighPass',
  'butterworthBandPass',
  'iirNotch',
  'iirComb',
  'hampel',
  'waveletDenoise'
]);

const parameterKeys: Record<FilterType, ReadonlyArray<keyof FilterStep>> = {
  nullFilter: [],
  movingAverage: ['windowSize'],
  savitzkyGolay: ['windowSize', 'polyOrder', 'iterations'],
  median: ['windowSize'],
  iir: ['alpha'],
  gaussian: ['sigma', 'kernelSize'],
  startStopNorm: [
    'startLength',
    'endLength',
    'startOffset',
    'autoOffset',
    'autoOffsetPoints',
    'applyStart',
    'applyEnd'
  ],
  lowPassFFT: ['cutoffFreq', 'slope'],
  highPassFFT: ['cutoffFreq', 'slope'],
  notchFFT: ['centerFreq', 'bandwidth'],
  firLowPass: ['cutoffFreq', 'transitionWidth', 'passbandRippleDb', 'stopbandAttenuationDb', 'processingMode'],
  firHighPass: ['cutoffFreq', 'transitionWidth', 'passbandRippleDb', 'stopbandAttenuationDb', 'processingMode'],
  firBandPass: [
    'centerFreq',
    'bandwidth',
    'transitionWidth',
    'passbandRippleDb',
    'stopbandAttenuationDb',
    'processingMode'
  ],
  firBandStop: [
    'centerFreq',
    'bandwidth',
    'transitionWidth',
    'passbandRippleDb',
    'stopbandAttenuationDb',
    'processingMode'
  ],
  butterworthLowPass: ['cutoffFreq', 'order', 'processingMode'],
  butterworthHighPass: ['cutoffFreq', 'order', 'processingMode'],
  butterworthBandPass: ['centerFreq', 'bandwidth', 'order', 'processingMode'],
  iirNotch: ['centerFreq', 'bandwidth', 'processingMode'],
  iirComb: ['centerFreq', 'bandwidth', 'harmonicCount', 'processingMode'],
  hampel: ['windowSize', 'thresholdSigma'],
  waveletDenoise: ['waveletLevels', 'waveletThreshold']
};

function finiteParameter(
  value: number | undefined,
  name: string,
  minimum: number,
  maximum: number,
  required = true
): void {
  if (value === undefined) {
    if (required) throw new Error(`${name} is required.`);
    return;
  }
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be finite and between ${minimum} and ${maximum}.`);
  }
}

function integerParameter(value: number | undefined, name: string, minimum: number, maximum: number): void {
  finiteParameter(value, name, minimum, maximum);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
}

function booleanParameter(value: boolean | undefined, name: string, required = true): void {
  if (value === undefined) {
    if (required) throw new Error(`${name} is required.`);
    return;
  }
  if (typeof value !== 'boolean') throw new Error(`${name} must be boolean.`);
}

interface FrequencyRunPlan {
  ranges: Array<{ start: number; end: number }>;
  warnings: string[];
}

function frequencyRunPlan(data: ArrayLike<number>, timeArray: ArrayLike<number> | null | undefined): FrequencyRunPlan {
  const ranges: Array<{ start: number; end: number }> = [];
  const warnings: string[] = [];
  let cursor = 0;
  while (cursor < data.length) {
    if (!Number.isFinite(Number(data[cursor])) || !Number.isFinite(Number(timeArray?.[cursor]))) {
      const start = cursor;
      const reasons = new Set<string>();
      while (
        cursor < data.length &&
        (!Number.isFinite(Number(data[cursor])) || !Number.isFinite(Number(timeArray?.[cursor])))
      ) {
        if (!Number.isFinite(Number(data[cursor]))) reasons.add('signal');
        if (!Number.isFinite(Number(timeArray?.[cursor]))) reasons.add('timestamp');
        cursor += 1;
      }
      warnings.push(
        `Skipped ${start === cursor - 1 ? `index ${start}` : `indices ${start}–${cursor - 1}`} because ${[
          ...reasons
        ].join(' and ')} values are non-finite.`
      );
      continue;
    }

    const start = cursor;
    cursor += 1;
    while (
      cursor < data.length &&
      Number.isFinite(Number(data[cursor])) &&
      Number.isFinite(Number(timeArray?.[cursor]))
    ) {
      if (!(Number(timeArray?.[cursor]) > Number(timeArray?.[cursor - 1]))) {
        warnings.push(
          `Split the frequency-filter run before index ${cursor} because its timestamp is duplicate or decreasing.`
        );
        break;
      }
      cursor += 1;
    }
    if (cursor - start >= 2) {
      ranges.push({ start, end: cursor });
    } else {
      warnings.push(`Skipped index ${start} because it has no adjacent finite, increasing timestamp.`);
    }
  }
  return { ranges, warnings };
}

function analyzeFilterTimebase(step: FilterStep, time: ArrayLike<number>) {
  return analyzeTimebase(time, firFilterTypes.has(step.type) ? FIR_UNIFORM_TOLERANCE : 0.01);
}

/**
 * Writes `Processed | OR(inputQuality[index - leftReach .. index + rightReach])` for every index of
 * the run `[start, end)`. Uses one prefix count per flag bit present in the run so the cost is
 * O(bits × run length) regardless of the reach (recursive filters can reach thousands of samples).
 */
function applyReachMask(
  output: Uint16Array,
  inputQuality: ArrayLike<number>,
  start: number,
  end: number,
  leftReach: number,
  rightReach: number,
  baseFlag: number = QualityFlag.Processed
): void {
  const length = end - start;
  if (length <= 0) return;
  let union = 0;
  for (let index = start; index < end; index += 1) union |= inputQuality[index] || 0;
  for (let index = start; index < end; index += 1) output[index] = baseFlag;
  if (union === 0) return;
  const prefix = new Int32Array(length + 1);
  for (let bit = 1; bit <= union; bit <<= 1) {
    if (!(union & bit)) continue;
    for (let index = 0; index < length; index += 1) {
      prefix[index + 1] = prefix[index] + ((inputQuality[start + index] || 0) & bit ? 1 : 0);
    }
    for (let index = 0; index < length; index += 1) {
      const low = Math.max(0, index - leftReach);
      const high = Math.min(length - 1, index + rightReach);
      if (prefix[high + 1] - prefix[low] > 0) output[start + index] |= bit;
    }
  }
}

export function validateFilterStep(step: FilterStep, sampleRate?: number): void {
  if (!step || typeof step.id !== 'string' || !step.id || typeof step.type !== 'string') {
    throw new Error('Filter step is missing a valid id or type.');
  }
  if (!supportedFilterTypes.has(step.type)) throw new Error(`Unsupported filter type: ${step.type}.`);
  booleanParameter(step.enabled, `${step.type} enabled`);
  const allowedKeys = new Set<string>(['id', 'type', 'enabled', ...parameterKeys[step.type]]);
  const unexpected = Object.keys(step).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${step.type} contains unsupported parameter(s): ${unexpected.join(', ')}.`);
  }
  if (step.type === 'movingAverage') {
    integerParameter(step.windowSize, 'movingAverage windowSize', 1, 9999);
  }
  if (step.type === 'savitzkyGolay') {
    integerParameter(step.windowSize, 'savitzkyGolay windowSize', 3, 1001);
  }
  if (step.type === 'median') integerParameter(step.windowSize, 'median windowSize', 1, 501);
  // A Hampel window needs at least one neighbour on each side to form a median/MAD estimate; the
  // implementation always uses radius >= 1, so smaller requests would silently widen the window.
  if (step.type === 'hampel') integerParameter(step.windowSize, 'hampel windowSize', 3, 501);
  if (step.type === 'savitzkyGolay') {
    integerParameter(step.polyOrder, 'Savitzky-Golay polyOrder', 0, 10);
    if ((step.polyOrder || 0) >= (step.windowSize || 1)) {
      throw new Error('Savitzky-Golay polyOrder must be smaller than windowSize.');
    }
    integerParameter(step.iterations, 'Savitzky-Golay iterations', 1, 16);
  }
  if (step.type === 'iir') finiteParameter(step.alpha, 'One-pole IIR alpha', Number.EPSILON, 1);
  if (step.type === 'gaussian') {
    finiteParameter(step.sigma, 'Gaussian sigma', 1e-6, 100);
    integerParameter(step.kernelSize, 'Gaussian kernelSize', 3, 1001);
  }
  if (step.type === 'startStopNorm') {
    integerParameter(step.startLength, 'Start taper length', 0, 10_000_000);
    integerParameter(step.endLength, 'End taper length', 0, 10_000_000);
    finiteParameter(step.startOffset, 'Start offset', -Number.MAX_VALUE, Number.MAX_VALUE);
    integerParameter(step.autoOffsetPoints, 'Auto-offset sample count', 1, 10_000_000);
    booleanParameter(step.autoOffset, 'Start/stop autoOffset');
    booleanParameter(step.applyStart, 'Start/stop applyStart');
    booleanParameter(step.applyEnd, 'Start/stop applyEnd');
  }
  if (
    ['lowPassFFT', 'highPassFFT', 'firLowPass', 'firHighPass', 'butterworthLowPass', 'butterworthHighPass'].includes(
      step.type
    )
  ) {
    finiteParameter(step.cutoffFreq, `${step.type} cutoffFreq`, Number.EPSILON, Number.MAX_VALUE);
  }
  if (['notchFFT', 'firBandPass', 'firBandStop', 'butterworthBandPass', 'iirNotch', 'iirComb'].includes(step.type)) {
    finiteParameter(step.centerFreq, `${step.type} centerFreq`, Number.EPSILON, Number.MAX_VALUE);
    finiteParameter(step.bandwidth, `${step.type} bandwidth`, Number.EPSILON, Number.MAX_VALUE);
  }
  if (['firLowPass', 'firHighPass', 'firBandPass', 'firBandStop'].includes(step.type)) {
    finiteParameter(step.transitionWidth, `${step.type} transitionWidth`, Number.EPSILON, Number.MAX_VALUE);
    finiteParameter(step.passbandRippleDb, `${step.type} passbandRippleDb`, 0.001, 6);
    finiteParameter(step.stopbandAttenuationDb, `${step.type} stopbandAttenuationDb`, 20, 160);
  }
  if (step.type === 'lowPassFFT' || step.type === 'highPassFFT') {
    integerParameter(step.slope, `${step.type} slope`, 6, 96);
    if ((step.slope || 0) % 6 !== 0) throw new Error(`${step.type} slope must be a multiple of 6 dB/octave.`);
  }
  if (['butterworthLowPass', 'butterworthHighPass', 'butterworthBandPass'].includes(step.type)) {
    integerParameter(step.order, `${step.type} order`, 2, 12);
    if (step.type === 'butterworthBandPass' && (step.order || 4) % 2 !== 0) {
      throw new Error('Butterworth band-pass order must be even.');
    }
  }
  if (
    [
      'firLowPass',
      'firHighPass',
      'firBandPass',
      'firBandStop',
      'butterworthLowPass',
      'butterworthHighPass',
      'butterworthBandPass',
      'iirNotch',
      'iirComb'
    ].includes(step.type)
  ) {
    if (step.processingMode !== 'causal' && step.processingMode !== 'zero-phase') {
      throw new Error(`${step.type} processingMode must be "causal" or "zero-phase".`);
    }
  }
  if (step.type === 'iirComb') {
    integerParameter(step.harmonicCount, 'IIR comb harmonicCount', 1, 100);
  }
  if (step.type === 'hampel') {
    finiteParameter(step.thresholdSigma, 'Hampel thresholdSigma', 0.1, 20);
  }
  if (step.type === 'waveletDenoise') {
    integerParameter(step.waveletLevels, 'Wavelet levels', 1, 20);
    finiteParameter(step.waveletThreshold, 'Wavelet threshold', 0, Number.MAX_VALUE, false);
  }

  if (sampleRate !== undefined) {
    if (!Number.isFinite(sampleRate) || !(sampleRate > 0)) throw new Error('Sample rate must be finite and positive.');
    const nyquist = sampleRate / 2;
    const requireBelowNyquist = (frequency: number | undefined, label: string) => {
      if (!(Number(frequency) > 0 && Number(frequency) < nyquist)) {
        throw new Error(`${label} must be above 0 and below Nyquist (${nyquist} Hz).`);
      }
    };
    if (
      ['lowPassFFT', 'highPassFFT', 'firLowPass', 'firHighPass', 'butterworthLowPass', 'butterworthHighPass'].includes(
        step.type
      )
    ) {
      requireBelowNyquist(step.cutoffFreq, `${step.type} cutoffFreq`);
    }
    if (['notchFFT', 'firBandPass', 'firBandStop', 'butterworthBandPass', 'iirNotch'].includes(step.type)) {
      const lower = Number(step.centerFreq) - Number(step.bandwidth) / 2;
      const upper = Number(step.centerFreq) + Number(step.bandwidth) / 2;
      requireBelowNyquist(lower, `${step.type} lower edge`);
      requireBelowNyquist(upper, `${step.type} upper edge`);
      if (
        step.type === 'iirNotch' &&
        Number(step.bandwidth) >= 2 * Math.min(Number(step.centerFreq), nyquist - Number(step.centerFreq)) * 0.8
      ) {
        throw new Error('IIR notch bandwidth is too broad for stable two-edge digital calibration.');
      }
    }
    if (step.type === 'firLowPass') {
      requireBelowNyquist(Number(step.cutoffFreq) + Number(step.transitionWidth), 'FIR low-pass stopband edge');
    }
    if (step.type === 'firHighPass') {
      requireBelowNyquist(Number(step.cutoffFreq) - Number(step.transitionWidth), 'FIR high-pass stopband edge');
    }
    if (step.type === 'firBandPass' || step.type === 'firBandStop') {
      requireBelowNyquist(
        Number(step.centerFreq) - Number(step.bandwidth) / 2 - Number(step.transitionWidth),
        `${step.type} lower outer edge`
      );
      requireBelowNyquist(
        Number(step.centerFreq) + Number(step.bandwidth) / 2 + Number(step.transitionWidth),
        `${step.type} upper outer edge`
      );
    }
    if (step.type === 'iirComb') {
      const lower = Number(step.centerFreq) - Number(step.bandwidth) / 2;
      const upper = Number(step.centerFreq) * Number(step.harmonicCount) + Number(step.bandwidth) / 2;
      requireBelowNyquist(lower, 'IIR comb first lower edge');
      requireBelowNyquist(upper, 'IIR comb final upper edge');
      if (Number(step.bandwidth) >= Number(step.centerFreq)) {
        throw new Error('IIR comb bandwidth must be smaller than the harmonic spacing.');
      }
    }
  }
}

export const Filter = {
  applyPipeline(
    dataArray: ArrayLike<number> | null | undefined,
    timeArray: ArrayLike<number> | null | undefined,
    pipeline?: FilterStep[] | null
  ): number[] {
    if (!dataArray || dataArray.length === 0) return [];

    const normalizedPipeline =
      pipeline && pipeline.length > 0 ? pipeline : [{ id: 'null-filter', type: 'nullFilter' as const, enabled: true }];

    let currentData = Array.from(dataArray);
    normalizedPipeline.forEach((step) => {
      if (step.enabled === false) return;
      validateFilterStep(step);
      const processFiniteRuns = (processor: (run: number[], sampleRate: number) => number[]) =>
        this.mapFiniteRuns(currentData, (run, start, end) => {
          const runTime = timeArray ? Array.from(timeArray).slice(start, end) : null;
          return processor(run, estimateSampleRate(runTime));
        });
      const processFrequencyRuns = (processor: (run: number[], sampleRate: number) => number[]) =>
        this.mapFrequencyRuns(currentData, timeArray, (run, runTime) => {
          const timebase = analyzeFilterTimebase(step, runTime);
          validateFilterStep(step, timebase.sampleRate);
          if (timebase.uniform) return processor(run, timebase.sampleRate);
          if (
            step.processingMode === 'causal' &&
            ['firLowPass', 'firHighPass', 'firBandPass', 'firBandStop'].includes(step.type)
          ) {
            throw new Error(
              'Causal FIR filtering requires a uniform timebase; offline resampling would consume future samples.'
            );
          }
          const uniform = resampleLinear(runTime, [run], timebase.medianDt);
          const filtered = processor(uniform.values[0], 1 / (uniform.time[1] - uniform.time[0]));
          return interpolateLinearToTimebase(uniform.time, filtered, runTime);
        });

      switch (step.type) {
        case 'nullFilter':
          break;
        case 'movingAverage':
          currentData = processFiniteRuns((run) => this.movingAverage(run, step.windowSize));
          break;
        case 'savitzkyGolay': {
          const iters = Math.max(1, Math.min(16, step.iterations || 1));
          for (let i = 0; i < iters; i++) {
            currentData = processFiniteRuns((run) => this.savitzkyGolay(run, step.windowSize, step.polyOrder));
          }
          break;
        }
        case 'median':
          currentData = processFiniteRuns((run) => this.median(run, step.windowSize));
          break;
        case 'iir':
          currentData = processFiniteRuns((run) => this.iirLowPass(run, step.alpha));
          break;
        case 'gaussian':
          currentData = processFiniteRuns((run) => this.gaussian(run, step.sigma, step.kernelSize));
          break;
        case 'startStopNorm':
          currentData = this.startStopNorm(currentData, step);
          break;
        case 'lowPassFFT':
          currentData = processFrequencyRuns((run, sampleRate) =>
            this.applyFFTFilter(run, sampleRate, 'lowpass', step)
          );
          break;
        case 'highPassFFT':
          currentData = processFrequencyRuns((run, sampleRate) =>
            this.applyFFTFilter(run, sampleRate, 'highpass', step)
          );
          break;
        case 'notchFFT':
          currentData = processFrequencyRuns((run, sampleRate) => this.applyFFTFilter(run, sampleRate, 'notch', step));
          break;
        case 'firLowPass':
        case 'firHighPass':
        case 'firBandPass':
        case 'firBandStop':
          currentData = processFrequencyRuns((run, sampleRate) => {
            const design = this.designedFir(step, sampleRate);
            return applyFir(run, design.coefficients, step.processingMode as 'causal' | 'zero-phase');
          });
          break;
        case 'butterworthLowPass':
        case 'butterworthHighPass':
        case 'butterworthBandPass':
        case 'iirNotch':
        case 'iirComb':
          currentData = processFrequencyRuns((run, sampleRate) =>
            applyIirCascade(run, this.designedIirSections(step, sampleRate), step.processingMode || 'zero-phase')
          );
          break;
        case 'hampel':
          currentData = processFiniteRuns(
            (run) => hampelDeglitch(run, Math.floor((step.windowSize || 7) / 2), step.thresholdSigma || 3).values
          );
          break;
        case 'waveletDenoise':
          currentData = processFiniteRuns(
            (run) =>
              waveletDenoiseHaar(run, {
                levels: step.waveletLevels || 4,
                threshold: step.waveletThreshold
              }).values
          );
          break;
      }
    });

    return currentData;
  },

  mapFiniteRuns(data: number[], processor: (run: number[], start: number, end: number) => number[]): number[] {
    const output = data.slice();
    let start = 0;
    while (start < data.length) {
      while (start < data.length && !Number.isFinite(data[start])) start += 1;
      if (start >= data.length) break;
      let end = start + 1;
      while (end < data.length && Number.isFinite(data[end])) end += 1;
      const processed = processor(data.slice(start, end), start, end);
      for (let index = 0; index < end - start; index += 1) {
        output[start + index] = processed[index] ?? Number.NaN;
      }
      start = end;
    }
    return output;
  },

  mapFrequencyRuns(
    data: number[],
    timeArray: ArrayLike<number> | null | undefined,
    processor: (run: number[], time: number[], start: number, end: number) => number[]
  ): number[] {
    const output = data.slice();
    const time = timeArray ? Array.from(timeArray) : [];
    const plan = frequencyRunPlan(data, time);
    for (const { start, end } of plan.ranges) {
      const processed = processor(data.slice(start, end), time.slice(start, end), start, end);
      for (let index = 0; index < end - start; index += 1) {
        output[start + index] = processed[index] ?? Number.NaN;
      }
    }
    return output;
  },

  effectiveParameters(
    step: FilterStep,
    timeArray?: ArrayLike<number> | null,
    dataArray?: ArrayLike<number>
  ): Record<string, string | number | boolean | null> {
    if (['movingAverage', 'savitzkyGolay', 'median', 'hampel'].includes(step.type)) {
      let windowSize = Math.max(1, Math.round(step.windowSize || 1));
      if (windowSize % 2 === 0) windowSize += 1;
      return {
        windowSize,
        ...(step.type === 'savitzkyGolay' ? { polyOrder: step.polyOrder || 0, iterations: step.iterations || 1 } : {}),
        ...(step.type === 'hampel' ? { thresholdSigma: step.thresholdSigma || 3 } : {})
      };
    }
    if (step.type === 'gaussian') {
      let kernelSize = Math.max(3, Math.round(step.kernelSize ?? step.windowSize ?? 5));
      if (kernelSize % 2 === 0) kernelSize += 1;
      return { sigma: step.sigma || 1, kernelSize };
    }
    if (['firLowPass', 'firHighPass', 'firBandPass', 'firBandStop'].includes(step.type)) {
      const base = {
        processingMode: step.processingMode || 'zero-phase',
        boundaryMode:
          step.processingMode === 'causal' ? 'constant-first-sample prehistory' : 'endpoint-excluding reflection',
        transitionWidth: step.transitionWidth || 0,
        passbandRippleDb: step.passbandRippleDb || 0,
        stopbandAttenuationDb: step.stopbandAttenuationDb || 0,
        ...(step.type === 'firLowPass' || step.type === 'firHighPass'
          ? { cutoffFreq: step.cutoffFreq || 0 }
          : { centerFreq: step.centerFreq || 0, bandwidth: step.bandwidth || 0 })
      };
      if (!dataArray || !timeArray) return base;
      let designCount = 0;
      let tapCountMin = Infinity;
      let tapCountMax = 0;
      let kaiserBetaMax = 0;
      let causalDelaySecondsMax = 0;
      let achievedPassbandRippleDbMax = 0;
      let achievedStopbandAttenuationDbMin = Infinity;
      const time = Array.from(timeArray);
      for (const { start, end } of frequencyRunPlan(dataArray, timeArray).ranges) {
        const analysis = analyzeFilterTimebase(step, time.slice(start, end));
        const design = this.designedFir(step, analysis.sampleRate);
        designCount += 1;
        tapCountMin = Math.min(tapCountMin, design.tapCount);
        tapCountMax = Math.max(tapCountMax, design.tapCount);
        kaiserBetaMax = Math.max(kaiserBetaMax, design.beta);
        causalDelaySecondsMax = Math.max(causalDelaySecondsMax, design.delaySamples / design.specification.sampleRate);
        achievedPassbandRippleDbMax = Math.max(achievedPassbandRippleDbMax, design.achievedPassbandRippleDb);
        achievedStopbandAttenuationDbMin = Math.min(
          achievedStopbandAttenuationDbMin,
          design.achievedStopbandAttenuationDb
        );
      }
      if (designCount === 0) return base;
      return {
        ...base,
        tapCountMin,
        tapCountMax,
        kaiserBetaMax,
        causalDelaySecondsMax,
        achievedPassbandRippleDbMax,
        achievedStopbandAttenuationDbMin
      };
    }
    if (['butterworthLowPass', 'butterworthHighPass', 'butterworthBandPass'].includes(step.type)) {
      return {
        order: step.order || 4,
        processingMode: step.processingMode || 'zero-phase',
        // Butterworth edges are the -3 dB points of a single pass; the forward/backward pass squares
        // the magnitude, so the same edge frequencies sit at -6 dB in zero-phase mode.
        edgeGainDb: (step.processingMode || 'zero-phase') === 'zero-phase' ? -6.02 : -3.01,
        ...(step.type === 'butterworthBandPass'
          ? {
              centerFreq: step.centerFreq || 0,
              bandwidth: step.bandwidth || 0,
              lowerEdgeHz: (step.centerFreq || 0) - (step.bandwidth || 0) / 2,
              upperEdgeHz: (step.centerFreq || 0) + (step.bandwidth || 0) / 2
            }
          : { cutoffFreq: step.cutoffFreq || 0 })
      };
    }
    if (step.type === 'iirNotch' || step.type === 'iirComb') {
      return {
        processingMode: step.processingMode || 'zero-phase',
        centerFreq: step.centerFreq || 0,
        bandwidth: step.bandwidth || 0,
        lowerEdgeHz: (step.centerFreq || 0) - (step.bandwidth || 0) / 2,
        upperEdgeHz: (step.centerFreq || 0) + (step.bandwidth || 0) / 2,
        ...(step.type === 'iirComb'
          ? {
              harmonicCount: step.harmonicCount || 10,
              finalCenterHz: (step.centerFreq || 0) * (step.harmonicCount || 10),
              finalUpperEdgeHz: (step.centerFreq || 0) * (step.harmonicCount || 10) + (step.bandwidth || 0) / 2
            }
          : {})
      };
    }
    if (step.type === 'lowPassFFT' || step.type === 'highPassFFT') {
      return { cutoffFreq: step.cutoffFreq || 0, slope: step.slope || 12 };
    }
    if (step.type === 'notchFFT') {
      // `bandwidth` is the full-rejection width; a raised-cosine taper of the same half-width follows
      // on each side, so the -3 dB width is wider and the total affected width is twice the request.
      const bandwidth = step.bandwidth || 0;
      return {
        centerFreq: step.centerFreq || 0,
        bandwidth,
        rejectionBandwidthHz: bandwidth,
        minus3dBBandwidthHz: bandwidth * (1 + Math.acos(1 - Math.SQRT2) / Math.PI),
        affectedBandwidthHz: 2 * bandwidth
      };
    }
    if (step.type === 'iir') return { alpha: step.alpha || 0.1 };
    if (step.type === 'waveletDenoise') {
      const requestedLevels = step.waveletLevels || 4;
      let effectiveLevelsMin: number | null = null;
      if (dataArray) {
        let start = 0;
        while (start < dataArray.length) {
          while (start < dataArray.length && !Number.isFinite(Number(dataArray[start]))) start += 1;
          if (start >= dataArray.length) break;
          let end = start + 1;
          while (end < dataArray.length && Number.isFinite(Number(dataArray[end]))) end += 1;
          const runLength = end - start;
          if (runLength >= 2) {
            const maximum = Math.floor(Math.log2(2 ** Math.ceil(Math.log2(runLength))));
            const effective = Math.max(1, Math.min(maximum, requestedLevels));
            effectiveLevelsMin = effectiveLevelsMin === null ? effective : Math.min(effectiveLevelsMin, effective);
          }
          start = end;
        }
      }
      return {
        levels: requestedLevels,
        ...(effectiveLevelsMin !== null && effectiveLevelsMin !== requestedLevels
          ? { effectiveLevels: effectiveLevelsMin }
          : {}),
        threshold: step.waveletThreshold ?? null,
        thresholdRule: step.waveletThreshold === undefined ? 'per-level universal soft' : 'explicit soft'
      };
    }
    return {};
  },

  filterWarnings(
    step: FilterStep,
    timeArray: ArrayLike<number> | null | undefined,
    dataArray?: ArrayLike<number>
  ): string[] {
    const warnings: string[] = [];
    const windowSize = step.type === 'gaussian' ? (step.kernelSize ?? step.windowSize) : step.windowSize;
    if (windowSize !== undefined && Math.round(windowSize) % 2 === 0) {
      warnings.push(`Even window ${windowSize} uses effective odd window ${Math.round(windowSize) + 1}.`);
    }
    const frequencyTypes = new Set([
      'lowPassFFT',
      'highPassFFT',
      'notchFFT',
      'firLowPass',
      'firHighPass',
      'firBandPass',
      'firBandStop',
      'butterworthLowPass',
      'butterworthHighPass',
      'butterworthBandPass',
      'iirNotch',
      'iirComb'
    ]);
    if (frequencyTypes.has(step.type)) {
      if (dataArray) {
        const plan = frequencyRunPlan(dataArray, timeArray);
        const time = Array.from(timeArray || []);
        warnings.push(...plan.warnings);
        for (const { start, end } of plan.ranges) {
          const analysis = analyzeFilterTimebase(step, time.slice(start, end));
          if (!analysis.uniform) {
            warnings.push(`Resampled indices ${start}–${end - 1} uniformly for this frequency-selective step.`);
          }
          if (['firLowPass', 'firHighPass', 'firBandPass', 'firBandStop'].includes(step.type)) {
            const design = this.designedFir(step, analysis.sampleRate);
            if (!analysis.uniform) {
              warnings.push(
                `FIR run ${start}–${end - 1} uses offline resampling; the complete operation is time-varying and has no single transfer function.`
              );
            }
            if (step.processingMode === 'causal') {
              warnings.push(
                `Causal FIR run ${start}–${end - 1} assumes ${design.tapCount - 1} samples of constant prehistory equal to its first value.`
              );
            }
            if (end - start <= design.delaySamples * 2) {
              warnings.push(
                `FIR run ${start}–${end - 1} is no longer than ${design.tapCount} taps; every output uses boundary extension.`
              );
            }
          }
          if (
            ['butterworthLowPass', 'butterworthHighPass', 'butterworthBandPass', 'iirNotch', 'iirComb'].includes(
              step.type
            )
          ) {
            const sections = this.designedIirSections(step, analysis.sampleRate);
            const plan = iirPaddingPlan(sections, end - start);
            if (step.processingMode === 'causal') {
              warnings.push(
                `Causal IIR run ${start}–${end - 1} starts from the DC steady state of its first sample; roughly the first ${plan.required} samples contain the start-up transient.`
              );
            } else if (plan.truncated) {
              warnings.push(
                `Zero-phase IIR run ${start}–${end - 1} (${end - start} samples) is shorter than the ${plan.required}-sample settling padding the poles require (used ${plan.effective}); samples near both ends may carry residual transients.`
              );
            }
          }
        }
      } else if (!timeArray || timeArray.length < 2) {
        warnings.push('No finite, increasing timebase was available for this frequency-selective step.');
      }
    }
    return warnings;
  },

  propagateStepQuality(
    data: number[],
    inputQuality: Uint16Array,
    step: FilterStep,
    timeArray?: ArrayLike<number> | null
  ): Uint16Array {
    const output = inputQuality.slice();
    if (step.type === 'nullFilter' || step.enabled === false) return output;
    const localWindowTypes = new Set(['movingAverage', 'savitzkyGolay', 'median', 'gaussian', 'hampel']);
    let radius = 0;
    if (localWindowTypes.has(step.type)) {
      const size = step.type === 'gaussian' ? (step.kernelSize ?? step.windowSize ?? 5) : step.windowSize || 1;
      radius = Math.floor(Math.max(1, Math.round(size)) / 2);
      if (step.type === 'savitzkyGolay') radius *= step.iterations || 1;
    }
    if (step.type === 'startStopNorm') {
      let baselineMask = QualityFlag.None;
      if (step.autoOffset) {
        const sampleCount = Math.min(data.length, step.autoOffsetPoints || 1);
        for (let index = 0; index < sampleCount; index += 1) {
          if (Number.isFinite(data[index])) baselineMask |= inputQuality[index] || QualityFlag.None;
        }
      }
      for (let index = 0; index < data.length; index += 1) {
        if (Number.isFinite(data[index])) {
          output[index] = QualityFlag.Processed | baselineMask | (inputQuality[index] || QualityFlag.None);
        }
      }
      return output;
    }
    if (['firLowPass', 'firHighPass', 'firBandPass', 'firBandStop'].includes(step.type)) {
      const time = Array.from(timeArray || []);
      for (const { start, end } of frequencyRunPlan(data, timeArray).ranges) {
        const analysis = analyzeFilterTimebase(step, time.slice(start, end));
        const design = this.designedFir(step, analysis.sampleRate);
        if (!analysis.uniform) {
          let runMask = QualityFlag.Processed;
          for (let index = start; index < end; index += 1) runMask |= inputQuality[index] || QualityFlag.None;
          for (let index = start; index < end; index += 1) output[index] = runMask;
          continue;
        }
        const causal = step.processingMode === 'causal';
        const leftReach = causal ? design.tapCount - 1 : design.delaySamples;
        const rightReach = causal ? 0 : design.delaySamples;
        applyReachMask(output, inputQuality, start, end, leftReach, rightReach);
      }
      return output;
    }
    if (
      ['butterworthLowPass', 'butterworthHighPass', 'butterworthBandPass', 'iirNotch', 'iirComb'].includes(step.type)
    ) {
      // Recursive filters have an infinite impulse response, but it decays geometrically; the
      // footprint uses the same 1e-8 pole-aware settling length that sizes the zero-phase padding
      // (one-sided for causal, two-sided for forward/backward). Resampled runs remain whole-run.
      const time = Array.from(timeArray || []);
      for (const { start, end } of frequencyRunPlan(data, timeArray).ranges) {
        const analysis = analyzeFilterTimebase(step, time.slice(start, end));
        if (!analysis.uniform) {
          applyReachMask(output, inputQuality, start, end, end - start, end - start);
          continue;
        }
        const reach = iirPaddingPlan(this.designedIirSections(step, analysis.sampleRate), end - start).required;
        const causal = step.processingMode === 'causal';
        applyReachMask(output, inputQuality, start, end, reach, causal ? 0 : reach);
      }
      return output;
    }
    if (step.type === 'iir') {
      const alpha = Math.min(1, Math.max(Number.EPSILON, step.alpha ?? 0.1));
      const reach = alpha >= 1 ? 0 : Math.ceil(Math.log(1e-8) / Math.log(1 - alpha));
      let start = 0;
      while (start < data.length) {
        while (start < data.length && !Number.isFinite(data[start])) start += 1;
        if (start >= data.length) break;
        let end = start + 1;
        while (end < data.length && Number.isFinite(data[end])) end += 1;
        applyReachMask(output, inputQuality, start, end, reach, 0);
        start = end;
      }
      return output;
    }
    const frequencyTypes = new Set(['lowPassFFT', 'highPassFFT', 'notchFFT']);
    if (frequencyTypes.has(step.type)) {
      for (const { start, end } of frequencyRunPlan(data, timeArray).ranges) {
        let runMask = QualityFlag.Processed;
        for (let index = start; index < end; index += 1) {
          runMask |= inputQuality[index] || QualityFlag.None;
        }
        for (let index = start; index < end; index += 1) output[index] = runMask;
      }
      return output;
    }
    let start = 0;
    while (start < data.length) {
      while (start < data.length && !Number.isFinite(data[start])) start += 1;
      if (start >= data.length) break;
      let end = start + 1;
      while (end < data.length && Number.isFinite(data[end])) end += 1;
      if (localWindowTypes.has(step.type)) {
        for (let index = start; index < end; index += 1) {
          let mask = QualityFlag.Processed;
          for (
            let sourceIndex = Math.max(start, index - radius);
            sourceIndex <= Math.min(end - 1, index + radius);
            sourceIndex += 1
          ) {
            mask |= inputQuality[sourceIndex] || QualityFlag.None;
          }
          output[index] = mask;
        }
      } else {
        let runMask = QualityFlag.Processed;
        for (let index = start; index < end; index += 1) {
          runMask |= inputQuality[index] || QualityFlag.None;
        }
        for (let index = start; index < end; index += 1) output[index] = runMask;
      }
      start = end;
    }
    return output;
  },

  applyPipelineWithReport(
    dataArray: ArrayLike<number> | null | undefined,
    timeArray: ArrayLike<number> | null | undefined,
    pipeline?: FilterStep[] | null,
    inputQuality?: ArrayLike<number>
  ): { values: number[]; quality: Uint16Array; steps: PipelineStepReport[] } {
    if (!dataArray || dataArray.length === 0) {
      return { values: [], quality: new Uint16Array(0), steps: [] };
    }
    const normalizedPipeline =
      pipeline && pipeline.length > 0 ? pipeline : [{ id: 'null-filter', type: 'nullFilter' as const, enabled: true }];
    let values = Array.from(dataArray);
    let quality: Uint16Array = inputQuality
      ? Uint16Array.from({ length: values.length }, (_, index) => Number(inputQuality[index]) || 0)
      : new Uint16Array(values.length);
    const reports: PipelineStepReport[] = [];
    for (const step of normalizedPipeline) {
      if (step.enabled === false) continue;
      const before = values;
      values = this.applyPipeline(before, timeArray, [step]);
      quality = this.propagateStepQuality(before, quality, step, timeArray);
      let changedSamples = 0;
      for (let index = 0; index < Math.min(before.length, values.length); index += 1) {
        if (!Object.is(before[index], values[index])) changedSamples += 1;
      }
      reports.push({
        stepId: step.id,
        type: step.type,
        changedSamples,
        totalSamples: values.length,
        warnings: this.filterWarnings(step, timeArray, before),
        effectiveParameters: this.effectiveParameters(step, timeArray, before)
      });
    }
    return { values, quality, steps: reports };
  },

  firSpecification(step: FilterStep, fs: number): FirSpecification {
    validateFilterStep(step, fs);
    const common = {
      sampleRate: fs,
      passbandRippleDb: step.passbandRippleDb as number,
      stopbandAttenuationDb: step.stopbandAttenuationDb as number
    };
    const transition = step.transitionWidth as number;
    if (step.type === 'firLowPass') {
      return {
        ...common,
        kind: 'lowpass',
        passbandEdgeHz: step.cutoffFreq as number,
        stopbandEdgeHz: (step.cutoffFreq as number) + transition
      };
    }
    if (step.type === 'firHighPass') {
      return {
        ...common,
        kind: 'highpass',
        stopbandEdgeHz: (step.cutoffFreq as number) - transition,
        passbandEdgeHz: step.cutoffFreq as number
      };
    }
    const center = step.centerFreq as number;
    const halfBandwidth = (step.bandwidth as number) / 2;
    if (step.type === 'firBandPass') {
      return {
        ...common,
        kind: 'bandpass',
        lowerStopbandEdgeHz: center - halfBandwidth - transition,
        lowerPassbandEdgeHz: center - halfBandwidth,
        upperPassbandEdgeHz: center + halfBandwidth,
        upperStopbandEdgeHz: center + halfBandwidth + transition
      };
    }
    if (step.type === 'firBandStop') {
      return {
        ...common,
        kind: 'bandstop',
        lowerPassbandEdgeHz: center - halfBandwidth - transition,
        lowerStopbandEdgeHz: center - halfBandwidth,
        upperStopbandEdgeHz: center + halfBandwidth,
        upperPassbandEdgeHz: center + halfBandwidth + transition
      };
    }
    throw new Error(`Filter type ${step.type} is not a designed FIR filter.`);
  },

  designedFir(step: FilterStep, fs: number): FirDesign {
    return designKaiserFir(this.firSpecification(step, fs));
  },

  firSpecificationKey(step: FilterStep, fs: number): string {
    return JSON.stringify(this.firSpecification(step, fs));
  },

  shouldRunFirInWorker(
    pipeline: FilterStep[] | null | undefined,
    time: ArrayLike<number>,
    sampleCount: number
  ): boolean {
    const firSteps = (pipeline || []).filter((step) => step.enabled !== false && firFilterTypes.has(step.type));
    if (firSteps.length === 0) return false;
    const analysis = analyzeTimebase(time, FIR_UNIFORM_TOLERANCE);
    if (!analysis.valid || !analysis.uniform) return true;
    try {
      for (const step of firSteps) {
        const taps = estimateKaiserFirTapCount(this.firSpecification(step, analysis.sampleRate));
        if (taps >= 512 || taps * sampleCount > 4_000_000) return true;
      }
    } catch {
      return true;
    }
    return false;
  },

  serializeFirDesigns(pipeline: FilterStep[] | null | undefined, fs: number): SerializedFirDesign[] {
    return (pipeline || [])
      .filter(
        (step) =>
          step.enabled !== false && ['firLowPass', 'firHighPass', 'firBandPass', 'firBandStop'].includes(step.type)
      )
      .map((step) => ({
        stepId: step.id,
        sampleRate: fs,
        specificationKey: this.firSpecificationKey(step, fs),
        coefficients: this.designedFir(step, fs).coefficients,
        processingMode: step.processingMode as 'causal' | 'zero-phase'
      }));
  },

  calculateDesignedFirResponse(
    pipeline: FilterStep[] | null | undefined,
    fs: number,
    points: number,
    serializedDesigns: SerializedFirDesign[] = []
  ): FilterResponse | null {
    const designed = (pipeline || []).filter(
      (step) =>
        step.enabled !== false && ['firLowPass', 'firHighPass', 'firBandPass', 'firBandStop'].includes(step.type)
    );
    if (designed.length === 0) return null;
    const responsePoints = Math.min(4097, Math.max(2, Math.floor(points)));
    let combined: FilterResponse | null = null;
    for (const step of designed) {
      const serialized = serializedDesigns.find(
        (candidate) =>
          candidate.stepId === step.id &&
          candidate.processingMode === step.processingMode &&
          candidate.specificationKey === this.firSpecificationKey(step, fs) &&
          Math.abs(candidate.sampleRate - fs) <= Math.max(1, fs) * 1e-9
      );
      const response = computeFirResponse(
        serialized?.coefficients || this.designedFir(step, fs).coefficients,
        fs,
        responsePoints,
        step.processingMode as 'causal' | 'zero-phase'
      );
      if (!combined) {
        combined = {
          frequency: response.frequency,
          magnitudeDb: new Array<number>(response.frequency.length).fill(0),
          phaseDeg: new Array<number>(response.frequency.length).fill(0),
          groupDelaySeconds: new Array<number>(response.frequency.length).fill(0)
        };
      }
      for (let index = 0; index < response.frequency.length; index += 1) {
        combined.magnitudeDb[index] += response.magnitudeDb[index];
        combined.phaseDeg[index] += response.phaseDeg[index];
        combined.groupDelaySeconds[index] += response.groupDelaySeconds[index];
      }
    }
    return combined;
  },

  designedIirSections(step: FilterStep, fs: number): Biquad[] {
    validateFilterStep(step, fs);
    if (step.type === 'butterworthLowPass') {
      return designButterworth('lowpass', fs, step.cutoffFreq as number, step.order as number);
    }
    if (step.type === 'butterworthHighPass') {
      return designButterworth('highpass', fs, step.cutoffFreq as number, step.order as number);
    }
    if (step.type === 'butterworthBandPass') {
      const center = step.centerFreq as number;
      const bandwidth = step.bandwidth as number;
      return designButterworthBandPass(fs, center - bandwidth / 2, center + bandwidth / 2, step.order as number);
    }
    if (step.type === 'iirNotch') {
      return designNotch(
        fs,
        step.centerFreq as number,
        step.bandwidth as number,
        step.processingMode as 'causal' | 'zero-phase'
      );
    }
    if (step.type === 'iirComb') {
      return designCombNotch(
        fs,
        step.centerFreq as number,
        step.bandwidth as number,
        step.harmonicCount as number,
        step.processingMode as 'causal' | 'zero-phase'
      );
    }
    return [];
  },

  calculateDesignedIirResponse(
    pipeline: FilterStep[] | null | undefined,
    fs: number,
    points: number
  ): FilterResponse | null {
    const designed = (pipeline || []).filter(
      (step) =>
        step.enabled !== false &&
        ['butterworthLowPass', 'butterworthHighPass', 'butterworthBandPass', 'iirNotch', 'iirComb'].includes(step.type)
    );
    if (designed.length === 0) return null;
    let combined: FilterResponse | null = null;
    for (const step of designed) {
      const response = computeFilterResponse(
        this.designedIirSections(step, fs),
        fs,
        points,
        step.processingMode || 'zero-phase'
      );
      if (!combined) {
        combined = {
          frequency: response.frequency,
          magnitudeDb: new Array<number>(response.frequency.length).fill(0),
          phaseDeg: new Array<number>(response.frequency.length).fill(0),
          groupDelaySeconds: new Array<number>(response.frequency.length).fill(0)
        };
      }
      for (let index = 0; index < response.frequency.length; index += 1) {
        combined.magnitudeDb[index] += response.magnitudeDb[index];
        combined.phaseDeg[index] += response.phaseDeg[index];
        combined.groupDelaySeconds[index] += response.groupDelaySeconds[index];
      }
    }
    return combined;
  },

  calculateSmootherResponse(
    pipeline: FilterStep[] | null | undefined,
    fs: number,
    points: number
  ): FilterResponse | null {
    const linearSteps = (pipeline || []).filter(
      (step) => step.enabled !== false && ['movingAverage', 'savitzkyGolay', 'gaussian', 'iir'].includes(step.type)
    );
    if (linearSteps.length === 0) return null;
    const count = Math.max(2, Math.floor(points));
    const frequency = Array.from({ length: count }, (_, index) => (index * fs) / (2 * (count - 1)));
    const magnitudeDb = new Array<number>(count);
    const phaseRadians = new Array<number>(count);
    frequency.forEach((value, index) => {
      const omega = (2 * Math.PI * value) / fs;
      let totalReal = 1;
      let totalImaginary = 0;
      for (const step of linearSteps) {
        let responseReal: number;
        let responseImaginary: number;
        if (step.type === 'iir') {
          const alpha = step.alpha || 0.1;
          const feedback = 1 - alpha;
          const denominatorReal = 1 - feedback * Math.cos(omega);
          const denominatorImaginary = feedback * Math.sin(omega);
          const denominatorPower = denominatorReal * denominatorReal + denominatorImaginary * denominatorImaginary;
          responseReal = (alpha * denominatorReal) / denominatorPower;
          responseImaginary = (-alpha * denominatorImaginary) / denominatorPower;
        } else {
          let coefficients: number[];
          if (step.type === 'movingAverage') {
            let size = Math.max(1, Math.round(step.windowSize || 5));
            if (size % 2 === 0) size += 1;
            coefficients = new Array<number>(size).fill(1 / size);
          } else if (step.type === 'savitzkyGolay') {
            let size = Math.max(3, Math.round(step.windowSize || 21));
            if (size % 2 === 0) size += 1;
            coefficients = this.computeSGWeights(Math.floor(size / 2), step.polyOrder ?? 2);
          } else {
            let size = Math.max(3, Math.round(step.kernelSize || 5));
            if (size % 2 === 0) size += 1;
            coefficients = this.computeGaussianKernel(step.sigma || 1, size);
          }
          responseImaginary = 0;
          const center = Math.floor(coefficients.length / 2);
          responseReal = coefficients.reduce(
            (sum, coefficient, coefficientIndex) => sum + coefficient * Math.cos(omega * (coefficientIndex - center)),
            0
          );
          const iterations = step.type === 'savitzkyGolay' ? Math.max(1, Math.min(16, step.iterations || 1)) : 1;
          responseReal = responseReal ** iterations;
        }
        const nextReal = totalReal * responseReal - totalImaginary * responseImaginary;
        totalImaginary = totalReal * responseImaginary + totalImaginary * responseReal;
        totalReal = nextReal;
      }
      magnitudeDb[index] = 20 * Math.log10(Math.max(Math.hypot(totalReal, totalImaginary), 1e-15));
      phaseRadians[index] = Math.atan2(totalImaginary, totalReal);
    });
    for (let index = 1; index < phaseRadians.length; index += 1) {
      while (phaseRadians[index] - phaseRadians[index - 1] > Math.PI) {
        phaseRadians[index] -= 2 * Math.PI;
      }
      while (phaseRadians[index] - phaseRadians[index - 1] < -Math.PI) {
        phaseRadians[index] += 2 * Math.PI;
      }
    }
    const groupDelaySeconds = phaseRadians.map((_, index) => {
      if (magnitudeDb[index] < -120) return 0;
      const left = Math.max(0, index - 1);
      const right = Math.min(phaseRadians.length - 1, index + 1);
      const angularSpan = (2 * Math.PI * (frequency[right] - frequency[left])) / fs;
      return angularSpan > 0 ? -(phaseRadians[right] - phaseRadians[left]) / angularSpan / fs : 0;
    });
    return {
      frequency,
      magnitudeDb,
      phaseDeg: phaseRadians.map((phase) => (phase * 180) / Math.PI),
      groupDelaySeconds
    };
  },

  analogGain(freq: number, type: GainKind, config: FilterStep): number {
    if (type === 'notch' || type === 'notchFFT') {
      const center = config.centerFreq || 0;
      const bw = config.bandwidth || 0;
      if (!(center > 0) || !(bw > 0)) return 1;
      const distance = Math.abs(freq - center);
      const stopHalfWidth = bw / 2;
      const transitionWidth = Math.max(stopHalfWidth, center * 1e-6);
      if (distance <= stopHalfWidth) return 0;
      if (distance >= stopHalfWidth + transitionWidth) return 1;
      const progress = (distance - stopHalfWidth) / transitionWidth;
      return 0.5 * (1 - Math.cos(Math.PI * progress));
    }

    const fc = config.cutoffFreq;
    if (!fc || fc <= 0) return 1;

    const isLow = type === 'lowpass' || type === 'lowPassFFT';
    if (freq === 0) return isLow ? 1 : 0;

    const slope = config.slope || 12;
    const order = Math.max(1, Math.round(slope / 6));
    const ratio = isLow ? freq / fc : fc / freq;
    if (!Number.isFinite(ratio)) return isLow ? 1 : 0;
    return 1 / Math.sqrt(1 + Math.pow(ratio, 2 * order));
  },

  calculateTransferFunction(
    pipeline: FilterStep[] | null | undefined,
    fs: number,
    nBins: number,
    fftSize?: number
  ): number[] {
    const points = Math.max(1, nBins || 0);
    const size = fftSize || Math.max(2, (points - 1) * 2);
    const transfer = new Array<number>(points).fill(1.0);
    const binWidth = frequencyBinWidth(size, fs);

    (pipeline || []).forEach((step) => {
      if (step.enabled === false) return;
      if (!['lowPassFFT', 'highPassFFT', 'notchFFT'].includes(step.type)) return;
      for (let i = 0; i < points; i++) {
        transfer[i] *= this.analogGain(i * binWidth, step.type, step);
      }
    });

    return transfer;
  },

  applyFFTFilter(data: number[], fs: number, type: GainKind, config: FilterStep): number[] {
    const len = data.length;
    if (len < 2) return data.slice();
    if ((type === 'notch' || type === 'notchFFT') && Number(config.bandwidth) < frequencyBinWidth(len, fs)) {
      throw new Error(
        `FFT notch bandwidth must be at least the record resolution (${frequencyBinWidth(len, fs).toPrecision(6)} Hz).`
      );
    }
    const preservesTrend = type !== 'highpass' && type !== 'highPassFFT';
    const trend = preservesTrend
      ? data.map(
          (_, index) =>
            data[0] + (data[data.length - 1] - data[0]) * (data.length === 1 ? 0 : index / (data.length - 1))
        )
      : new Array<number>(data.length).fill(0);
    const detrended = data.map((value, index) => value - trend[index]);
    const basePadding = Math.min(len - 1, Math.max(32, Math.min(2048, Math.ceil(len * 0.1))));
    const resolutionLength =
      type === 'notch' || type === 'notchFFT'
        ? Math.ceil((fs * 8) / Math.max(Number.EPSILON, config.bandwidth || 0))
        : 0;
    const transformLength = FFT.nextPowerOfTwo(Math.max(len + basePadding * 2, resolutionLength));
    if (transformLength > 2 ** 22) {
      throw new Error('FFT notch bandwidth is too narrow for the 4M-point transform safety limit.');
    }
    const padding = Math.floor((transformLength - len) / 2);
    const extended = Array.from({ length: transformLength }, (_, index) =>
      this.getReflectedValue(detrended, index - padding)
    );
    const { re, im } = FFT.forward(extended, { zeroPadMode: 'none' });
    const n = re.length;
    const binWidth = frequencyBinWidth(n, fs);
    const nyquistBin = Math.floor(n / 2);

    for (let i = 0; i <= nyquistBin; i++) {
      const gain = this.analogGain(i * binWidth, type, config);
      re[i] *= gain;
      im[i] *= gain;
      if (i > 0 && i < nyquistBin) {
        const mirror = n - i;
        re[mirror] *= gain;
        im[mirror] *= gain;
      }
    }

    const filtered = FFT.inverse(re, im, extended.length).slice(padding, padding + len);
    return filtered.map((value, index) => value + trend[index]);
  },

  getReflectedValue(data: number[], index: number): number {
    const len = data.length;
    if (len === 0) return Number.NaN;
    if (len === 1) return data[0];
    const period = 2 * (len - 1);
    const wrapped = ((index % period) + period) % period;
    return data[wrapped < len ? wrapped : period - wrapped];
  },

  movingAverage(data: number[], windowSize = 5): number[] {
    if (data.length === 0) return [];
    let size = Math.max(1, Math.round(windowSize) || 1);
    if (size % 2 === 0) size += 1;
    const result = new Array<number>(data.length).fill(0);
    const gap = Math.floor(size / 2);
    const denom = 2 * gap + 1;
    let sum = 0;
    for (let offset = -gap; offset <= gap; offset += 1) {
      sum += this.getReflectedValue(data, offset);
    }
    result[0] = sum / denom;
    for (let index = 1; index < data.length; index += 1) {
      sum -= this.getReflectedValue(data, index - gap - 1);
      sum += this.getReflectedValue(data, index + gap);
      result[index] = sum / denom;
    }
    return result;
  },

  median(data: number[], windowSize = 5): number[] {
    let size = Math.max(1, Math.min(501, Math.round(windowSize) || 1));
    if (size % 2 === 0) size += 1;
    const result = new Array<number>(data.length).fill(0);
    const gap = Math.floor(size / 2);
    const len = data.length;
    for (let i = 0; i < len; i++) {
      const window: number[] = [];
      for (let j = -gap; j <= gap; j++) {
        let idx = i + j;
        if (idx < 0) idx = 0;
        if (idx >= len) idx = len - 1;
        window.push(data[idx]);
      }
      window.sort((a, b) => a - b);
      result[i] = window[gap];
    }
    return result;
  },

  iirLowPass(data: number[], alpha = 0.1): number[] {
    if (!data.length) return [];
    const a = Math.min(1, Math.max(0, Number.isFinite(alpha) ? alpha : 0.1));
    const result = new Array<number>(data.length);
    result[0] = data[0];
    let prev = data[0];
    for (let i = 1; i < data.length; i++) {
      const smoothed = a * data[i] + (1 - a) * prev;
      result[i] = smoothed;
      prev = smoothed;
    }
    return result;
  },

  savitzkyGolay(data: number[], windowSize = 21, order = 2): number[] {
    if (data.length === 0) return [];
    let size = Math.max(3, Math.min(1001, Math.round(windowSize) || 3));
    if (size % 2 === 0) size += 1;
    const safeOrder = Math.max(0, Math.min(Math.floor(order), size - 2));
    const half = Math.floor(size / 2);
    const result = new Array<number>(data.length).fill(0);
    const weights = this.computeSGWeights(half, safeOrder);
    for (let i = 0; i < data.length; i++) {
      let sum = 0;
      for (let j = -half; j <= half; j++) {
        sum += this.getReflectedValue(data, i + j) * weights[j + half];
      }
      result[i] = sum;
    }
    return result;
  },

  gaussian(data: number[], sigma = 1, kernelSize = 5): number[] {
    if (data.length === 0) return [];
    const safeSigma = Math.max(1e-6, Number.isFinite(sigma) ? sigma : 1);
    let size = Math.max(3, Math.min(1001, Math.round(kernelSize) || Math.ceil(safeSigma * 6)));
    if (size % 2 === 0) size += 1;
    const half = Math.floor(size / 2);
    const kernel = this.computeGaussianKernel(safeSigma, size);
    const result = new Array<number>(data.length).fill(0);
    for (let i = 0; i < data.length; i++) {
      let sum = 0;
      for (let j = -half; j <= half; j++) {
        sum += this.getReflectedValue(data, i + j) * kernel[j + half];
      }
      result[i] = sum;
    }
    return result;
  },

  startStopNorm(data: number[], config?: FilterStep): number[] {
    const {
      startLength,
      endLength,
      startOffset = 0,
      autoOffset = false,
      autoOffsetPoints = 100,
      applyStart = true,
      applyEnd = true
    } = config || {};

    const resolvedStart = startLength ?? 0;
    const resolvedEnd = endLength ?? 0;
    const len = data.length;
    if (len === 0) return data;

    const startSafe = applyStart ? Math.min(Math.max(0, resolvedStart), Math.floor(len / 2)) : 0;
    const endSafe = applyEnd ? Math.min(Math.max(0, resolvedEnd), Math.floor(len / 2)) : 0;
    if (startSafe <= 0 && endSafe <= 0 && startOffset === 0 && !autoOffset) return data;

    const offsetToApply = (() => {
      if (!autoOffset) return startOffset;
      const sampleCount = Math.min(Math.max(1, Math.floor(autoOffsetPoints || 1)), len);
      let sum = 0;
      let count = 0;
      for (let i = 0; i < sampleCount; i++) {
        if (!Number.isFinite(data[i])) continue;
        sum += data[i];
        count += 1;
      }
      return count > 0 ? sum / count : 0;
    })();

    const tapered = data.map((v) => (Number.isFinite(v) ? v - offsetToApply : v));
    const fadeFactor = (i: number, length: number) => {
      if (length <= 0) return 1;
      if (length === 1) return 0;
      return Math.sin((i / (length - 1)) * (Math.PI / 2));
    };

    for (let i = 0; i < startSafe; i++) {
      if (Number.isFinite(tapered[i])) tapered[i] *= fadeFactor(i, startSafe);
    }
    for (let i = 0; i < endSafe; i++) {
      if (Number.isFinite(tapered[len - 1 - i])) {
        tapered[len - 1 - i] *= fadeFactor(i, endSafe);
      }
    }
    return tapered;
  },

  computeSGWeights(m: number, order: number): number[] {
    const windowSize = 2 * m + 1;
    const safeOrder = Math.max(0, Math.min(order || 0, windowSize - 1));
    const cacheKey = `${windowSize}:${safeOrder}`;
    const cached = savitzkyGolayWeightCache.get(cacheKey);
    if (cached) return cached.slice();
    const columnCount = safeOrder + 1;
    const qColumns: number[][] = [];
    const r = Array.from({ length: columnCount }, () => new Array<number>(columnCount).fill(0));
    for (let column = 0; column < columnCount; column += 1) {
      const vector = Array.from({ length: windowSize }, (_, row) => Math.pow(m === 0 ? 0 : (row - m) / m, column));
      for (let previous = 0; previous < column; previous += 1) {
        let projection = 0;
        for (let row = 0; row < windowSize; row += 1) {
          projection += qColumns[previous][row] * vector[row];
        }
        r[previous][column] = projection;
        for (let row = 0; row < windowSize; row += 1) {
          vector[row] -= projection * qColumns[previous][row];
        }
      }
      for (let previous = 0; previous < column; previous += 1) {
        let correction = 0;
        for (let row = 0; row < windowSize; row += 1) {
          correction += qColumns[previous][row] * vector[row];
        }
        r[previous][column] += correction;
        for (let row = 0; row < windowSize; row += 1) {
          vector[row] -= correction * qColumns[previous][row];
        }
      }
      let squaredNorm = 0;
      for (const value of vector) squaredNorm += value * value;
      const norm = Math.sqrt(squaredNorm);
      if (!(norm > 1e-12)) {
        throw new Error('Savitzky-Golay design is rank deficient for the requested window and order.');
      }
      r[column][column] = norm;
      qColumns[column] = vector.map((value) => value / norm);
    }
    const coefficients = new Array<number>(columnCount).fill(0);
    for (let row = 0; row < columnCount; row += 1) {
      let sum = row === 0 ? 1 : 0;
      for (let previous = 0; previous < row; previous += 1) {
        sum -= r[previous][row] * coefficients[previous];
      }
      coefficients[row] = sum / r[row][row];
    }
    const weights = Array.from({ length: windowSize }, (_, row) =>
      qColumns.reduce((sum, column, index) => sum + column[row] * coefficients[index], 0)
    );
    const total = weights.reduce((sum, value) => sum + value, 0);
    const normalized = total !== 0 ? weights.map((value) => value / total) : weights;
    savitzkyGolayWeightCache.set(cacheKey, normalized);
    return normalized.slice();
  },

  computeGaussianKernel(sigma: number, size: number): number[] {
    const kernel: number[] = [];
    const center = Math.floor(size / 2);
    let sum = 0;
    for (let i = 0; i < size; i++) {
      const x = i - center;
      const val = Math.exp(-(x * x) / (2 * sigma * sigma));
      kernel.push(val);
      sum += val;
    }
    return kernel.map((v) => v / sum);
  },

  transpose(matrix: number[][]): number[][] {
    return matrix[0].map((_, c) => matrix.map((r) => r[c]));
  },

  multiplyMatrices(m1: number[][], m2: number[][]): number[][] {
    const result: number[][] = [];
    for (let i = 0; i < m1.length; i++) {
      result[i] = [];
      for (let j = 0; j < m2[0].length; j++) {
        let sum = 0;
        for (let k = 0; k < m1[0].length; k++) sum += m1[i][k] * m2[k][j];
        result[i][j] = sum;
      }
    }
    return result;
  },

  invertMatrix(M: number[][]): number[][] | null {
    const n = M.length;
    const A = M.map((row, i) => {
      const augmented = [...row, ...new Array<number>(n).fill(0)];
      augmented[n + i] = 1;
      return augmented;
    });

    for (let i = 0; i < n; i++) {
      let pivotRow = i;
      let pivotAbs = Math.abs(A[i][i]);
      for (let k = i + 1; k < n; k++) {
        const candidate = Math.abs(A[k][i]);
        if (candidate > pivotAbs) {
          pivotAbs = candidate;
          pivotRow = k;
        }
      }
      if (pivotAbs < 1e-12) return null;
      if (pivotRow !== i) {
        const swap = A[i];
        A[i] = A[pivotRow];
        A[pivotRow] = swap;
      }
      const pivot = A[i][i];
      for (let j = i; j < 2 * n; j++) A[i][j] /= pivot;
      for (let k = 0; k < n; k++) {
        if (k === i) continue;
        const factor = A[k][i];
        for (let j = i; j < 2 * n; j++) A[k][j] -= factor * A[i][j];
      }
    }

    return A.map((row) => row.slice(n));
  }
};

/** Half-width (in samples) of the Kaiser-windowed sinc used for fractional sample shifts. */
export const FRACTIONAL_SHIFT_HALF_TAPS = 32;
const FRACTIONAL_SHIFT_KAISER_BETA = 8;

function kaiserBessel0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 60; k += 1) {
    term *= (x * x) / (4 * k * k);
    sum += term;
    if (term < 1e-14 * sum) break;
  }
  return sum;
}

/**
 * Kaiser-windowed sinc kernel h[k] = sinc(k - d) * w(k - d) for k in [-H, H], normalised to unit DC
 * gain so a constant input is reproduced exactly. The kernel is band-limited and local: interpolation
 * error is below 1e-4 up to roughly 0.4 fs and boundary effects stay within H samples of a run edge,
 * unlike a circular FFT phase ramp whose wrap-around ringing spreads across the record.
 */
function fractionalShiftKernel(delay: number): Float64Array {
  const half = FRACTIONAL_SHIFT_HALF_TAPS;
  const kernel = new Float64Array(2 * half + 1);
  const denominator = kaiserBessel0(FRACTIONAL_SHIFT_KAISER_BETA);
  let sum = 0;
  for (let k = -half; k <= half; k += 1) {
    const x = k - delay;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const ratio = x / (half + 1);
    const window =
      Math.abs(ratio) >= 1
        ? 0
        : kaiserBessel0(FRACTIONAL_SHIFT_KAISER_BETA * Math.sqrt(1 - ratio * ratio)) / denominator;
    kernel[k + half] = sinc * window;
    sum += kernel[k + half];
  }
  if (sum !== 0) for (let i = 0; i < kernel.length; i += 1) kernel[i] /= sum;
  return kernel;
}

function shiftFiniteRun(source: number[], delay: number): number[] {
  if (source.length < 2 || delay === 0) return source.slice();
  const half = FRACTIONAL_SHIFT_HALF_TAPS;
  const kernel = fractionalShiftKernel(delay);
  const n = source.length;
  const first = source[0];
  const last = source[n - 1];
  const output = new Array<number>(n);
  for (let index = 0; index < n; index += 1) {
    // y[n] = x(n - d) = sum_k x[n - k] * sinc(k - d); samples beyond either edge hold the edge value.
    let acc = 0;
    for (let k = -half; k <= half; k += 1) {
      const sourceIndex = index - k;
      const value = sourceIndex < 0 ? first : sourceIndex >= n ? last : source[sourceIndex];
      acc += value * kernel[k + half];
    }
    output[index] = acc;
  }
  return output;
}

function fractionalShiftFiniteRuns(source: number[], delay: number): number[] {
  const output = source.slice();
  let start = 0;
  while (start < source.length) {
    while (start < source.length && !Number.isFinite(source[start])) start += 1;
    if (start >= source.length) break;
    let end = start + 1;
    while (end < source.length && Number.isFinite(source[end])) end += 1;
    const shifted = shiftFiniteRun(source.slice(start, end), delay);
    for (let index = 0; index < shifted.length; index += 1) output[start + index] = shifted[index];
    start = end;
  }
  return output;
}

function integerShift(source: number[], offset: number): number[] {
  if (offset === 0) return source;
  return source.map((_, index) => {
    const sourceIndex = index - offset;
    if (sourceIndex < 0) return source[0];
    if (sourceIndex >= source.length) return source[source.length - 1];
    return source[sourceIndex];
  });
}

export function applyXOffset(data: ArrayLike<number> = [], offset = 0): number[] {
  const source = Array.from(data);
  const resolvedOffset = Number.isFinite(offset) ? offset : 0;
  if (source.length === 0) return [];
  if (resolvedOffset === 0) return [...source];
  const integerOffset = Math.trunc(resolvedOffset);
  const fractionalOffset = resolvedOffset - integerOffset;
  const fractionallyShifted = fractionalShiftFiniteRuns(source, fractionalOffset);
  return integerShift(fractionallyShifted, integerOffset);
}

/**
 * Quality companion of {@link applyXOffset}: the mask moves with the values. The integer part is a
 * pure index shift (edge-held outputs beyond the record are `Missing | Interpolated`); the fractional
 * part marks every sample of each finite run `Interpolated` and ORs the flags of the
 * ±FRACTIONAL_SHIFT_HALF_TAPS source samples the kernel actually reads. Samples that are non-finite
 * in `data` keep their own flags because the kernel skips them (runs are shifted independently).
 */
export function shiftQualityMask(mask: ArrayLike<number>, offset: number, data?: ArrayLike<number>): Uint16Array {
  const length = mask.length;
  const source = Uint16Array.from({ length }, (_, index) => Number(mask[index]) || 0);
  const resolvedOffset = Number.isFinite(offset) ? offset : 0;
  if (length === 0 || resolvedOffset === 0) return source;
  const integerOffset = Math.trunc(resolvedOffset);
  const fractionalOffset = resolvedOffset - integerOffset;
  let working = source;
  if (fractionalOffset !== 0) {
    working = source.slice();
    const isFinite = (index: number) => (data ? Number.isFinite(Number(data[index])) : true);
    let start = 0;
    while (start < length) {
      while (start < length && !isFinite(start)) start += 1;
      if (start >= length) break;
      let end = start + 1;
      while (end < length && isFinite(end)) end += 1;
      applyReachMask(
        working,
        source,
        start,
        end,
        FRACTIONAL_SHIFT_HALF_TAPS,
        FRACTIONAL_SHIFT_HALF_TAPS,
        QualityFlag.Interpolated
      );
      start = end;
    }
  }
  if (integerOffset === 0) return working;
  const shifted = new Uint16Array(length);
  for (let index = 0; index < length; index += 1) {
    const sourceIndex = index - integerOffset;
    shifted[index] =
      sourceIndex < 0 || sourceIndex >= length ? QualityFlag.Missing | QualityFlag.Interpolated : working[sourceIndex];
  }
  return shifted;
}
