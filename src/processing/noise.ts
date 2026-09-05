export interface ProcessingResult {
  values: number[];
  changedIndices: number[];
  affectedIndices?: number[];
  warnings: string[];
  effectiveParameters?: Record<string, string | number | number[] | boolean | null>;
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function subtractBaseline(
  values: ArrayLike<number>,
  region: { startIndex: number; endIndex: number },
  estimator: 'mean' | 'median' | 'trimmed-mean' = 'median'
): ProcessingResult {
  const source = Array.from(values);
  const start = Math.max(0, Math.min(region.startIndex, region.endIndex, source.length - 1));
  const end = Math.max(start, Math.min(Math.max(region.startIndex, region.endIndex), source.length - 1));
  let baselineValues = source
    .slice(start, end + 1)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (baselineValues.length === 0) {
    return { values: source, changedIndices: [], warnings: ['Baseline region contains no finite samples.'] };
  }
  if (estimator === 'trimmed-mean' && baselineValues.length >= 10) {
    const trim = Math.floor(baselineValues.length * 0.1);
    baselineValues = baselineValues.slice(trim, baselineValues.length - trim);
  }
  const baseline =
    estimator === 'median'
      ? median(baselineValues)
      : baselineValues.reduce((sum, value) => sum + value, 0) / baselineValues.length;
  return {
    values: source.map((value) => value - baseline),
    changedIndices: Array.from({ length: source.length }, (_, index) => index),
    warnings: [],
    effectiveParameters: { baseline, estimator, startIndex: start, endIndex: end }
  };
}

export function hampelDeglitch(values: ArrayLike<number>, halfWindow = 3, thresholdSigma = 3): ProcessingResult {
  const source = Array.from(values);
  const output = source.slice();
  const changedIndices: number[] = [];
  const radius = Math.max(1, Math.floor(halfWindow));
  for (let index = 0; index < source.length; index += 1) {
    const window = source.slice(Math.max(0, index - radius), Math.min(source.length, index + radius + 1));
    const center = median(window);
    const mad = median(window.map((value) => Math.abs(value - center)));
    const numericalFloor = Number.EPSILON * Math.max(1, Math.abs(center)) * 16;
    const robustSigma = Math.max(numericalFloor, 1.4826 * mad);
    if (Math.abs(source[index] - center) > thresholdSigma * robustSigma) {
      output[index] = center;
      changedIndices.push(index);
    }
  }
  return { values: output, changedIndices, warnings: [] };
}

function nextPowerOfTwo(value: number): number {
  return value <= 1 ? 1 : 2 ** Math.ceil(Math.log2(value));
}

export function waveletDenoiseHaar(
  values: ArrayLike<number>,
  options: { levels?: number; threshold?: number } = {}
): ProcessingResult {
  const source = Array.from(values);
  if (source.length < 2) return { values: source, changedIndices: [], warnings: [] };
  const paddedLength = nextPowerOfTwo(source.length);
  const data = new Array<number>(paddedLength);
  for (let index = 0; index < paddedLength; index += 1) {
    const reflected = index < source.length ? index : Math.max(0, 2 * source.length - index - 2);
    data[index] = source[Math.min(source.length - 1, reflected)];
  }
  const maximumLevels = Math.floor(Math.log2(paddedLength));
  const levels = Math.max(1, Math.min(maximumLevels, options.levels ?? maximumLevels));
  const detailRanges: Array<{ start: number; end: number }> = [];
  let activeLength = paddedLength;
  const sqrt2 = Math.sqrt(2);

  for (let level = 0; level < levels; level += 1) {
    const half = activeLength / 2;
    const transformed = new Array<number>(activeLength);
    for (let index = 0; index < half; index += 1) {
      transformed[index] = (data[index * 2] + data[index * 2 + 1]) / sqrt2;
      transformed[half + index] = (data[index * 2] - data[index * 2 + 1]) / sqrt2;
    }
    for (let index = 0; index < activeLength; index += 1) data[index] = transformed[index];
    detailRanges.push({ start: half, end: activeLength });
    activeLength = half;
  }

  const thresholds: number[] = [];
  for (const range of detailRanges) {
    const detail = data.slice(range.start, range.end);
    const noiseSigma = median(detail.map((value) => Math.abs(value))) / 0.6744897501960817;
    const threshold = options.threshold ?? noiseSigma * Math.sqrt(2 * Math.log(Math.max(2, detail.length)));
    thresholds.push(threshold);
    for (let index = range.start; index < range.end; index += 1) {
      const magnitude = Math.abs(data[index]);
      data[index] = Math.sign(data[index]) * Math.max(0, magnitude - threshold);
    }
  }

  for (let level = detailRanges.length - 1; level >= 0; level -= 1) {
    const range = detailRanges[level];
    const half = range.start;
    const reconstructed = new Array<number>(range.end);
    for (let index = 0; index < half; index += 1) {
      reconstructed[index * 2] = (data[index] + data[half + index]) / sqrt2;
      reconstructed[index * 2 + 1] = (data[index] - data[half + index]) / sqrt2;
    }
    for (let index = 0; index < range.end; index += 1) data[index] = reconstructed[index];
  }

  const output = data.slice(0, source.length);
  const changedIndices = output
    .map((value, index) => ({ value, index }))
    .filter(({ value, index }) => value !== source[index])
    .map(({ index }) => index);
  return {
    values: output,
    changedIndices,
    warnings: paddedLength === source.length ? [] : [`Reflected ${paddedLength - source.length} boundary sample(s).`],
    effectiveParameters: {
      family: 'haar',
      boundaryMode: 'reflected',
      thresholdMode: 'soft',
      thresholdRule: options.threshold === undefined ? 'per-level universal MAD' : 'explicit',
      thresholds
    }
  };
}

export function timeGate(
  time: ArrayLike<number>,
  values: ArrayLike<number>,
  startTime: number,
  endTime: number
): ProcessingResult {
  const length = Math.min(time.length, values.length);
  const output = Array.from(values).slice(0, length);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    return { values: output, changedIndices: [], warnings: ['Time-gate bounds must be finite.'] };
  }
  const lower = Math.min(startTime, endTime);
  const upper = Math.max(startTime, endTime);
  const changedIndices: number[] = [];
  const affectedIndices: number[] = [];
  for (let index = 0; index < length; index += 1) {
    if (Number(time[index]) < lower || Number(time[index]) > upper) {
      affectedIndices.push(index);
      if (output[index] !== 0) changedIndices.push(index);
      output[index] = 0;
    }
  }
  return { values: output, changedIndices, affectedIndices, warnings: [] };
}

export function blankArtifact(
  time: ArrayLike<number>,
  values: ArrayLike<number>,
  startTime: number,
  endTime: number,
  mode: 'missing' | 'interpolate' = 'missing'
): ProcessingResult {
  const length = Math.min(time.length, values.length);
  const output = Array.from(values).slice(0, length);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    return { values: output, changedIndices: [], warnings: ['Artifact bounds must be finite.'] };
  }
  const lowerBound = Math.min(startTime, endTime);
  const upperBound = Math.max(startTime, endTime);
  const indices: number[] = [];
  for (let index = 0; index < length; index += 1) {
    if (Number(time[index]) >= lowerBound && Number(time[index]) <= upperBound) indices.push(index);
  }
  if (indices.length === 0) return { values: output, changedIndices: [], warnings: [] };
  const left = indices[0] - 1;
  const right = indices[indices.length - 1] + 1;
  const canInterpolate =
    mode === 'interpolate' &&
    left >= 0 &&
    right < length &&
    Number.isFinite(Number(time[left])) &&
    Number.isFinite(Number(time[right])) &&
    Number(time[right]) > Number(time[left]) &&
    Number.isFinite(Number(values[left])) &&
    Number.isFinite(Number(values[right]));
  for (const index of indices) {
    if (canInterpolate) {
      const fraction = (Number(time[index]) - Number(time[left])) / (Number(time[right]) - Number(time[left]));
      output[index] = Number(values[left]) + (Number(values[right]) - Number(values[left])) * fraction;
    } else {
      output[index] = Number.NaN;
    }
  }
  return {
    values: output,
    changedIndices: indices,
    affectedIndices: indices,
    warnings: canInterpolate
      ? ['Artifact region was explicitly interpolated.']
      : [
          mode === 'interpolate'
            ? 'Artifact region touches a boundary and was marked missing instead of interpolated.'
            : 'Artifact region was marked missing.'
        ],
    effectiveParameters: {
      operation: canInterpolate ? 'interpolate' : 'missing',
      leftAnchorIndex: canInterpolate ? left : null,
      rightAnchorIndex: canInterpolate ? right : null
    }
  };
}

export function subtractReference(
  values: ArrayLike<number>,
  reference: ArrayLike<number>,
  scale = 1
): ProcessingResult {
  const output = Array.from({ length: values.length }, (_, index) =>
    index < reference.length ? Number(values[index]) - scale * Number(reference[index]) : Number.NaN
  );
  return {
    values: output,
    changedIndices: Array.from({ length: values.length }, (_, index) => index),
    warnings:
      reference.length === values.length
        ? []
        : ['Reference length differs from the primary trace; unmatched samples were marked missing.']
  };
}

export function residual(original: ArrayLike<number>, processed: ArrayLike<number>): number[] {
  const length = Math.min(original.length, processed.length);
  return Array.from({ length }, (_, index) => Number(original[index]) - Number(processed[index]));
}
