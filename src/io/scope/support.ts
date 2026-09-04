import type { ScopeSupportLevel } from './types';

export interface ScopeSupportEntry {
  manufacturer: string;
  format: string;
  extensions: string[];
  supportLevel: ScopeSupportLevel;
  variants: string;
  limitations: string;
}

export const ScopeSupportMatrix: readonly ScopeSupportEntry[] = [
  {
    manufacturer: 'Tektronix',
    format: 'WFM#003',
    extensions: ['.wfm'],
    supportLevel: 'verified',
    variants: 'Little-endian ordinary analogue; single frame and FastFrame',
    limitations: 'WFM#001/#002, big-endian and non-analogue classes are rejected.'
  },
  {
    manufacturer: 'Tektronix',
    format: 'ISF',
    extensions: ['.isf'],
    supportLevel: 'layout-tested',
    variants: 'Binary waveform block with explicit preamble',
    limitations: 'Instrument-family preamble variants require additional captures.'
  },
  {
    manufacturer: 'Keysight / Agilent',
    format: 'AGxx BIN',
    extensions: ['.bin'],
    supportLevel: 'verified',
    variants: 'AG10 ordinary analogue; AG01/AG03 layout-tested',
    limitations: 'Segmented, peak-detect, logic and digital records are rejected.'
  },
  {
    manufacturer: 'Rohde & Schwarz',
    format: 'RTx paired waveform',
    extensions: ['.bin', '.Wfm.bin'],
    supportLevel: 'verified',
    variants: 'Float32, int8 and explicit-time XYDOUBLEFLOAT; int16 layout-tested',
    limitations: 'Select both files. History, multi-acquisition and non-analogue records are rejected.'
  },
  {
    manufacturer: 'Teledyne LeCroy',
    format: 'TRC',
    extensions: ['.trc', '.000'],
    supportLevel: 'verified',
    variants: 'LECROY_1_0/2_3 little-endian int16; big-endian layout-tested',
    limitations: 'Sequences, RIS, sparse and secondary arrays are rejected.'
  },
  {
    manufacturer: 'Rigol',
    format: 'WFM',
    extensions: ['.wfm'],
    supportLevel: 'verified',
    variants: 'DS1000B/C/D-E/Z, DS2000, DS4000 and DHO800',
    limitations: 'DS6000 remains provisional; format is dispatched by content/model.'
  },
  {
    manufacturer: 'Rigol',
    format: 'BIN',
    extensions: ['.bin'],
    supportLevel: 'verified',
    variants: 'MSO5000 and DHO800',
    limitations: 'MSO7000/8000 and logic records remain provisional/unsupported.'
  },
  {
    manufacturer: 'PicoScope',
    format: 'Two-row CSV',
    extensions: ['.csv', '.tsv', '.txt'],
    supportLevel: 'layout-tested',
    variants: 'Analogue channels with a second-row unit declaration',
    limitations: 'Locale, digital, maths and spectrum variants need more fixtures.'
  },
  {
    manufacturer: 'PicoScope',
    format: 'PSDATA',
    extensions: ['.psdata'],
    supportLevel: 'conversion-required',
    variants: 'Signature detection and conversion guidance',
    limitations: 'Proprietary; export CSV using PicoScope or BatchConvert.'
  },
  {
    manufacturer: 'PicoScope',
    format: 'HDF5',
    extensions: ['.h5', '.hdf5'],
    supportLevel: 'experimental',
    variants: 'Content detection only',
    limitations: 'No bounded browser decoder or representative real PicoScope 7 fixture yet.'
  },
  {
    manufacturer: 'Siglent',
    format: 'Native BIN',
    extensions: ['.bin'],
    supportLevel: 'provisional',
    variants: 'No fixture-backed variant',
    limitations: 'Parser references alone are not sufficient to enable import.'
  }
] as const;
