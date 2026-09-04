import type { ImportSource } from '../adapters/types';
import { ScopeImportError, type DetectedScopeFile } from './types';

function extension(name: string): string {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index).toLowerCase() : '';
}

function containsAscii(bytes: Uint8Array, needle: string, maximum = bytes.length): boolean {
  return asciiOffset(bytes, needle, maximum) >= 0;
}

function asciiOffset(bytes: Uint8Array, needle: string, maximum = bytes.length): number {
  const encoded = new TextEncoder().encode(needle);
  const limit = Math.min(maximum, bytes.length) - encoded.length;
  outer: for (let offset = 0; offset <= limit; offset += 1) {
    for (let index = 0; index < encoded.length; index += 1) {
      if (bytes[offset + index] !== encoded[index]) continue outer;
    }
    return offset;
  }
  return -1;
}

function looksTextual(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(1024, bytes.length));
  if (sample.length === 0) return false;
  let printable = 0;
  let delimiter = false;
  for (const value of sample) {
    if (value === 9 || value === 10 || value === 13 || (value >= 32 && value <= 126) || value >= 128) {
      printable += 1;
    }
    if (value === 9 || value === 44 || value === 59) delimiter = true;
  }
  return printable / sample.length > 0.95 && delimiter;
}

export function detectScopeFile(source: ImportSource): DetectedScopeFile | null {
  const bytes = source.bytes;
  const ext = extension(source.name);
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x48 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return {
      format: 'picoscope-hdf5',
      supportLevel: 'experimental',
      manufacturer: 'Pico Technology',
      displayName: 'PicoScope HDF5',
      confidence: 1,
      reason: 'HDF5 file signature.'
    };
  }
  if (
    bytes.length >= 10 &&
    ((bytes[0] === 0x0f && bytes[1] === 0x0f) || (bytes[0] === 0xf0 && bytes[1] === 0xf0)) &&
    [':WFM#001', ':WFM#002', ':WFM#003'].some((marker) => containsAscii(bytes.subarray(2, 10), marker))
  ) {
    const version = new TextDecoder('ascii').decode(bytes.subarray(2, 10));
    const verified = bytes[0] === 0x0f && bytes[1] === 0x0f && version === ':WFM#003';
    return {
      format: 'tektronix-wfm',
      supportLevel: verified ? 'verified' : 'provisional',
      manufacturer: 'Tektronix',
      displayName: `Tektronix ${version.slice(1)}`,
      confidence: 1,
      reason: 'Tektronix byte-order marker and WFM version cookie.'
    };
  }
  const textStart = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const probeText = new TextDecoder('latin1')
    .decode(bytes.subarray(textStart, Math.min(bytes.length, textStart + 64 * 1024)))
    .toUpperCase();
  const normalizedProbeText = probeText.replace(/^\s*/, '');
  if (
    ext === '.isf' &&
    (probeText.includes(':WFMP') || probeText.includes(':WFMPRE')) &&
    /:CURV(?:E)?\s+#\d/.test(probeText)
  ) {
    return {
      format: 'tektronix-isf',
      supportLevel: 'layout-tested',
      manufacturer: 'Tektronix',
      displayName: 'Tektronix ISF',
      confidence: 1,
      reason: 'Tektronix waveform preamble and CURVE block.'
    };
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x41 &&
    bytes[1] === 0x47 &&
    ((bytes[2] === 0x30 && (bytes[3] === 0x31 || bytes[3] === 0x33)) || (bytes[2] === 0x31 && bytes[3] === 0x30))
  ) {
    return {
      format: 'keysight-agxx-bin',
      supportLevel: bytes[2] === 0x31 ? 'verified' : 'layout-tested',
      manufacturer: 'Keysight / Agilent',
      displayName: 'Keysight/Agilent AGxx BIN',
      confidence: 1,
      reason: 'AG01, AG03, or AG10 file cookie.'
    };
  }
  if (
    normalizedProbeText.startsWith('<?XML') &&
    normalizedProbeText.includes('<DATABASE') &&
    /SAVEITEMTYPE\s*=\s*["']DATA["']/.test(normalizedProbeText)
  ) {
    return {
      format: 'rohde-schwarz-rtx-bin',
      supportLevel: 'verified',
      manufacturer: 'Rohde & Schwarz',
      displayName: 'R&S RTx waveform pair',
      confidence: 1,
      reason: 'R&S Database/Data XML description.'
    };
  }
  if (source.name.toLowerCase().endsWith('.wfm.bin')) {
    if (bytes.length >= 8) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const formatCode = view.getUint32(0, true);
      const recordLength = view.getUint32(4, true);
      if ([0, 1, 4, 6].includes(formatCode) && recordLength > 0) {
        return {
          format: 'rohde-schwarz-wfm-bin-payload',
          supportLevel: 'verified',
          manufacturer: 'Rohde & Schwarz',
          displayName: 'R&S waveform payload',
          confidence: 0.95,
          reason: 'R&S companion name and plausible payload header.'
        };
      }
    }
  }
  const wavedescOffset = asciiOffset(bytes, 'WAVEDESC', Math.min(bytes.length, 1024 * 1024));
  if (wavedescOffset >= 0 && wavedescOffset <= bytes.length - 40) {
    const template = new TextDecoder('ascii')
      .decode(bytes.subarray(wavedescOffset + 16, wavedescOffset + 32))
      .replace(/\0.*$/s, '')
      .trim();
    const order = bytes[wavedescOffset + 34];
    const littleEndian = order === 1;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const commType = view.getUint16(wavedescOffset + 32, littleEndian);
    const descriptorLength = view.getInt32(wavedescOffset + 36, littleEndian);
    const minimumDescriptor = template === 'LECROY_1_0' ? 320 : template === 'LECROY_2_3' ? 346 : Infinity;
    if (
      Number.isFinite(minimumDescriptor) &&
      (order === 0 || order === 1) &&
      commType === 1 &&
      descriptorLength >= minimumDescriptor &&
      descriptorLength <= bytes.length - wavedescOffset
    ) {
      return {
        format: 'teledyne-lecroy-trc',
        supportLevel: order === 1 ? 'verified' : 'layout-tested',
        manufacturer: 'Teledyne LeCroy',
        displayName: 'LeCroy TRC',
        confidence: 1,
        reason: 'Plausible WAVEDESC template and byte-order header.'
      };
    }
  }
  const magic = bytes.length >= 4 ? Array.from(bytes.subarray(0, 4)) : [];
  const rigolWfm =
    [
      [0xa5, 0xa5, 0xa4, 0x01],
      [0xa1, 0xa5, 0x00, 0x00],
      [0x01, 0xff, 0xff, 0xff],
      [0xa5, 0xa5, 0x38, 0x00],
      [0xa5, 0xa5, 0x00, 0x00]
    ].some((signature) => signature.every((value, index) => magic[index] === value)) ||
    (ext === '.wfm' && magic[0] === 0x02 && magic[1] === 0 && magic[2] === 0 && magic[3] === 0);
  if (rigolWfm) {
    let supportLevel: DetectedScopeFile['supportLevel'] = 'verified';
    if (magic[0] === 0xa5 && magic[1] === 0xa5 && magic[2] === 0x38 && magic[3] === 0) {
      const model = new TextDecoder('ascii')
        .decode(bytes.subarray(4, Math.min(bytes.length, 24)))
        .replace(/\0.*$/s, '');
      if (!/^(?:DS|MSO)[24]/i.test(model)) supportLevel = 'provisional';
    } else if (magic[0] === 0x02 && magic[1] === 0 && magic[2] === 0 && magic[3] === 0) {
      supportLevel = 'provisional';
    }
    return {
      format: 'rigol-wfm',
      supportLevel,
      manufacturer: 'Rigol',
      displayName: 'Rigol WFM',
      confidence: 1,
      reason: 'Fixture-backed Rigol family signature.'
    };
  }
  if (
    magic.length === 4 &&
    ((magic[0] === 0x52 && magic[1] === 0x47 && magic[2] === 0x30 && magic[3] === 0x31) ||
      (magic[0] === 0x52 && magic[1] === 0x47 && magic[2] === 0x30 && magic[3] === 0x33))
  ) {
    const headerSize =
      bytes.length >= 16 ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(12, true) : 0;
    const supportLevel =
      magic[3] === 0x33 && headerSize === 140
        ? 'verified'
        : magic[3] === 0x31 && headerSize === 140
          ? 'verified'
          : 'provisional';
    return {
      format: 'rigol-bin',
      supportLevel,
      manufacturer: 'Rigol',
      displayName: 'Rigol BIN',
      confidence: 1,
      reason: 'RG01 or RG03 binary cookie.'
    };
  }
  if (
    (bytes.length >= 4 && bytes[0] === 0x4a && bytes[1] === 0x57 && bytes[2] === 0x57 && bytes[3] === 0x44) ||
    ext === '.psdata'
  ) {
    return {
      format: 'picoscope-psdata',
      supportLevel: 'conversion-required',
      manufacturer: 'Pico Technology',
      displayName: 'PicoScope PSDATA',
      confidence: 1,
      reason: 'PicoScope PSDATA signature or extension.'
    };
  }
  if (['.csv', '.tsv', '.txt'].includes(ext) && looksTextual(bytes)) {
    const firstLines = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 8192))).split(/\r?\n/);
    const unitCells = firstLines[1]?.split(/[\t,;]/) || [];
    const picoUnits =
      unitCells.length >= 2 &&
      unitCells.every((cell) => /^\s*\(\s*[^)]+\s*\)\s*$/.test(cell)) &&
      /^\s*\(\s*(?:p|n|u|µ|μ|m)?s\s*\)\s*$/i.test(unitCells[0]);
    if (picoUnits) {
      return {
        format: 'picoscope-csv',
        supportLevel: 'layout-tested',
        manufacturer: 'Pico Technology',
        displayName: 'PicoScope two-row CSV',
        confidence: 0.9,
        reason: 'Two-row PicoScope name/unit heading.'
      };
    }
  }
  return null;
}

export function requireDetectedScopeFile(source: ImportSource): DetectedScopeFile {
  const detected = detectScopeFile(source);
  if (!detected) {
    throw new ScopeImportError('unrecognised-format', `Cannot identify oscilloscope format: ${source.name}`, {
      fileNames: [source.name]
    });
  }
  return detected;
}
