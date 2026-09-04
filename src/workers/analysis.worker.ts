import Papa from 'papaparse';
import { CrossChannel } from '../analysis/crossChannel';
import { TimeFrequency } from '../analysis/timeFrequency';
import { calculatePulsePower } from '../analysis/pulsePower';
import { FFT } from '../processing/fft';
import { Filter } from '../processing/filter';
import { FIR_UNIFORM_TOLERANCE } from '../processing/fir';
import { analyzeTimebase } from '../processing/sampling';
import type { WorkerResponse, WorkerTask, WorkerTaskResult } from './protocol';

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerTask>) => void) | null;
  postMessage(message: WorkerResponse): void;
}

const workerScope = self as unknown as WorkerScope;

function progress(id: string, value: number, stage: string): void {
  workerScope.postMessage({ id, type: 'progress', progress: value, stage });
}

function execute(task: WorkerTask): WorkerTaskResult {
  progress(task.id, 0.05, 'Preparing');
  if (task.kind === 'spectrum') {
    progress(task.id, 0.25, 'Computing spectrum');
    return FFT.computeSpectrum(task.signal, task.time, task.options);
  }
  if (task.kind === 'spectrogram') {
    progress(task.id, 0.2, 'Computing time-frequency frames');
    return TimeFrequency.computeSpectrogram(task.signal, task.time, task.options);
  }
  if (task.kind === 'transfer') {
    progress(task.id, 0.2, 'Computing Welch averages');
    return CrossChannel.computeTransferFunction(
      Array.from(task.input),
      Array.from(task.output),
      Array.from(task.time),
      task.options
    );
  }
  if (task.kind === 'filter') {
    progress(task.id, 0.2, 'Applying processing recipe');
    const result = Filter.applyPipelineWithReport(task.signal, task.time, task.pipeline, task.quality);
    const timebase = analyzeTimebase(task.time, FIR_UNIFORM_TOLERANCE);
    return {
      ...result,
      firDesigns:
        timebase.valid && timebase.uniform ? Filter.serializeFirDesigns(task.pipeline, timebase.sampleRate) : []
    };
  }
  if (task.kind === 'pulse-power') {
    progress(task.id, 0.2, 'Calculating pulse power');
    return calculatePulsePower(task.input);
  }

  progress(task.id, 0.2, 'Parsing delimited text');
  const result = Papa.parse<Record<string, string | number | boolean | null>>(task.text, {
    delimiter: task.delimiter,
    dynamicTyping: true,
    header: true,
    skipEmptyLines: true
  });
  return {
    data: result.data,
    fields: result.meta.fields || [],
    errors: result.errors.map((error) => error.message)
  };
}

workerScope.onmessage = (event) => {
  const task = event.data;
  try {
    const result = execute(task);
    progress(task.id, 1, 'Complete');
    workerScope.postMessage({ id: task.id, type: 'result', result });
  } catch (error) {
    workerScope.postMessage({
      id: task.id,
      type: 'error',
      error: error instanceof Error ? error.message : String(error)
    });
  }
};
