import { FFT } from '../processing/fft.js';

function integrateBand(freq = [], power = [], f1 = 0, f2 = Infinity) {
    if (!freq.length || !power.length) return 0;
    let total = 0;
    for (let i = 0; i < freq.length; i += 1) {
        const f = freq[i];
        if (f < f1 || f > f2) continue;
        const prev = i === 0 ? (freq[1] !== undefined ? freq[1] - freq[0] : 0) : (freq[i] - freq[i - 1]);
        const binWidth = Math.max(prev, 0);
        total += power[i] * binWidth;
    }
    return total;
}

function nearestBin(freqAxis = [], targetFreq) {
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

function sanitizeMagnitude(mags = []) {
    return mags.map((m) => (Number.isFinite(m) ? m : 0));
}

export const SpectralMetrics = {
    computePeaks(freq = [], mag = [], options = {}) {
        const { maxPeaks = 5, prominence = 0.01 } = options;
        if (!freq.length || !mag.length) return [];
        const cleanMag = sanitizeMagnitude(mag);
        const maxVal = Math.max(...cleanMag, 0);
        const minProm = maxVal * (prominence || 0);
        const peaks = [];
        for (let i = 1; i < cleanMag.length - 1; i += 1) {
            const val = cleanMag[i];
            if (val < cleanMag[i - 1] || val < cleanMag[i + 1]) continue;
            const leftDiff = val - cleanMag[i - 1];
            const rightDiff = val - cleanMag[i + 1];
            const localProm = Math.min(leftDiff, rightDiff);
            if (localProm >= minProm) {
                peaks.push({ freq: freq[i], magnitude: val, index: i });
            }
        }
        return peaks
            .sort((a, b) => b.magnitude - a.magnitude)
            .slice(0, maxPeaks);
    },

    computeHarmonics(freq = [], mag = [], fundamentalHz, count = 5) {
        if (!Number.isFinite(fundamentalHz) || fundamentalHz <= 0) return [];
        const cleanMag = sanitizeMagnitude(mag);
        const harmonics = [];
        for (let i = 1; i <= count; i += 1) {
            const target = fundamentalHz * i;
            const { index, freq: resolvedFreq } = nearestBin(freq, target);
            if (index >= 0) harmonics.push({ order: i, freq: resolvedFreq, magnitude: cleanMag[index], index });
        }
        return harmonics;
    },

    thd(freq = [], mag = [], fundamentalHz, harmonicCount = 5) {
        const harmonics = this.computeHarmonics(freq, mag, fundamentalHz, harmonicCount);
        if (!harmonics.length) return null;
        const fundamental = harmonics.find((h) => h.order === 1);
        if (!fundamental || !fundamental.magnitude) return null;
        const noisePower = harmonics
            .filter((h) => h.order > 1)
            .reduce((acc, h) => acc + (h.magnitude * h.magnitude), 0);
        const thdRatio = Math.sqrt(noisePower) / fundamental.magnitude;
        return thdRatio;
    },

    snr(freq = [], mag = [], fundamentalHz, bandwidthHz = null) {
        const cleanMag = sanitizeMagnitude(mag);
        const power = cleanMag.map((m) => m * m);
        const totalPower = integrateBand(freq, power, 0, bandwidthHz || Infinity);
        const { index } = nearestBin(freq, fundamentalHz);
        if (index < 0) return null;
        const sigPower = power[index];
        const noisePower = Math.max(totalPower - sigPower, 0);
        if (noisePower <= 0) return null;
        return sigPower / noisePower;
    },

    bandpower(freq = [], mag = [], f1 = 0, f2 = Infinity) {
        const power = sanitizeMagnitude(mag).map((m) => m * m);
        return integrateBand(freq, power, f1, f2);
    },

    spur(freq = [], mag = [], fundamentalHz, harmonicCount = 5) {
        const harmonics = this.computeHarmonics(freq, mag, fundamentalHz, harmonicCount).map((h) => h.index);
        const excluded = new Set(harmonics);
        const cleanMag = sanitizeMagnitude(mag);
        let best = { freq: null, magnitude: 0 };
        for (let i = 0; i < cleanMag.length; i += 1) {
            if (excluded.has(i)) continue;
            if (cleanMag[i] > best.magnitude) {
                best = { freq: freq[i], magnitude: cleanMag[i] };
            }
        }
        return best;
    },

    summarize(signal = [], time = [], options = {}) {
        const spectrum = FFT.computeSpectrum(signal, time, options);
        const peaks = this.computePeaks(spectrum.freq, spectrum.linearMagnitude, {
            maxPeaks: options.maxPeaks || 5,
            prominence: options.prominence || 0.01
        });
        const fundamentalHz = Number.isFinite(options.fundamentalHz) && options.fundamentalHz > 0
            ? options.fundamentalHz
            : (peaks[0]?.freq || null);
        const harmonics = this.computeHarmonics(spectrum.freq, spectrum.linearMagnitude, fundamentalHz, options.harmonicCount || 5);
        const thd = fundamentalHz ? this.thd(spectrum.freq, spectrum.linearMagnitude, fundamentalHz, options.harmonicCount || 5) : null;
        const snr = fundamentalHz ? this.snr(spectrum.freq, spectrum.linearMagnitude, fundamentalHz, options.bandwidthHz || spectrum.meta.nyquist) : null;
        const spur = fundamentalHz ? this.spur(spectrum.freq, spectrum.linearMagnitude, fundamentalHz, options.harmonicCount || 5) : { freq: null, magnitude: null };
        const bandpower = this.bandpower(
            spectrum.freq,
            spectrum.linearMagnitude,
            options.bandStartHz || 0,
            options.bandEndHz || spectrum.meta.nyquist
        );

        return {
            spectrum,
            peaks,
            harmonics,
            thd,
            snr,
            spur,
            bandpower,
            fundamentalHz,
            warnings: spectrum.warnings || []
        };
    },

    summarizeFromSpectrum(spectrum, options = {}) {
        if (!spectrum) {
            return { spectrum: { freq: [], linearMagnitude: [], warnings: [], meta: {} }, peaks: [], harmonics: [], thd: null, snr: null, spur: { freq: null, magnitude: null }, bandpower: 0, fundamentalHz: null, warnings: [] };
        }
        const peaks = this.computePeaks(spectrum.freq, spectrum.linearMagnitude, {
            maxPeaks: options.maxPeaks || 5,
            prominence: options.prominence || 0.01
        });
        const fundamentalHz = Number.isFinite(options.fundamentalHz) && options.fundamentalHz > 0
            ? options.fundamentalHz
            : (peaks[0]?.freq || null);
        const harmonics = this.computeHarmonics(spectrum.freq, spectrum.linearMagnitude, fundamentalHz, options.harmonicCount || 5);
        const thd = fundamentalHz ? this.thd(spectrum.freq, spectrum.linearMagnitude, fundamentalHz, options.harmonicCount || 5) : null;
        const snr = fundamentalHz ? this.snr(spectrum.freq, spectrum.linearMagnitude, fundamentalHz, options.bandwidthHz || spectrum.meta?.nyquist) : null;
        const spur = fundamentalHz ? this.spur(spectrum.freq, spectrum.linearMagnitude, fundamentalHz, options.harmonicCount || 5) : { freq: null, magnitude: null };
        const bandpower = this.bandpower(
            spectrum.freq,
            spectrum.linearMagnitude,
            options.bandStartHz || 0,
            options.bandEndHz || spectrum.meta?.nyquist
        );

        return {
            spectrum,
            peaks,
            harmonics,
            thd,
            snr,
            spur,
            bandpower,
            fundamentalHz,
            warnings: spectrum.warnings || []
        };
    }
};
