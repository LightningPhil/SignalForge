import { describe, expect, it } from 'vitest';
import { SpectralMetrics } from '../../src/analysis/spectralMetrics';
import { TimeFrequency } from '../../src/analysis/timeFrequency';

describe('PSD-based spectral metrics', () => {
  it('reports bandpower in squared engineering units', () => {
    const sampleRate = 2048;
    const length = 2048;
    const time = Array.from({ length }, (_, index) => index / sampleRate);
    const signal = time.map((value) => 2 * Math.sin(2 * Math.PI * 100 * value));
    const summary = SpectralMetrics.summarize(signal, time, {
      windowType: 'rectangular',
      detrend: 'none',
      zeroPadMode: 'none',
      fundamentalHz: 100,
      bandStartHz: 90,
      bandEndHz: 110
    });

    expect(summary.bandpower).toBeCloseTo(2, 10);
    expect(summary.thd).toBeLessThan(1e-10);
  });

  it('does not count deterministic harmonic distortion as noise in SNR', () => {
    const sampleRate = 4096;
    const length = 4096;
    const time = Array.from({ length }, (_, index) => index / sampleRate);
    const signal = time.map((value) => Math.sin(2 * Math.PI * 100 * value) + 0.1 * Math.sin(2 * Math.PI * 200 * value));
    const summary = SpectralMetrics.summarize(signal, time, {
      windowType: 'rectangular',
      detrend: 'none',
      zeroPadMode: 'none',
      fundamentalHz: 100,
      harmonicCount: 5
    });

    expect(summary.thd).toBeCloseTo(0.1, 10);
    expect(summary.snr).toBeNull();
  });

  it('does not clamp out-of-band harmonics onto the Nyquist bin', () => {
    const frequency = Array.from({ length: 501 }, (_, index) => index);
    const psd = new Array<number>(501).fill(0);
    const magnitude = new Array<number>(501).fill(0);
    psd[120] = 100;
    psd[500] = 1;
    magnitude[120] = 10;

    expect(SpectralMetrics.snr(frequency, psd, 120, 500, 5, 0)).toBeCloseTo(100, 12);
    expect(SpectralMetrics.computeHarmonics(frequency, magnitude, 120, 5).map((peak) => peak.order)).toEqual([
      1, 2, 3, 4
    ]);
  });
});

describe('spectrogram anti-aliasing', () => {
  it('filters before reducing a large STFT input', () => {
    const sampleRate = 4096;
    const length = 4096;
    const time = Array.from({ length }, (_, index) => index / sampleRate);
    const signal = time.map((value) => Math.sin(2 * Math.PI * 100 * value) + Math.sin(2 * Math.PI * 900 * value));
    const result = TimeFrequency.computeSpectrogram(signal, time, {
      windowSize: 256,
      maxPoints: 1024,
      windowType: 'hann'
    });
    const firstFrame = result.magnitudeDb.map((bins) => bins[0]);
    let dominantIndex = 1;
    for (let index = 2; index < firstFrame.length; index += 1) {
      if (firstFrame[index] > firstFrame[dominantIndex]) dominantIndex = index;
    }

    expect(result.meta.antiAliasCutoffHz).toBeDefined();
    expect(result.freqBins[dominantIndex]).toBeCloseTo(100, -1);
    expect(result.warnings.join(' ')).toContain('IIR anti-alias');
  });
});
