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

  it('keeps SNR within 1 dB of the analytic value under zero-padding and wide-main-lobe windows', () => {
    // Regression: the signal region used to be a fixed +/-2 transform bins, so padding and
    // Blackman-Harris/flat-top leakage were counted as noise (errors of 10-20 dB).
    const sampleRate = 4096;
    const length = 4096;
    const sigma = 0.1;
    let seed = 42;
    const gaussian = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      const u1 = (seed + 1) / 4294967297;
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      const u2 = (seed + 1) / 4294967297;
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    };
    const time = Array.from({ length }, (_, index) => index / sampleRate);
    const noise = time.map(() => sigma * gaussian());
    let noiseVariance = 0;
    for (const value of noise) noiseVariance += value * value;
    noiseVariance /= length;
    const signal = time.map((value, index) => Math.sin(2 * Math.PI * 100 * value) + noise[index]);
    const expectedSnrDb = 10 * Math.log10(0.5 / noiseVariance);

    for (const windowType of ['hann', 'blackman-harris', 'flattop'] as const) {
      for (const zeroPadFactor of [1, 4, 16]) {
        const summary = SpectralMetrics.summarize(signal, time, {
          windowType,
          detrend: 'none',
          zeroPadMode: zeroPadFactor === 1 ? 'none' : 'factor',
          zeroPadFactor,
          fundamentalHz: 100,
          harmonicCount: 1
        });
        const snrDb = 10 * Math.log10(summary.snr as number);
        expect(Math.abs(snrDb - expectedSnrDb), `${windowType} x${zeroPadFactor}`).toBeLessThan(1);
      }
    }
  });

  it('still finds smooth zero-padded peaks with the default prominence threshold', () => {
    // Regression: prominence was an adjacent-bin slope test that returned nothing at 8x-16x padding.
    const sampleRate = 1024;
    const length = 1024;
    const time = Array.from({ length }, (_, index) => index / sampleRate);
    const signal = time.map((value) => Math.sin(2 * Math.PI * 100 * value) + 0.3 * Math.sin(2 * Math.PI * 300 * value));
    for (const windowType of ['hann', 'blackman-harris', 'flattop'] as const) {
      for (const zeroPadFactor of [4, 16, 32]) {
        const summary = SpectralMetrics.summarize(signal, time, {
          windowType,
          detrend: 'none',
          zeroPadMode: 'factor',
          zeroPadFactor,
          maxPeaks: 2
        });
        const found = summary.peaks.map((peak) => Math.round(peak.freq)).sort((a, b) => a - b);
        expect(found, `${windowType} x${zeroPadFactor}`).toEqual([100, 300]);
      }
    }
  });

  it('uses the median-based sample rate so one short first interval cannot bias the frequency axis', () => {
    const length = 4096;
    const time = Array.from({ length }, (_, index) => index / 1000);
    time[0] = time[1] - 0.001 * 0.991;
    const signal = time.map((value) => Math.sin(2 * Math.PI * 250 * value));
    const summary = SpectralMetrics.summarize(signal, time, { windowType: 'hann', detrend: 'none', maxPeaks: 1 });

    expect(summary.spectrum.meta.resampled).toBe(false);
    // The first-interval estimate would report 1 / 0.000991 s = 1009 Hz (0.9 % error).
    expect(Math.abs(summary.spectrum.meta.fs - 1000)).toBeLessThan(0.01);
    expect(summary.peaks[0].freq).toBeCloseTo(250, 0);
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

  it('resamples a jittered timebase before framing the STFT', () => {
    const sampleRate = 4096;
    const length = 4096;
    const time = Array.from({ length }, (_, index) => index / sampleRate + (index % 5 === 0 ? 0.3 / sampleRate : 0));
    const signal = time.map((value) => Math.sin(2 * Math.PI * 400 * value));
    const result = TimeFrequency.computeSpectrogram(signal, time, { windowSize: 512, maxPoints: 0 });
    const firstFrame = result.magnitudeDb.map((bins) => bins[0]);
    let dominantIndex = 1;
    for (let index = 2; index < firstFrame.length; index += 1) {
      if (firstFrame[index] > firstFrame[dominantIndex]) dominantIndex = index;
    }

    expect(result.warnings.join(' ')).toContain('Resampled');
    expect(result.freqBins[dominantIndex]).toBeCloseTo(400, -1);
    expect(result.meta.fs).toBeCloseTo(sampleRate, -1);
  });

  it('accepts a reversed selection range', () => {
    const time = Array.from({ length: 2048 }, (_, index) => index / 2048);
    const signal = time.map((value) => Math.sin(2 * Math.PI * 100 * value));
    const forward = TimeFrequency.computeSpectrogram(signal, time, {
      selection: { i0: 100, i1: 1800 },
      windowSize: 256
    });
    const reversed = TimeFrequency.computeSpectrogram(signal, time, {
      selection: { i0: 1800, i1: 100 },
      windowSize: 256
    });

    expect(reversed.meta.nFrames).toBe(forward.meta.nFrames);
    expect(reversed.meta.nFrames).toBeGreaterThan(0);
  });
});
