import { FFT, type SpectrumOptions } from '../processing/fft';
import type { SpectrumResult } from '../types';

export interface SpectralPeak {
  freq: number;
  magnitude: number;
  index: number;
}

export interface SpectralSummary {
  spectrum: SpectrumResult;
  peaks: SpectralPeak[];
  harmonics: Array<SpectralPeak & { order: number }>;
  thd: number | null;
  snr: number | null;
  spur: { freq: number | null; magnitude: number | null };
  bandpower: number;
  fundamentalHz: number | null;
  warnings: string[];
}

function integrateBand(freq: number[] = [], power: number[] = [], f1 = 0, f2 = Infinity): number {
  if (!freq.length || !power.length) return 0;
  let total = 0;
  for (let i = 0; i < freq.length; i += 1) {
    if (freq[i] < f1 || freq[i] > f2) continue;
    const prev = i === 0 ? (freq[1] !== undefined ? freq[1] - freq[0] : 0) : (freq[i] - freq[i - 1]);
    total += power[i] * Math.max(prev, 0);
  }
  return total;
}

function nearestBin(freqAxis: number[] = [], targetFreq: number): { index: number; freq: number | null } {
  if (!freqAxis.length || !Number.isFinite(targetFreq)) return { index: -1, freq: null };
  let bestIdx = 0;
  let bestErr = Math.abs(freqAxis[0] - targetFreq);
  for (let i = 1; i < freqAxis.length; i += 1) {
    const err = Math.abs(freqAxis[i] - targetFreq);
    if (err < bestErr) {
      bestErr = err;
      bestIdx = i;
    }
  }
  return { index: bestIdx, freq: freqAxis[bestIdx] };
}

function sanitizeMagnitude(mags: number[] = []): number[] {
  return mags.map((m) => (Number.isFinite(m) ? m : 0));
}

export const SpectralMetrics = {
  computePeaks(freq: number[] = [], mag: number[] = [], options: { maxPeaks?: number; prominence?: number } = {}): SpectralPeak[] {
    const { maxPeaks = 5, prominence = 0.01 } = options;
    if (!freq.length || !mag.length) return [];
    const cleanMag = sanitizeMagnitude(mag);
    const maxVal = Math.max(...cleanMag, 0);
    const minProm = maxVal * (prominence || 0);
    const peaks: SpectralPeak[] = [];
    for (let i = 1; i < cleanMag.length - 1; i += 1) {
      const val = cleanMag[i];
      if (val < cleanMag[i - 1] || val < cleanMag[i + 1]) continue;
      if (Math.min(val - cleanMag[i - 1], val - cleanMag[i + 1]) >= minProm) {
        peaks.push({ freq: freq[i], magnitude: val, index: i });
      }
    }
    return peaks.sort((a, b) => b.magnitude - a.magnitude).slice(0, maxPeaks);
  },

  computeHarmonics(freq: number[] = [], mag: number[] = [], fundamentalHz: number | null, count = 5): Array<SpectralPeak & { order: number }> {
    if (!Number.isFinite(fundamentalHz) || !fundamentalHz || fundamentalHz <= 0) return [];
    const cleanMag = sanitizeMagnitude(mag);
    const harmonics: Array<SpectralPeak & { order: number }> = [];
    for (let i = 1; i <= count; i += 1) {
      const { index, freq: resolvedFreq } = nearestBin(freq, fundamentalHz * i);
      if (index >= 0 && resolvedFreq !== null) {
        harmonics.push({ order: i, freq: resolvedFreq, magnitude: cleanMag[index], index });
      }
    }
    return harmonics;
  },

  thd(freq: number[] = [], mag: number[] = [], fundamentalHz: number | null, harmonicCount = 5): number | null {
    const harmonics = this.computeHarmonics(freq, mag, fundamentalHz, harmonicCount);
    const fundamental = harmonics.find((h) => h.order === 1);
    if (!fundamental || !fundamental.magnitude) return null;
    const noisePower = harmonics.filter((h) => h.order > 1).reduce((acc, h) => acc + h.magnitude * h.magnitude, 0);
    return Math.sqrt(noisePower) / fundamental.magnitude;
  },

  snr(freq: number[] = [], mag: number[] = [], fundamentalHz: number | null, bandwidthHz: number | null = null): number | null {
    if (!fundamentalHz) return null;
    const power = sanitizeMagnitude(mag).map((m) => m * m);
    const totalPower = integrateBand(freq, power, 0, bandwidthHz || Infinity);
    const { index } = nearestBin(freq, fundamentalHz);
    if (index < 0) return null;
    const noisePower = Math.max(totalPower - power[index], 0);
    return noisePower <= 0 ? null : power[index] / noisePower;
  },

  bandpower(freq: number[] = [], mag: number[] = [], f1 = 0, f2 = Infinity): number {
    return integrateBand(freq, sanitizeMagnitude(mag).map((m) => m * m), f1, f2);
  },

  spur(freq: number[] = [], mag: number[] = [], fundamentalHz: number | null, harmonicCount = 5): { freq: number | null; magnitude: number } {
    const excluded = new Set(this.computeHarmonics(freq, mag, fundamentalHz, harmonicCount).map((h) => h.index));
    const cleanMag = sanitizeMagnitude(mag);
    let best = { freq: null as number | null, magnitude: 0 };
    for (let i = 0; i < cleanMag.length; i += 1) {
      if (excluded.has(i) || cleanMag[i] <= best.magnitude) continue;
      best = { freq: freq[i], magnitude: cleanMag[i] };
    }
    return best;
  },

  summarizeFromSpectrum(spectrum: SpectrumResult | null, options: {
    maxPeaks?: number;
    prominence?: number;
    harmonicCount?: number;
    fundamentalHz?: number;
    bandwidthHz?: number;
    bandStartHz?: number;
    bandEndHz?: number;
  } = {}): SpectralSummary {
    if (!spectrum) {
      return {
        spectrum: {
          freq: [], linearMagnitude: [], magnitude: [], phase: [], warnings: [],
          meta: { fs: 1, deltaF: 0, nyquist: 0, coherentGain: 1, enbw: 1 },
          re: new Float64Array(0), im: new Float64Array(0), length: 0
        },
        peaks: [], harmonics: [], thd: null, snr: null,
        spur: { freq: null, magnitude: null }, bandpower: 0, fundamentalHz: null, warnings: []
      };
    }
    const peaks = this.computePeaks(spectrum.freq, spectrum.linearMagnitude, {
      maxPeaks: options.maxPeaks || 5,
      prominence: options.prominence || 0.01
    });
    const fundamentalHz = Number.isFinite(options.fundamentalHz) && options.fundamentalHz && options.fundamentalHz > 0
      ? options.fundamentalHz
      : (peaks[0]?.freq || null);
    return {
      spectrum,
      peaks,
      harmonics: this.computeHarmonics(spectrum.freq, spectrum.linearMagnitude, fundamentalHz, options.harmonicCount || 5),
      thd: fundamentalHz ? this.thd(spectrum.freq, spectrum.linearMagnitude, fundamentalHz, options.harmonicCount || 5) : null,
      snr: fundamentalHz ? this.snr(spectrum.freq, spectrum.linearMagnitude, fundamentalHz, options.bandwidthHz || spectrum.meta?.nyquist) : null,
      spur: fundamentalHz ? this.spur(spectrum.freq, spectrum.linearMagnitude, fundamentalHz, options.harmonicCount || 5) : { freq: null, magnitude: null },
      bandpower: this.bandpower(spectrum.freq, spectrum.linearMagnitude, options.bandStartHz || 0, options.bandEndHz || spectrum.meta?.nyquist),
      fundamentalHz,
      warnings: spectrum.warnings || []
    };
  },

  summarize(signal: ArrayLike<number> = [], time: ArrayLike<number> = [], options: SpectrumOptions & {
    maxPeaks?: number;
    prominence?: number;
    harmonicCount?: number;
    fundamentalHz?: number;
    bandwidthHz?: number;
    bandStartHz?: number;
    bandEndHz?: number;
  } = {}): SpectralSummary {
    return this.summarizeFromSpectrum(FFT.computeSpectrum(signal, time, options), options);
  }
};
