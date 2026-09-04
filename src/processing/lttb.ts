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

export function alignedLttbIndices(
  x: ArrayLike<number>,
  alignedSeries: ArrayLike<number>[],
  threshold: number
): number[] {
  const length = Math.min(x.length, ...alignedSeries.map((series) => series.length));
  if (threshold >= length || threshold < 3) return Array.from({ length }, (_, index) => index);
  const ranges = alignedSeries.map((series) => {
    let min = Infinity;
    let max = -Infinity;
    for (let index = 0; index < length; index += 1) {
      const value = Number(series[index]);
      if (!Number.isFinite(value)) continue;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    return {
      midpoint: Number.isFinite(min) && Number.isFinite(max) ? (min + max) / 2 : 0,
      span: Number.isFinite(max - min) && max > min ? max - min : 1
    };
  });
  const selector: Point[] = Array.from({ length }, (_, index) => {
    let selected = 0;
    let largestMagnitude = -1;
    alignedSeries.forEach((series, seriesIndex) => {
      const value = Number(series[index]);
      if (!Number.isFinite(value)) return;
      const normalized = (value - ranges[seriesIndex].midpoint) / ranges[seriesIndex].span;
      if (Math.abs(normalized) > largestMagnitude) {
        selected = normalized;
        largestMagnitude = Math.abs(normalized);
      }
    });
    return [Number(x[index]), selected];
  });
  return lttbIndices(selector, threshold);
}

export function lttb(data: Point[], threshold: number): Point[] {
  return lttbIndices(data, threshold).map((index) => data[index]);
}
