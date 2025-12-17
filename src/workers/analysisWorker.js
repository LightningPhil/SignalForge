import { FFT } from '../processing/fft.js';
import { TimeFrequency } from '../analysis/timeFrequency.js';
import { CrossChannel } from '../analysis/crossChannel.js';

self.onmessage = (ev) => {
    const { jobId, type, payload } = ev.data || {};
    try {
        let result = null;
        if (type === 'fft') {
            const opts = { ...(payload.options || {}), useWorker: false };
            result = FFT.computeSpectrum(payload.signal || [], payload.time || [], opts);
        } else if (type === 'stft') {
            const opts = { ...(payload.options || {}), useWorker: false };
            result = TimeFrequency.computeSpectrogram(payload.signal || [], payload.time || [], opts);
        } else if (type === 'correlation') {
            const opts = payload.options || {};
            result = CrossChannel.estimateDelay(payload.time || [], payload.x || [], payload.y || [], opts);
        }
        self.postMessage({ jobId, result });
    } catch (err) {
        self.postMessage({ jobId, error: err?.message || 'Worker error' });
    }
};
