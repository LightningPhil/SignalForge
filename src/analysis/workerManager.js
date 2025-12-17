const WORKER_THRESHOLD = 75000;
let worker = null;
const pending = new Map();
let jobSeq = 0;

function isSupported() {
    return typeof Worker !== 'undefined';
}

function ensureWorker() {
    if (worker || !isSupported()) return worker;
    worker = new Worker(new URL('../workers/analysisWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => {
        const { jobId, result, error } = ev.data || {};
        const entry = pending.get(jobId);
        if (!entry) return;
        pending.delete(jobId);
        if (error) {
            entry.reject(new Error(error));
        } else {
            entry.resolve(result);
        }
    };
    worker.onerror = (err) => {
        pending.forEach((entry) => entry.reject(err));
        pending.clear();
    };
    return worker;
}

export const WorkerManager = {
    threshold: WORKER_THRESHOLD,

    isSupported() {
        return isSupported();
    },

    shouldOffload(length = 0) {
        return isSupported() && Number.isInteger(length) && length > WORKER_THRESHOLD;
    },

    run(jobType, payload = {}) {
        const target = ensureWorker();
        if (!target) return Promise.reject(new Error('Web Workers not supported'));
        const jobId = `job-${jobSeq += 1}`;
        const promise = new Promise((resolve, reject) => {
            pending.set(jobId, { resolve, reject });
        });
        target.postMessage({ jobId, type: jobType, payload });
        return promise;
    },

    cancelAll() {
        pending.forEach((entry) => entry.reject(new Error('Job cancelled')));
        pending.clear();
    }
};
