import { CheckedReader } from '../../limits';
import { type ImportedWaveformRecord, type ScopeImportRequest } from '../../types';
import { decodeDhoBin, decodeMso5000Bin } from './bin';
import { checkpoint, cleanAscii, importFailure } from './common';
import { decodeDhoWfm } from './dhoWfm';
import { decodeDs1000B, decodeDs1000C, decodeDs1000E } from './ds1000';
import { decodeDs1000Z } from './ds1000z';
import { decodeDs2000, decodeDs4000 } from './modernWfm';

function hasMagic(reader: CheckedReader, expected: readonly number[]): boolean {
  if (reader.bytes.byteLength < expected.length) return false;
  return expected.every((value, index) => reader.bytes[index] === value);
}

function isPaddedDs1000C(reader: CheckedReader): boolean {
  reader.requireRange(0, 74, 'Rigol DS1000C/D/E dispatch header');
  const points = reader.u32(28, true, 'Rigol DS1000C/D/E dispatch point count');
  const firstEnabled = reader.u8(49, 'Rigol DS1000C/D/E CH1 dispatch flag');
  const secondEnabled = reader.u8(73, 'Rigol DS1000C/D/E CH2 dispatch flag');
  if (points === 0 || (firstEnabled !== 0 && firstEnabled !== 1) || (secondEnabled !== 0 && secondEnabled !== 1)) {
    return false;
  }
  const channelCount = firstEnabled + secondEnabled;
  if (channelCount === 0) return false;
  const expectedLength = reader.checkedSum(
    [272, reader.checkedProduct(channelCount, points, 'Rigol padded DS1000C dispatch payload')],
    'Rigol padded DS1000C dispatch extent'
  );
  return expectedLength === reader.bytes.byteLength;
}

function decodeWfm(
  request: ScopeImportRequest,
  reader: CheckedReader
): Promise<ImportedWaveformRecord[]> | ImportedWaveformRecord[] {
  if (hasMagic(reader, [0xa5, 0xa5, 0xa4, 0x01])) {
    return decodeDs1000B(request, reader);
  }
  if (hasMagic(reader, [0xa1, 0xa5, 0x00, 0x00])) {
    return decodeDs1000C(request, reader);
  }
  if (hasMagic(reader, [0xa5, 0xa5, 0x00, 0x00])) {
    return isPaddedDs1000C(reader) ? decodeDs1000C(request, reader) : decodeDs1000E(request, reader);
  }
  if (hasMagic(reader, [0x01, 0xff, 0xff, 0xff])) {
    return decodeDs1000Z(request, reader);
  }
  if (hasMagic(reader, [0x02, 0x00, 0x00, 0x00])) {
    return decodeDhoWfm(request, reader);
  }
  if (hasMagic(reader, [0xa5, 0xa5, 0x38, 0x00])) {
    reader.requireRange(4, 20, 'Rigol DS2000/4000/6000 model');
    const model = cleanAscii(reader.ascii(4, 20, 'Rigol WFM model'));
    if (/^(?:DS|MSO)4/i.test(model)) return decodeDs4000(request, reader);
    if (/^(?:DS|MSO)6/i.test(model)) {
      importFailure(
        'unsupported-variant',
        'Rigol DS6000 WFM is provisional and is not supported.',
        'rigol-wfm',
        request
      );
    }
    if (/^(?:DS|MSO)2/i.test(model)) return decodeDs2000(request, reader);
    importFailure(
      'unsupported-variant',
      `Rigol WFM model "${model || 'unknown'}" is not a fixture-backed family.`,
      'rigol-wfm',
      request
    );
  }
  importFailure(
    'invalid-header',
    'The source does not contain a supported Rigol WFM family signature.',
    'rigol-wfm',
    request
  );
}

function decodeBin(request: ScopeImportRequest, reader: CheckedReader): ImportedWaveformRecord[] {
  if (hasMagic(reader, [0x52, 0x47, 0x30, 0x31])) {
    return decodeMso5000Bin(request, reader);
  }
  if (hasMagic(reader, [0x52, 0x47, 0x30, 0x33])) {
    return decodeDhoBin(request, reader);
  }
  importFailure(
    'invalid-header',
    'The source does not contain a supported Rigol RG01 or RG03 BIN signature.',
    'rigol-bin',
    request
  );
}

export function decodeRigol(
  request: ScopeImportRequest,
  format: 'rigol-wfm' | 'rigol-bin'
): Promise<ImportedWaveformRecord[]> | ImportedWaveformRecord[] {
  const reader = new CheckedReader(request.primary.bytes, format);
  checkpoint(request, 0, 'Detecting Rigol waveform family');
  if (!Number.isSafeInteger(request.primary.size) || request.primary.size !== request.primary.bytes.byteLength) {
    importFailure(
      'length-mismatch',
      `Source size ${request.primary.size} does not match the ${request.primary.bytes.byteLength} supplied bytes.`,
      format,
      request
    );
  }
  return format === 'rigol-wfm' ? decodeWfm(request, reader) : decodeBin(request, reader);
}
