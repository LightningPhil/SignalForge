import { describe, expect, it } from 'vitest';
import { QualityFlag } from '../../src/data/quality';
import { DelimitedTextAdapter } from '../../src/io/adapters/delimitedTextAdapter';
import { ImportAdapterRegistry } from '../../src/io/adapters/registry';
import { UnsupportedVariantError, type ImportSource } from '../../src/io/adapters/types';

function source(name: string, text: string): ImportSource {
  const bytes = new TextEncoder().encode(text);
  return { name, bytes, size: bytes.length, lastModified: null };
}

describe('waveform import adapters', () => {
  it('imports robust delimited text without hiding invalid values', async () => {
    const result = await DelimitedTextAdapter.import(
      source('shot.csv', 'Instrument metadata\nTime (s),Voltage (V)\n0,1\n0.1,CLIPPED\n0.2,3\n'),
      { headerRow: 1 }
    );

    expect(result.channels).toHaveLength(1);
    expect(Array.from(result.channels[0].values)).toEqual([1, Number.NaN, 3]);
    expect(result.channels[0].quality[1] & QualityFlag.Clipped).toBeTruthy();
    expect(result.channels[0].unit).toBe('V');
  });

  it('reports native formats as fixture-gated rather than pretending to decode them', async () => {
    const nativeSource = source('capture.trc', 'not a real fixture');
    const candidates = ImportAdapterRegistry.identify(nativeSource);
    const adapter = candidates[0].adapter;

    expect(adapter.status).toBe('fixture-required');
    await expect(adapter.import(nativeSource)).rejects.toBeInstanceOf(UnsupportedVariantError);
  });

  it('normalizes declared time units to seconds', async () => {
    const result = await DelimitedTextAdapter.import(source('timed.csv', 'Time (ms),Voltage (V)\n0,0\n2,1\n'));

    expect(Array.from(result.channels[0].time)).toEqual([0, 0.002]);
    expect(result.channels[0].timeUnit).toBe('s');
    expect(result.sourceFile.metadata.declaredTimeUnit).toBe('ms');
  });

  it('preserves missing timestamps without mislabeling the next valid sample as non-monotonic', async () => {
    const result = await DelimitedTextAdapter.import(source('gapped.csv', 'Time (s),Voltage (V)\n0,1\n,2\n1,3\n'));

    expect(result.channels[0].quality[1] & QualityFlag.Missing).toBeTruthy();
    expect(result.channels[0].quality[1] & QualityFlag.NonMonotonicTime).toBeFalsy();
    expect(result.channels[0].quality[2] & QualityFlag.NonMonotonicTime).toBeFalsy();
  });
});
