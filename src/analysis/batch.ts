import { authoritativeAnnotation, type Session, type SessionAnalysisResult, type Shot } from '../domain/session';
import { hashCanonicalJson } from '../domain/provenance';
import { analyzeTimebase } from '../processing/sampling';
import { analysisWorkerClient } from '../workers/client';
import { calculatePulsePower, type PulsePowerInput, type PulsePowerResult } from './pulsePower';

export interface BatchPulseRecipe {
  id: string;
  voltageChannel: string;
  currentChannel: string;
  startMarker?: string;
  endMarker?: string;
  currentDelaySamples?: number;
  minimumCurrent?: number;
  voltagePolarity?: 1 | -1;
  currentPolarity?: 1 | -1;
  applicationVersion: string;
}

export interface BatchProgress {
  completed: number;
  total: number;
  shotId: string;
  status: 'complete' | 'failed' | 'cached';
  error?: string;
}

export interface BatchResult {
  recipeHash: string;
  results: Map<string, SessionAnalysisResult>;
  failures: Map<string, string>;
}

async function hashRecipe(recipe: BatchPulseRecipe): Promise<string> {
  return hashCanonicalJson(recipe);
}

function markerIndex(
  shot: Shot,
  channelTime: Float64Array,
  timeOffsetSeconds: number,
  name: string | undefined,
  fallback: number
): number {
  if (!name) return fallback;
  const marker = authoritativeAnnotation(shot.annotations, name);
  if (!marker) throw new Error(`Accepted marker "${name}" is missing.`);
  let selected = fallback;
  let distance = Infinity;
  for (let index = 0; index < channelTime.length; index += 1) {
    const candidate = Math.abs(channelTime[index] + timeOffsetSeconds - marker.startTime);
    if (candidate < distance) {
      distance = candidate;
      selected = index;
    }
  }
  return selected;
}

export class BatchAnalyzer {
  private cache = new Map<string, SessionAnalysisResult>();

  async run(
    session: Session,
    recipe: BatchPulseRecipe,
    options: { signal?: AbortSignal; onProgress?: (progress: BatchProgress) => void } = {}
  ): Promise<BatchResult> {
    const recipeHash = await hashRecipe(recipe);
    const results = new Map<string, SessionAnalysisResult>();
    const failures = new Map<string, string>();
    let completed = 0;

    for (const shot of session.shots) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (options.signal?.aborted) throw new DOMException('Batch analysis was cancelled.', 'AbortError');
      const cacheKey = `${shot.id}:${shot.updatedAt}:${recipeHash}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        results.set(shot.id, cached);
        completed += 1;
        options.onProgress?.({ completed, total: session.shots.length, shotId: shot.id, status: 'cached' });
        continue;
      }
      try {
        const voltage = shot.channels.find((channel) => channel.name === recipe.voltageChannel);
        const current = shot.channels.find((channel) => channel.name === recipe.currentChannel);
        if (!voltage || !current) throw new Error('Required voltage/current channel is missing.');
        const length = Math.min(voltage.values.length, voltage.time.length);
        const i0 = markerIndex(shot, voltage.time, voltage.timingOffsetSeconds, recipe.startMarker, 0);
        const i1 = markerIndex(shot, voltage.time, voltage.timingOffsetSeconds, recipe.endMarker, length - 1);
        const pulseInput: PulsePowerInput = {
          time: voltage.time,
          voltage: voltage.values,
          current: current.values,
          currentTime: current.time,
          voltageTimingOffsetSeconds: voltage.timingOffsetSeconds,
          currentTimingOffsetSeconds: current.timingOffsetSeconds,
          voltageQuality: voltage.quality,
          currentQuality: current.quality,
          voltageUnit: voltage.unit,
          currentUnit: current.unit,
          currentDelaySamples: recipe.currentDelaySamples,
          minimumCurrent: recipe.minimumCurrent,
          voltagePolarity: recipe.voltagePolarity,
          currentPolarity: recipe.currentPolarity,
          region: { i0: Math.min(i0, i1), i1: Math.max(i0, i1), markerName: recipe.endMarker }
        };
        const calculation =
          length >= 100_000 && typeof Worker !== 'undefined'
            ? await analysisWorkerClient.run<PulsePowerResult>(
                { kind: 'pulse-power', input: pulseInput },
                { signal: options.signal }
              )
            : calculatePulsePower(pulseInput);
        if (options.signal?.aborted) throw new DOMException('Batch analysis was cancelled.', 'AbortError');
        const result: SessionAnalysisResult = {
          id: `analysis-${crypto.randomUUID()}`,
          type: 'pulse-power',
          values: Object.fromEntries(
            Object.entries(calculation.metrics).map(([name, measurement]) => [name, measurement.value])
          ),
          units: Object.fromEntries(
            Object.entries(calculation.metrics).map(([name, measurement]) => [name, measurement.unit])
          ),
          provenance: {
            sourceChannelIds: [voltage.id, current.id],
            processingRecipeHash: recipeHash,
            annotationIds: shot.annotations
              .filter((annotation) => annotation.name === recipe.startMarker || annotation.name === recipe.endMarker)
              .map((annotation) => annotation.id),
            warnings: calculation.warnings,
            applicationVersion: recipe.applicationVersion,
            appliedDelaySeconds:
              current.timingOffsetSeconds -
              voltage.timingOffsetSeconds +
              (recipe.currentDelaySamples || 0) * analyzeTimebase(voltage.time).medianDt,
            createdAt: new Date().toISOString()
          }
        };
        this.cache.set(cacheKey, result);
        results.set(shot.id, result);
        options.onProgress?.({
          completed: completed + 1,
          total: session.shots.length,
          shotId: shot.id,
          status: 'complete'
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        const message = error instanceof Error ? error.message : String(error);
        failures.set(shot.id, message);
        options.onProgress?.({
          completed: completed + 1,
          total: session.shots.length,
          shotId: shot.id,
          status: 'failed',
          error: message
        });
      }
      completed += 1;
    }
    return { recipeHash, results, failures };
  }

  clearCache(): void {
    this.cache.clear();
  }
}
