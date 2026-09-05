import { describe, expect, it } from 'vitest';
import { QualityFlag } from '../../src/data/quality';
import { buildQualitySummary } from '../../src/domain/provenance';
import { buildReport, buildReportArtifacts, renderReportHtml, serializeReportJson } from '../../src/io/reportBuilder';

const generatedAt = '2026-09-05T00:00:00.000Z';

describe('reproducible report serialization', () => {
  it('serializes every report section, including event metadata and typed spectral arrays', () => {
    const report = buildReport({
      generatedAt,
      applicationVersion: '6.0.0',
      buildId: 'abc123def456',
      trace: { name: 'Voltage', columnId: 'CH1', isMath: false },
      selection: { i0: 1, i1: 2, xMin: 0.001, xMax: 0.002 },
      source: {
        name: 'capture.csv',
        size: 42,
        lastModified: null,
        sha256: 'abc123'
      },
      processingRecipe: { pipeline: [{ type: 'movingAverage', windowSize: 5 }] },
      processingRecipeHash: 'processing-hash',
      analysisRecipe: { config: { fftWindow: 'hann' }, selectionOnly: true },
      analysisRecipeHash: 'analysis-hash',
      quality: buildQualitySummary(new Uint16Array([QualityFlag.None, QualityFlag.Clipped, QualityFlag.Interpolated]), {
        i0: 1,
        i1: 2
      }),
      moduleQuality: { spectral: { source: 'raw', excluded: 1 } },
      measurements: {
        metrics: { rms: 2.5, unavailableMetric: null },
        warnings: ['Shared limitation.'],
        meta: { sampleCount: 2 }
      },
      events: {
        events: [{ index: 2, time: 0.002, type: 'edge', metadata: { direction: 'rising', threshold: 1 } }],
        warnings: ['Event limitation.', 'Shared limitation.']
      },
      spectral: {
        fundamentalHz: 1000,
        thd: 0.02,
        snr: 100,
        bandpower: 4,
        warnings: ['Spectral limitation.'],
        spectrum: { re: new Float64Array([1, 2]), im: new Float64Array([0, -1]) }
      },
      system: {
        input: 'CH1',
        output: 'CH2',
        delay: {
          delaySeconds: 1e-6,
          delaySamples: 1,
          correlationPeak: 0.95,
          confidence: 0.91,
          warnings: ['Shared limitation.']
        },
        frf: {
          warnings: ['FRF limitation.'],
          meta: { segmentLength: 256, segmentCount: 8 }
        }
      },
      pipeline: [
        { stepId: 'smooth', warnings: ['Pipeline limitation.', 'Shared limitation.'] },
        { stepId: 'gain', warnings: ['Pipeline limitation.'] }
      ]
    });

    const json = serializeReportJson(report);
    const parsed = JSON.parse(json) as {
      source: { sha256: string };
      processingRecipe: { pipeline: Array<{ windowSize: number }> };
      analysisRecipe: { config: { fftWindow: string } };
      quality: { selectedSampleCount: number };
      measurements: { meta: { sampleCount: number } };
      events: { events: Array<{ metadata: { direction: string } }> };
      spectral: { spectrum: { re: number[]; im: number[] } };
      system: { delay: { confidence: number } };
      pipeline: Array<{ stepId: string }>;
      limitations: string[];
      buildId: string;
      moduleQuality: { spectral: { source: string } };
    };

    expect(parsed.source.sha256).toBe('abc123');
    expect(parsed.buildId).toBe('abc123def456');
    expect(parsed.moduleQuality.spectral.source).toBe('raw');
    expect(parsed.processingRecipe.pipeline[0].windowSize).toBe(5);
    expect(parsed.analysisRecipe.config.fftWindow).toBe('hann');
    expect(parsed.quality.selectedSampleCount).toBe(2);
    expect(parsed.measurements.meta.sampleCount).toBe(2);
    expect(parsed.events.events[0].metadata.direction).toBe('rising');
    expect(parsed.spectral.spectrum).toEqual({ re: [1, 2], im: [0, -1] });
    expect(parsed.system.delay.confidence).toBe(0.91);
    expect(parsed.pipeline[0].stepId).toBe('smooth');
    expect(parsed.limitations.filter((warning) => warning === 'Shared limitation.')).toHaveLength(1);
    expect(parsed.limitations).toContain('Pipeline limitation.');

    const html = renderReportHtml(report);
    expect(html).toContain('<th scope="row">Confidence</th><td>0.9100</td>');
    expect(html).toContain('<th scope="row">SNR</th><td>20.0000 dB</td>');
  });

  it('builds matching HTML and full JSON artifacts from one immutable snapshot', () => {
    const input = {
      generatedAt,
      trace: { name: 'CH1' },
      measurements: { metrics: { mean: 1 }, meta: { sampleCount: 3 } },
      events: { events: [] },
      spectral: { snr: null, warnings: [] }
    };
    const artifacts = buildReportArtifacts(input);

    input.measurements.metrics.mean = 99;

    expect(artifacts.report.measurements).toEqual({ metrics: { mean: 1 }, meta: { sampleCount: 3 } });
    expect(JSON.parse(artifacts.json).measurements.metrics.mean).toBe(1);
    expect(artifacts.html).toContain('<td>1.0000</td>');
  });

  it('renders every source fingerprint in multi-file provenance', () => {
    const report = buildReport({
      generatedAt,
      source: [
        { name: 'description.bin', sourceFileId: 'source-a', adapterId: 'rohde-schwarz-rtx', sha256: 'aaa' },
        { name: 'capture.Wfm.bin', sourceFileId: 'source-b', adapterId: 'rohde-schwarz-rtx', sha256: 'bbb' }
      ]
    });
    const html = renderReportHtml(report);

    expect(html).toContain('Source 1');
    expect(html).toContain('description.bin');
    expect(html).toContain('aaa');
    expect(html).toContain('Source 2');
    expect(html).toContain('capture.Wfm.bin');
    expect(html).toContain('bbb');
    expect(html).not.toContain('Source provenance unavailable');
  });

  it('discloses events omitted from a bounded HTML summary', () => {
    const report = buildReport({
      generatedAt,
      events: {
        events: [{ index: 1, time: 0.1, type: 'edge' }],
        totalEventCount: 10_000,
        omittedEventCount: 9_999
      }
    });
    const html = renderReportHtml(report);
    expect(html).toContain('10000 events reported; showing 1');
    expect(html).toContain('9999 omitted from this HTML summary');
  });
});

describe('human-readable report safety and unavailable values', () => {
  it('renders unavailable spectral and system values without inventing confidence', () => {
    const report = buildReport({
      generatedAt,
      trace: { name: 'CH1' },
      measurements: { metrics: { mean: null } },
      events: { events: [] },
      spectral: { fundamentalHz: null, thd: null, snr: null, bandpower: null },
      system: { delay: { delaySeconds: null, warnings: ['Delay unavailable.'] } }
    });
    const html = renderReportHtml(report);

    expect(html).toContain('<th scope="row">SNR</th><td>Unavailable</td>');
    expect(html).toContain('<th scope="row">Fundamental (Hz)</th><td>Unavailable</td>');
    expect(html).toContain('<th scope="row">Delay (s)</th><td>Unavailable</td>');
    expect(html).not.toContain('NaN dB');
    expect(html).not.toContain('>Confidence<');
    expect(report.limitations).toEqual(['Delay unavailable.']);
  });

  it('escapes every user-controlled HTML field and rejects unsafe image data URLs', () => {
    const attack = '<script>alert("report")</script>';
    const report = buildReport({
      generatedAt,
      applicationVersion: '6.0.0"><svg/onload=alert(1)>',
      title: '<img src=x onerror="alert(1)">',
      trace: { name: `trace ${attack}` },
      source: { name: `capture ${attack}.csv`, sha256: attack },
      processingRecipe: { label: attack },
      processingRecipeHash: attack,
      analysisRecipe: { expression: attack },
      measurements: { metrics: { [attack]: attack }, warnings: [attack] },
      events: {
        events: [{ index: 0, time: 0, type: attack, metadata: { note: `</td>${attack}` } }],
        warnings: [attack]
      },
      spectral: { snr: null, warnings: [attack] },
      limitations: [attack],
      plotImageDataUrl: 'data:image/svg+xml,<svg onload=alert(1)>'
    });
    const html = renderReportHtml(report);

    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).toContain('&lt;script&gt;alert(&quot;report&quot;)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert("report")</script>');
    expect(html).not.toContain('<img src=x onerror=');
    expect(html).not.toContain('data:image/svg+xml');
    expect(html).toContain('Plot snapshot unavailable.');
    expect(report.limitations).toEqual([attack]);

    const serialized = serializeReportJson(report);
    expect(JSON.parse(serialized).title).toBe('<img src=x onerror="alert(1)">');
  });
});
