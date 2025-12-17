/**
 * Fast Fourier Transform (FFT) Module
 * Implements standard Radix-2 Cooley-Tukey Algorithm (Iterative).
 */
const spectrumCache = new WeakMap();

function spectrumCacheKey(signal, indices, options, timeArray) {
    const selectionKey = `${indices.start}-${indices.end}`;
    const optKey = [options.windowType, options.detrend, options.zeroPadMode, options.zeroPadFactor].join('|');
    const tKeySource = indices.start === 0 && indices.end === signal.length - 1 ? timeArray : timeArray.slice(indices.start, indices.end + 1);
    const timeKey = `${tKeySource.length}:${tKeySource[0] ?? 0}:${tKeySource[tKeySource.length - 1] ?? 0}`;
    return `${options.cacheKey || 'default'}|${selectionKey}|${optKey}|${timeKey}`;
}

function getSpectrumCache(signal) {
    let cache = spectrumCache.get(signal);
    if (!cache) {
        cache = new Map();
        spectrumCache.set(signal, cache);
    }
    return cache;
}

export const FFT = {
    
    /**
     * Calculates the Next Power of Two for padding.
     */
    nextPowerOfTwo(n) {
        if (!Number.isFinite(n) || n <= 1) return 1;
        return 2 ** Math.ceil(Math.log2(n));
    },

    /**
     * Forward FFT
     * @param {Array<number>} data - Real input data
     * @param {object} options
     * @param {'nextPow2'|'none'|'factor'} [options.zeroPadMode='nextPow2']
     * @param {number} [options.zeroPadFactor=1]
     * @returns {{ re: Float64Array, im: Float64Array, length: number }}
     */
    forward(data, options = {}) {
        const { zeroPadMode = 'nextPow2', zeroPadFactor = 1 } = options;
        const sourceLength = Array.isArray(data) || ArrayBuffer.isView(data) ? data.length : 0;
        if (sourceLength === 0) {
            return { re: new Float64Array(0), im: new Float64Array(0), length: 0 };
        }

        const desiredLength = (() => {
            if (zeroPadMode === 'none') return sourceLength;
            if (zeroPadMode === 'factor' && Number.isFinite(zeroPadFactor) && zeroPadFactor > 1) {
                const target = Math.max(sourceLength, Math.ceil(sourceLength * zeroPadFactor));
                return this.nextPowerOfTwo(target);
            }
            return this.nextPowerOfTwo(sourceLength);
        })();

        const safeLength = Number.isFinite(desiredLength) && desiredLength > 0 ? desiredLength : 1;
        const re = new Float64Array(safeLength);
        const im = new Float64Array(safeLength);

        for (let i = 0; i < sourceLength; i += 1) re[i] = data[i];

        this.transform(re, im);
        return { re, im, length: safeLength };
    },

    /**
     * Inverse FFT
     * @param {Array<number>} re - Real part
     * @param {Array<number>} im - Imaginary part
     * @param {number} originalLength - Length to crop result to
     * @returns {Array<number>} Real part of the time-domain signal
     */
    inverse(re, im, originalLength) {
        const n = re.length;
        
        // Conjugate (invert imaginary)
        for(let i=0; i<n; i++) im[i] = -im[i];
        
        this.transform(re, im);
        
        // Conjugate again and Scale
        const output = [];
        for(let i=0; i<originalLength; i++) {
            // Real part is scaled by N, imaginary should be near 0
            output.push(re[i] / n); 
        }
        
        return output;
    },

    /**
     * Helper: Calculate Magnitude Spectrum in dB
     * Mag = sqrt(re^2 + im^2)
     * dB = 20 * log10(Mag)
     */
    getMagnitudeDB(re, im, options = {}) {
        const { coherentGain = 1, lengthOverride = null } = options;
        const n = lengthOverride || re.length;
        const half = Math.floor(n / 2);
        const mags = [];
        const scale = 2 / (n * (coherentGain || 1));
        for (let i = 0; i <= half; i += 1) {
            const mag = Math.sqrt((re[i] * re[i]) + (im[i] * im[i])) * scale;
            const corrected = (i === 0 || (n % 2 === 0 && i === half)) ? mag * 0.5 : mag;
            const db = 20 * Math.log10(Math.max(corrected, 1e-12));
            mags.push(db);
        }
        return mags;
    },

    getLinearMagnitude(re, im, options = {}) {
        const { coherentGain = 1, lengthOverride = null } = options;
        const n = lengthOverride || re.length;
        const half = Math.floor(n / 2);
        const mags = [];
        const scale = 2 / (n * (coherentGain || 1));
        for (let i = 0; i <= half; i += 1) {
            const mag = Math.sqrt((re[i] * re[i]) + (im[i] * im[i])) * scale;
            const corrected = (i === 0 || (n % 2 === 0 && i === half)) ? mag * 0.5 : mag;
            mags.push(corrected);
        }
        return mags;
    },

    getPhaseDegrees(re, im, options = {}) {
        const n = options.lengthOverride || re.length;
        const half = Math.floor(n / 2);
        const phase = [];
        for (let i = 0; i <= half; i += 1) {
            phase.push(Math.atan2(im[i], re[i]) * (180 / Math.PI));
        }
        return phase;
    },

    /**
     * Core Cooley-Tukey Algorithm (In-Place)
     */
    transform(re, im) {
        const n = re.length;
        
        // Bit Reversal Permutation
        let target = 0;
        for (let i = 0; i < n - 1; i++) {
            if (i < target) {
                let tempRe = re[i]; re[i] = re[target]; re[target] = tempRe;
                let tempIm = im[i]; im[i] = im[target]; im[target] = tempIm;
            }
            let k = n >> 1;
            while (k <= target) {
                target -= k;
                k >>= 1;
            }
            target += k;
        }

        // Butterfly Computations
        for (let step = 1; step < n; step <<= 1) {
            const jump = step << 1;
            const deltaAngle = -Math.PI / step;
            const sine = Math.sin(0.5 * deltaAngle);
            const multiplierRe = -2.0 * sine * sine;
            const multiplierIm = Math.sin(deltaAngle);
            
            let wRe = 1.0;
            let wIm = 0.0;

            for (let group = 0; group < step; group++) {
                for (let pair = group; pair < n; pair += jump) {
                    const match = pair + step;
                    
                    const prodRe = wRe * re[match] - wIm * im[match];
                    const prodIm = wRe * im[match] + wIm * re[match];
                    
                    re[match] = re[pair] - prodRe;
                    im[match] = im[pair] - prodIm;
                    re[pair] += prodRe;
                    im[pair] += prodIm;
                }
                
                // Trignometric recurrence
                const tempWRe = wRe;
                wRe = wRe * multiplierRe - wIm * multiplierIm + wRe;
                wIm = wIm * multiplierRe + tempWRe * multiplierIm + wIm;
            }
        }
    },

    applyDetrend(values = [], mode = 'none') {
        const n = values.length;
        if (n === 0 || mode === 'none') return values.slice();
        if (mode === 'removeMean') {
            const mean = values.reduce((acc, v) => acc + v, 0) / n;
            return values.map((v) => v - mean);
        }
        if (mode === 'linear') {
            let sumX = 0; let sumY = 0; let sumXY = 0; let sumXX = 0;
            for (let i = 0; i < n; i += 1) {
                sumX += i;
                sumY += values[i];
                sumXY += i * values[i];
                sumXX += i * i;
            }
            const denom = (n * sumXX) - (sumX * sumX);
            const slope = denom !== 0 ? ((n * sumXY) - (sumX * sumY)) / denom : 0;
            const intercept = (sumY - (slope * sumX)) / n;
            return values.map((v, idx) => v - (slope * idx + intercept));
        }
        return values.slice();
    },

    getWindow(windowType = 'hann', length = 0, opts = {}) {
        const n = Math.max(1, length);
        if (n <= 1) {
            return { window: new Float64Array([1]), coherentGain: 1, enbw: 1 };
        }
        const window = new Float64Array(n);
        if (windowType === 'rectangular') {
            window.fill(1);
            return { window, coherentGain: 1, enbw: 1 };
        }

        const pi = Math.PI;
        switch (windowType) {
        case 'hamming':
            for (let i = 0; i < n; i += 1) window[i] = 0.54 - 0.46 * Math.cos((2 * pi * i) / (n - 1));
            break;
        case 'blackman':
            for (let i = 0; i < n; i += 1) window[i] = 0.42 - 0.5 * Math.cos((2 * pi * i) / (n - 1)) + 0.08 * Math.cos((4 * pi * i) / (n - 1));
            break;
        case 'blackman-harris':
            for (let i = 0; i < n; i += 1) window[i] = 0.35875 - 0.48829 * Math.cos((2 * pi * i) / (n - 1)) + 0.14128 * Math.cos((4 * pi * i) / (n - 1)) - 0.01168 * Math.cos((6 * pi * i) / (n - 1));
            break;
        case 'flattop':
            for (let i = 0; i < n; i += 1) window[i] = 1 - 1.93 * Math.cos((2 * pi * i) / (n - 1)) + 1.29 * Math.cos((4 * pi * i) / (n - 1)) - 0.388 * Math.cos((6 * pi * i) / (n - 1)) + 0.0322 * Math.cos((8 * pi * i) / (n - 1));
            break;
        case 'kaiser': {
            const beta = Number.isFinite(opts.beta) ? opts.beta : 6;
            const denom = modifiedBessel0(beta);
            for (let i = 0; i < n; i += 1) {
                const ratio = (2 * i) / (n - 1) - 1;
                window[i] = modifiedBessel0(beta * Math.sqrt(1 - ratio * ratio)) / denom;
            }
            break;
        }
        case 'hann':
        default:
            for (let i = 0; i < n; i += 1) window[i] = 0.5 * (1 - Math.cos((2 * pi * i) / (n - 1)));
            break;
        }

        const coherentGain = window.reduce((acc, v) => acc + v, 0) / n;
        const power = window.reduce((acc, v) => acc + v * v, 0);
        const enbw = coherentGain === 0 ? 1 : power / (coherentGain * coherentGain * n);
        return { window, coherentGain, enbw };
    },

    applyWindow(signal = [], window) {
        if (!window || !window.length || window.length !== signal.length) return signal.slice();
        const out = new Float64Array(signal.length);
        for (let i = 0; i < signal.length; i += 1) out[i] = signal[i] * window[i];
        return out;
    },

    computeFreqAxis(length, fs) {
        const n = Math.max(1, length);
        const half = Math.floor(n / 2);
        const delta = fs / n;
        const freq = [];
        for (let i = 0; i <= half; i += 1) freq.push(i * delta);
        return { freq, deltaF: delta };
    },

    inferSampleRate(timeArray = []) {
        if (!timeArray || timeArray.length < 2) return { fs: 1, warnings: ['Insufficient time samples to infer sampling rate.'] };
        const deltas = [];
        for (let i = 0; i < timeArray.length - 1; i += 1) {
            const dt = timeArray[i + 1] - timeArray[i];
            if (Number.isFinite(dt)) deltas.push(Math.abs(dt));
        }
        if (!deltas.length) return { fs: 1, warnings: ['Unable to infer sampling rate; using 1 Hz.'] };
        const sorted = deltas.slice().sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
        const mean = deltas.reduce((acc, v) => acc + v, 0) / deltas.length;
        const spread = Math.abs(mean - median) / (median || 1);
        const fs = median > 0 ? 1 / median : 1;
        const warnings = [];
        if (spread > 0.05) warnings.push('Non-uniform sampling detected; FFT metrics may be approximate.');
        return { fs, warnings, medianDt: median };
    },

    computeSpectrum(signal = [], timeArray = [], options = {}) {
        const { selection = null, windowType = 'hann', detrend = 'removeMean', zeroPadMode = 'nextPow2', zeroPadFactor = 1, windowOpts = {} } = options;
        const indices = selection && selection.i0 !== null && selection.i1 !== null
            ? { start: Math.max(0, selection.i0), end: Math.min(signal.length - 1, selection.i1) }
            : { start: 0, end: signal.length - 1 };

        const cache = getSpectrumCache(signal);
        const key = spectrumCacheKey(signal, indices, options, timeArray);
        const cached = cache.get(key);
        if (cached) return cached;

        const sliced = signal.slice(indices.start, indices.end + 1);
        const slicedTime = timeArray.slice(indices.start, indices.end + 1);
        if (!sliced || sliced.length < 2) {
            const empty = {
                freq: [],
                magnitude: [],
                linearMagnitude: [],
                phase: [],
                warnings: sliced.length ? [] : ['Selection too short for FFT.'],
                meta: { fs: 1, deltaF: 0, nyquist: 0, coherentGain: 1, enbw: 1, medianDt: undefined },
                re: new Float64Array(0),
                im: new Float64Array(0),
                length: sliced.length,
            };
            cache.set(key, empty);
            return empty;
        }
        const { fs, warnings: timingWarnings, medianDt } = this.inferSampleRate(slicedTime.length ? slicedTime : timeArray);
        const detrended = this.applyDetrend(sliced, detrend);
        const { window, coherentGain, enbw } = this.getWindow(windowType, detrended.length, windowOpts);
        const windowed = this.applyWindow(detrended, window);

        const { re, im, length } = this.forward(windowed, { zeroPadMode, zeroPadFactor });
        const { freq, deltaF } = this.computeFreqAxis(length, fs);
        const magnitude = this.getMagnitudeDB(re, im, { coherentGain, lengthOverride: length });
        const linearMag = this.getLinearMagnitude(re, im, { coherentGain, lengthOverride: length });
        const phase = this.getPhaseDegrees(re, im, { lengthOverride: length });

        const meta = { fs, deltaF, nyquist: fs / 2, coherentGain, enbw, medianDt };
        const warnings = [...(timingWarnings || [])];
        const result = { freq, magnitude, linearMagnitude: linearMag, phase, warnings, meta, re, im, length };
        cache.set(key, result);
        return result;
    }
};

function modifiedBessel0(x) {
    let sum = 1;
    let term = 1;
    const maxIter = 50;
    for (let k = 1; k < maxIter; k += 1) {
        term *= (x * x) / (4 * k * k);
        sum += term;
        if (term < 1e-12) break;
    }
    return sum;
}