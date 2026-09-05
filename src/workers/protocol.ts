import type { TransferFunctionOptions, TransferFunctionResult } from '../analysis/crossChannel';
import type { SpectrogramOptions, SpectrogramResult } from '../analysis/timeFrequency';
import type { PulsePowerInput, PulsePowerResult } from '../analysis/pulsePower';
import type { SpectrumOptions } from '../processing/fft';
import type { FilterExecutionContext } from '../processing/filter';
import type { FilterStep, PipelineStepReport, SerializedFirDesign, SpectrumResult } from '../types';

export interface FilterWorkerResult {
  values: number[];
  quality: Uint16Array;
  steps: PipelineStepReport[];
  firDesigns: SerializedFirDesign[];
}

export type WorkerTask =
  | {
      id: string;
      kind: 'spectrum';
      signal: Float64Array;
      time: Float64Array;
      options: SpectrumOptions;
    }
  | {
      id: string;
      kind: 'spectrogram';
      signal: Float64Array;
      time: Float64Array;
      options: SpectrogramOptions;
    }
  | {
      id: string;
      kind: 'transfer';
      input: Float64Array;
      output: Float64Array;
      time: Float64Array;
      options: TransferFunctionOptions;
    }
  | {
      id: string;
      kind: 'filter';
      signal: Float64Array;
      time: Float64Array;
      quality: Uint16Array;
      pipeline: FilterStep[];
      context?: FilterExecutionContext;
    }
  | {
      id: string;
      kind: 'pulse-power';
      input: PulsePowerInput;
    }
  | {
      id: string;
      kind: 'parse-delimited';
      text: string;
      delimiter?: string;
    };

export type WorkerTaskResult =
  | SpectrumResult
  | SpectrogramResult
  | TransferFunctionResult
  | PulsePowerResult
  | FilterWorkerResult
  | {
      data: Array<Record<string, string | number | boolean | null>>;
      fields: string[];
      errors: string[];
    };

export type WorkerResponse =
  | { id: string; type: 'progress'; progress: number; stage: string }
  | { id: string; type: 'result'; result: WorkerTaskResult }
  | { id: string; type: 'error'; error: string };
