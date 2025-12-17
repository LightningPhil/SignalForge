import { FFT } from '../processing/fft.js';

function normalizeSelection(selection, length) {
    if (!selection || selection.i0 === null || selection.i1 === null) return { start: 0, end: length - 1 };
    return {
        start: Math.max(0, Math.min(selection.i0, selection.i1, length - 1)),
        end: Math.min(length - 1, Math.max(selection.i0, selection.i1))
    };
}

function sliceWithSelection(arr = [], sel = { start: 0, end: arr.length - 1 }) {
    return arr.slice(sel.start, sel.end + 1);
}

function wrapPhaseDegrees(value) {
    let v = value;
    while (v > 180) v -= 360;
    while (v < -180) v += 360;
    return v;
}

export const CrossChannel = {
    estimateDelay(time = [], x = [], y = [], options = {}) {
        const { selection = null, maxLagSeconds = null } = options;
        if (!Array.isArray(time) || time.length < 2 || !Array.isArray(x) || !Array.isArray(y)) {
            return { delay: 0, correlation: 0, warnings: ['Insufficient data for delay estimation.'] };
        }

        const sel = normalizeSelection(selection, Math.min(x.length, y.length, time.length));
        const tx = sliceWithSelection(time, sel);
        const xSel = sliceWithSelection(x, sel);
        const ySel = sliceWithSelection(y, sel);
        if (tx.length < 2 || xSel.length < 2 || ySel.length < 2) {
            return { delay: 0, correlation: 0, warnings: ['Selection too short for delay estimation.'] };
        }

        const { fs, warnings: timingWarnings } = FFT.inferSampleRate(tx);
        const maxLagSamples = maxLagSeconds ? Math.min(Math.floor(maxLagSeconds * fs), tx.length - 1) : Math.min(tx.length - 1, 2000);
        let bestCorr = -Infinity;
        let bestLag = 0;

        for (let lag = -maxLagSamples; lag <= maxLagSamples; lag += 1) {
            let num = 0;
            let denomX = 0;
            let denomY = 0;
            for (let i = 0; i < xSel.length; i += 1) {
                const j = i + lag;
                if (j < 0 || j >= ySel.length) continue;
                const xv = xSel[i];
                const yv = ySel[j];
                num += xv * yv;
                denomX += xv * xv;
                denomY += yv * yv;
            }
            const denom = Math.sqrt(denomX * denomY) || 1;
            const corr = num / denom;
            if (corr > bestCorr) {
                bestCorr = corr;
                bestLag = lag;
            }
        }

        return {
            delay: bestLag / fs,
            correlation: bestCorr,
            warnings: timingWarnings || []
        };
    },

    computeTransferFunction(input = [], output = [], time = [], options = {}) {
        const { selection = null, windowType = 'hann', detrend = 'removeMean', zeroPadMode = 'nextPow2', zeroPadFactor = 1 } = options;
        if (!input.length || !output.length || !time.length) {
            return { freq: [], magnitudeDb: [], phaseDeg: [], coherence: [], warnings: ['Missing input/output data.'], meta: {} };
        }

        const sel = normalizeSelection(selection, Math.min(input.length, output.length, time.length));
        const x = sliceWithSelection(input, sel);
        const y = sliceWithSelection(output, sel);
        const t = sliceWithSelection(time, sel);

        const baseOpts = { selection: { i0: 0, i1: x.length - 1 }, windowType, detrend, zeroPadMode, zeroPadFactor };
        const inSpec = FFT.computeSpectrum(x, t, baseOpts);
        const outSpec = FFT.computeSpectrum(y, t, baseOpts);

        const n = Math.min(inSpec.freq.length, outSpec.freq.length);
        const freq = inSpec.freq.slice(0, n);
        const magnitudeDb = [];
        const phaseDeg = [];
        const coherence = [];

        for (let i = 0; i < n; i += 1) {
            const inMag = Math.max(inSpec.linearMagnitude[i] || 0, 1e-12);
            const outMag = Math.max(outSpec.linearMagnitude[i] || 0, 1e-12);
            magnitudeDb.push(20 * Math.log10(outMag / inMag));

            const phase = wrapPhaseDegrees((outSpec.phase[i] || 0) - (inSpec.phase[i] || 0));
            phaseDeg.push(phase);

            const reX = inSpec.re[i] || 0;
            const imX = inSpec.im[i] || 0;
            const reY = outSpec.re[i] || 0;
            const imY = outSpec.im[i] || 0;
            const sxyRe = reY * reX + imY * imX;
            const sxyIm = imY * reX - reY * imX;
            const sxyMag2 = sxyRe * sxyRe + sxyIm * sxyIm;
            const sxx = reX * reX + imX * imX;
            const syy = reY * reY + imY * imY;
            const coh = sxx > 0 && syy > 0 ? Math.min(1, sxyMag2 / (sxx * syy + 1e-24)) : 0;
            coherence.push(coh);
        }

        const warnings = [...(inSpec.warnings || []), ...(outSpec.warnings || [])];
        return {
            freq,
            magnitudeDb,
            phaseDeg,
            coherence,
            warnings,
            meta: { fs: inSpec.meta?.fs || outSpec.meta?.fs || null }
        };
    }
};
