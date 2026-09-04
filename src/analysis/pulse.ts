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

/** A threshold crossing located between samples `index - 1` and `index`, at interpolated `time`. */
export interface Crossing {
  index: number;
  time: number;
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

const MIN_BINS = 16;
const MAX_BINS = 256;

interface StateCandidate {
  level: number;
  /** Samples in the mode bin and its two neighbours. */
  population: number;
}

/**
 * Locates the most populated histogram bin among those allowed by `accept` (neighbouring bins break
 * ties), refining the level to the median of the samples inside the bin and its immediate
 * neighbours. The median keeps a clean plateau exact while staying unbiased for a noisy one.
 */
function findMode(
  finite: number[],
  counts: Int32Array,
  min: number,
  binWidth: number,
  accept: (binIndex: number) => boolean
): StateCandidate | null {
  const bins = counts.length;
  let bestBin = -1;
  let bestCount = -1;
  let bestScore = -1;
  for (let bin = 0; bin < bins; bin += 1) {
    if (!accept(bin)) continue;
    const score = counts[bin] + (bin > 0 ? counts[bin - 1] : 0) + (bin < bins - 1 ? counts[bin + 1] : 0);
    if (counts[bin] > bestCount || (counts[bin] === bestCount && score > bestScore)) {
      bestCount = counts[bin];
      bestScore = score;
      bestBin = bin;
    }
  }
  if (bestBin < 0 || bestCount <= 0) return null;
  const lower = min + (bestBin - 1) * binWidth;
  const upper = min + (bestBin + 2) * binWidth;
  const members = finite.filter((value) => value >= lower && value <= upper);
  return { level: members.length > 0 ? median(members) : min + (bestBin + 0.5) * binWidth, population: bestScore };
}

/**
 * Estimates the two state levels of a pulse record using the histogram (mode) method of IEEE 181:
 * the low and high states are the two most populated amplitude modes, so overshoot, ringing and
 * slow edges (which are sparse in amplitude) do not bias them and the estimate does not depend on
 * where in the record the pulse sits. Baseline/top assignment prefers the state occupying the record
 * edges; when the record starts and ends in different states the more populated (then lower) state
 * is the baseline. This follows the standard's state-level method but makes no formal conformance
 * claim.
 */
export function estimatePulseLevels(
  values: number[],
  options: { lowFraction?: number; highFraction?: number; baselineFraction?: number } = {}
): PulseLevels | null {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 3) return null;
  const warnings: string[] = [];
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
  const range = max - min;
  const lowFraction = options.lowFraction ?? 0.1;
  const highFraction = options.highFraction ?? 0.9;
  if (!(range > 0)) {
    return {
      baseline: min,
      top: min,
      amplitude: 0,
      polarity: 1,
      lowThreshold: min,
      highThreshold: min,
      peakIndex: maxIndex,
      warnings: ['Unable to separate baseline and pulse state levels.']
    };
  }

  const bins = Math.max(MIN_BINS, Math.min(MAX_BINS, Math.round(Math.sqrt(finite.length))));
  const binWidth = range / bins;
  const counts = new Int32Array(bins);
  for (const value of finite) {
    counts[Math.min(bins - 1, Math.floor((value - min) / binWidth))] += 1;
  }
  const binCenter = (bin: number) => min + (bin + 0.5) * binWidth;

  const first = findMode(finite, counts, min, binWidth, () => true);
  if (!first) return null;
  // Noise scale of the dominant state: spread of the samples in the half of the range nearer to it.
  const nearFirst = finite.filter((value) => Math.abs(value - first.level) < range / 2);
  const firstMad = median(nearFirst.map((value) => Math.abs(value - first.level)));
  const minimumSeparation = Math.max(2 * binWidth, firstMad * 1.4826 * 6, range * 0.01);
  const second = findMode(
    finite,
    counts,
    min,
    binWidth,
    (bin) => Math.abs(binCenter(bin) - first.level) >= minimumSeparation
  );

  let low: StateCandidate;
  let high: StateCandidate;
  if (second) {
    [low, high] = first.level <= second.level ? [first, second] : [second, first];
  } else {
    // Only one populated mode: treat the farthest excursion as a (sparse) second state.
    const extreme = max - first.level >= first.level - min ? max : min;
    const sparse: StateCandidate = { level: extreme, population: 1 };
    [low, high] = extreme >= first.level ? [first, sparse] : [sparse, first];
    warnings.push('Pulse top-state estimate is based on fewer than three samples.');
  }
  if (second && Math.min(low.population, high.population) < 3) {
    warnings.push('Pulse top-state estimate is based on fewer than three samples.');
  }

  // Baseline = the state the record rests in at its edges. The outermost samples are consulted
  // first (a 90 % duty pulse still starts and ends on its baseline); a wider window is the fallback.
  const edgePolarity = (fraction: number): 1 | -1 | null => {
    const count = Math.max(3, Math.min(values.length, Math.floor(values.length * fraction)));
    const edgeValues = [
      ...values.slice(0, count).filter(Number.isFinite),
      ...values.slice(-count).filter(Number.isFinite)
    ];
    let nearLow = 0;
    let nearHigh = 0;
    for (const value of edgeValues) {
      if (Math.abs(value - low.level) <= Math.abs(value - high.level)) nearLow += 1;
      else nearHigh += 1;
    }
    if (edgeValues.length === 0) return null;
    if (nearLow >= (2 * edgeValues.length) / 3) return 1;
    if (nearHigh >= (2 * edgeValues.length) / 3) return -1;
    return null;
  };
  let polarity: 1 | -1;
  const edgeDecision = edgePolarity(0.02) ?? edgePolarity(options.baselineFraction ?? 0.1);
  if (edgeDecision !== null) polarity = edgeDecision;
  else {
    polarity = low.population > high.population ? 1 : high.population > low.population ? -1 : 1;
    warnings.push(
      'Record starts and ends in different states; the baseline was assigned to the more populated (or lower) state.'
    );
  }
  const baseline = polarity === 1 ? low.level : high.level;
  const top = polarity === 1 ? high.level : low.level;
  const amplitude = top - baseline;
  const peakIndex = polarity === 1 ? maxIndex : minIndex;
  if (!Number.isFinite(amplitude) || Math.abs(amplitude) <= Number.EPSILON) {
    warnings.push('Unable to separate baseline and pulse state levels.');
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

function crossed(previous: number, current: number, threshold: number, rising: boolean): boolean {
  return rising ? previous <= threshold && current >= threshold : previous >= threshold && current <= threshold;
}

/**
 * Last crossing of `threshold` in the given direction whose upper sample index is at most `endIndex`.
 */
export function lastCrossingBefore(
  time: number[],
  values: number[],
  threshold: number,
  endIndex: number,
  rising: boolean,
  sourceIndices?: number[]
): Crossing | null {
  for (let index = Math.min(endIndex, values.length - 1); index >= 1; index -= 1) {
    if (sourceIndices && sourceIndices[index] !== sourceIndices[index - 1] + 1) continue;
    const previous = values[index - 1];
    const current = values[index];
    if (crossed(previous, current, threshold, rising)) {
      return { index, time: interpolateCrossing(time[index - 1], previous, time[index], current, threshold) };
    }
  }
  return null;
}

/**
 * First crossing of `threshold` in the given direction whose upper sample index is at least `startIndex`.
 */
export function firstCrossingAfter(
  time: number[],
  values: number[],
  threshold: number,
  startIndex: number,
  rising: boolean,
  sourceIndices?: number[]
): Crossing | null {
  for (let index = Math.max(1, startIndex); index < values.length; index += 1) {
    if (sourceIndices && sourceIndices[index] !== sourceIndices[index - 1] + 1) continue;
    const previous = values[index - 1];
    const current = values[index];
    if (crossed(previous, current, threshold, rising)) {
      return { index, time: interpolateCrossing(time[index - 1], previous, time[index], current, threshold) };
    }
  }
  return null;
}

export function findCrossingBeforePeak(
  time: number[],
  values: number[],
  threshold: number,
  peakIndex: number,
  rising: boolean,
  sourceIndices?: number[]
): number | null {
  return lastCrossingBefore(time, values, threshold, peakIndex, rising, sourceIndices)?.time ?? null;
}

export function findCrossingAfterPeak(
  time: number[],
  values: number[],
  threshold: number,
  peakIndex: number,
  falling: boolean,
  sourceIndices?: number[]
): number | null {
  return firstCrossingAfter(time, values, threshold, peakIndex + 1, !falling, sourceIndices)?.time ?? null;
}

export interface PulseTransitions {
  riseStart: number | null;
  riseEnd: number | null;
  fallStart: number | null;
  fallEnd: number | null;
  widthStart: number | null;
  widthEnd: number | null;
}

/**
 * Locates the rising and falling transitions adjacent to the pulse's mesial (50 %) crossings, in the
 * manner of IEEE 181: the rising transition is bounded by the low-reference crossing immediately
 * before and the high-reference crossing immediately after the first mesial crossing, and the
 * falling transition likewise around the last mesial crossing. Overshoot and ringing on the top
 * therefore cannot masquerade as the start of the fall.
 */
export function locatePulseTransitions(
  time: number[],
  values: number[],
  levels: PulseLevels,
  sourceIndices?: number[]
): PulseTransitions {
  const rising = levels.polarity === 1;
  const midThreshold = levels.baseline + levels.amplitude * 0.5;
  const mesialStart = lastCrossingBefore(time, values, midThreshold, levels.peakIndex, rising, sourceIndices);
  const mesialEnd = firstCrossingAfter(time, values, midThreshold, levels.peakIndex + 1, !rising, sourceIndices);

  const riseStart = mesialStart
    ? lastCrossingBefore(time, values, levels.lowThreshold, mesialStart.index, rising, sourceIndices)
    : null;
  const riseEnd = mesialStart
    ? firstCrossingAfter(time, values, levels.highThreshold, mesialStart.index, rising, sourceIndices)
    : null;
  const fallStart = mesialEnd
    ? lastCrossingBefore(time, values, levels.highThreshold, mesialEnd.index, !rising, sourceIndices)
    : null;
  const fallEnd = mesialEnd
    ? firstCrossingAfter(time, values, levels.lowThreshold, mesialEnd.index, !rising, sourceIndices)
    : null;

  return {
    riseStart: riseStart?.time ?? null,
    riseEnd: riseEnd?.time ?? null,
    fallStart: fallStart?.time ?? null,
    fallEnd: fallEnd?.time ?? null,
    widthStart: mesialStart?.time ?? null,
    widthEnd: mesialEnd?.time ?? null
  };
}
