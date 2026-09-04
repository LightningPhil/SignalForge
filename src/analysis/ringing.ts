export interface RingingResult {
  frequencyHz: number | null;
  decayTimeConstant: number | null;
  qualityFactor: number | null;
  fitR2: number | null;
  peakCount: number;
  warnings: string[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function analyzeRinging(
  time: ArrayLike<number>,
  values: ArrayLike<number>,
  options: { startIndex?: number; endIndex?: number; minimumPeakFraction?: number } = {}
): RingingResult {
  const length = Math.min(time.length, values.length);
  const start = Math.max(0, options.startIndex || 0);
  const end = Math.min(length - 1, options.endIndex ?? length - 1);
  const warnings: string[] = [];
  if (end - start < 4) {
    return {
      frequencyHz: null,
      decayTimeConstant: null,
      qualityFactor: null,
      fitR2: null,
      peakCount: 0,
      warnings: ['Ringing region is too short.']
    };
  }
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
  for (const value of centered) maximum = Math.max(maximum, Math.abs(value));
  const minimumPeak = maximum * (options.minimumPeakFraction ?? 0.02);
  const peaks: Array<{ time: number; amplitude: number }> = [];
  const positiveCrossings: number[] = [];

  for (let index = 1; index < centered.length; index += 1) {
    if (centered[index - 1] <= 0 && centered[index] > 0) {
      const fraction = -centered[index - 1] / (centered[index] - centered[index - 1] || 1);
      positiveCrossings.push(selectedTime[index - 1] + (selectedTime[index] - selectedTime[index - 1]) * fraction);
    }
  }
  for (let index = 1; index < centered.length - 1; index += 1) {
    const amplitude = Math.abs(centered[index]);
    if (
      amplitude >= minimumPeak &&
      amplitude >= Math.abs(centered[index - 1]) &&
      amplitude > Math.abs(centered[index + 1])
    ) {
      peaks.push({ time: selectedTime[index], amplitude });
    }
  }

  const periods: number[] = [];
  for (let index = 1; index < positiveCrossings.length; index += 1) {
    const period = positiveCrossings[index] - positiveCrossings[index - 1];
    if (period > 0) periods.push(period);
  }
  const period = median(periods);
  const frequencyHz = period && period > 0 ? 1 / period : null;
  if (frequencyHz === null) warnings.push('Insufficient zero crossings for ringing frequency.');

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
    warnings.push('At least three ringing peaks are required for decay fitting.');
  }
  return {
    frequencyHz,
    decayTimeConstant,
    qualityFactor:
      frequencyHz !== null && decayTimeConstant !== null ? Math.PI * frequencyHz * decayTimeConstant : null,
    fitR2,
    peakCount: peaks.length,
    warnings
  };
}
