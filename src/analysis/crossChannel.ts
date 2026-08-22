import { FFT, type SpectrumOptions } from '../processing/fft';
import type { AnalysisSelection } from '../types';

export interface DelayEstimate {
  delaySeconds: number;
  delaySamples: number;
  correlationPeak: number;
  confidence: number;
  warnings: string[];
}

export interface TransferFunctionResult {
  freq: number[];
  magnitudeDb: number[];
  phaseDeg: number[];
  coherence: number[];
  warnings: string[];
  meta: { fs: number | null };
}

function normalizeSelection(selection: AnalysisSelection | null, length: number): { start: number; end: number } {
  if (!selection || selection.i0 === null || selection.i1 === null) return { start: 0, end: length - 1 };
  return {
    start: Math.max(0, Math.min(selection.i0, selection.i1, length - 1)),
    end: Math.min(length - 1, Math.max(selection.i0, selection.i1))
  };
}

function wrapPhaseDegrees(value: number): number {
  let v = value;
  while (v > 180) v -= 360;
  while (v < -180) v += 360;
  return v;
}

export const CrossChannel = {
  estimateDelay(time: number[] = [], x: number[] = [], y: number[] = [], options: {
    selection?: AnalysisSelection | null;
    maxLagSeconds?: number | null;
  } = {}): DelayEstimate {
    const { selection = null, maxLagSeconds = null } = options;
    if (time.length < 2 || x.length < 2 || y.length < 2) {
      return { delaySeconds: 0, delaySamples: 0, correlationPeak: 0, confidence: 0, warnings: ['Insufficient data for delay estimation.'] };
    }

    const sel = normalizeSelection(selection, Math.min(x.length, y.length, time.length));
    const tx = time.slice(sel.start, sel.end + 1);
    const xSel = x.slice(sel.start, sel.end + 1);
    const ySel = y.slice(sel.start, sel.end + 1);
    if (tx.length < 2) {
      return { delaySeconds: 0, delaySamples: 0, correlationPeak: 0, confidence: 0, warnings: ['Selection too short for delay estimation.'] };
    }

    const { fs, warnings: timingWarnings } = FFT.inferSampleRate(tx);
    if (!Number.isFinite(fs) || fs <= 0) {
      return { delaySeconds: 0, delaySamples: 0, correlationPeak: 0, confidence: 0, warnings: ['Unable to infer sampling rate.'] };
    }

    const maxLagSamples = maxLagSeconds
      ? Math.min(Math.floor(maxLagSeconds * fs), tx.length - 1)
      : Math.min(tx.length - 1, 2000);

    let bestCorr = -Infinity;
    let bestLag = 0;
    for (let lag = -maxLagSamples; lag <= maxLagSamples; lag += 1) {
      let num = 0;
      let denomX = 0;
      let denomY = 0;
      for (let i = 0; i < xSel.length; i += 1) {
        const j = i + lag;
        if (j < 0 || j >= ySel.length) continue;
        num += xSel[i] * ySel[j];
        denomX += xSel[i] * xSel[i];
        denomY += ySel[j] * ySel[j];
      }
      const corr = num / (Math.sqrt(denomX * denomY) || 1);
      if (corr > bestCorr) {
        bestCorr = corr;
        bestLag = lag;
      }
    }

    return {
      delaySeconds: bestLag / fs,
      delaySamples: bestLag,
      correlationPeak: bestCorr,
      confidence: Number.isFinite(bestCorr) ? Math.max(0, Math.min(1, (bestCorr + 1) / 2)) : 0,
      warnings: timingWarnings || []
    };
  },

  computeTransferFunction(input: number[] = [], output: number[] = [], time: number[] = [], options: SpectrumOptions = {}): TransferFunctionResult {
    const { selection = null, windowType = 'hann', detrend = 'removeMean', zeroPadMode = 'nextPow2', zeroPadFactor = 1 } = options;
    if (!input.length || !output.length || !time.length) {
      return { freq: [], magnitudeDb: [], phaseDeg: [], coherence: [], warnings: ['Missing input/output data.'], meta: { fs: null } };
    }

    const sel = normalizeSelection(selection, Math.min(input.length, output.length, time.length));
    const x = input.slice(sel.start, sel.end + 1);
    const y = output.slice(sel.start, sel.end + 1);
    const t = time.slice(sel.start, sel.end + 1);
    const baseOpts = { selection: { xMin: null, xMax: null, i0: 0, i1: x.length - 1 }, windowType, detrend, zeroPadMode, zeroPadFactor };
    const inSpec = FFT.computeSpectrum(x, t, baseOpts);
    const outSpec = FFT.computeSpectrum(y, t, baseOpts);
    const n = Math.min(inSpec.freq.length, outSpec.freq.length);
    const freq = inSpec.freq.slice(0, n);
    const magnitudeDb: number[] = [];
    const phaseDeg: number[] = [];
    const coherence: number[] = [];

    for (let i = 0; i < n; i += 1) {
      const inMag = Math.max(inSpec.linearMagnitude[i] || 0, 1e-12);
      const outMag = Math.max(outSpec.linearMagnitude[i] || 0, 1e-12);
      magnitudeDb.push(20 * Math.log10(outMag / inMag));
      phaseDeg.push(wrapPhaseDegrees((outSpec.phase[i] || 0) - (inSpec.phase[i] || 0)));
      const reX = inSpec.re[i] || 0;
      const imX = inSpec.im[i] || 0;
      const reY = outSpec.re[i] || 0;
      const imY = outSpec.im[i] || 0;
      const sxyMag2 = (reY * reX + imY * imX) ** 2 + (imY * reX - reY * imX) ** 2;
      const sxx = reX * reX + imX * imX;
      const syy = reY * reY + imY * imY;
      coherence.push(sxx > 0 && syy > 0 ? Math.min(1, sxyMag2 / (sxx * syy + 1e-24)) : 0);
    }

    return {
      freq,
      magnitudeDb,
      phaseDeg,
      coherence,
      warnings: [...(inSpec.warnings || []), ...(outSpec.warnings || [])],
      meta: { fs: inSpec.meta?.fs || outSpec.meta?.fs || null }
    };
  }
};
