type Point = [number, number];

export function lttbIndices(data: Point[], threshold: number): number[] {
  const dataLength = data.length;

  if (!Array.isArray(data) || threshold >= dataLength || threshold < 3) {
    return Array.from({ length: dataLength }, (_, index) => index);
  }

  const sampled: number[] = [];
  let sampledIndex = 0;
  const every = (dataLength - 2) / (threshold - 2);

  let a = 0;
  sampled[sampledIndex++] = a;

  for (let i = 0; i < threshold - 2; i++) {
    let avgX = 0;
    let avgY = 0;
    let avgRangeStart = Math.floor((i + 1) * every) + 1;
    let avgRangeEnd = Math.floor((i + 2) * every) + 1;
    avgRangeEnd = avgRangeEnd < dataLength ? avgRangeEnd : dataLength;

    const avgRangeLength = avgRangeEnd - avgRangeStart;
    if (avgRangeLength <= 0) continue;

    for (; avgRangeStart < avgRangeEnd; avgRangeStart++) {
      avgX += data[avgRangeStart][0];
      avgY += data[avgRangeStart][1];
    }

    avgX /= avgRangeLength;
    avgY /= avgRangeLength;

    let rangeOffs = Math.floor(i * every) + 1;
    const rangeTo = Math.floor((i + 1) * every) + 1;
    const pointAx = data[a][0];
    const pointAy = data[a][1];

    let maxArea = -1;
    let nextA = a;

    for (; rangeOffs < rangeTo; rangeOffs++) {
      const area =
        Math.abs(
          (pointAx - avgX) * (data[rangeOffs][1] - pointAy) - (pointAx - data[rangeOffs][0]) * (avgY - pointAy)
        ) * 0.5;

      if (area > maxArea) {
        maxArea = area;
        nextA = rangeOffs;
      }
    }

    if (maxArea < 0) {
      const fallbackIdx = Math.min(dataLength - 2, Math.max(1, rangeTo - 1));
      nextA = fallbackIdx;
    }

    sampled[sampledIndex++] = nextA;
    a = nextA;
  }

  sampled[sampledIndex] = dataLength - 1;
  return sampled;
}

/**
 * Shared-index display downsampling for time-aligned traces (raw, processed, residual).
 *
 * Every trace is downsampled with its own LTTB pass and the selected indices are merged, so a
 * feature that is visually important in any one trace survives in all of them. A single combined
 * selector was previously used; one outlier in a low-variance trace (typically the residual) shifted
 * that trace's normalisation and hid full-scale glitches in the other traces. The per-trace budget
 * is the largest value (found by bisection between `threshold / traceCount` and `threshold`) whose
 * merged index set still fits the requested point budget, so similar traces keep full resolution.
 */
export function alignedLttbIndices(
  x: ArrayLike<number>,
  alignedSeries: ArrayLike<number>[],
  threshold: number
): number[] {
  const length = Math.min(x.length, ...alignedSeries.map((series) => series.length));
  if (threshold >= length || threshold < 3) return Array.from({ length }, (_, index) => index);
  const xs = Array.from({ length }, (_, index) => Number(x[index]));
  // Non-finite samples cannot form triangles; substitute the running finite value for selection
  // purposes only (the caller still plots the original NaN at that index).
  const pointSets: Point[][] = alignedSeries.map((series) => {
    let lastFinite = 0;
    const points: Point[] = new Array(length);
    for (let index = 0; index < length; index += 1) {
      const value = Number(series[index]);
      if (Number.isFinite(value)) lastFinite = value;
      points[index] = [xs[index], lastFinite];
    }
    return points;
  });
  const unionFor = (budget: number): number[] => {
    const selected = new Uint8Array(length);
    for (const points of pointSets) for (const index of lttbIndices(points, budget)) selected[index] = 1;
    const indices: number[] = [];
    for (let index = 0; index < length; index += 1) if (selected[index]) indices.push(index);
    return indices;
  };
  let low = Math.max(3, Math.floor(threshold / Math.max(1, pointSets.length)));
  let high = threshold;
  let best = unionFor(high);
  if (best.length <= threshold) return best;
  best = unionFor(low);
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    const candidate = unionFor(middle);
    if (candidate.length <= threshold) {
      best = candidate;
      low = middle;
    } else {
      high = middle;
    }
  }
  return best;
}

export function lttb(data: Point[], threshold: number): Point[] {
  return lttbIndices(data, threshold).map((index) => data[index]);
}
