import type { FilterExecutionContext } from '../processing/filter';
import { SessionWorkspace } from '../session/workspace';
import { State } from '../state';

function medianInterval(time: ArrayLike<number> | undefined): number {
  if (!time || time.length < 2) return 0;
  const deltas: number[] = [];
  for (let index = 1; index < time.length; index += 1) {
    const delta = Number(time[index]) - Number(time[index - 1]);
    if (Number.isFinite(delta) && delta > 0) deltas.push(delta);
  }
  deltas.sort((left, right) => left - right);
  return deltas.length ? deltas[Math.floor(deltas.length / 2)] : 0;
}

function referencedColumns(columnId: string): string[] {
  return [
    ...new Set(
      State.getPipelineForColumn(columnId)
        .filter((step) => step.enabled !== false && step.type === 'referenceSubtract' && step.referenceColumnId)
        .map((step) => step.referenceColumnId as string)
    )
  ];
}

export function buildFilterExecutionContext(columnId: string, targetTime?: ArrayLike<number>): FilterExecutionContext {
  const shot = SessionWorkspace.getActiveShot();
  const shotChannel = shot?.channels.find((channel) => channel.name === columnId);
  const interval = medianInterval(targetTime);
  const targetOffset = shotChannel?.timingOffsetSeconds || (State.getTraceConfig(columnId).xOffset || 0) * interval;
  const references = Object.fromEntries(
    referencedColumns(columnId).flatMap((candidate) => {
      const channel = shot?.channels.find((entry) => entry.name === candidate);
      const values = channel?.values || State.data.columns[candidate];
      if (!values) return [];
      return [
        [
          candidate,
          {
            values,
            time: channel?.time || targetTime,
            timingOffsetSeconds:
              channel?.timingOffsetSeconds || (State.getTraceConfig(candidate).xOffset || 0) * interval,
            quality: channel?.quality || State.data.quality[candidate]
          }
        ]
      ];
    })
  );
  return {
    annotations: shot?.annotations,
    selection: State.getAnalysisSelection(),
    timingOffsetSeconds: targetOffset,
    references
  };
}

export function filterExecutionContextKey(columnId: string): string {
  const shot = SessionWorkspace.getActiveShot();
  const shotChannel = shot?.channels.find((channel) => channel.name === columnId);
  const pipeline = State.getPipelineForColumn(columnId);
  const usesSelection = pipeline.some(
    (step) =>
      step.enabled !== false &&
      ['baselineSubtract', 'timeGate', 'artifactBlank'].includes(step.type) &&
      step.regionMode === 'selection'
  );
  const referenceColumns = referencedColumns(columnId);
  return JSON.stringify({
    shotId: shot?.id || null,
    annotations:
      shot?.annotations.map((annotation) => [
        annotation.id,
        annotation.name,
        annotation.kind,
        annotation.startTime,
        annotation.endTime ?? null,
        annotation.source,
        annotation.suggestionState ?? null
      ]) || [],
    selection: usesSelection ? State.getAnalysisSelection() : null,
    timingOffset: shotChannel?.timingOffsetSeconds ?? State.getTraceConfig(columnId).xOffset ?? 0,
    referenceColumns: referenceColumns.map((candidate) => {
      const channel = shot?.channels.find((entry) => entry.name === candidate);
      return [candidate, channel?.timingOffsetSeconds || State.getTraceConfig(candidate).xOffset || 0];
    })
  });
}

export function cloneFilterExecutionContextForWorker(context: FilterExecutionContext): FilterExecutionContext {
  return {
    ...context,
    annotations: context.annotations ? structuredClone(context.annotations) : undefined,
    selection: context.selection ? { ...context.selection } : context.selection,
    references: context.references
      ? Object.fromEntries(
          Object.entries(context.references).map(([columnId, reference]) => [
            columnId,
            {
              values: Float64Array.from(reference.values),
              time: reference.time ? Float64Array.from(reference.time) : undefined,
              quality: reference.quality ? Uint16Array.from(reference.quality) : undefined,
              timingOffsetSeconds: reference.timingOffsetSeconds
            }
          ])
        )
      : undefined
  };
}
