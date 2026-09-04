export type IirMode = 'causal' | 'zero-phase';
export type IirKind = 'lowpass' | 'highpass' | 'notch';

export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export interface FilterResponse {
  frequency: number[];
  magnitudeDb: number[];
  phaseDeg: number[];
  groupDelaySeconds: number[];
}

interface Complex {
  real: number;
  imaginary: number;
}

function complexMultiply(left: Complex, right: Complex): Complex {
  return {
    real: left.real * right.real - left.imaginary * right.imaginary,
    imaginary: left.real * right.imaginary + left.imaginary * right.real
  };
}

function complexDivide(left: Complex, right: Complex): Complex {
  const denominator = right.real ** 2 + right.imaginary ** 2;
  return {
    real: (left.real * right.real + left.imaginary * right.imaginary) / denominator,
    imaginary: (left.imaginary * right.real - left.real * right.imaginary) / denominator
  };
}

function complexSquareRoot(value: Complex): Complex {
  const magnitude = Math.hypot(value.real, value.imaginary);
  return {
    real: Math.sqrt(Math.max(0, (magnitude + value.real) / 2)),
    imaginary: Math.sign(value.imaginary || 1) * Math.sqrt(Math.max(0, (magnitude - value.real) / 2))
  };
}

function validateFrequency(sampleRate: number, frequency: number): void {
  if (!(sampleRate > 0) || !(frequency > 0) || frequency >= sampleRate / 2) {
    throw new Error(`Filter frequency must be between 0 and Nyquist (${sampleRate / 2} Hz).`);
  }
}

export function designBiquad(kind: IirKind, sampleRate: number, frequency: number, q = Math.SQRT1_2): Biquad {
  validateFrequency(sampleRate, frequency);
  const safeQ = Math.max(1e-6, q);
  const omega = (2 * Math.PI * frequency) / sampleRate;
  const cosine = Math.cos(omega);
  const sine = Math.sin(omega);
  const alpha = sine / (2 * safeQ);
  const a0 = 1 + alpha;
  if (kind === 'highpass') {
    return {
      b0: (1 + cosine) / 2 / a0,
      b1: -(1 + cosine) / a0,
      b2: (1 + cosine) / 2 / a0,
      a1: (-2 * cosine) / a0,
      a2: (1 - alpha) / a0
    };
  }
  if (kind === 'notch') {
    return {
      b0: 1 / a0,
      b1: (-2 * cosine) / a0,
      b2: 1 / a0,
      a1: (-2 * cosine) / a0,
      a2: (1 - alpha) / a0
    };
  }
  return {
    b0: (1 - cosine) / 2 / a0,
    b1: (1 - cosine) / a0,
    b2: (1 - cosine) / 2 / a0,
    a1: (-2 * cosine) / a0,
    a2: (1 - alpha) / a0
  };
}

function designFirstOrder(kind: 'lowpass' | 'highpass', sampleRate: number, cutoffHz: number): Biquad {
  validateFrequency(sampleRate, cutoffHz);
  const warped = Math.tan((Math.PI * cutoffHz) / sampleRate);
  const normalization = 1 / (1 + warped);
  return kind === 'lowpass'
    ? {
        b0: warped * normalization,
        b1: warped * normalization,
        b2: 0,
        a1: (warped - 1) * normalization,
        a2: 0
      }
    : {
        b0: normalization,
        b1: -normalization,
        b2: 0,
        a1: (warped - 1) * normalization,
        a2: 0
      };
}

function butterworthQ(order: number): number[] {
  const safeOrder = Math.max(1, Math.round(order));
  return Array.from(
    { length: Math.floor(safeOrder / 2) },
    (_, section) => 1 / (2 * Math.sin(((2 * section + 1) * Math.PI) / (2 * safeOrder)))
  );
}

export function designButterworth(
  kind: 'lowpass' | 'highpass',
  sampleRate: number,
  cutoffHz: number,
  order = 4
): Biquad[] {
  const safeOrder = Math.max(1, Math.round(order));
  const sections = butterworthQ(safeOrder)
    .sort((left, right) => left - right)
    .map((q) => designBiquad(kind, sampleRate, cutoffHz, q));
  if (safeOrder % 2 === 1) sections.push(designFirstOrder(kind, sampleRate, cutoffHz));
  return sections;
}

export function designButterworthBandPass(
  sampleRate: number,
  lowCutoffHz: number,
  highCutoffHz: number,
  order = 4
): Biquad[] {
  if (!(highCutoffHz > lowCutoffHz)) throw new Error('Band-pass high cutoff must exceed its low cutoff.');
  validateFrequency(sampleRate, lowCutoffHz);
  validateFrequency(sampleRate, highCutoffHz);
  const safeOrder = Math.max(2, Math.round(order));
  if (safeOrder % 2 !== 0) throw new Error('Butterworth band-pass final order must be even.');
  const prototypeOrder = safeOrder / 2;
  const warpedLow = 2 * sampleRate * Math.tan((Math.PI * lowCutoffHz) / sampleRate);
  const warpedHigh = 2 * sampleRate * Math.tan((Math.PI * highCutoffHz) / sampleRate);
  const bandwidth = warpedHigh - warpedLow;
  const centerSquared = warpedLow * warpedHigh;
  const analogPoles: Complex[] = [];
  for (let index = 0; index < prototypeOrder; index += 1) {
    const angle = (Math.PI * (2 * index + prototypeOrder + 1)) / (2 * prototypeOrder);
    const prototypePole = { real: Math.cos(angle), imaginary: Math.sin(angle) };
    const scaledPole = {
      real: bandwidth * prototypePole.real,
      imaginary: bandwidth * prototypePole.imaginary
    };
    const discriminant = complexMultiply(scaledPole, scaledPole);
    discriminant.real -= 4 * centerSquared;
    const root = complexSquareRoot(discriminant);
    analogPoles.push(
      {
        real: (scaledPole.real + root.real) / 2,
        imaginary: (scaledPole.imaginary + root.imaginary) / 2
      },
      {
        real: (scaledPole.real - root.real) / 2,
        imaginary: (scaledPole.imaginary - root.imaginary) / 2
      }
    );
  }
  const bilinearScale = 2 * sampleRate;
  const digitalPoles = analogPoles.map((pole) =>
    complexDivide(
      { real: bilinearScale + pole.real, imaginary: pole.imaginary },
      { real: bilinearScale - pole.real, imaginary: -pole.imaginary }
    )
  );
  const unused = new Set(digitalPoles.map((_, index) => index));
  const sections: Biquad[] = [];
  while (unused.size) {
    const firstIndex = unused.values().next().value as number;
    unused.delete(firstIndex);
    const first = digitalPoles[firstIndex];
    let pairIndex = -1;
    let pairError = Infinity;
    for (const candidateIndex of unused) {
      const candidate = digitalPoles[candidateIndex];
      const error = Math.abs(candidate.real - first.real) + Math.abs(candidate.imaginary + first.imaginary);
      if (error < pairError) {
        pairError = error;
        pairIndex = candidateIndex;
      }
    }
    if (pairIndex < 0) throw new Error('Unable to pair Butterworth band-pass poles.');
    unused.delete(pairIndex);
    const second = digitalPoles[pairIndex];
    const poleProduct = complexMultiply(first, second);
    sections.push({
      b0: 1,
      b1: 0,
      b2: -1,
      a1: -(first.real + second.real),
      a2: poleProduct.real
    });
  }
  let real = 1;
  let imaginary = 0;
  const centerOmega = 2 * Math.atan(Math.sqrt(warpedLow * warpedHigh) / (2 * sampleRate));
  for (const section of sections) {
    const response = sectionResponse(section, centerOmega);
    const nextReal = real * response.real - imaginary * response.imaginary;
    imaginary = real * response.imaginary + imaginary * response.real;
    real = nextReal;
  }
  const centerMagnitude = Math.hypot(real, imaginary);
  if (centerMagnitude > 0 && sections[0]) {
    const gain = 1 / centerMagnitude;
    sections[0] = {
      ...sections[0],
      b0: sections[0].b0 * gain,
      b1: sections[0].b1 * gain,
      b2: sections[0].b2 * gain
    };
  }
  return sections;
}

export function applyBiquad(values: ArrayLike<number>, coefficients: Biquad): number[] {
  const output = new Array<number>(values.length);
  if (values.length === 0) return output;
  const initialInput = Number(values[0]);
  const dcDenominator = 1 + coefficients.a1 + coefficients.a2;
  const dcGain =
    Math.abs(dcDenominator) > Number.EPSILON
      ? (coefficients.b0 + coefficients.b1 + coefficients.b2) / dcDenominator
      : 0;
  const initialOutput = initialInput * dcGain;
  let z1 = initialOutput - coefficients.b0 * initialInput;
  let z2 = coefficients.b2 * initialInput - coefficients.a2 * initialOutput;
  for (let index = 0; index < values.length; index += 1) {
    const input = Number(values[index]);
    const value = coefficients.b0 * input + z1;
    z1 = coefficients.b1 * input - coefficients.a1 * value + z2;
    z2 = coefficients.b2 * input - coefficients.a2 * value;
    output[index] = value;
  }
  return output;
}

/**
 * Upper bound on the zero-phase settling extension per side. Poles extremely close to the unit
 * circle (very narrow notches at high sample rates) can demand hundreds of millions of settling
 * samples; beyond this bound the plan is reported as truncated and callers warn.
 */
export const MAX_IIR_SETTLING_PADDING = 1 << 21;

/**
 * Value of the odd-symmetric (point-reflected) extension of `values` at any integer index. Point
 * reflection about both end samples composes to a translation by 2·(last − first) every
 * 2·(N − 1) samples, so the extension continues indefinitely with the record's own spectral content
 * and no discontinuity — which is what lets the settling padding exceed the record length. Records
 * whose endpoint trend has been removed (the zero-phase path does this when the DC gain is unity)
 * make the extension purely periodic.
 */
function extendedValue(values: number[], index: number): number {
  const length = values.length;
  if (index >= 0 && index < length) return values[index];
  if (length === 1) return values[0];
  const period = 2 * (length - 1);
  const cycles = Math.floor(index / period);
  const remainder = index - cycles * period;
  const base = remainder < length ? values[remainder] : 2 * values[length - 1] - values[period - remainder];
  return base + cycles * 2 * (values[length - 1] - values[0]);
}

function padded(values: number[], requestedPadding = 48): { values: number[]; padding: number } {
  const padding = values.length < 2 ? 0 : Math.min(Math.max(0, requestedPadding), MAX_IIR_SETTLING_PADDING);
  const result = new Array<number>(values.length + padding * 2);
  for (let index = 0; index < padding; index += 1) {
    result[index] = extendedValue(values, index - padding);
  }
  for (let index = 0; index < values.length; index += 1) {
    result[padding + index] = values[index];
  }
  for (let index = 0; index < padding; index += 1) {
    result[padding + values.length + index] = extendedValue(values, values.length + index);
  }
  return { values: result, padding };
}

export interface IirPaddingPlan {
  required: number;
  effective: number;
  truncated: boolean;
}

export function iirPaddingPlan(sections: Biquad[], inputLength: number): IirPaddingPlan {
  let maximumPoleRadius = 0;
  for (const section of sections) {
    const discriminant = section.a1 ** 2 - 4 * section.a2;
    if (discriminant < 0) {
      maximumPoleRadius = Math.max(maximumPoleRadius, Math.sqrt(Math.abs(section.a2)));
    } else {
      const root = Math.sqrt(discriminant);
      maximumPoleRadius = Math.max(
        maximumPoleRadius,
        Math.abs((-section.a1 + root) / 2),
        Math.abs((-section.a1 - root) / 2)
      );
    }
  }
  const settlingPadding =
    maximumPoleRadius > 0 && maximumPoleRadius < 1 ? Math.ceil(Math.log(1e-8) / Math.log(maximumPoleRadius)) : 48;
  const required = Math.max(48, settlingPadding);
  const effective = inputLength < 2 ? 0 : Math.min(MAX_IIR_SETTLING_PADDING, required);
  return { required, effective, truncated: effective < required };
}

export function effectiveIirPadding(sections: Biquad[], inputLength: number): number {
  return iirPaddingPlan(sections, inputLength).effective;
}

export function applyIirCascade(input: ArrayLike<number>, sections: Biquad[], mode: IirMode = 'causal'): number[] {
  const source = Array.from(input);
  if (source.length === 0 || sections.length === 0) return source;
  if (mode === 'causal') {
    return sections.reduce((values, section) => applyBiquad(values, section), source);
  }
  const dcGain = sections.reduce((gain, section) => {
    const denominator = 1 + section.a1 + section.a2;
    return gain * (Math.abs(denominator) > Number.EPSILON ? (section.b0 + section.b1 + section.b2) / denominator : 0);
  }, 1);
  const preservesTrend =
    Math.abs(dcGain - 1) < 1e-8 && Number.isFinite(source[0]) && Number.isFinite(source[source.length - 1]);
  const trend = preservesTrend
    ? source.map(
        (_, index) =>
          source[0] + (source[source.length - 1] - source[0]) * (source.length === 1 ? 0 : index / (source.length - 1))
      )
    : new Array<number>(source.length).fill(0);
  const detrended = source.map((value, index) => value - trend[index]);
  const extension = padded(detrended, effectiveIirPadding(sections, source.length));
  let values = sections.reduce((current, section) => applyBiquad(current, section), extension.values);
  values.reverse();
  values = sections.reduce((current, section) => applyBiquad(current, section), values);
  values.reverse();
  return values.slice(extension.padding, extension.padding + source.length).map((value, index) => value + trend[index]);
}

function normalizedNotchSection(centerOmega: number, poleRadius: number, poleOmega: number): Biquad {
  const a1 = -2 * poleRadius * Math.cos(poleOmega);
  const a2 = poleRadius * poleRadius;
  const numeratorAtDc = 2 - 2 * Math.cos(centerOmega);
  const gain = (1 + a1 + a2) / numeratorAtDc;
  return {
    b0: gain,
    b1: -2 * gain * Math.cos(centerOmega),
    b2: gain,
    a1,
    a2
  };
}

function magnitudeAt(section: Biquad, omega: number): number {
  const response = sectionResponse(section, omega);
  return Math.hypot(response.real, response.imaginary);
}

export function designNotch(
  sampleRate: number,
  centerHz: number,
  bandwidthHz: number,
  mode: IirMode = 'causal'
): Biquad[] {
  validateFrequency(sampleRate, centerHz);
  if (!Number.isFinite(bandwidthHz) || !(bandwidthHz > 0)) {
    throw new Error('Notch bandwidth must be finite and positive.');
  }
  const halfBandwidth = bandwidthHz / 2;
  const lower = centerHz - halfBandwidth;
  const upper = centerHz + halfBandwidth;
  validateFrequency(sampleRate, lower);
  validateFrequency(sampleRate, upper);
  if (bandwidthHz >= 2 * Math.min(centerHz, sampleRate / 2 - centerHz) * 0.8) {
    throw new Error('Notch bandwidth is too broad for stable two-edge digital calibration.');
  }
  const centerOmega = (2 * Math.PI * centerHz) / sampleRate;
  const lowerOmega = (2 * Math.PI * lower) / sampleRate;
  const upperOmega = (2 * Math.PI * upper) / sampleRate;
  const targetMagnitude = mode === 'zero-phase' ? Math.pow(0.5, 0.25) : Math.SQRT1_2;
  let poleRadius = Math.exp((-Math.PI * bandwidthHz) / sampleRate);
  let poleOmega = centerOmega;

  const errors = (radius: number, omega: number): [number, number] => {
    const section = normalizedNotchSection(centerOmega, radius, omega);
    return [
      Math.log(magnitudeAt(section, lowerOmega) / targetMagnitude),
      Math.log(magnitudeAt(section, upperOmega) / targetMagnitude)
    ];
  };

  for (let iteration = 0; iteration < 60; iteration += 1) {
    const current = errors(poleRadius, poleOmega);
    const residual = Math.max(Math.abs(current[0]), Math.abs(current[1]));
    if (residual < 1e-12) break;

    const radiusStep = Math.max(1e-8, (1 - poleRadius) * 1e-4);
    const nextRadius =
      poleRadius < 0.999999 - radiusStep ? poleRadius + radiusStep : Math.max(1e-8, poleRadius - radiusStep);
    const omegaStep = 1e-6;
    const radiusErrors = errors(nextRadius, poleOmega);
    const omegaErrors = errors(poleRadius, poleOmega + omegaStep);
    const j00 = (radiusErrors[0] - current[0]) / (nextRadius - poleRadius);
    const j10 = (radiusErrors[1] - current[1]) / (nextRadius - poleRadius);
    const j01 = (omegaErrors[0] - current[0]) / omegaStep;
    const j11 = (omegaErrors[1] - current[1]) / omegaStep;
    const determinant = j00 * j11 - j01 * j10;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-14) break;
    const radiusDelta = (-current[0] * j11 + j01 * current[1]) / determinant;
    const omegaDelta = (j10 * current[0] - j00 * current[1]) / determinant;

    let scale = 1;
    let accepted = false;
    for (let search = 0; search < 20; search += 1) {
      const candidateRadius = Math.max(1e-8, Math.min(0.999999999, poleRadius + scale * radiusDelta));
      const candidateOmega = Math.max(1e-8, Math.min(Math.PI - 1e-8, poleOmega + scale * omegaDelta));
      const candidate = errors(candidateRadius, candidateOmega);
      const candidateResidual = Math.max(Math.abs(candidate[0]), Math.abs(candidate[1]));
      if (candidateResidual < residual) {
        poleRadius = candidateRadius;
        poleOmega = candidateOmega;
        accepted = true;
        break;
      }
      scale /= 2;
    }
    if (!accepted) break;
  }

  const calibratedErrors = errors(poleRadius, poleOmega);
  const calibratedResidual = Math.max(Math.abs(calibratedErrors[0]), Math.abs(calibratedErrors[1]));
  if (calibratedResidual > 1e-8) {
    throw new Error('Unable to calibrate the requested digital notch bandwidth.');
  }
  return [normalizedNotchSection(centerOmega, poleRadius, poleOmega)];
}

export function designCombNotch(
  sampleRate: number,
  fundamentalHz: number,
  bandwidthHz: number,
  harmonicCount = Infinity,
  mode: IirMode = 'causal'
): Biquad[] {
  validateFrequency(sampleRate, fundamentalHz);
  if (!Number.isFinite(bandwidthHz) || !(bandwidthHz > 0)) {
    throw new Error('Comb-notch bandwidth must be finite and positive.');
  }
  if (bandwidthHz >= fundamentalHz) {
    throw new Error('Comb-notch bandwidth must be smaller than the harmonic spacing.');
  }
  const maximumHarmonic = Math.floor((sampleRate / 2 - bandwidthHz / 2) / fundamentalHz);
  if (Number.isFinite(harmonicCount) && harmonicCount > maximumHarmonic) {
    throw new Error(`Comb-notch harmonic count must not exceed ${maximumHarmonic} at this sample rate.`);
  }
  const sections: Biquad[] = [];
  const count = Number.isFinite(harmonicCount) ? Math.floor(harmonicCount) : maximumHarmonic;
  for (let harmonic = 1; harmonic <= count; harmonic += 1) {
    sections.push(...designNotch(sampleRate, fundamentalHz * harmonic, bandwidthHz, mode));
  }
  const targetDb = 20 * Math.log10(Math.SQRT1_2);
  for (let harmonic = 1; harmonic <= count; harmonic += 1) {
    for (const edgeHz of [fundamentalHz * harmonic - bandwidthHz / 2, fundamentalHz * harmonic + bandwidthHz / 2]) {
      const omega = (2 * Math.PI * edgeHz) / sampleRate;
      const singlePassMagnitude = sections.reduce((magnitude, section) => magnitude * magnitudeAt(section, omega), 1);
      const effectiveMagnitude = mode === 'zero-phase' ? singlePassMagnitude ** 2 : singlePassMagnitude;
      const edgeDb = 20 * Math.log10(Math.max(effectiveMagnitude, 1e-15));
      if (Math.abs(edgeDb - targetDb) > 0.05) {
        throw new Error(
          'Comb-notch sections overlap enough to violate the requested -3 dB bandwidth; reduce bandwidth or harmonic count.'
        );
      }
    }
  }
  return sections;
}

function sectionResponse(section: Biquad, omega: number): { real: number; imaginary: number } {
  const cos1 = Math.cos(omega);
  const sin1 = Math.sin(omega);
  const cos2 = Math.cos(2 * omega);
  const sin2 = Math.sin(2 * omega);
  const numeratorReal = section.b0 + section.b1 * cos1 + section.b2 * cos2;
  const numeratorImaginary = -section.b1 * sin1 - section.b2 * sin2;
  const denominatorReal = 1 + section.a1 * cos1 + section.a2 * cos2;
  const denominatorImaginary = -section.a1 * sin1 - section.a2 * sin2;
  const denominatorPower = denominatorReal ** 2 + denominatorImaginary ** 2;
  return {
    real: (numeratorReal * denominatorReal + numeratorImaginary * denominatorImaginary) / denominatorPower,
    imaginary: (numeratorImaginary * denominatorReal - numeratorReal * denominatorImaginary) / denominatorPower
  };
}

export function computeFilterResponse(
  sections: Biquad[],
  sampleRate: number,
  points = 1024,
  mode: IirMode = 'causal'
): FilterResponse {
  const count = Math.max(2, Math.floor(points));
  const frequency = Array.from({ length: count }, (_, index) => (index * sampleRate) / (2 * (count - 1)));
  const phaseRadians = new Array<number>(count);
  const magnitudeDb = new Array<number>(count);

  frequency.forEach((value, index) => {
    let real = 1;
    let imaginary = 0;
    const omega = (2 * Math.PI * value) / sampleRate;
    for (const section of sections) {
      const response = sectionResponse(section, omega);
      const nextReal = real * response.real - imaginary * response.imaginary;
      imaginary = real * response.imaginary + imaginary * response.real;
      real = nextReal;
    }
    const magnitude = Math.hypot(real, imaginary);
    magnitudeDb[index] = 20 * Math.log10(Math.max(mode === 'zero-phase' ? magnitude ** 2 : magnitude, 1e-15));
    phaseRadians[index] = mode === 'zero-phase' ? 0 : Math.atan2(imaginary, real);
  });

  for (let index = 1; index < phaseRadians.length; index += 1) {
    while (phaseRadians[index] - phaseRadians[index - 1] > Math.PI) phaseRadians[index] -= 2 * Math.PI;
    while (phaseRadians[index] - phaseRadians[index - 1] < -Math.PI) phaseRadians[index] += 2 * Math.PI;
  }
  const groupDelaySeconds = phaseRadians.map((_, index) => {
    if (mode === 'zero-phase') return 0;
    const left = Math.max(0, index - 1);
    const right = Math.min(phaseRadians.length - 1, index + 1);
    const angularSpan = (2 * Math.PI * (frequency[right] - frequency[left])) / sampleRate;
    return angularSpan > 0 ? -(phaseRadians[right] - phaseRadians[left]) / angularSpan / sampleRate : 0;
  });
  return {
    frequency,
    magnitudeDb,
    phaseDeg: phaseRadians.map((phase) => (phase * 180) / Math.PI),
    groupDelaySeconds
  };
}
