export type MarkerSnapMode = 'none' | 'sample' | 'slope' | 'curvature' | 'change-point';

export interface MarkerSuggestion {
  index: number;
  time: number;
  mode: MarkerSnapMode;
  score: number;
  confidence: number;
}

function nearestIndex(time: ArrayLike<number>, targetTime: number): number {
  let bestIndex = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < time.length; index += 1) {
    const distance = Math.abs(Number(time[index]) - targetTime);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function normalizeConfidence(score: number, scores: number[]): number {
  const finite = scores
    .filter(Number.isFinite)
    .map(Math.abs)
    .sort((a, b) => a - b);
  if (finite.length === 0) return 0;
  const median = finite[Math.floor(finite.length / 2)] || Number.EPSILON;
  return Math.max(0, Math.min(1, Math.abs(score) / (Math.abs(score) + 6 * median)));
}

export function snapMarker(
  time: ArrayLike<number>,
  values: ArrayLike<number>,
  targetTime: number,
  mode: MarkerSnapMode,
  radiusSamples = 50
): MarkerSuggestion | null {
  const length = Math.min(time.length, values.length);
  if (length === 0 || !Number.isFinite(targetTime)) return null;
  const nearest = nearestIndex(time, targetTime);
  if (mode === 'none') {
    return { index: nearest, time: targetTime, mode, score: 0, confidence: 1 };
  }
  if (mode === 'sample') {
    return { index: nearest, time: Number(time[nearest]), mode, score: 0, confidence: 1 };
  }
  const start = Math.max(1, nearest - Math.max(1, radiusSamples));
  const end = Math.min(length - 2, nearest + Math.max(1, radiusSamples));
  const candidates: Array<{ index: number; score: number }> = [];

  for (let index = start; index <= end; index += 1) {
    const previousTime = Number(time[index - 1]);
    const currentTime = Number(time[index]);
    const nextTime = Number(time[index + 1]);
    const previous = Number(values[index - 1]);
    const current = Number(values[index]);
    const next = Number(values[index + 1]);
    if (![previousTime, currentTime, nextTime, previous, current, next].every(Number.isFinite)) continue;
    let score: number;
    if (mode === 'slope') {
      score = (next - previous) / (nextTime - previousTime);
    } else if (mode === 'curvature') {
      const leftSlope = (current - previous) / (currentTime - previousTime);
      const rightSlope = (next - current) / (nextTime - currentTime);
      score = (rightSlope - leftSlope) / ((nextTime - previousTime) / 2);
    } else {
      const width = Math.min(10, index - start + 1, end - index + 1);
      if (width < 2) continue;
      let leftMean = 0;
      let rightMean = 0;
      for (let offset = 0; offset < width; offset += 1) {
        leftMean += Number(values[index - offset]);
        rightMean += Number(values[index + 1 + offset]);
      }
      score = rightMean / width - leftMean / width;
    }
    candidates.push({ index, score });
  }
  if (candidates.length === 0) return null;
  const best = candidates.reduce((selected, candidate) =>
    Math.abs(candidate.score) > Math.abs(selected.score) ? candidate : selected
  );
  return {
    index: best.index,
    time: Number(time[best.index]),
    mode,
    score: best.score,
    confidence: normalizeConfidence(
      best.score,
      candidates.map((candidate) => candidate.score)
    )
  };
}
