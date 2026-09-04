/**
 * Backward-difference derivative on the actual timestamps. Intervals whose timestamp does not
 * advance (duplicate or reversed) or whose samples are non-finite yield NaN rather than a fabricated
 * zero slope, so callers skip them instead of treating them as flat. The first sample reuses the
 * first valid difference (there is no earlier sample to difference against).
 */
export function computeDerivative(t: ArrayLike<number> = [], y: ArrayLike<number> = []): Float64Array {
  const len = Math.min(t.length, y.length);
  const dy = new Float64Array(len);
  for (let i = 1; i < len; i += 1) {
    const dt = t[i] - t[i - 1];
    const dv = y[i] - y[i - 1];
    dy[i] = dt > 0 && Number.isFinite(dv) ? dv / dt : Number.NaN;
  }
  if (len > 1) dy[0] = dy[1];
  else if (len === 1) dy[0] = Number.NaN;
  return dy;
}
