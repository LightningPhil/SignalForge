import { requireDetectedScopeFile } from './detect';
import { ScopeImportError, throwIfCancelled, type ImportedWaveformRecord, type ScopeImportRequest } from './types';

export async function decodeScopeRequest(request: ScopeImportRequest): Promise<ImportedWaveformRecord[]> {
  throwIfCancelled(request.signal);
  const detected = requireDetectedScopeFile(request.primary);
  request.onProgress?.(0, `Detected ${detected.displayName}`);
  switch (detected.format) {
    case 'tektronix-wfm': {
      const { decodeTekWfm } = await import('./adapters/tekWfm');
      return decodeTekWfm(request);
    }
    case 'tektronix-isf': {
      const { decodeTekIsf } = await import('./adapters/tekIsf');
      return decodeTekIsf(request);
    }
    case 'keysight-agxx-bin': {
      const { decodeKeysightAgxx } = await import('./adapters/keysightAgxx');
      return decodeKeysightAgxx(request);
    }
    case 'rohde-schwarz-rtx-bin': {
      const { decodeRohdeSchwarzRtx } = await import('./adapters/rohdeSchwarzRtx');
      return decodeRohdeSchwarzRtx(request);
    }
    case 'teledyne-lecroy-trc': {
      const { decodeLecroyTrc } = await import('./adapters/lecroyTrc');
      return decodeLecroyTrc(request);
    }
    case 'rigol-wfm':
    case 'rigol-bin': {
      const { decodeRigol } = await import('./adapters/rigol');
      return await decodeRigol(request, detected.format);
    }
    case 'picoscope-csv': {
      const { decodePicoCsv } = await import('./adapters/picoCsv');
      return decodePicoCsv(request);
    }
    case 'picoscope-psdata':
      throw new ScopeImportError(
        'conversion-required',
        'PicoScope PSDATA is proprietary and cannot be decoded safely. Export CSV/HDF5 in PicoScope or use PicoScope BatchConvert.',
        { format: detected.format, fileNames: [request.primary.name] }
      );
    case 'picoscope-hdf5':
      throw new ScopeImportError(
        'unsupported-variant',
        'PicoScope HDF5 is detected but remains experimental pending a real PicoScope 7 fixture and a bounded browser HDF5 decoder. Export CSV for verified import.',
        { format: detected.format, fileNames: [request.primary.name] }
      );
    case 'rohde-schwarz-wfm-bin-payload':
      throw new ScopeImportError(
        'missing-companion',
        `${request.primary.name} is an R&S sample payload. Select its sibling description .bin file too.`,
        { format: detected.format, fileNames: [request.primary.name] }
      );
  }
}
