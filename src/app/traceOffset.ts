import { State } from '../state';

export function applyTraceSampleOffset(traceId: string, sampleOffset = 0): number | null {
  if (!traceId || !Number.isFinite(sampleOffset)) return null;
  const current = State.getTraceConfig(traceId).xOffset || 0;
  const next = current + sampleOffset;
  State.updateTraceConfig(traceId, { xOffset: next });
  return next;
}
