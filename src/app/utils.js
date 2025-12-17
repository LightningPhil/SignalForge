export function debounce(fn, delay = 300) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(null, args), delay);
    };
}

export function formatSeconds(value) {
    if (!Number.isFinite(value)) return 'n/a';
    const abs = Math.abs(value);
    if (abs < 1e-6) return `${(value * 1e9).toFixed(3)} ns`;
    if (abs < 1e-3) return `${(value * 1e6).toFixed(3)} µs`;
    if (abs < 1) return `${(value * 1e3).toFixed(3)} ms`;
    if (abs >= 1000) return `${value.toExponential(3)} s`;
    return `${value.toFixed(6).replace(/\.0+$/, '').replace(/\.([0-9]*?)0+$/, '.$1')} s`;
}

export function selectionKey(selection) {
    if (!selection || selection.i0 === null || selection.i1 === null) return 'full';
    return `${selection.i0}-${selection.i1}`;
}

export function seriesSignature(series = {}, sourceLabel = 'raw') {
    const { rawX = [], rawY = [], filteredY = [], seriesName = 'series', isMath = false } = series;
    const y = sourceLabel === 'filtered' ? filteredY : rawY;
    const firstX = rawX[0] ?? 0;
    const lastX = rawX[rawX.length - 1] ?? 0;
    const firstY = y[0] ?? 0;
    const lastY = y[y.length - 1] ?? 0;
    return [
        seriesName,
        isMath ? 'math' : 'raw',
        sourceLabel,
        rawX.length,
        y.length,
        firstX,
        lastX,
        firstY,
        lastY
    ].join('|');
}
