export function computeDerivative(t = [], y = []) {
    const len = Math.min(t.length, y.length);
    const dy = new Float64Array(len);
    for (let i = 1; i < len; i += 1) {
        const dt = t[i] - t[i - 1];
        dy[i] = dt > 0 ? (y[i] - y[i - 1]) / dt : 0;
    }
    if (len > 1) {
        dy[0] = dy[1];
    } else if (len === 1) {
        dy[0] = 0;
    }
    return dy;
}
