import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DelimitedTextAdapter } from '../../src/io/adapters/delimitedTextAdapter';
import { NativeScopeAdapter } from '../../src/io/adapters/nativeScopeAdapter';
import type { ImportSource } from '../../src/io/adapters/types';
import { compileFilenameProfile, parseFieldCorrection } from '../../src/io/filenameProfile';
import { decodePicoCsv } from '../../src/io/scope/adapters/picoCsv';
import { decodeScopeRequest } from '../../src/io/scope/decode';
import { detectScopeFile } from '../../src/io/scope/detect';
import { groupScopeSourcesWithFailures } from '../../src/io/scope/groupFiles';
import { ScopeImportLimits } from '../../src/io/scope/limits';
import { ScopeImportClient } from '../../src/io/scope/client';
import { ScopeImportError } from '../../src/io/scope/types';
import type { ScopeWorkerRequest } from '../../src/io/scope/workerProtocol';

const fixtureRoot = path.resolve('reference-material/SignalForge-scope-import-examples/fixtures');

function textSource(name: string, text: string): ImportSource {
  const bytes = new TextEncoder().encode(text);
  return { name, bytes, size: bytes.length, lastModified: null };
}

async function fixture(relativePath: string, overrideName?: string): Promise<ImportSource> {
  const bytes = new Uint8Array(await readFile(path.join(fixtureRoot, relativePath)));
  return { name: overrideName || path.basename(relativePath), bytes, size: bytes.length, lastModified: null };
}

function withBytes(source: ImportSource, bytes: Uint8Array): ImportSource {
  return { ...source, bytes, size: bytes.length };
}

describe('import hardening regressions', () => {
  it('requires XINCR and YMULT in Tektronix ISF preambles and discloses defaulted calibration terms', async () => {
    const isf = await fixture('tektronix/representative_pulse.isf');
    const text = new TextDecoder('latin1').decode(isf.bytes);
    const preambleEnd = text.indexOf(':CURVE');
    const rewrite = (transform: (preamble: string) => string): ImportSource => {
      const preamble = transform(text.slice(0, preambleEnd));
      const bytes = new Uint8Array(preamble.length + isf.bytes.length - preambleEnd);
      for (let index = 0; index < preamble.length; index += 1) bytes[index] = preamble.charCodeAt(index);
      bytes.set(isf.bytes.subarray(preambleEnd), preamble.length);
      return withBytes(isf, bytes);
    };

    await expect(decodeScopeRequest({ primary: rewrite((p) => p.replace(/YMULT [^;]+;/, '')) })).rejects.toThrow(
      /no YMULT field/
    );
    await expect(decodeScopeRequest({ primary: rewrite((p) => p.replace(/XINCR [^;]+;/, '')) })).rejects.toThrow(
      /no XINCR field/
    );
    const defaulted = await decodeScopeRequest({ primary: rewrite((p) => p.replace(/YOFF [^;]+;/, '')) });
    expect(defaulted[0].warnings.join('\n')).toMatch(/YOFF=0/);
    const intact = await decodeScopeRequest({ primary: isf });
    expect(intact[0].warnings.join('\n')).not.toMatch(/YOFF/);
  });

  it('rejects blank PicoScope timestamps and normalises unit case without touching SI prefixes', () => {
    expect(() =>
      decodePicoCsv({ primary: textSource('pico.csv', 'Time,Channel A\n(us),(V)\n0,1\n,2\n2,3\n') })
    ).toThrow(ScopeImportError);
    const lowercase = decodePicoCsv({ primary: textSource('pico.csv', 'Time,Channel A\n(us),(mv)\n0,1\n1,2\n') });
    expect(lowercase[0].channels[0]).toMatchObject({ unit: 'V', sourceToSiScale: 1e-3 });
    const mega = decodePicoCsv({ primary: textSource('pico.csv', 'Time,Channel A\n(us),(MV)\n0,1\n1,2\n') });
    expect(mega[0].channels[0].sourceToSiScale).toBe(1e6);
    const unknown = decodePicoCsv({ primary: textSource('pico.csv', 'Time,Channel A\n(us),(furlongs)\n0,1\n1,2\n') });
    expect(unknown[0].warnings.join('\n')).toMatch(/furlongs/);
  });

  it('keeps every row of a headerless numeric text file instead of consuming the first sample as names', async () => {
    const result = await DelimitedTextAdapter.import(textSource('raw.csv', '0,1\n0.001,2\n0.002,3\n'));
    expect(result.channels).toHaveLength(1);
    expect(result.channels[0].name).toBe('Channel 1');
    expect(Array.from(result.channels[0].time)).toEqual([0, 0.001, 0.002]);
    expect(Array.from(result.channels[0].values)).toEqual([1, 2, 3]);
    expect(result.warnings.join('\n')).toMatch(/No header row/);
    const tabbed = await DelimitedTextAdapter.import(textSource('raw.tsv', '0\t1\t5\n1\t2\t6\n'));
    expect(tabbed.channels.map((channel) => channel.name)).toEqual(['Channel 1', 'Channel 2']);
    expect(Array.from(tabbed.channels[1].values)).toEqual([5, 6]);
  });

  it('bounds delimited text channel count and predicted memory before parsing', async () => {
    const wideHeader = [
      'Time',
      ...Array.from({ length: ScopeImportLimits.maxDelimitedChannels + 1 }, (_, i) => `C${i}`)
    ];
    const wide = textSource('wide.csv', `${wideHeader.join(',')}\n${wideHeader.map(() => '1').join(',')}\n`);
    await expect(DelimitedTextAdapter.import(wide)).rejects.toThrow(/limited to/);
    const oversized: ImportSource = {
      name: 'huge.csv',
      bytes: new Uint8Array(0),
      size: 0,
      lastModified: null
    };
    Object.defineProperty(oversized.bytes, 'byteLength', { value: ScopeImportLimits.maxTextBytes + 1 });
    await expect(DelimitedTextAdapter.import(oversized)).rejects.toThrow(/limited to/);
  });

  it('does not let textual cookies hijack generic CSV files as Keysight or Rigol binaries', () => {
    const keysightLike = textSource('AG10_bench.csv', 'AG10,Voltage (V),Current (A)\n0,1,2\n1,2,3\n2,3,4\n');
    const detectedKeysight = detectScopeFile(keysightLike);
    expect(detectedKeysight === null || detectedKeysight.format !== 'keysight-bin').toBe(true);
    const rigolLike = textSource('RG01_log.csv', 'RG01,Time (s),Voltage (V)\n0,1\n1,2\n2,3\n');
    const detectedRigol = detectScopeFile(rigolLike);
    expect(detectedRigol === null || detectedRigol.format !== 'rigol-bin').toBe(true);
  });

  it('groups the rest of a selection when one R&S half is orphaned', async () => {
    const orphan = await fixture('rohde_schwarz/rs_rtp_int8.bin');
    const tek = await fixture('tektronix/analog_waveform.wfm');
    const result = groupScopeSourcesWithFailures([orphan, tek]);
    expect(result.groups.map((group) => group.primary.name)).toEqual([tek.name]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].sources.map((source) => source.name)).toEqual([orphan.name]);
    expect(result.failures[0].error).toBeInstanceOf(ScopeImportError);
  });

  it('re-parses manual filename corrections with the field rules', () => {
    const profile = compileFilenameProfile('shot{shot:int}_{voltage:quantity[V]}');
    const voltage = profile.fields.find((field) => field.name === 'voltage');
    const shot = profile.fields.find((field) => field.name === 'shot');
    if (!voltage || !shot) throw new Error('profile fields missing');
    expect(parseFieldCorrection(voltage, '25 kV')).toMatchObject({ field: { value: 25, valueSi: 25000 } });
    expect(parseFieldCorrection(voltage, '25 A')).toHaveProperty('warning');
    expect(parseFieldCorrection(voltage, 'twenty five')).toHaveProperty('warning');
    expect(parseFieldCorrection(shot, '7')).toMatchObject({ field: { value: 7 } });
    expect(parseFieldCorrection(shot, '7.5')).toHaveProperty('warning');
  });

  it('reports the decoded evidence level rather than the pre-decode guess', async () => {
    const dho = await fixture('rigol/rigol_dho824.wfm');
    const result = await NativeScopeAdapter.import(dho);
    expect(result.supportLevel).toBe('verified');
    expect(result.sourceFile.metadata.supportLevel).toBe('verified');
  });

  it('discloses Tektronix vendor tails and rejects LeCroy files with bytes beyond the declared blocks', async () => {
    const tek = await fixture('tektronix/analog_waveform.wfm');
    const records = await decodeScopeRequest({ primary: tek });
    expect(records[0].warnings.join('\n')).toMatch(/after the declared Tektronix EOF/);

    const trc = await fixture('teledyne_lecroy/lecroy_waverunner_template_2_3.trc');
    const padded = new Uint8Array(trc.bytes.length + 16);
    padded.set(trc.bytes);
    await expect(decodeScopeRequest({ primary: withBytes(trc, padded) })).rejects.toThrow(/declared blocks end/);
    const newline = new Uint8Array(trc.bytes.length + 1);
    newline.set(trc.bytes);
    newline[trc.bytes.length] = 0x0a;
    const [withNewline] = await decodeScopeRequest({ primary: withBytes(trc, newline) });
    const [pristine] = await decodeScopeRequest({ primary: trc });
    expect(withNewline.channels[0].values.length).toBe(pristine.channels[0].values.length);
  });

  it('fails an import whose worker result cannot be deserialised instead of hanging', async () => {
    class BrokenWorker extends EventTarget {
      postMessage(request: ScopeWorkerRequest): void {
        void request;
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('messageerror', { data: null })));
      }
      terminate(): void {}
    }
    const client = new ScopeImportClient(() => new BrokenWorker() as unknown as Worker);
    await expect(
      client.decode({ name: 'capture.isf', bytes: new Uint8Array([1, 2, 3]), size: 3, lastModified: null })
    ).rejects.toThrow(/deserialisation failed/);
  });
});
