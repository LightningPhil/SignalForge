import { DelimitedTextAdapter } from './delimitedTextAdapter';
import type { AdapterIdentification, ImportSource, WaveformImportAdapter } from './types';
import { UnsupportedVariantError } from './types';

function extension(name: string): string {
  return name.slice(name.lastIndexOf('.')).toLowerCase();
}

function fixtureRequiredAdapter(
  id: string,
  name: string,
  extensions: string[],
  manufacturer: string
): WaveformImportAdapter {
  return {
    id,
    name,
    status: 'fixture-required',
    identify(source: ImportSource): AdapterIdentification {
      const matches = extensions.includes(extension(source.name));
      return {
        confidence: matches ? 0.4 : 0,
        manufacturer,
        format: extension(source.name),
        reason: matches
          ? `Extension is associated with ${manufacturer}, but exact model and firmware fixtures are required.`
          : 'Extension does not match.'
      };
    },
    async import() {
      throw new UnsupportedVariantError(
        id,
        `${name} is fixture-gated. Supply representative files and a trusted vendor export before enabling this adapter.`
      );
    }
  };
}

const adapters: WaveformImportAdapter[] = [
  DelimitedTextAdapter,
  fixtureRequiredAdapter('tektronix-native', 'Tektronix WFM/ISF', ['.wfm', '.isf'], 'Tektronix'),
  fixtureRequiredAdapter('lecroy-trc', 'Teledyne LeCroy TRC', ['.trc'], 'Teledyne LeCroy'),
  fixtureRequiredAdapter('keysight-native', 'Keysight/Agilent BIN/H5', ['.bin', '.h5', '.hdf5'], 'Keysight'),
  fixtureRequiredAdapter('rohde-schwarz-native', 'Rohde & Schwarz waveform', ['.bin', '.wfm'], 'Rohde & Schwarz'),
  fixtureRequiredAdapter('siglent-native', 'Siglent waveform', ['.bin'], 'Siglent'),
  fixtureRequiredAdapter('rigol-native', 'Rigol waveform', ['.wfm'], 'Rigol'),
  fixtureRequiredAdapter('picoscope-native', 'PicoScope waveform', ['.psdata'], 'Pico Technology')
];

export const ImportAdapterRegistry = {
  all(): readonly WaveformImportAdapter[] {
    return adapters;
  },

  register(adapter: WaveformImportAdapter): void {
    if (adapters.some((existing) => existing.id === adapter.id)) {
      throw new Error(`Import adapter "${adapter.id}" is already registered.`);
    }
    adapters.push(adapter);
  },

  identify(source: ImportSource): Array<{ adapter: WaveformImportAdapter; identification: AdapterIdentification }> {
    return adapters
      .map((adapter) => ({ adapter, identification: adapter.identify(source) }))
      .filter(({ identification }) => identification.confidence > 0)
      .sort((left, right) => right.identification.confidence - left.identification.confidence);
  },

  supportedFor(source: ImportSource): WaveformImportAdapter | null {
    return this.identify(source).find(({ adapter }) => adapter.status === 'supported')?.adapter || null;
  }
};
