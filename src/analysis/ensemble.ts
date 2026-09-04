import { authoritativeAnnotation, type Shot } from '../domain/session';

export interface AlignedShotSeries {
  shotId: string;
  shotName: string;
  relativeTime: number[];
  values: number[];
  metadata: Shot['metadata'];
}

export interface EventAlignedEnsemble {
  relativeTime: number[];
  shots: AlignedShotSeries[];
  mean: number[];
  median: number[];
  trimmedMean: number[];
  warnings: string[];
}

function interpolate(time: Float64Array, values: Float64Array, target: number): number {
  if (target < time[0] || target > time[time.length - 1]) return Number.NaN;
  let low = 0;
  let high = time.length - 1;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (time[middle] <= target) low = middle;
    else high = middle;
  }
  const interval = time[high] - time[low];
  if (!(interval > 0)) return Number.NaN;
  const fraction = (target - time[low]) / interval;
  return values[low] + (values[high] - values[low]) * fraction;
}

function aggregate(rows: number[][], mode: 'mean' | 'median' | 'trimmed', trimFraction = 0.1): number[] {
  const length = rows[0]?.length || 0;
  return Array.from({ length }, (_, index) => {
    const values = rows
      .map((row) => row[index])
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    if (values.length === 0) return Number.NaN;
    if (mode === 'median') {
      const middle = Math.floor(values.length / 2);
      return values.length % 2 === 0 ? (values[middle - 1] + values[middle]) / 2 : values[middle];
    }
    const trim = mode === 'trimmed' ? Math.floor(values.length * trimFraction) : 0;
    const retained = values.slice(trim, values.length - trim || undefined);
    return retained.reduce((sum, value) => sum + value, 0) / retained.length;
  });
}

export function eventAlignShots(
  shots: Shot[],
  channelName: string,
  markerName: string,
  options: { beforeSeconds: number; afterSeconds: number; sampleCount?: number; trimFraction?: number }
): EventAlignedEnsemble {
  const warnings: string[] = [];
  const sampleCount = Math.max(2, Math.floor(options.sampleCount || 1000));
  const span = options.beforeSeconds + options.afterSeconds;
  const relativeTime = Array.from(
    { length: sampleCount },
    (_, index) => -options.beforeSeconds + (index * span) / (sampleCount - 1)
  );
  const aligned: AlignedShotSeries[] = [];

  for (const shot of shots) {
    const marker = authoritativeAnnotation(shot.annotations, markerName);
    const channel = shot.channels.find((candidate) => candidate.name === channelName);
    if (!marker || !channel) {
      warnings.push(`${shot.name}: missing accepted "${markerName}" marker or "${channelName}" channel.`);
      continue;
    }
    const values = relativeTime.map((relative) =>
      interpolate(channel.time, channel.values, marker.startTime + relative - channel.timingOffsetSeconds)
    );
    aligned.push({
      shotId: shot.id,
      shotName: shot.name,
      relativeTime,
      values,
      metadata: shot.metadata
    });
  }

  const rows = aligned.map((shot) => shot.values);
  return {
    relativeTime,
    shots: aligned,
    mean: rows.length ? aggregate(rows, 'mean') : [],
    median: rows.length ? aggregate(rows, 'median') : [],
    trimmedMean: rows.length ? aggregate(rows, 'trimmed', options.trimFraction ?? 0.1) : [],
    warnings
  };
}
