import { FFT } from '../processing/fft.js';

function sliceBySelection(signal = [], time = [], selection = null) {
    if (!selection || selection.i0 === null || selection.i1 === null) {
        return { y: signal.slice(), t: time.slice() };
    }
    const start = Math.max(0, selection.i0);
    const end = Math.min(signal.length - 1, selection.i1);
    return {
        y: signal.slice(start, end + 1),
        t: time.slice(start, end + 1)
    };
}

function downsampleForSpectrogram(y = [], t = [], maxPoints = 40000) {
    if (!maxPoints || y.length <= maxPoints) return { y, t, factor: 1 };
    const stride = Math.ceil(y.length / maxPoints);
    const reducedY = [];
    const reducedT = [];
    for (let i = 0; i < y.length; i += stride) {
        reducedY.push(y[i]);
        reducedT.push(t[i]);
    }
    return { y: reducedY, t: reducedT, factor: stride };
}

export const TimeFrequency = {
    /**
     * Compute a spectrogram (STFT) over the provided signal.
     * @param {Array<number>} signal
     * @param {Array<number>} timeArray
     * @param {object} options
     * @returns {{ timeBins: number[], freqBins: number[], magnitudeDb: number[][], warnings: string[], meta: object }}
     */
    computeSpectrogram(signal = [], timeArray = [], options = {}) {
        const {
            selection = null,
            windowSize = 512,
            overlap = 0.5,
            windowType = 'hann',
            detrend = 'removeMean',
            maxPoints = 40000,
            freqMin = 0,
            freqMax = null,
            windowOpts = {}
        } = options;

        const warnings = [];
        if (!signal.length || !timeArray.length) {
            return { timeBins: [], freqBins: [], magnitudeDb: [], warnings: ['No signal data'], meta: {} };
        }

        const sliced = sliceBySelection(signal, timeArray, selection);
        const downsampled = downsampleForSpectrogram(sliced.y, sliced.t, maxPoints);
        if (downsampled.factor > 1) {
            warnings.push(`Downsampled spectrogram input by ${downsampled.factor}x to ${downsampled.y.length} points.`);
        }

        const { fs, warnings: timingWarnings, medianDt } = FFT.inferSampleRate(downsampled.t.length ? downsampled.t : timeArray);
        warnings.push(...(timingWarnings || []));
        if (!Number.isFinite(fs) || fs <= 0) {
            return { timeBins: [], freqBins: [], magnitudeDb: [], warnings: ['Invalid sampling rate'], meta: {} };
        }

        const segmentLength = Math.min(windowSize, downsampled.y.length);
        const hop = Math.max(1, Math.floor(segmentLength * (1 - overlap)));
        if (segmentLength < 2 || hop <= 0) {
            return { timeBins: [], freqBins: [], magnitudeDb: [], warnings: ['Spectrogram window too small'], meta: {} };
        }

        const { window, coherentGain } = FFT.getWindow(windowType, segmentLength, windowOpts);
        const zeroPadLength = FFT.nextPowerOfTwo(segmentLength);
        const { freq: freqAxis, deltaF } = FFT.computeFreqAxis(zeroPadLength, fs);

        let freqStart = 0;
        let freqEnd = freqAxis.length;
        if (Number.isFinite(freqMin) && freqMin > 0) {
            const idx = freqAxis.findIndex((f) => f >= freqMin);
            freqStart = idx === -1 ? freqStart : idx;
        }
        if (Number.isFinite(freqMax) && freqMax > 0) {
            const idx = freqAxis.findIndex((f) => f > freqMax);
            freqEnd = idx === -1 ? freqEnd : idx;
        }

        const freqBins = freqAxis.slice(freqStart, freqEnd);
        const frames = [];
        const timeBins = [];

        for (let start = 0; start + segmentLength <= downsampled.y.length; start += hop) {
            const segment = downsampled.y.slice(start, start + segmentLength);
            const detrended = FFT.applyDetrend(segment, detrend);
            const windowed = FFT.applyWindow(detrended, window);
            const { re, im, length } = FFT.forward(windowed, { zeroPadMode: 'factor', zeroPadFactor: zeroPadLength / segmentLength });
            const mags = FFT.getMagnitudeDB(re, im, { coherentGain, lengthOverride: length });
            const frame = mags.slice(freqStart, freqEnd);
            frames.push(frame);

            const centerIdx = Math.min(downsampled.t.length - 1, start + Math.floor(segmentLength / 2));
            timeBins.push(downsampled.t[centerIdx]);
        }

        const magnitudeDb = freqBins.map((_, fi) => frames.map((frame) => frame[fi]));

        const meta = {
            fs,
            medianDt,
            hop,
            windowSize: segmentLength,
            overlap,
            nFrames: frames.length,
            freqResolution: deltaF,
            nyquist: fs / 2
        };

        return { timeBins, freqBins, magnitudeDb, warnings, meta };
    }
};
