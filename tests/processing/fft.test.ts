import { describe, expect, it } from 'vitest';
import { FFT } from '../../src/processing/fft';

function directDft(values: number[]): { re: number[]; im: number[] } {
  const re = new Array<number>(values.length).fill(0);
  const im = new Array<number>(values.length).fill(0);
  for (let k = 0; k < values.length; k += 1) {
    for (let n = 0; n < values.length; n += 1) {
      const angle = (-2 * Math.PI * k * n) / values.length;
      re[k] += values[n] * Math.cos(angle);
      im[k] += values[n] * Math.sin(angle);
    }
  }
  return { re, im };
}

function uniformTime(length: number, sampleRate: number): number[] {
  return Array.from({ length }, (_, index) => index / sampleRate);
}

describe('FFT', () => {
  it('matches a direct DFT for a prime-length record with padding disabled', () => {
    const values = [0.25, -1, 2, 0.5, -0.75, 1.25, 0.125];
    const expected = directDft(values);
    const actual = FFT.forward(values, { zeroPadMode: 'none' });

    expect(actual.length).toBe(values.length);
    for (let i = 0; i < values.length; i += 1) {
      expect(actual.re[i]).toBeCloseTo(expected.re[i], 10);
      expect(actual.im[i]).toBeCloseTo(expected.im[i], 10);
    }
  });

  it('round-trips power-of-two and non-power-of-two records', () => {
    for (const length of [8, 15, 31]) {
      const values = Array.from({ length }, (_, index) => Math.sin(index * 0.37) + index / 100);
      const transformed = FFT.forward(values, { zeroPadMode: 'none' });
      const restored = FFT.inverse(transformed.re, transformed.im, values.length);

      restored.forEach((value, index) => expect(value).toBeCloseTo(values[index], 10));
    }
  });

  it('keeps bin-centred tone amplitude invariant under zero padding', () => {
    const length = 1024;
    const sampleRate = 1024;
    const amplitude = 2.75;
    const frequency = 37;
    const signal = Array.from(
      { length },
      (_, index) => amplitude * Math.sin((2 * Math.PI * frequency * index) / sampleRate)
    );
    const time = uniformTime(length, sampleRate);

    const spectra = [
      FFT.computeSpectrum(signal, time, {
        windowType: 'rectangular',
        detrend: 'none',
        zeroPadMode: 'none',
        cacheKey: 'none'
      }),
      FFT.computeSpectrum(signal, time, {
        windowType: 'rectangular',
        detrend: 'none',
        zeroPadMode: 'factor',
        zeroPadFactor: 2,
        cacheKey: 'two'
      }),
      FFT.computeSpectrum(signal, time, {
        windowType: 'rectangular',
        detrend: 'none',
        zeroPadMode: 'factor',
        zeroPadFactor: 4,
        cacheKey: 'four'
      })
    ];

    for (const spectrum of spectra) {
      const bin = Math.round(frequency / spectrum.meta.deltaF);
      expect(spectrum.linearMagnitude[bin]).toBeCloseTo(amplitude, 10);
    }
  });

  it('integrates one-sided PSD to the time-domain mean square', () => {
    const length = 1000;
    const sampleRate = 10_000;
    const signal = Array.from(
      { length },
      (_, index) =>
        0.7 * Math.sin((2 * Math.PI * 37 * index) / length) + 0.2 * Math.cos((2 * Math.PI * 113 * index) / length)
    );
    const spectrum = FFT.computeSpectrum(signal, uniformTime(length, sampleRate), {
      windowType: 'rectangular',
      detrend: 'none',
      zeroPadMode: 'factor',
      zeroPadFactor: 4,
      cacheKey: 'psd'
    });
    const spectralMeanSquare = spectrum.psd.reduce((sum, value) => sum + value, 0) * spectrum.meta.deltaF;
    const timeMeanSquare = signal.reduce((sum, value) => sum + value * value, 0) / signal.length;

    expect(spectralMeanSquare).toBeCloseTo(timeMeanSquare, 10);
  });

  it('resamples a non-uniform timebase before spectral analysis', () => {
    const length = 256;
    const sampleRate = 1000;
    const time = Array.from({ length }, (_, index) => index / sampleRate + (index % 7 === 0 ? 0.00005 : 0));
    const signal = time.map((value) => Math.sin(2 * Math.PI * 50 * value));
    const spectrum = FFT.computeSpectrum(signal, time, {
      windowType: 'hann',
      zeroPadMode: 'nextPow2'
    });

    expect(spectrum.meta.resampled).toBe(true);
    expect(spectrum.warnings.some((warning) => warning.includes('Resampled'))).toBe(true);
    expect(spectrum.freq.length).toBeGreaterThan(0);
  });
});
