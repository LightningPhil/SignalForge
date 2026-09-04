export interface PulseLevels {
  baseline: number;
  top: number;
  amplitude: number;
  polarity: 1 | -1;
  lowThreshold: number;
  highThreshold: number;
  peakIndex: number;
  warnings: string[];
}

function percentile(values: number[], fraction: number): number {
  const sorted = values.slice().sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  const position = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * fraction));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function median(values: number[]): number {
  return percentile(values, 0.5);
}

export function estimatePulseLevels(
  values: number[],
  options: { lowFraction?: number; highFraction?: number; baselineFraction?: number } = {}
): PulseLevels | null {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 3) return null;
  const baselineCount = Math.max(
    3,
    Math.min(values.length, Math.floor(values.length * (options.baselineFraction ?? 0.1)))
  );
  const edgeValues = [
    ...values.slice(0, baselineCount).filter(Number.isFinite),
    ...values.slice(-baselineCount).filter(Number.isFinite)
  ];
  const baseline = edgeValues.length > 0 ? median(edgeValues) : median(finite);
  let min = Infinity;
  let max = -Infinity;
  let minIndex = 0;
  let maxIndex = 0;
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) return;
    if (value < min) {
      min = value;
      minIndex = index;
    }
    if (value > max) {
      max = value;
      maxIndex = index;
    }
  });
  const positiveExcursion = max - baseline;
  const negativeExcursion = baseline - min;
  const polarity: 1 | -1 = positiveExcursion >= negativeExcursion ? 1 : -1;
  const peakIndex = polarity === 1 ? maxIndex : minIndex;
  const peakExcursion = Math.max(positiveExcursion, negativeExcursion);
  const baselineMad = median(edgeValues.map((value) => Math.abs(value - baseline)));
  const minimumExcursion = Math.max(Number.EPSILON, peakExcursion * 0.01, baselineMad * 1.4826 * 6);
  const excursions = finite
    .map((value) => polarity * (value - baseline))
    .filter((value) => value >= minimumExcursion)
    .sort((left, right) => left - right);
  const clusterTolerance = Math.max(Number.EPSILON, peakExcursion * 0.02, baselineMad * 1.4826 * 3);
  const clusters: number[][] = [];
  for (const excursion of excursions) {
    const current = clusters[clusters.length - 1];
    if (!current || excursion - current[0] > clusterTolerance) clusters.push([excursion]);
    else current.push(excursion);
  }
  const stateCluster = clusters.reduce<number[]>(
    (selected, cluster) =>
      cluster.length > selected.length || (cluster.length === selected.length && median(cluster) > median(selected))
        ? cluster
        : selected,
    []
  );
  const stateExcursion = stateCluster.length > 0 ? median(stateCluster) : peakExcursion;
  const top = baseline + polarity * stateExcursion;
  const amplitude = top - baseline;
  const lowFraction = options.lowFraction ?? 0.1;
  const highFraction = options.highFraction ?? 0.9;
  const warnings: string[] = [];
  if (!Number.isFinite(amplitude) || Math.abs(amplitude) <= Number.EPSILON) {
    warnings.push('Unable to separate baseline and pulse state levels.');
  }
  if (stateCluster.length < 3) {
    warnings.push('Pulse top-state estimate is based on fewer than three samples.');
  }
  if (peakIndex < baselineCount || peakIndex >= values.length - baselineCount) {
    warnings.push('Pulse peak lies in the baseline-estimation edge region.');
  }
  return {
    baseline,
    top,
    amplitude,
    polarity,
    lowThreshold: baseline + amplitude * lowFraction,
    highThreshold: baseline + amplitude * highFraction,
    peakIndex,
    warnings
  };
}

export function interpolateCrossing(
  time0: number,
  value0: number,
  time1: number,
  value1: number,
  threshold: number
): number {
  const difference = value1 - value0;
  if (!Number.isFinite(difference) || difference === 0) return time1;
  const fraction = Math.max(0, Math.min(1, (threshold - value0) / difference));
  return time0 + (time1 - time0) * fraction;
}

export function findCrossingBeforePeak(
  time: number[],
  values: number[],
  threshold: number,
  peakIndex: number,
  rising: boolean,
  sourceIndices?: number[]
): number | null {
  let crossing: number | null = null;
  for (let index = 1; index <= peakIndex; index += 1) {
    if (sourceIndices && sourceIndices[index] !== sourceIndices[index - 1] + 1) continue;
    const previous = values[index - 1];
    const current = values[index];
    const crossed = rising
      ? previous <= threshold && current >= threshold
      : previous >= threshold && current <= threshold;
    if (crossed) crossing = interpolateCrossing(time[index - 1], previous, time[index], current, threshold);
  }
  return crossing;
}

export function findCrossingAfterPeak(
  time: number[],
  values: number[],
  threshold: number,
  peakIndex: number,
  falling: boolean,
  sourceIndices?: number[]
): number | null {
  for (let index = Math.max(1, peakIndex + 1); index < values.length; index += 1) {
    if (sourceIndices && sourceIndices[index] !== sourceIndices[index - 1] + 1) continue;
    const previous = values[index - 1];
    const current = values[index];
    const crossed = falling
      ? previous >= threshold && current <= threshold
      : previous <= threshold && current >= threshold;
    if (crossed) return interpolateCrossing(time[index - 1], previous, time[index], current, threshold);
  }
  return null;
}
