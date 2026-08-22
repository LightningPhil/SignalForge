import type { FilterStep } from '../types';
import { FFT } from './fft';
import { estimateSampleRate, frequencyBinWidth } from './sampling';

type GainKind = FilterStep['type'] | 'lowpass' | 'highpass' | 'notch';

export const Filter = {
  applyPipeline(dataArray: ArrayLike<number> | null | undefined, timeArray: ArrayLike<number> | null | undefined, pipeline?: FilterStep[] | null): number[] {
    if (!dataArray || dataArray.length === 0) return [];

    const normalizedPipeline = pipeline && pipeline.length > 0
      ? pipeline
      : [{ id: 'null-filter', type: 'nullFilter' as const, enabled: true }];

    let currentData = Array.from(dataArray);
    const fs = estimateSampleRate(timeArray);

    normalizedPipeline.forEach((step) => {
      if (step.enabled === false) return;

      switch (step.type) {
        case 'nullFilter':
          break;
        case 'movingAverage':
          currentData = this.movingAverage(currentData, step.windowSize);
          break;
        case 'savitzkyGolay': {
          const iters = Math.max(1, Math.min(16, step.iterations || 1));
          for (let i = 0; i < iters; i++) {
            currentData = this.savitzkyGolay(currentData, step.windowSize, step.polyOrder);
          }
          break;
        }
        case 'median':
          currentData = this.median(currentData, step.windowSize);
          break;
        case 'iir':
          currentData = this.iirLowPass(currentData, step.alpha);
          break;
        case 'gaussian':
          currentData = this.gaussian(currentData, step.sigma, step.kernelSize);
          break;
        case 'startStopNorm':
          currentData = this.startStopNorm(currentData, step);
          break;
        case 'lowPassFFT':
          currentData = this.applyFFTFilter(currentData, fs, 'lowpass', step);
          break;
        case 'highPassFFT':
          currentData = this.applyFFTFilter(currentData, fs, 'highpass', step);
          break;
        case 'notchFFT':
          currentData = this.applyFFTFilter(currentData, fs, 'notch', step);
          break;
      }
    });

    return currentData;
  },

  analogGain(freq: number, type: GainKind, config: FilterStep): number {
    if (type === 'notch' || type === 'notchFFT') {
      const center = config.centerFreq || 0;
      const bw = config.bandwidth || 0;
      return freq >= (center - bw / 2) && freq <= (center + bw / 2) ? 0 : 1;
    }

    const fc = config.cutoffFreq;
    if (!fc || fc <= 0) return 1;

    const isLow = type === 'lowpass' || type === 'lowPassFFT';
    if (freq === 0) return isLow ? 1 : 0;

    const slope = config.slope || 12;
    const order = Math.max(1, Math.round(slope / 6));
    const q = Math.max(0.05, config.qFactor || Math.SQRT1_2);
    const ratio = isLow ? (freq / fc) : (fc / freq);
    if (!Number.isFinite(ratio)) return isLow ? 1 : 0;

    if (Math.abs(q - Math.SQRT1_2) < 0.02) {
      return 1 / Math.sqrt(1 + Math.pow(ratio, 2 * order));
    }

    const sections = Math.max(1, Math.ceil(order / 2));
    const mag2 = Math.pow(1 - ratio * ratio, 2) + Math.pow(ratio / q, 2);
    return 1 / Math.pow(Math.sqrt(mag2), sections);
  },

  calculateTransferFunction(pipeline: FilterStep[] | null | undefined, fs: number, nBins: number, fftSize?: number): number[] {
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
    const { re, im } = FFT.forward(data);
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

    return FFT.inverse(re, im, len);
  },

  getReflectedValue(data: number[], index: number): number {
    const len = data.length;
    if (index >= 0 && index < len) return data[index];
    if (index < 0) return data[-index < len ? -index : 0];
    const r = len - 2 - (index - len);
    return data[r >= 0 ? r : len - 1];
  },

  movingAverage(data: number[], windowSize = 5): number[] {
    let size = Math.max(1, Math.round(windowSize) || 1);
    if (size % 2 === 0) size += 1;
    const result = new Array<number>(data.length).fill(0);
    const gap = Math.floor(size / 2);
    const denom = (2 * gap) + 1;
    for (let i = 0; i < data.length; i++) {
      let sum = 0;
      for (let j = -gap; j <= gap; j++) sum += this.getReflectedValue(data, i + j);
      result[i] = sum / denom;
    }
    return result;
  },

  median(data: number[], windowSize = 5): number[] {
    const result = new Array<number>(data.length).fill(0);
    const gap = Math.floor(windowSize / 2);
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
      const smoothed = (a * data[i]) + ((1 - a) * prev);
      result[i] = smoothed;
      prev = smoothed;
    }
    return result;
  },

  savitzkyGolay(data: number[], windowSize = 21, order = 2): number[] {
    let size = windowSize;
    if (size % 2 === 0) size += 1;
    const half = Math.floor(size / 2);
    const result = new Array<number>(data.length).fill(0);
    const weights = this.computeSGWeights(half, order);
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
    let size = kernelSize;
    if (size % 2 === 0) size += 1;
    const half = Math.floor(size / 2);
    const kernel = this.computeGaussianKernel(sigma, size);
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
      decayLength,
      startOffset = 0,
      autoOffset = false,
      autoOffsetPoints = 100,
      applyStart = true,
      applyEnd = true
    } = config || {};

    const resolvedStart = startLength ?? decayLength ?? 0;
    const resolvedEnd = endLength ?? decayLength ?? 0;
    const len = data.length;
    if (len === 0) return data;

    const startSafe = applyStart ? Math.min(Math.max(0, resolvedStart), Math.floor(len / 2)) : 0;
    const endSafe = applyEnd ? Math.min(Math.max(0, resolvedEnd), Math.floor(len / 2)) : 0;
    if (startSafe <= 0 && endSafe <= 0 && startOffset === 0 && !autoOffset) return data;

    const offsetToApply = (() => {
      if (!autoOffset) return startOffset;
      const sampleCount = Math.min(Math.max(1, Math.floor(autoOffsetPoints || 1)), len);
      let sum = 0;
      for (let i = 0; i < sampleCount; i++) sum += data[i];
      return sum / sampleCount;
    })();

    const tapered = data.map((v) => v - offsetToApply);
    const fadeFactor = (i: number, length: number) => {
      if (length <= 0) return 1;
      if (length === 1) return 0;
      return Math.sin((i / (length - 1)) * (Math.PI / 2));
    };

    for (let i = 0; i < startSafe; i++) tapered[i] *= fadeFactor(i, startSafe);
    for (let i = 0; i < endSafe; i++) tapered[len - 1 - i] *= fadeFactor(i, endSafe);
    return tapered;
  },

  computeSGWeights(m: number, order: number): number[] {
    const windowSize = 2 * m + 1;
    const safeOrder = Math.max(0, Math.min(order || 0, windowSize - 1));
    const A: number[][] = [];
    for (let i = -m; i <= m; i++) {
      const row: number[] = [];
      for (let j = 0; j <= safeOrder; j++) row.push(Math.pow(i, j));
      A.push(row);
    }
    const AT = this.transpose(A);
    const ATA = this.multiplyMatrices(AT, A);
    const ATAInv = this.invertMatrix(ATA);
    if (!ATAInv) return new Array<number>(windowSize).fill(1 / windowSize);
    return this.multiplyMatrices(ATAInv, AT)[0];
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

export function applyXOffset(data: ArrayLike<number> = [], offset = 0): number[] {
  const source = Array.from(data);
  const len = source.length;
  const intOffset = Math.round(offset || 0);
  if (len === 0) return [];
  if (intOffset === 0) return [...source];

  const shifted = new Array<number>(len);
  for (let i = 0; i < len; i++) {
    const sourceIdx = i - intOffset;
    shifted[i] = sourceIdx >= 0 && sourceIdx < len
      ? source[sourceIdx]
      : sourceIdx < 0 ? source[0] : source[len - 1];
  }
  return shifted;
}
