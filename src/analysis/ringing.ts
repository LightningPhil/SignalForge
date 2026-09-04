export interface RingingResult {
  frequencyHz: number | null;
  decayTimeConstant: number | null;
  qualityFactor: number | null;
  fitR2: number | null;
  peakCount: number;
  /** Robust estimate of the additive noise standard deviation used to gate peaks and crossings. */
  noiseSigma: number;
  warnings: string[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function robustSigma(values: number[]): number {
  const finite = values.filter(Number.isFinite);
  const center = median(finite);
  if (center === null) return 0;
  return (median(finite.map((value) => Math.abs(value - center))) ?? 0) * 1.4826;
}

/**
 * Noise standard deviation of the centred segment: the smaller of (a) the spread of the trailing
 * 10 % of the region, which is pure noise once the ring has decayed, and (b) the second-difference
 * estimate (MAD/√6), which cancels smooth oscillation when it is sampled densely. Both can only
 * over-estimate the noise, so the minimum is the safer gate.
 */
function estimateNoiseSigma(centered: number[]): number {
  const tailCount = Math.max(4, Math.floor(centered.length * 0.1));
  const tailSigma = robustSigma(centered.slice(-tailCount));
  const seconds: number[] = [];
  for (let index = 2; index < centered.length; index += 1) {
    seconds.push(centered[index] - 2 * centered[index - 1] + centered[index - 2]);
  }
  const differenceSigma = robustSigma(seconds) / Math.sqrt(6);
  return Math.min(tailSigma, differenceSigma);
}

/** Zero crossings detected with a ±band Schmitt trigger so noise near zero cannot create spurious ones. */
function hystereticCrossings(
  time: number[],
  centered: number[],
  band: number
): Array<{ time: number; index: number; rising: boolean }> {
  const crossings: Array<{ time: number; index: number; rising: boolean }> = [];
  let state: 'high' | 'low' | null = null;
  for (let index = 0; index < centered.length; index += 1) {
    const value = centered[index];
    if (!Number.isFinite(value)) continue;
    const next: 'high' | 'low' | null = value > band ? 'high' : value < -band ? 'low' : null;
    if (next === null || next === state) continue;
    if (state !== null) {
      // Walk back to the actual sign change for the interpolated crossing time.
      let crossIndex = index;
      while (crossIndex > 1 && Math.sign(centered[crossIndex - 1]) === Math.sign(value)) crossIndex -= 1;
      const previous = centered[crossIndex - 1];
      const current = centered[crossIndex];
      const fraction = Number.isFinite(previous) && current !== previous ? -previous / (current - previous) : 0;
      crossings.push({
        time: time[crossIndex - 1] + (time[crossIndex] - time[crossIndex - 1]) * Math.max(0, Math.min(1, fraction)),
        index: crossIndex,
        rising: next === 'high'
      });
    }
    state = next;
  }
  return crossings;
}

export function analyzeRinging(
  time: ArrayLike<number>,
  values: ArrayLike<number>,
  options: { startIndex?: number; endIndex?: number; minimumPeakFraction?: number; noiseGateSigma?: number } = {}
): RingingResult {
  const length = Math.min(time.length, values.length);
  const start = Math.max(0, options.startIndex || 0);
  const end = Math.min(length - 1, options.endIndex ?? length - 1);
  const warnings: string[] = [];
  const empty = (reason: string, noiseSigma = 0): RingingResult => ({
    frequencyHz: null,
    decayTimeConstant: null,
    qualityFactor: null,
    fitR2: null,
    peakCount: 0,
    noiseSigma,
    warnings: [...warnings, reason]
  });
  if (end - start < 4) return empty('Ringing region is too short.');

  const edgeCount = Math.max(2, Math.floor((end - start + 1) * 0.1));
  const baselineValues = [
    ...Array.from(values).slice(start, start + edgeCount),
    ...Array.from(values).slice(end - edgeCount + 1, end + 1)
  ].filter(Number.isFinite);
  const baseline = median(baselineValues) || 0;
  const centered = Array.from(values)
    .slice(start, end + 1)
    .map((value) => Number(value) - baseline);
  const selectedTime = Array.from(time)
    .slice(start, end + 1)
    .map(Number);
  let maximum = 0;
  for (const value of centered) if (Number.isFinite(value)) maximum = Math.max(maximum, Math.abs(value));
  if (!(maximum > 0)) return empty('Ringing region has no excursion from the baseline.');

  const noiseSigma = estimateNoiseSigma(centered);
  const gate = Math.max(maximum * (options.minimumPeakFraction ?? 0.02), noiseSigma * (options.noiseGateSigma ?? 3));
  if (gate >= maximum) return empty('Ringing amplitude does not exceed the noise floor.', noiseSigma);

  const crossings = hystereticCrossings(selectedTime, centered, Math.min(gate / 1.5, maximum / 2));
  // One amplitude per half-cycle (between consecutive crossings): the noise-corrected RMS amplitude
  // √(2·(ms − σ²)) is unbiased for a sinusoidal half-cycle, whereas the raw maximum is inflated by
  // the noise extreme and flattens the decay fit. Collection stops once the envelope sinks to the gate.
  const peaks: Array<{ time: number; amplitude: number }> = [];
  for (let segment = 0; segment + 1 < crossings.length; segment += 1) {
    const from = crossings[segment].index;
    const to = crossings[segment + 1].index;
    if (to <= from) continue;
    let sumSquares = 0;
    let count = 0;
    let peakIndex = from;
    let peakAmplitude = 0;
    for (let index = from; index < to; index += 1) {
      const value = centered[index];
      if (!Number.isFinite(value)) continue;
      sumSquares += value * value;
      count += 1;
      if (Math.abs(value) > peakAmplitude) {
        peakAmplitude = Math.abs(value);
        peakIndex = index;
      }
    }
    if (count === 0) continue;
    const amplitude = Math.sqrt(Math.max(0, 2 * (sumSquares / count - noiseSigma * noiseSigma)));
    if (amplitude < gate) break;
    peaks.push({ time: selectedTime[peakIndex], amplitude });
  }

  const validUntil = peaks.length > 0 ? peaks[peaks.length - 1].time : -Infinity;
  const risingTimes = crossings
    .filter((crossing) => crossing.rising && crossing.time <= validUntil)
    .map((crossing) => crossing.time);
  const periods: number[] = [];
  for (let index = 1; index < risingTimes.length; index += 1) {
    const period = risingTimes[index] - risingTimes[index - 1];
    if (period > 0) periods.push(period);
  }
  let frequencyHz: number | null = null;
  const period = median(periods);
  if (period && period > 0 && periods.length >= 2) {
    const spread = median(periods.map((value) => Math.abs(value - period))) ?? 0;
    if (spread / period > 0.25) {
      warnings.push('Zero-crossing intervals are inconsistent with a single ringing frequency; frequency withheld.');
    } else {
      frequencyHz = 1 / period;
    }
  } else if (period && period > 0 && periods.length === 1) {
    frequencyHz = 1 / period;
    warnings.push('Ringing frequency is based on a single full cycle.');
  } else {
    warnings.push('Insufficient zero crossings above the noise floor for ringing frequency.');
  }

  let decayTimeConstant: number | null = null;
  let fitR2: number | null = null;
  if (peaks.length >= 3) {
    const xOrigin = peaks[0].time;
    const x = peaks.map((peak) => peak.time - xOrigin);
    const y = peaks.map((peak) => Math.log(peak.amplitude));
    const meanX = x.reduce((sum, value) => sum + value, 0) / x.length;
    const meanY = y.reduce((sum, value) => sum + value, 0) / y.length;
    let covariance = 0;
    let varianceX = 0;
    let varianceY = 0;
    for (let index = 0; index < x.length; index += 1) {
      covariance += (x[index] - meanX) * (y[index] - meanY);
      varianceX += (x[index] - meanX) ** 2;
      varianceY += (y[index] - meanY) ** 2;
    }
    const slope = varianceX > 0 ? covariance / varianceX : 0;
    decayTimeConstant = slope < 0 ? -1 / slope : null;
    fitR2 = varianceX > 0 && varianceY > 0 ? (covariance * covariance) / (varianceX * varianceY) : null;
    if (decayTimeConstant === null) warnings.push('Peak envelope does not show exponential decay.');
    if (fitR2 !== null && fitR2 < 0.8) warnings.push('Exponential decay fit quality is poor.');
  } else {
    warnings.push('At least three ringing peaks above the noise floor are required for decay fitting.');
  }
  return {
    frequencyHz,
    decayTimeConstant,
    qualityFactor:
      frequencyHz !== null && decayTimeConstant !== null ? Math.PI * frequencyHz * decayTimeConstant : null,
    fitR2,
    peakCount: peaks.length,
    noiseSigma,
    warnings
  };
}
