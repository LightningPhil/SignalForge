import { performance } from 'node:perf_hooks';
import { EventDetector } from '../src/analysis/eventDetector.ts';
import { Filter } from '../src/processing/filter.ts';
import { designKaiserFir } from '../src/processing/fir.ts';
import { alignedLttbIndices } from '../src/processing/lttb.ts';
import { buildScaleFixture } from '../tests/synthetic/scale.ts';

const requested = process.argv.includes('--million') ? [100_000, 1_000_000] : [100_000];

function measure(label, operation) {
  const started = performance.now();
  const value = operation();
  return { label, milliseconds: Number((performance.now() - started).toFixed(3)), value };
}

const runs = requested.map((sampleCount) => {
  const generated = measure('generate', () => buildScaleFixture(sampleCount));
  const { record } = generated.value;
  const filtered = measure('moving-average-9', () =>
    Filter.applyPipeline(record.values, record.time, [
      { id: 'bench-smooth', type: 'movingAverage', enabled: true, windowSize: 9 }
    ])
  );
  const events = measure('event-detection', () =>
    EventDetector.detect({
      t: record.time,
      y: record.values,
      quality: record.quality,
      config: {
        type: 'level',
        direction: 'rising',
        threshold: 0.5,
        hysteresis: 0.05,
        selectionOnly: false
      }
    })
  );
  const display = measure('aligned-lttb', () => alignedLttbIndices(record.time, [record.values, filtered.value], 4096));
  return {
    sampleCount,
    timingsMs: Object.fromEntries(
      [generated, filtered, events, display].map(({ label, milliseconds }) => [label, milliseconds])
    ),
    resultShape: {
      filteredSamples: filtered.value.length,
      events: events.value.events.length,
      displaySamples: display.value.length
    },
    payloadBytes: record.time.byteLength + record.values.byteLength + record.quality.byteLength
  };
});

const firDesign = measure('kaiser-fir-10k-design', () =>
  designKaiserFir({
    kind: 'lowpass',
    sampleRate: 1_000_000,
    passbandEdgeHz: 10_000,
    stopbandEdgeHz: 10_500,
    passbandRippleDb: 0.1,
    stopbandAttenuationDb: 80
  })
);

const memory = process.memoryUsage();
console.log(
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      runtime: process.version,
      platform: `${process.platform}-${process.arch}`,
      runs,
      firDesign: {
        milliseconds: firDesign.milliseconds,
        tapCount: firDesign.value.tapCount,
        achievedPassbandRippleDb: firDesign.value.achievedPassbandRippleDb,
        achievedStopbandAttenuationDb: firDesign.value.achievedStopbandAttenuationDb
      },
      processMemoryBytes: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers
      },
      policy:
        'Informational benchmark: structural and numerical tests gate correctness; wall-clock values do not gate CI.'
    },
    null,
    2
  )
);
