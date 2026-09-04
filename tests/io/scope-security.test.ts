import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ImportSource } from '../../src/io/adapters/types';
import { decodePicoCsv } from '../../src/io/scope/adapters/picoCsv';
import { decodeScopeRequest } from '../../src/io/scope/decode';
import { detectScopeFile } from '../../src/io/scope/detect';
import { groupScopeSources } from '../../src/io/scope/groupFiles';
import { ScopeImportError } from '../../src/io/scope/types';

const fixtureRoot = path.resolve('reference-material/SignalForge-scope-import-examples/fixtures');

async function source(relativePath: string, overrideName?: string): Promise<ImportSource> {
  const bytes = new Uint8Array(await readFile(path.join(fixtureRoot, relativePath)));
  return {
    name: overrideName || path.basename(relativePath),
    bytes,
    size: bytes.length,
    lastModified: null
  };
}

const truncationFixtures = [
  'tektronix/analog_waveform.wfm',
  'tektronix/fastframe_5mhz_100frames.wfm',
  'tektronix/representative_pulse.isf',
  'keysight/keysight_dsox1102g_single_channel.bin',
  'keysight/keysight_synthetic_ag03.bin',
  'teledyne_lecroy/lecroy_7200_template_1_0.trc',
  'teledyne_lecroy/lecroy_waverunner_template_2_3.trc',
  'teledyne_lecroy/lecroy_synthetic_be_word.trc',
  'rigol/rigol_ds1204b.wfm',
  'rigol/rigol_ds1202ca.wfm',
  'rigol/rigol_ds1102d.wfm',
  'rigol/rigol_ds1054z.wfm',
  'rigol/rigol_ds2072a.wfm',
  'rigol/rigol_ds4022.wfm',
  'rigol/rigol_mso5000.bin',
  'rigol/rigol_dho824.wfm',
  'rigol/rigol_dho824.bin'
];

describe('native scope import security', () => {
  it('uses case-sensitive SI prefixes for PicoScope CSV and rejects scaled overflow', () => {
    const pico = (unit: string, value: string): ImportSource => {
      const bytes = new TextEncoder().encode(`Time,Channel A\n(us),(${unit})\n0,${value}\n1,2\n`);
      return { name: 'pico.csv', bytes, size: bytes.length, lastModified: null };
    };
    expect(decodePicoCsv({ primary: pico('uV', '1') })[0].channels[0]).toMatchObject({
      unit: 'V',
      sourceUnit: 'uV',
      sourceToSiScale: 1e-6
    });
    expect(decodePicoCsv({ primary: pico('MV', '1') })[0].channels[0].values[0]).toBe(1e6);
    expect(decodePicoCsv({ primary: pico('pA', '1') })[0].channels[0].values[0]).toBe(1e-12);
    expect(() => decodePicoCsv({ primary: pico('kV', '1e308') })).toThrow(/overflows/);
    const oversizedCell = pico('V', '1'.repeat(1025));
    expect(() => decodePicoCsv({ primary: oversizedCell })).toThrow(/cell exceeds/);
    const extraCells = new TextEncoder().encode(
      `Time,Channel A\n(us),(V)\n0,1,${new Array(2000).fill('1').join(',')}\n`
    );
    expect(() =>
      decodePicoCsv({
        primary: { name: 'wide.csv', bytes: extraCells, size: extraCells.length, lastModified: null }
      })
    ).toThrow(/cells; expected/);
  });

  it('uses structural content probes instead of extension or waveform text alone', async () => {
    const arbitraryPayload = new TextEncoder().encode('not an R&S payload');
    expect(
      detectScopeFile({
        name: 'not-a-scope.Wfm.bin',
        bytes: arbitraryPayload,
        size: arbitraryPayload.length,
        lastModified: null
      })
    ).toBeNull();
    const csv = new TextEncoder().encode('Time,Note\n0,WAVEDESC\n1,ordinary text\n');
    expect(detectScopeFile({ name: 'notes.csv', bytes: csv, size: csv.length, lastModified: null })).toBeNull();
    const blankUnitRow = new TextEncoder().encode('Time,Voltage\n,\n0,1\n');
    expect(
      detectScopeFile({
        name: 'blank-units.csv',
        bytes: blankUnitRow,
        size: blankUnitRow.length,
        lastModified: null
      })
    ).toBeNull();
    const markerCsv = new TextEncoder().encode('Name,Value\n:WFMPRE,:CURVE #14\n');
    expect(
      detectScopeFile({ name: 'markers.csv', bytes: markerCsv, size: markerCsv.length, lastModified: null })
    ).toBeNull();
    const fakeLecroy = new Uint8Array(100);
    fakeLecroy.set(new TextEncoder().encode('WAVEDESC'), 0);
    fakeLecroy.set(new TextEncoder().encode('LECROY_2_3'), 16);
    fakeLecroy[34] = 1;
    expect(
      detectScopeFile({ name: 'fake.trc', bytes: fakeLecroy, size: fakeLecroy.length, lastModified: null })
    ).toBeNull();
    const ds6000 = new Uint8Array(64);
    ds6000.set([0xa5, 0xa5, 0x38, 0]);
    ds6000.set(new TextEncoder().encode('DS6000'), 4);
    expect(
      detectScopeFile({ name: 'ds6000.wfm', bytes: ds6000, size: ds6000.length, lastModified: null })?.supportLevel
    ).toBe('provisional');

    const rs = await source('rohde_schwarz/rs_rtp_two_channel.bin');
    const bom = new Uint8Array(rs.bytes.length + 3);
    bom.set([0xef, 0xbb, 0xbf]);
    bom.set(rs.bytes, 3);
    expect(detectScopeFile({ ...rs, bytes: bom, size: bom.length })?.format).toBe('rohde-schwarz-rtx-bin');
  });

  it.each(truncationFixtures)('rejects truncated %s without a partial waveform', async (relativePath) => {
    const original = await source(relativePath);
    const truncated: ImportSource = {
      ...original,
      bytes: original.bytes.slice(0, Math.max(16, Math.floor(original.bytes.length / 2))),
      size: Math.max(16, Math.floor(original.bytes.length / 2))
    };
    await expect(decodeScopeRequest({ primary: truncated })).rejects.toBeInstanceOf(ScopeImportError);
  });

  it('rejects Keysight declared-size mismatches before decoding samples', async () => {
    const damaged = await source('keysight/keysight_dsox1102g_single_channel.bin');
    const view = new DataView(damaged.bytes.buffer, damaged.bytes.byteOffset, damaged.bytes.byteLength);
    view.setUint32(4, damaged.bytes.length + 4096, true);
    await expect(decodeScopeRequest({ primary: damaged })).rejects.toMatchObject({ code: 'length-mismatch' });
  });

  it('rejects truncated and format-mismatched R&S companions', async () => {
    const primary = await source('rohde_schwarz/rs_rtp_two_channel.bin', 'capture.bin');
    const payload = await source('rohde_schwarz/rs_rtp_two_channel.Wfm.bin', 'capture.Wfm.bin');
    await expect(
      decodeScopeRequest({
        primary,
        companions: [{ ...payload, bytes: payload.bytes.slice(0, -4), size: payload.size - 4 }]
      })
    ).rejects.toMatchObject({ code: 'length-mismatch' });
    new DataView(payload.bytes.buffer, payload.bytes.byteOffset, payload.bytes.byteLength).setUint32(0, 0, true);
    await expect(decodeScopeRequest({ primary, companions: [payload] })).rejects.toMatchObject({
      code: 'length-mismatch'
    });
  });

  it('requires positive implicit sample intervals', async () => {
    const isf = await source('tektronix/representative_pulse.isf');
    const isfText = new TextDecoder('latin1').decode(isf.bytes);
    const increment = /XINCR\s+[^;]+/i.exec(isfText);
    expect(increment).not.toBeNull();
    const replacement = 'XINCR 0'.padEnd(increment![0].length, ' ');
    isf.bytes.set(new TextEncoder().encode(replacement), increment!.index);
    await expect(decodeScopeRequest({ primary: isf })).rejects.toMatchObject({ code: 'invalid-header' });

    const primary = await source('rohde_schwarz/rs_rtp_int8.bin', 'interval.bin');
    const xml = new TextDecoder().decode(primary.bytes);
    const start = /Name="XStart"\s+Value="([^"]+)"/.exec(xml);
    expect(start).not.toBeNull();
    const damagedXml = xml.replace(/(Name="XStop"\s+Value=")[^"]+/, `$1${start![1]}`);
    const damagedBytes = new TextEncoder().encode(damagedXml);
    const payload = await source('rohde_schwarz/rs_rtp_int8.Wfm.bin', 'interval.Wfm.bin');
    await expect(
      decodeScopeRequest({
        primary: { ...primary, bytes: damagedBytes, size: damagedBytes.length },
        companions: [payload]
      })
    ).rejects.toMatchObject({ code: 'invalid-header' });
  });

  it('pairs R&S files case-insensitively and rejects missing or ambiguous companions', async () => {
    const primary = await source('rohde_schwarz/rs_rtp_int8.bin', 'capture.bin');
    const payload = await source('rohde_schwarz/rs_rtp_int8.Wfm.bin', 'capture.WFM.BIN');
    expect(groupScopeSources([payload, primary])).toHaveLength(1);
    expect(() => groupScopeSources([primary])).toThrowError(ScopeImportError);
    expect(() => groupScopeSources([primary, payload, { ...payload, name: 'CAPTURE.wfm.bin' }])).toThrowError(
      ScopeImportError
    );
    expect(() => groupScopeSources([primary, { ...primary, name: 'CAPTURE.BIN' }, payload])).toThrowError(
      ScopeImportError
    );
  });

  it('rejects reserved LeCroy blocks and accepts flat DS1000Z analogue data', async () => {
    const lecroy = await source('teledyne_lecroy/lecroy_waverunner_template_2_3.trc');
    const marker = new TextEncoder().encode('WAVEDESC');
    let descriptor = -1;
    outer: for (let offset = 0; offset <= lecroy.bytes.length - marker.length; offset += 1) {
      for (let index = 0; index < marker.length; index += 1) {
        if (lecroy.bytes[offset + index] !== marker[index]) continue outer;
      }
      descriptor = offset;
      break;
    }
    expect(descriptor).toBeGreaterThanOrEqual(0);
    new DataView(lecroy.bytes.buffer, lecroy.bytes.byteOffset, lecroy.bytes.byteLength).setInt32(
      descriptor + 44,
      2_000_000_000,
      true
    );
    await expect(decodeScopeRequest({ primary: lecroy })).rejects.toMatchObject({ code: 'unsupported-variant' });

    const rigol = await source('rigol/rigol_ds1054z.wfm');
    const view = new DataView(rigol.bytes.buffer, rigol.bytes.byteOffset, rigol.bytes.byteLength);
    const dataStart = view.getUint32(260, true) + view.getUint32(256, true);
    const memoryDepth = view.getUint32(116, true);
    rigol.bytes.fill(128, dataStart, dataStart + memoryDepth);
    const records = await decodeScopeRequest({ primary: rigol });
    expect(records[0].channels[0].values.every(Number.isFinite)).toBe(true);

    const ds2000 = await source('rigol/rigol_ds2072a.wfm');
    const ds2000View = new DataView(ds2000.bytes.buffer, ds2000.bytes.byteOffset, ds2000.bytes.byteLength);
    ds2000.bytes[65] = 0;
    ds2000View.setUint32(252, ds2000View.getUint32(252, true) / 2, true);
    await expect(decodeScopeRequest({ primary: ds2000 })).rejects.toMatchObject({ code: 'length-mismatch' });
  });

  it('returns actionable conversion/detection failures for PSDATA and HDF5', async () => {
    const psdata = new TextEncoder().encode('JWWD synthetic detection header');
    await expect(
      decodeScopeRequest({
        primary: { name: 'capture.psdata', bytes: psdata, size: psdata.length, lastModified: null }
      })
    ).rejects.toMatchObject({ code: 'conversion-required' });
    const hdf5 = Uint8Array.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]);
    await expect(
      decodeScopeRequest({
        primary: { name: 'capture.h5', bytes: hdf5, size: hdf5.length, lastModified: null }
      })
    ).rejects.toMatchObject({ code: 'unsupported-variant' });
  });
});
