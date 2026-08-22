type Point = [number, number];

export function lttb(data: Point[], threshold: number): Point[] {
  const dataLength = data.length;

  if (!Array.isArray(data) || threshold >= dataLength || threshold < 3) {
    return data;
  }

  const sampled: Point[] = [];
  let sampledIndex = 0;
  const every = (dataLength - 2) / (threshold - 2);

  let a = 0;
  sampled[sampledIndex++] = data[a];

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

    let maxAreaPoint: Point | null = null;
    let maxArea = -1;
    let nextA = a;

    for (; rangeOffs < rangeTo; rangeOffs++) {
      const area = Math.abs(
        (pointAx - avgX) * (data[rangeOffs][1] - pointAy) -
        (pointAx - data[rangeOffs][0]) * (avgY - pointAy)
      ) * 0.5;

      if (area > maxArea) {
        maxArea = area;
        maxAreaPoint = data[rangeOffs];
        nextA = rangeOffs;
      }
    }

    if (!maxAreaPoint) {
      const fallbackIdx = Math.min(dataLength - 2, Math.max(1, rangeTo - 1));
      maxAreaPoint = data[fallbackIdx];
      nextA = fallbackIdx;
    }

    sampled[sampledIndex++] = maxAreaPoint;
    a = nextA;
  }

  sampled[sampledIndex++] = data[dataLength - 1];
  return sampled;
}
