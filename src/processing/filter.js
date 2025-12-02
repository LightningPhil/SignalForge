import { FFT } from './fft.js';

/**
 * Filter Processing Engine
 */
export const Filter = {

    applyPipeline(dataArray, timeArray, pipeline) {
        if (!dataArray || dataArray.length === 0) return [];

        const normalizedPipeline = (pipeline && pipeline.length > 0)
            ? pipeline
            : [{ id: 'null-filter', type: 'nullFilter', enabled: true }];

        let currentData = [...dataArray];

        // Calculate Sampling Rate (Fs)
        let fs = 1.0;
        if(timeArray && timeArray.length > 1) {
            const limit = Math.min(100, timeArray.length - 1);
            let sumDt = 0;
            for(let i=0; i<limit; i++) sumDt += (timeArray[i+1] - timeArray[i]);
            const avgDt = sumDt / limit;
            if(avgDt > 0) fs = 1.0 / avgDt;
        }

        normalizedPipeline.forEach(step => {
            if (!step.enabled) return;

            switch(step.type) {
                case 'nullFilter':
                    currentData = [...currentData];
                    break;
                // Time Domain
                case 'movingAverage':
                    currentData = this.movingAverage(currentData, step.windowSize);
                    break;
                case 'savitzkyGolay':
                    const iters = Math.max(1, Math.min(16, step.iterations || 1));
                    for(let i=0; i<iters; i++) {
                        currentData = this.savitzkyGolay(currentData, step.windowSize, step.polyOrder);
                    }
                    break;
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
                
                // Frequency Domain
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

    /**
     * Calculates the Combined Transfer Function H(f) for all active FFT filters in pipeline.
     * @returns {Array} Array of Gain values (linear 0-1) for plot
     */
    calculateTransferFunction(pipeline, fs, points) {
        const transfer = new Array(points).fill(1.0); // Start at unity gain
        const binWidth = (fs / 2) / points; // Nyquist / points

        pipeline.forEach(step => {
            if (!step.enabled) return;
            if (!['lowPassFFT','highPassFFT','notchFFT'].includes(step.type)) return;

            for(let i=0; i < points; i++) {
                const freq = i * binWidth;
                let gain = 1.0;

                if (step.type === 'notchFFT') {
                    const center = step.centerFreq;
                    const bw = step.bandwidth;
                    if (freq >= (center - bw/2) && freq <= (center + bw/2)) {
                        gain = 0.0;
                    }
                } else {
                    const fc = step.cutoffFreq;
                    const slope = step.slope || 12;
                    const order = Math.max(1, Math.round(slope / 6));
                    
                    let ratio = (step.type === 'lowPassFFT') ? (freq / fc) : (fc / freq);
                    gain = 1.0 / Math.sqrt(1 + Math.pow(ratio, 2 * order));
                }
                
                transfer[i] *= gain;
            }
        });

        return transfer;
    },

    // --- FFT Logic ---

    applyFFTFilter(data, fs, type, config) {
        const len = data.length;
        const { re, im } = FFT.forward(data);
        const n = re.length; 
        const binWidth = fs / n;

        for(let i=0; i <= n/2; i++) {
            const freq = i * binWidth;
            let gain = 1.0;

            if (type === 'notch') {
                const center = config.centerFreq;
                const bw = config.bandwidth;
                if (freq >= (center - bw/2) && freq <= (center + bw/2)) {
                    gain = 0.0;
                }
            } else {
                const fc = config.cutoffFreq;
                const slope = config.slope || 12; 
                const order = Math.max(1, Math.round(slope / 6));
                
                let ratio = (type === 'lowpass') ? (freq / fc) : (fc / freq);
                gain = 1.0 / Math.sqrt(1 + Math.pow(ratio, 2 * order));
            }

            re[i] *= gain;
            im[i] *= gain;
            
            if (i > 0 && i < n/2) {
                const mirror = n - i;
                re[mirror] *= gain;
                im[mirror] *= gain;
            }
        }

        return FFT.inverse(re, im, len);
    },

    // --- Time Domain Algorithms ---

    getReflectedValue(data, index) {
        const len = data.length;
        if (index >= 0 && index < len) return data[index];
        if (index < 0) return data[-index < len ? -index : 0]; 
        if (index >= len) {
            const r = len - 2 - (index - len);
            return data[r >= 0 ? r : len - 1];
        }
    },

    movingAverage(data, windowSize) {
        const result = new Array(data.length).fill(0);
        const gap = Math.floor(windowSize / 2);
        for (let i = 0; i < data.length; i++) {
            let sum = 0;
            for (let j = -gap; j <= gap; j++) sum += this.getReflectedValue(data, i + j);
            result[i] = sum / windowSize;
        }
        return result;
    },

    median(data, windowSize) {
        const result = new Array(data.length).fill(0);
        const gap = Math.floor(windowSize / 2);
        const len = data.length;
        for (let i = 0; i < len; i++) {
            const window = [];
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

    iirLowPass(data, alpha) {
        const result = [];
        let prev = data[0]; 
        result.push(prev);
        for (let i = 1; i < data.length; i++) {
            const current = data[i];
            const smoothed = (alpha * current) + ((1 - alpha) * prev);
            result.push(smoothed);
            prev = smoothed;
        }
        return result;
    },

    savitzkyGolay(data, windowSize, order) {
        if (windowSize % 2 === 0) windowSize++;
        const half = Math.floor(windowSize / 2);
        const result = new Array(data.length).fill(0);
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

    gaussian(data, sigma, kernelSize) {
        if (kernelSize % 2 === 0) kernelSize++;
        const half = Math.floor(kernelSize / 2);
        const kernel = this.computeGaussianKernel(sigma, kernelSize);
        const result = new Array(data.length).fill(0);
        for (let i = 0; i < data.length; i++) {
            let sum = 0;
            for (let j = -half; j <= half; j++) {
                sum += this.getReflectedValue(data, i + j) * kernel[j + half];
            }
            result[i] = sum;
        }
        return result;
    },

    startStopNorm(data, config) {
        const {
            startLength = undefined,
            endLength = undefined,
            decayLength = undefined,
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

        const resolveAutoOffset = () => {
            if (!autoOffset) return startOffset;
            const sampleCount = Math.min(Math.max(1, Math.floor(autoOffsetPoints || 1)), len);
            let sum = 0;
            for (let i = 0; i < sampleCount; i++) sum += data[i];
            return sum / sampleCount;
        };

        const offsetToApply = resolveAutoOffset();
        const tapered = data.map(v => v - offsetToApply);

        const fadeFactor = (i, length) => {
            if (length <= 0) return 1;
            if (length === 1) return 0;
            const ratio = i / (length - 1);
            return Math.sin(ratio * (Math.PI / 2));
        };

        for (let i = 0; i < startSafe; i++) {
            tapered[i] *= fadeFactor(i, startSafe);
        }

        for (let i = 0; i < endSafe; i++) {
            tapered[len - 1 - i] *= fadeFactor(i, endSafe);
        }

        return tapered;
    },

    // --- Helpers ---

    computeSGWeights(m, order) {
        const windowSize = 2 * m + 1;
        const A = [];
        for (let i = -m; i <= m; i++) {
            const row = [];
            for (let j = 0; j <= order; j++) { row.push(Math.pow(i, j)); }
            A.push(row);
        }
        const AT = this.transpose(A);
        const ATA = this.multiplyMatrices(AT, A);
        const ATAInv = this.invertMatrix(ATA);
        const C = this.multiplyMatrices(ATAInv, AT);
        return C[0]; 
    },

    computeGaussianKernel(sigma, size) {
        const kernel = [];
        const center = Math.floor(size / 2);
        let sum = 0;
        for (let i = 0; i < size; i++) {
            const x = i - center;
            const val = Math.exp(-(x * x) / (2 * sigma * sigma));
            kernel.push(val);
            sum += val;
        }
        return kernel.map(v => v / sum);
    },

    transpose(matrix) { return matrix[0].map((_, c) => matrix.map(r => r[c])); },
    
    multiplyMatrices(m1, m2) {
        let result = [];
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

    invertMatrix(M){
        let n = M.length;
        let A = M.map(row => [...row]);
        let I = [];
        for(let i=0; i<n; i++){
            let row = new Array(n).fill(0);
            row[i] = 1;
            I.push(row);
        }
        A.forEach((r,i) => r.push(...I[i]));
        for(let i=0; i<n; i++){
            let pivot = A[i][i];
            for(let j=i; j<2*n; j++) A[i][j] /= pivot;
            for(let k=0; k<n; k++){
                if(k!==i){
                    let factor = A[k][i];
                    for(let j=i; j<2*n; j++) A[k][j] -= factor * A[i][j];
                }
            }
        }
        return A.map(r => r.slice(n));
    }
};

export function applyXOffset(data = [], offset = 0) {
    const source = Array.isArray(data) || ArrayBuffer.isView(data) ? data : [];
    const len = source.length;
    const intOffset = Math.round(offset || 0);

    if (len === 0) return [];
    if (intOffset === 0) return Array.isArray(source) ? [...source] : source.slice();

    const shifted = Array.isArray(source) ? new Array(len) : new source.constructor(len);

    for (let i = 0; i < len; i++) {
        const sourceIdx = i - intOffset;

        if (sourceIdx >= 0 && sourceIdx < len) {
            shifted[i] = source[sourceIdx];
        } else {
            shifted[i] = sourceIdx < 0 ? source[0] : source[len - 1];
        }
    }

    return shifted;
}