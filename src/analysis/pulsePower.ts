import { applyXOffset } from '../processing/filter';
import { QualityFlag } from '../data/quality';
import { alignQualityToTimebase, interpolateToTimebase } from '../processing/sampling';
import { dimensionsEqual, normalizeUnit } from '../units/units';
import { Measurements } from './measurements';

export interface PulsePowerInput {
  time: ArrayLike<number>;
  voltage: ArrayLike<number>;
  current: ArrayLike<number>;
  currentTime?: ArrayLike<number>;
  voltageTimingOffsetSeconds?: number;
  currentTimingOffsetSeconds?: number;
  voltageQuality?: ArrayLike<number>;
  currentQuality?: ArrayLike<number>;
  voltageUnit?: string;
  currentUnit?: string;
  voltagePolarity?: 1 | -1;
  currentPolarity?: 1 | -1;
  currentDelaySamples?: number;
  minimumCurrent?: number;
  region?: { i0: number; i1: number; markerName?: string };
  pretriggerRegion?: { i0: number; i1: number };
}

export interface EngineeringValue {
  value: number | null;
  unit: string;
}

export interface PulsePowerResult {
  metrics: Record<string, EngineeringValue>;
  warnings: string[];
  provenance: {
    region: { i0: number; i1: number; markerName?: string };
    voltagePolarity: 1 | -1;
    currentPolarity: 1 | -1;
    currentDelaySamples: number;
    voltageTimeOffsetSeconds: number;
    currentTimeOffsetSeconds: number;
    minimumCurrent: number;
    maskedImpedanceSamples: number;
  };
}

function maxAbsolute(values: number[]): number | null {
  let selected: number | null = null;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (selected === null || Math.abs(value) > Math.abs(selected)) selected = value;
  }
  return selected;
}

function mean(values: number[]): number | null {
  let total = 0;
  let count = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    total += value;
    count += 1;
  }
  return count > 0 ? total / count : null;
}

function median(values: number[]): number | null {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 === 0 ? (finite[middle - 1] + finite[middle]) / 2 : finite[middle];
}

function integrate(time: number[], values: number[]): number | null {
  let total = 0;
  let intervals = 0;
  for (let index = 1; index < Math.min(time.length, values.length); index += 1) {
    const dt = time[index] - time[index - 1];
    if (!(dt > 0) || !Number.isFinite(values[index - 1]) || !Number.isFinite(values[index])) continue;
    total += ((values[index - 1] + values[index]) * dt) / 2;
    intervals += 1;
  }
  return intervals > 0 ? total : null;
}

function derivative(time: number[], values: number[]): number[] {
  if (time.length < 2 || values.length < 2) return [];
  const length = Math.min(time.length, values.length);
  const output = new Array<number>(length);
  output[0] = (values[1] - values[0]) / (time[1] - time[0]);
  for (let index = 1; index < length - 1; index += 1) {
    output[index] = (values[index + 1] - values[index - 1]) / (time[index + 1] - time[index - 1]);
  }
  output[length - 1] = (values[length - 1] - values[length - 2]) / (time[length - 1] - time[length - 2]);
  return output;
}

function noiseMetrics(values: number[]): { rms: number | null; peakToPeak: number | null } {
  const average = mean(values);
  if (average === null) return { rms: null, peakToPeak: null };
  let sumSquares = 0;
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    sumSquares += (value - average) ** 2;
    min = Math.min(min, value);
    max = Math.max(max, value);
    count += 1;
  }
  return {
    rms: count > 0 ? Math.sqrt(sumSquares / count) : null,
    peakToPeak: count > 0 ? max - min : null
  };
}

function shiftQualityMask(mask: Uint16Array, offset: number): Uint16Array {
  if (offset === 0) return mask.slice();
  const shifted = new Uint16Array(mask.length);
  const fractional = offset !== Math.trunc(offset);
  let aggregateMask = QualityFlag.None;
  if (fractional) {
    for (const quality of mask) aggregateMask |= quality;
  }
  for (let index = 0; index < mask.length; index += 1) {
    const sourceIndex = index - offset;
    if (sourceIndex < 0 || sourceIndex > mask.length - 1) {
      shifted[index] = QualityFlag.Missing | QualityFlag.Interpolated;
      continue;
    }
    const lower = Math.floor(sourceIndex);
    const upper = Math.min(mask.length - 1, Math.ceil(sourceIndex));
    shifted[index] =
      mask[lower] |
      mask[upper] |
      aggregateMask |
      (fractional || lower !== upper ? QualityFlag.Interpolated : QualityFlag.None);
  }
  return shifted;
}

export function calculatePulsePower(input: PulsePowerInput): PulsePowerResult {
  const warnings: string[] = [];
  const voltageUnit = normalizeUnit(input.voltageUnit || 'V');
  const currentUnit = normalizeUnit(input.currentUnit || 'A');
  const expectedVoltage = normalizeUnit('V');
  const expectedCurrent = normalizeUnit('A');
  if (!voltageUnit) warnings.push(`Unknown voltage unit "${input.voltageUnit}". Values were treated as volts.`);
  if (!currentUnit) warnings.push(`Unknown current unit "${input.currentUnit}". Values were treated as amperes.`);
  if (voltageUnit && expectedVoltage && !dimensionsEqual(voltageUnit.dimension, expectedVoltage.dimension)) {
    throw new Error(`Voltage channel unit "${voltageUnit.symbol}" is not dimensionally compatible with volts.`);
  }
  if (currentUnit && expectedCurrent && !dimensionsEqual(currentUnit.dimension, expectedCurrent.dimension)) {
    throw new Error(`Current channel unit "${currentUnit.symbol}" is not dimensionally compatible with amperes.`);
  }
  const voltageScale = voltageUnit?.scale ?? 1;
  const currentScale = currentUnit?.scale ?? 1;
  const voltagePolarity = input.voltagePolarity ?? 1;
  const currentPolarity = input.currentPolarity ?? 1;
  const delay = Number.isFinite(input.currentDelaySamples) ? input.currentDelaySamples || 0 : 0;
  const minimumCurrent = Math.max(0, input.minimumCurrent ?? 1e-9);
  const length = Math.min(input.time.length, input.voltage.length);
  const voltageTimeOffset = input.voltageTimingOffsetSeconds || 0;
  const fullTime = Array.from(input.time)
    .slice(0, length)
    .map((time) => Number(time) + voltageTimeOffset);
  const fullVoltage = Array.from(input.voltage)
    .slice(0, length)
    .map((value) => Number(value) * voltageScale * voltagePolarity);
  const sourceCurrent = Array.from(input.current).map((value) => Number(value) * currentScale * currentPolarity);
  const alignedCurrent = input.currentTime
    ? interpolateToTimebase(input.currentTime, sourceCurrent, fullTime, input.currentTimingOffsetSeconds || 0)
    : {
        values: Array.from({ length }, (_, index) => sourceCurrent[index] ?? Number.NaN),
        warnings:
          sourceCurrent.length === length
            ? []
            : ['Current has no independent timebase; index alignment truncated unequal channel lengths.']
      };
  warnings.push(...alignedCurrent.warnings);
  const fullCurrent = delay === 0 ? alignedCurrent.values : applyXOffset(alignedCurrent.values, -delay);
  const sourceCurrentQuality = input.currentQuality
    ? Uint16Array.from(input.currentQuality)
    : new Uint16Array(sourceCurrent.length);
  const alignedCurrentQuality = input.currentTime
    ? alignQualityToTimebase(
        input.currentTime,
        sourceCurrentQuality,
        fullTime,
        input.currentTimingOffsetSeconds || 0,
        sourceCurrent
      )
    : (() => {
        const aligned = new Uint16Array(length);
        aligned.fill(QualityFlag.Missing);
        aligned.set(sourceCurrentQuality.slice(0, length));
        return aligned;
      })();
  const fullCurrentQuality = shiftQualityMask(alignedCurrentQuality, -delay);
  const start = Math.max(0, Math.min(input.region?.i0 ?? 0, length - 1));
  const end = Math.max(start, Math.min(input.region?.i1 ?? length - 1, length - 1));
  const time = fullTime.slice(start, end + 1);
  const voltage = fullVoltage.slice(start, end + 1);
  const current = fullCurrent.slice(start, end + 1);
  const qualityMask = QualityFlag.Clipped | QualityFlag.Saturated | QualityFlag.Invalid | QualityFlag.Missing;
  let suspectQualitySamples = 0;
  for (let index = start; index <= end; index += 1) {
    const voltageQuality = Number(input.voltageQuality?.[index] || 0);
    const currentQuality = fullCurrentQuality[index] || 0;
    if ((voltageQuality & qualityMask) !== 0 || (currentQuality & qualityMask) !== 0) suspectQualitySamples += 1;
  }
  if (suspectQualitySamples > 0) {
    warnings.push(
      `${suspectQualitySamples} sample(s) in the calculation region have missing, invalid or clipped quality flags.`
    );
  }
  const power = voltage.map((value, index) => value * current[index]);
  const currentSquared = current.map((value) => value * value);
  const impedance: number[] = [];
  let maskedImpedanceSamples = 0;
  for (let index = 0; index < current.length; index += 1) {
    if (Math.abs(current[index]) < minimumCurrent) {
      maskedImpedanceSamples += 1;
    } else {
      impedance.push(voltage[index] / current[index]);
    }
  }
  if (maskedImpedanceSamples > 0) {
    warnings.push(
      `Masked ${maskedImpedanceSamples} dynamic-impedance sample(s) below ${minimumCurrent.toPrecision(4)} A.`
    );
  }
  if (time.some((value, index) => index > 0 && !(value > time[index - 1]))) {
    warnings.push('Non-increasing timestamps were excluded from integrations where encountered.');
  }

  const voltageMeasurements = Measurements.compute({ t: time, y: voltage });
  const currentMeasurements = Measurements.compute({ t: time, y: current });
  warnings.push(...voltageMeasurements.warnings, ...currentMeasurements.warnings);
  const duration = time.length > 1 ? time[time.length - 1] - time[0] : 0;
  const energy = integrate(time, power);
  const charge = integrate(time, current);
  const actionIntegral = integrate(time, currentSquared);
  const pretriggerStart = Math.max(0, input.pretriggerRegion?.i0 ?? 0);
  const pretriggerEnd = Math.min(length - 1, input.pretriggerRegion?.i1 ?? Math.max(0, start - 1));
  const pretriggerVoltage =
    pretriggerEnd >= pretriggerStart ? fullVoltage.slice(pretriggerStart, pretriggerEnd + 1) : [];
  const pretriggerNoise = noiseMetrics(pretriggerVoltage);

  return {
    metrics: {
      peakVoltage: { value: maxAbsolute(voltage), unit: 'V' },
      peakCurrent: { value: maxAbsolute(current), unit: 'A' },
      peakPower: { value: maxAbsolute(power), unit: 'W' },
      averagePower: { value: duration > 0 && energy !== null ? energy / duration : null, unit: 'W' },
      energy: { value: energy, unit: 'J' },
      charge: { value: charge, unit: 'C' },
      actionIntegral: { value: actionIntegral, unit: 'A²·s' },
      dynamicImpedanceMedian: { value: median(impedance), unit: 'Ω' },
      maxDvDt: { value: maxAbsolute(derivative(time, voltage)), unit: 'V/s' },
      maxDiDt: { value: maxAbsolute(derivative(time, current)), unit: 'A/s' },
      voltageRiseTime: { value: voltageMeasurements.metrics.riseTime, unit: 's' },
      voltageFallTime: { value: voltageMeasurements.metrics.fallTime, unit: 's' },
      currentRiseTime: { value: currentMeasurements.metrics.riseTime, unit: 's' },
      currentFallTime: { value: currentMeasurements.metrics.fallTime, unit: 's' },
      voltagePulseWidth: { value: voltageMeasurements.metrics.pulseWidth, unit: 's' },
      currentPulseWidth: { value: currentMeasurements.metrics.pulseWidth, unit: 's' },
      pretriggerNoiseRms: { value: pretriggerNoise.rms, unit: 'V' },
      pretriggerNoisePeakToPeak: { value: pretriggerNoise.peakToPeak, unit: 'V' }
    },
    warnings: [...new Set(warnings)],
    provenance: {
      region: { i0: start, i1: end, markerName: input.region?.markerName },
      voltagePolarity,
      currentPolarity,
      currentDelaySamples: delay,
      voltageTimeOffsetSeconds: voltageTimeOffset,
      currentTimeOffsetSeconds: input.currentTimingOffsetSeconds || 0,
      minimumCurrent,
      maskedImpedanceSamples
    }
  };
}
