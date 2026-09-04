import { FFT } from './fft';
import type { FilterResponse } from './iir';

export const MAX_FIR_TAPS = 16_385;
export const FIR_UNIFORM_TOLERANCE = 1e-9;
const DIRECT_CONVOLUTION_WORK = 4_000_000;
const MAX_CONVOLUTION_FFT = 2 ** 20;
export const MAX_FIR_WORKING_BYTES = 512 * 1024 * 1024;

export type FirApplicationMode = 'causal' | 'zero-phase';

interface FirCommonSpecification {
  sampleRate: number;
  passbandRippleDb: number;
  stopbandAttenuationDb: number;
  maxTaps?: number;
}

export type FirSpecification =
  | (FirCommonSpecification & {
      kind: 'lowpass';
      passbandEdgeHz: number;
      stopbandEdgeHz: number;
    })
  | (FirCommonSpecification & {
      kind: 'highpass';
      stopbandEdgeHz: number;
      passbandEdgeHz: number;
    })
  | (FirCommonSpecification & {
      kind: 'bandpass';
      lowerStopbandEdgeHz: number;
      lowerPassbandEdgeHz: number;
      upperPassbandEdgeHz: number;
      upperStopbandEdgeHz: number;
    })
  | (FirCommonSpecification & {
      kind: 'bandstop';
      lowerPassbandEdgeHz: number;
      lowerStopbandEdgeHz: number;
      upperStopbandEdgeHz: number;
      upperPassbandEdgeHz: number;
    });

export interface FirDesign {
  coefficients: number[];
  tapCount: number;
  beta: number;
  delaySamples: number;
  achievedPassbandRippleDb: number;
  achievedStopbandAttenuationDb: number;
  specification: FirSpecification;
}

interface VerificationResult {
  passbandRippleDb: number;
  stopbandAttenuationDb: number;
}

const designCache = new Map<string, FirDesign>();

function modifiedBessel0(value: number): number {
  const halfSquared = (value * value) / 4;
  let sum = 1;
  let term = 1;
  for (let index = 1; index < 10_000; index += 1) {
    term *= halfSquared / (index * index);
    const next = sum + term;
    if (Math.abs(term) <= Math.abs(next) * 2e-16) return next;
    sum = next;
  }
  throw new Error('Kaiser-window Bessel evaluation did not converge.');
}

export function kaiserBeta(attenuationDb: number): number {
  if (attenuationDb > 50) return 0.1102 * (attenuationDb - 8.7);
  if (attenuationDb >= 21) {
    return 0.5842 * Math.pow(attenuationDb - 21, 0.4) + 0.07886 * (attenuationDb - 21);
  }
  return 0;
}

function sinc(value: number): number {
  if (Math.abs(value) < 1e-14) return 1;
  const angle = Math.PI * value;
  return Math.sin(angle) / angle;
}

function validateSpecification(specification: FirSpecification): void {
  const { sampleRate, passbandRippleDb, stopbandAttenuationDb } = specification;
  if (!Number.isFinite(sampleRate) || !(sampleRate > 0)) {
    throw new Error('FIR sample rate must be finite and positive.');
  }
  if (!Number.isFinite(passbandRippleDb) || passbandRippleDb < 0.001 || passbandRippleDb > 6) {
    throw new Error('FIR passband ripple must be between 0.001 dB and 6 dB.');
  }
  if (!Number.isFinite(stopbandAttenuationDb) || stopbandAttenuationDb < 20 || stopbandAttenuationDb > 160) {
    throw new Error('FIR stopband attenuation must be between 20 dB and 160 dB.');
  }
  const nyquist = sampleRate / 2;
  const orderedEdges =
    specification.kind === 'lowpass'
      ? [specification.passbandEdgeHz, specification.stopbandEdgeHz]
      : specification.kind === 'highpass'
        ? [specification.stopbandEdgeHz, specification.passbandEdgeHz]
        : specification.kind === 'bandpass'
          ? [
              specification.lowerStopbandEdgeHz,
              specification.lowerPassbandEdgeHz,
              specification.upperPassbandEdgeHz,
              specification.upperStopbandEdgeHz
            ]
          : [
              specification.lowerPassbandEdgeHz,
              specification.lowerStopbandEdgeHz,
              specification.upperStopbandEdgeHz,
              specification.upperPassbandEdgeHz
            ];
  for (let index = 0; index < orderedEdges.length; index += 1) {
    const edge = orderedEdges[index];
    if (!Number.isFinite(edge) || !(edge > 0 && edge < nyquist)) {
      throw new Error(`FIR edge frequencies must be finite and between 0 and Nyquist (${nyquist} Hz).`);
    }
    if (index > 0 && !(edge > orderedEdges[index - 1])) {
      throw new Error('FIR edge frequencies must be strictly increasing.');
    }
  }
}

function transitionWidth(specification: FirSpecification): number {
  if (specification.kind === 'lowpass') {
    return specification.stopbandEdgeHz - specification.passbandEdgeHz;
  }
  if (specification.kind === 'highpass') {
    return specification.passbandEdgeHz - specification.stopbandEdgeHz;
  }
  if (specification.kind === 'bandpass') {
    return Math.min(
      specification.lowerPassbandEdgeHz - specification.lowerStopbandEdgeHz,
      specification.upperStopbandEdgeHz - specification.upperPassbandEdgeHz
    );
  }
  return Math.min(
    specification.lowerStopbandEdgeHz - specification.lowerPassbandEdgeHz,
    specification.upperPassbandEdgeHz - specification.upperStopbandEdgeHz
  );
}

function designAttenuation(specification: FirSpecification): number {
  const gain = Math.pow(10, specification.passbandRippleDb / 20);
  const passbandDeviation = (gain - 1) / (gain + 1);
  const stopbandDeviation = Math.pow(10, -specification.stopbandAttenuationDb / 20);
  return -20 * Math.log10(Math.min(passbandDeviation, stopbandDeviation));
}

function estimatedTapCount(specification: FirSpecification, attenuationDb: number): number {
  const normalizedTransition = (2 * Math.PI * transitionWidth(specification)) / specification.sampleRate;
  let order = Math.max(2, Math.ceil((attenuationDb - 8) / (2.285 * normalizedTransition)));
  if (order % 2 !== 0) order += 1;
  return order + 1;
}

export function estimateKaiserFirTapCount(specification: FirSpecification): number {
  validateSpecification(specification);
  return estimatedTapCount(specification, designAttenuation(specification));
}

function lowPassSample(cutoffHz: number, sampleRate: number, offset: number): number {
  const normalized = cutoffHz / sampleRate;
  return 2 * normalized * sinc(2 * normalized * offset);
}

function referenceGain(coefficients: number[], specification: FirSpecification): number {
  const delay = (coefficients.length - 1) / 2;
  const referenceHz =
    specification.kind === 'lowpass' || specification.kind === 'bandstop'
      ? 0
      : specification.kind === 'highpass'
        ? specification.sampleRate / 2
        : (specification.lowerPassbandEdgeHz + specification.upperPassbandEdgeHz) / 2;
  const omega = (2 * Math.PI * referenceHz) / specification.sampleRate;
  let gain = 0;
  for (let index = 0; index < coefficients.length; index += 1) {
    gain += coefficients[index] * Math.cos(omega * (index - delay));
  }
  return gain;
}

function zeroPhaseGain(coefficients: number[], frequencyHz: number, sampleRate: number): number {
  const delay = (coefficients.length - 1) / 2;
  const omega = (2 * Math.PI * frequencyHz) / sampleRate;
  let gain = 0;
  for (let index = 0; index < coefficients.length; index += 1) {
    gain += coefficients[index] * Math.cos(omega * (index - delay));
  }
  return gain;
}

function enforceEndpointGains(coefficients: number[], specification: FirSpecification): void {
  const center = (coefficients.length - 1) / 2;
  const desiredDc = specification.kind === 'lowpass' || specification.kind === 'bandstop' ? 1 : 0;
  const desiredNyquist = specification.kind === 'highpass' || specification.kind === 'bandstop' ? 1 : 0;
  const dcCorrection = desiredDc - zeroPhaseGain(coefficients, 0, specification.sampleRate);
  coefficients[center] += dcCorrection * 0.5;
  coefficients[center - 1] += dcCorrection * 0.25;
  coefficients[center + 1] += dcCorrection * 0.25;

  const nyquistCorrection =
    desiredNyquist - zeroPhaseGain(coefficients, specification.sampleRate / 2, specification.sampleRate);
  coefficients[center] += nyquistCorrection * 0.5;
  coefficients[center - 1] -= nyquistCorrection * 0.25;
  coefficients[center + 1] -= nyquistCorrection * 0.25;

  if (specification.kind === 'bandpass') {
    const centerFrequency = (specification.lowerPassbandEdgeHz + specification.upperPassbandEdgeHz) / 2;
    const gain = zeroPhaseGain(coefficients, centerFrequency, specification.sampleRate);
    if (!Number.isFinite(gain) || Math.abs(gain) < 1e-12) {
      throw new Error('FIR band-pass center normalization has zero or non-finite gain.');
    }
    for (let index = 0; index < coefficients.length; index += 1) coefficients[index] /= gain;
  }
}

function designCoefficients(specification: FirSpecification, tapCount: number, beta: number): number[] {
  const delay = (tapCount - 1) / 2;
  const denominator = modifiedBessel0(beta);
  const coefficients = new Array<number>(tapCount);
  const cutoffEdges =
    specification.kind === 'lowpass'
      ? [(specification.passbandEdgeHz + specification.stopbandEdgeHz) / 2]
      : specification.kind === 'highpass'
        ? [(specification.stopbandEdgeHz + specification.passbandEdgeHz) / 2]
        : specification.kind === 'bandpass'
          ? [
              (specification.lowerStopbandEdgeHz + specification.lowerPassbandEdgeHz) / 2,
              (specification.upperPassbandEdgeHz + specification.upperStopbandEdgeHz) / 2
            ]
          : [
              (specification.lowerPassbandEdgeHz + specification.lowerStopbandEdgeHz) / 2,
              (specification.upperStopbandEdgeHz + specification.upperPassbandEdgeHz) / 2
            ];

  for (let index = 0; index <= delay; index += 1) {
    const offset = index - delay;
    const ratio = delay === 0 ? 0 : offset / delay;
    const window = modifiedBessel0(beta * Math.sqrt(Math.max(0, 1 - ratio * ratio))) / denominator;
    let ideal: number;
    if (specification.kind === 'lowpass') {
      ideal = lowPassSample(cutoffEdges[0], specification.sampleRate, offset);
    } else if (specification.kind === 'highpass') {
      ideal = (offset === 0 ? 1 : 0) - lowPassSample(cutoffEdges[0], specification.sampleRate, offset);
    } else {
      const bandPass =
        lowPassSample(cutoffEdges[1], specification.sampleRate, offset) -
        lowPassSample(cutoffEdges[0], specification.sampleRate, offset);
      ideal = specification.kind === 'bandpass' ? bandPass : (offset === 0 ? 1 : 0) - bandPass;
    }
    const coefficient = ideal * window;
    coefficients[index] = coefficient;
    coefficients[tapCount - 1 - index] = coefficient;
  }

  const gain = referenceGain(coefficients, specification);
  if (!Number.isFinite(gain) || Math.abs(gain) < 1e-12) {
    throw new Error('FIR normalization reference has zero or non-finite gain.');
  }
  for (let index = 0; index < coefficients.length; index += 1) coefficients[index] /= gain;
  enforceEndpointGains(coefficients, specification);
  if (coefficients.some((value) => !Number.isFinite(value))) {
    throw new Error('FIR design produced non-finite coefficients.');
  }
  return coefficients;
}

function directMagnitude(coefficients: number[], frequencyHz: number, sampleRate: number): number {
  const omega = (2 * Math.PI * frequencyHz) / sampleRate;
  let real = 0;
  let imaginary = 0;
  for (let tap = 0; tap < coefficients.length; tap += 1) {
    real += coefficients[tap] * Math.cos(omega * tap);
    imaginary -= coefficients[tap] * Math.sin(omega * tap);
  }
  return Math.hypot(real, imaginary);
}

/** Number of worst grid extrema per region that are re-evaluated exactly with the direct sum. */
const EXACT_EXTREMA_PER_REGION = 24;

function keepWorst(
  list: Array<{ frequency: number; magnitude: number }>,
  candidate: { frequency: number; magnitude: number },
  worseIfLarger: boolean
): void {
  if (list.length < EXACT_EXTREMA_PER_REGION) {
    list.push(candidate);
    return;
  }
  let replaceIndex = -1;
  let best = candidate.magnitude;
  for (let index = 0; index < list.length; index += 1) {
    const value = list[index].magnitude;
    if (worseIfLarger ? value < best : value > best) {
      best = value;
      replaceIndex = index;
    }
  }
  if (replaceIndex >= 0) list[replaceIndex] = candidate;
}

/**
 * Verifies a design against its specification. The response is sampled on a dense FFT grid
 * (at least 64 bins per tap, so every ripple lobe is resolved), every local extremum is refined
 * by parabolic interpolation, and the worst candidates in each region plus the exact band edges
 * are then re-evaluated with the direct O(taps) sum so the reported ripple/attenuation come from
 * exact evaluations rather than grid samples.
 */
function verifyDesign(coefficients: number[], specification: FirSpecification): VerificationResult {
  const requestedLength = Math.max(32_768, coefficients.length * 64);
  const fftLength = Math.min(MAX_CONVOLUTION_FFT, FFT.nextPowerOfTwo(requestedLength));
  if (coefficients.length > fftLength) throw new Error('FIR response verification exceeds the FFT safety limit.');
  const padded = new Float64Array(fftLength);
  padded.set(coefficients);
  const transformed = FFT.forward(padded, { zeroPadMode: 'none' });
  let passbandMinimum = Infinity;
  let passbandMaximum = 0;
  let stopbandMaximum = 0;
  const nyquistBin = fftLength / 2;
  const passbandLows: Array<{ frequency: number; magnitude: number }> = [];
  const passbandHighs: Array<{ frequency: number; magnitude: number }> = [];
  const stopbandHighs: Array<{ frequency: number; magnitude: number }> = [];

  const classify = (frequency: number): 'pass' | 'stop' | 'transition' => {
    if (specification.kind === 'lowpass') {
      if (frequency <= specification.passbandEdgeHz) return 'pass';
      if (frequency >= specification.stopbandEdgeHz) return 'stop';
    } else if (specification.kind === 'highpass') {
      if (frequency <= specification.stopbandEdgeHz) return 'stop';
      if (frequency >= specification.passbandEdgeHz) return 'pass';
    } else if (specification.kind === 'bandpass') {
      if (frequency >= specification.lowerPassbandEdgeHz && frequency <= specification.upperPassbandEdgeHz) {
        return 'pass';
      }
      if (frequency <= specification.lowerStopbandEdgeHz || frequency >= specification.upperStopbandEdgeHz) {
        return 'stop';
      }
    } else {
      if (frequency <= specification.lowerPassbandEdgeHz || frequency >= specification.upperPassbandEdgeHz) {
        return 'pass';
      }
      if (frequency >= specification.lowerStopbandEdgeHz && frequency <= specification.upperStopbandEdgeHz) {
        return 'stop';
      }
    }
    return 'transition';
  };

  const update = (region: 'pass' | 'stop' | 'transition', magnitude: number) => {
    if (region === 'pass') {
      passbandMinimum = Math.min(passbandMinimum, magnitude);
      passbandMaximum = Math.max(passbandMaximum, magnitude);
    } else if (region === 'stop') {
      stopbandMaximum = Math.max(stopbandMaximum, magnitude);
    }
  };

  const gridMagnitude = new Float64Array(nyquistBin + 1);
  for (let bin = 0; bin <= nyquistBin; bin += 1) {
    gridMagnitude[bin] = Math.hypot(transformed.re[bin], transformed.im[bin]);
  }
  for (let bin = 0; bin <= nyquistBin; bin += 1) {
    const frequency = (bin * specification.sampleRate) / fftLength;
    const magnitude = gridMagnitude[bin];
    const region = classify(frequency);
    update(region, magnitude);
    if (region === 'transition' || bin === 0 || bin === nyquistBin) continue;
    const previous = gridMagnitude[bin - 1];
    const next = gridMagnitude[bin + 1];
    const isMaximum = magnitude >= previous && magnitude >= next;
    const isMinimum = magnitude <= previous && magnitude <= next;
    if (!isMaximum && !isMinimum) continue;
    const denominator = previous - 2 * magnitude + next;
    const offset =
      Math.abs(denominator) > Number.EPSILON
        ? Math.max(-0.5, Math.min(0.5, (0.5 * (previous - next)) / denominator))
        : 0;
    const refinedFrequency = ((bin + offset) * specification.sampleRate) / fftLength;
    if (classify(refinedFrequency) !== region) continue;
    const refinedMagnitude = magnitude - 0.25 * (previous - next) * offset;
    const candidate = { frequency: refinedFrequency, magnitude: refinedMagnitude };
    if (region === 'stop') {
      if (isMaximum) keepWorst(stopbandHighs, candidate, true);
    } else if (isMaximum) {
      keepWorst(passbandHighs, candidate, true);
    } else {
      keepWorst(passbandLows, candidate, false);
    }
  }
  for (const { frequency } of passbandLows) {
    update('pass', directMagnitude(coefficients, frequency, specification.sampleRate));
  }
  for (const { frequency } of passbandHighs) {
    update('pass', directMagnitude(coefficients, frequency, specification.sampleRate));
  }
  for (const { frequency } of stopbandHighs) {
    update('stop', directMagnitude(coefficients, frequency, specification.sampleRate));
  }

  const exactPassbandEdges =
    specification.kind === 'lowpass'
      ? [specification.passbandEdgeHz]
      : specification.kind === 'highpass'
        ? [specification.passbandEdgeHz]
        : specification.kind === 'bandpass'
          ? [specification.lowerPassbandEdgeHz, specification.upperPassbandEdgeHz]
          : [specification.lowerPassbandEdgeHz, specification.upperPassbandEdgeHz];
  const exactStopbandEdges =
    specification.kind === 'lowpass'
      ? [specification.stopbandEdgeHz]
      : specification.kind === 'highpass'
        ? [specification.stopbandEdgeHz]
        : specification.kind === 'bandpass'
          ? [specification.lowerStopbandEdgeHz, specification.upperStopbandEdgeHz]
          : [specification.lowerStopbandEdgeHz, specification.upperStopbandEdgeHz];
  for (const frequency of exactPassbandEdges) {
    update('pass', directMagnitude(coefficients, frequency, specification.sampleRate));
  }
  for (const frequency of exactStopbandEdges) {
    update('stop', directMagnitude(coefficients, frequency, specification.sampleRate));
  }

  return {
    passbandRippleDb:
      passbandMinimum > 0 && Number.isFinite(passbandMinimum)
        ? 20 * Math.log10(passbandMaximum / passbandMinimum)
        : Infinity,
    stopbandAttenuationDb: -20 * Math.log10(Math.max(stopbandMaximum, 1e-300))
  };
}

function cloneDesign(design: FirDesign): FirDesign {
  return {
    ...design,
    coefficients: design.coefficients.slice(),
    specification: { ...design.specification }
  };
}

export function designKaiserFir(specification: FirSpecification): FirDesign {
  validateSpecification(specification);
  const maximumTaps = Math.min(MAX_FIR_TAPS, Math.max(3, Math.floor(specification.maxTaps || MAX_FIR_TAPS)));
  const attenuationDb = designAttenuation(specification);
  const beta = kaiserBeta(attenuationDb);
  const tapCount = estimateKaiserFirTapCount(specification);
  if (tapCount > maximumTaps) {
    throw new Error(`FIR specification requires ${tapCount} taps, above the ${maximumTaps}-tap safety limit.`);
  }
  const cacheKey = JSON.stringify({ ...specification, maxTaps: maximumTaps });
  const cached = designCache.get(cacheKey);
  if (cached) return cloneDesign(cached);

  const attempt = (taps: number): FirDesign | null => {
    const coefficients = designCoefficients(specification, taps, beta);
    const verification = verifyDesign(coefficients, specification);
    if (
      verification.passbandRippleDb <= specification.passbandRippleDb &&
      verification.stopbandAttenuationDb >= specification.stopbandAttenuationDb
    ) {
      return {
        coefficients,
        tapCount: taps,
        beta,
        delaySamples: (taps - 1) / 2,
        achievedPassbandRippleDb: verification.passbandRippleDb,
        achievedStopbandAttenuationDb: verification.stopbandAttenuationDb,
        specification: { ...specification }
      };
    }
    return null;
  };

  // The Kaiser estimate is usually within a few percent of the tap count that meets the
  // specification. Bracket the first passing odd tap count with geometrically growing steps and
  // then bisect, so the number of dense verifications is O(log taps) instead of O(taps).
  let passing: FirDesign | null = attempt(tapCount);
  let failing = tapCount;
  let step = 2;
  while (!passing) {
    if (failing >= maximumTaps) {
      throw new Error(`Unable to meet the FIR ripple/attenuation specification within ${maximumTaps} taps.`);
    }
    let candidateTaps = Math.min(maximumTaps, failing + step);
    if (candidateTaps % 2 === 0) candidateTaps -= 1;
    if (candidateTaps <= failing) candidateTaps = failing + 2;
    if (candidateTaps > maximumTaps) {
      throw new Error(`Unable to meet the FIR ripple/attenuation specification within ${maximumTaps} taps.`);
    }
    passing = attempt(candidateTaps);
    if (!passing) failing = candidateTaps;
    step *= 2;
  }
  while (passing.tapCount - failing > 2) {
    let middle = Math.floor((passing.tapCount + failing) / 2);
    if (middle % 2 === 0) middle += 1;
    if (middle >= passing.tapCount || middle <= failing) break;
    const candidate = attempt(middle);
    if (candidate) passing = candidate;
    else failing = middle;
  }
  if (designCache.size >= 32) designCache.delete(designCache.keys().next().value as string);
  designCache.set(cacheKey, passing);
  return cloneDesign(passing);
}

function directConvolution(input: number[], coefficients: number[]): number[] {
  const output = new Array<number>(input.length + coefficients.length - 1).fill(0);
  for (let inputIndex = 0; inputIndex < input.length; inputIndex += 1) {
    const value = input[inputIndex];
    for (let tap = 0; tap < coefficients.length; tap += 1) {
      output[inputIndex + tap] += value * coefficients[tap];
    }
  }
  return output;
}

function fftConvolution(input: number[], coefficients: number[]): number[] {
  const fftLength = FFT.nextPowerOfTwo(Math.max(2048, coefficients.length * 2));
  if (fftLength > MAX_CONVOLUTION_FFT) throw new Error('FIR convolution exceeds the FFT block safety limit.');
  const blockLength = fftLength - coefficients.length + 1;
  if (blockLength < 1) throw new Error('FIR convolution block is shorter than the coefficient array.');
  const kernel = new Float64Array(fftLength);
  kernel.set(coefficients);
  const kernelSpectrum = FFT.forward(kernel, { zeroPadMode: 'none' });
  const output = new Float64Array(input.length + coefficients.length - 1);

  for (let offset = 0; offset < input.length; offset += blockLength) {
    const count = Math.min(blockLength, input.length - offset);
    const block = new Float64Array(fftLength);
    for (let index = 0; index < count; index += 1) block[index] = input[offset + index];
    const spectrum = FFT.forward(block, { zeroPadMode: 'none' });
    for (let bin = 0; bin < fftLength; bin += 1) {
      const real = spectrum.re[bin];
      const imaginary = spectrum.im[bin];
      spectrum.re[bin] = real * kernelSpectrum.re[bin] - imaginary * kernelSpectrum.im[bin];
      spectrum.im[bin] = real * kernelSpectrum.im[bin] + imaginary * kernelSpectrum.re[bin];
    }
    const convolved = FFT.inverse(spectrum.re, spectrum.im);
    const validLength = Math.min(count + coefficients.length - 1, output.length - offset);
    for (let index = 0; index < validLength; index += 1) output[offset + index] += convolved[index];
  }
  return Array.from(output);
}

function convolve(input: number[], coefficients: number[]): number[] {
  return input.length * coefficients.length <= DIRECT_CONVOLUTION_WORK
    ? directConvolution(input, coefficients)
    : fftConvolution(input, coefficients);
}

export function estimateFirWorkingBytes(inputLength: number, tapCount: number): number {
  const fftLength = FFT.nextPowerOfTwo(Math.max(2048, tapCount * 2));
  return 8 * (6 * Math.max(0, inputLength) + 8 * Math.max(0, tapCount) + 16 * fftLength);
}

function reflectedValue(values: number[], index: number): number {
  if (values.length === 1) return values[0];
  const period = 2 * (values.length - 1);
  const wrapped = ((index % period) + period) % period;
  return values[wrapped < values.length ? wrapped : period - wrapped];
}

export function applyFir(
  input: ArrayLike<number>,
  coefficients: ArrayLike<number>,
  mode: FirApplicationMode
): number[] {
  if (input.length === 0 || coefficients.length === 0) return Array.from(input);
  if (coefficients.length % 2 !== 1) throw new Error('Linear-phase FIR application requires an odd tap count.');
  if (estimateFirWorkingBytes(input.length, coefficients.length) > MAX_FIR_WORKING_BYTES) {
    throw new Error(
      `FIR working set exceeds the ${Math.round(MAX_FIR_WORKING_BYTES / (1024 * 1024))} MiB safety limit.`
    );
  }
  const source = Array.from(input);
  const taps = Array.from(coefficients);
  if (taps.some((value) => !Number.isFinite(value))) throw new Error('FIR coefficients must all be finite.');
  const delay = (taps.length - 1) / 2;
  if (mode === 'causal') {
    const prefix = new Array<number>(taps.length - 1).fill(source[0]);
    const convolved = convolve([...prefix, ...source], taps);
    return convolved.slice(taps.length - 1, taps.length - 1 + source.length);
  }
  const extended = Array.from({ length: source.length + delay * 2 }, (_, index) =>
    reflectedValue(source, index - delay)
  );
  const convolved = convolve(extended, taps);
  return convolved.slice(delay * 2, delay * 2 + source.length);
}

export function computeFirResponse(
  coefficients: ArrayLike<number>,
  sampleRate: number,
  points = 1024,
  mode: FirApplicationMode = 'causal'
): FilterResponse {
  const taps = Array.from(coefficients);
  const count = Math.max(2, Math.floor(points));
  const delay = (taps.length - 1) / 2;
  const frequency = Array.from({ length: count }, (_, index) => (index * sampleRate) / (2 * (count - 1)));
  const magnitudeDb = new Array<number>(count);
  const phaseRadians = new Array<number>(count);
  for (let frequencyIndex = 0; frequencyIndex < count; frequencyIndex += 1) {
    const omega = (2 * Math.PI * frequency[frequencyIndex]) / sampleRate;
    let real = 0;
    let imaginary = 0;
    for (let tap = 0; tap < taps.length; tap += 1) {
      real += taps[tap] * Math.cos(omega * tap);
      imaginary -= taps[tap] * Math.sin(omega * tap);
    }
    if (mode === 'zero-phase') {
      const cosine = Math.cos(omega * delay);
      const sine = Math.sin(omega * delay);
      const shiftedReal = real * cosine - imaginary * sine;
      const shiftedImaginary = real * sine + imaginary * cosine;
      real = shiftedReal;
      imaginary = shiftedImaginary;
    }
    const magnitude = Math.hypot(real, imaginary);
    magnitudeDb[frequencyIndex] = 20 * Math.log10(Math.max(magnitude, 1e-15));
    phaseRadians[frequencyIndex] = Math.atan2(imaginary, real);
  }
  for (let index = 1; index < phaseRadians.length; index += 1) {
    while (phaseRadians[index] - phaseRadians[index - 1] > Math.PI) phaseRadians[index] -= 2 * Math.PI;
    while (phaseRadians[index] - phaseRadians[index - 1] < -Math.PI) phaseRadians[index] += 2 * Math.PI;
  }
  return {
    frequency,
    magnitudeDb,
    phaseDeg: phaseRadians.map((phase, index) => (magnitudeDb[index] > -120 ? (phase * 180) / Math.PI : 0)),
    groupDelaySeconds: magnitudeDb.map((magnitude) => (magnitude > -120 && mode === 'causal' ? delay / sampleRate : 0))
  };
}
