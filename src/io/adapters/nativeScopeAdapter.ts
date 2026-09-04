import { bridgeScopeRecords } from '../scope/bridge';
import { scopeImportClient } from '../scope/client';
import { decodeScopeRequest } from '../scope/decode';
import { detectScopeFile } from '../scope/detect';
import type {
  AdapterIdentification,
  AdapterImportResult,
  ImportAdapterOptions,
  ImportSource,
  WaveformImportAdapter
} from './types';

export const NativeScopeAdapter: WaveformImportAdapter = {
  id: 'native-oscilloscope',
  name: 'Native oscilloscope waveform',
  status: 'supported',

  identify(source: ImportSource): AdapterIdentification {
    const detected = detectScopeFile(source);
    return detected
      ? {
          confidence: detected.confidence,
          manufacturer: detected.manufacturer,
          format: detected.displayName,
          reason: `${detected.reason} Evidence: ${detected.supportLevel}.`
        }
      : { confidence: 0, reason: 'No supported native oscilloscope signature.' };
  },

  async import(source: ImportSource, options: ImportAdapterOptions = {}): Promise<AdapterImportResult> {
    const detected = detectScopeFile(source);
    if (!detected) throw new Error(`Cannot identify native oscilloscope format: ${source.name}`);
    const companions = options.companions || [];
    const records =
      typeof Worker !== 'undefined'
        ? await scopeImportClient.decode(source, {
            companions,
            signal: options.signal,
            onProgress: options.onProgress
          })
        : await decodeScopeRequest({
            primary: source,
            companions,
            signal: options.signal,
            onProgress: options.onProgress
          });
    return bridgeScopeRecords(this.id, detected, source, companions, records);
  }
};
