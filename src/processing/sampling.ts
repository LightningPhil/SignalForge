import type { FrequencyAxis } from '../types';

export function estimateSampleRate(timeArray: ArrayLike<number> | null | undefined, sampleLimit = 100): number {
  if (!timeArray || timeArray.length < 2) return 1.0;

  const limit = Math.min(sampleLimit, timeArray.length - 1);
  let sumDt = 0;
  let count = 0;

  for (let i = 0; i < limit; i++) {
    const dt = timeArray[i + 1] - timeArray[i];
    if (Number.isFinite(dt) && dt > 0) {
      sumDt += dt;
      count += 1;
    }
  }

  if (count === 0 || sumDt <= 0) return 1.0;
  return 1.0 / (sumDt / count);
}

export function frequencyBinCount(fftSize: number): number {
  return Math.floor(fftSize / 2) + 1;
}

export function frequencyBinWidth(fftSize: number, fs: number): number {
  return fftSize > 0 ? fs / fftSize : 0;
}

export function buildFrequencyAxis(fftSize: number, fs: number): FrequencyAxis {
  const nBins = frequencyBinCount(fftSize);
  const binWidth = frequencyBinWidth(fftSize, fs);
  const axis = new Array<number>(nBins);
  for (let i = 0; i < nBins; i++) {
    axis[i] = i * binWidth;
  }
  return { axis, binWidth, nBins };
}
