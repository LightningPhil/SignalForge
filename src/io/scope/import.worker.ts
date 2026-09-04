import { decodeScopeRequest } from './decode';
import { ScopeImportError } from './types';
import type { ScopeWorkerRequest, ScopeWorkerResponse } from './workerProtocol';

interface WorkerScope {
  onmessage: ((event: MessageEvent<ScopeWorkerRequest>) => void) | null;
  postMessage(message: ScopeWorkerResponse, transfer?: Transferable[]): void;
}

const workerScope = self as unknown as WorkerScope;

function resultTransfers(records: Awaited<ReturnType<typeof decodeScopeRequest>>): Transferable[] {
  const transfers: Transferable[] = [];
  for (const record of records) {
    if (record.timeSeconds.buffer instanceof ArrayBuffer) transfers.push(record.timeSeconds.buffer);
    for (const channel of record.channels) {
      if (channel.values.buffer instanceof ArrayBuffer) transfers.push(channel.values.buffer);
      if (channel.invalidMask?.buffer instanceof ArrayBuffer) transfers.push(channel.invalidMask.buffer);
    }
  }
  return transfers;
}

workerScope.onmessage = (event) => {
  const request = event.data;
  void decodeScopeRequest({
    primary: request.primary,
    companions: request.companions,
    onProgress: (progress, stage) => workerScope.postMessage({ id: request.id, type: 'progress', progress, stage })
  })
    .then((records) => {
      workerScope.postMessage({ id: request.id, type: 'result', records }, resultTransfers(records));
    })
    .catch((error: unknown) => {
      const failure =
        error instanceof ScopeImportError
          ? error
          : new ScopeImportError('invalid-header', error instanceof Error ? error.message : String(error));
      workerScope.postMessage({
        id: request.id,
        type: 'error',
        error: {
          code: failure.code,
          message: failure.message,
          format: failure.format,
          fileNames: failure.fileNames
        }
      });
    });
};
