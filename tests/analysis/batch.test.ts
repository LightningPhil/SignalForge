import { describe, expect, it } from 'vitest';
import { BatchAnalyzer } from '../../src/analysis/batch';
import { createAnnotation, createSession, createShot, type SessionChannel } from '../../src/domain/session';

function channel(id: string, name: string, values: number[]): SessionChannel {
  return {
    id,
    name,
    unit: name === 'Voltage' ? 'V' : 'A',
    timeUnit: 's',
    time: new Float64Array([0, 1, 2]),
    values: new Float64Array(values),
    quality: new Uint16Array(3),
    calibration: { scale: 1, offset: 0 },
    timingOffsetSeconds: 0
  };
}

describe('batch analysis', () => {
  it('isolates per-shot failures and reports progress', async () => {
    const session = createSession('Batch');
    const valid = createShot('Valid', 1);
    valid.channels.push(channel('v', 'Voltage', [2, 2, 2]), channel('i', 'Current', [1, 1, 1]));
    valid.annotations.push(createAnnotation('start', 0), createAnnotation('end', 2));
    session.shots.push(valid, createShot('Missing current', 2));
    const progress: string[] = [];

    const result = await new BatchAnalyzer().run(
      session,
      {
        id: 'pulse',
        voltageChannel: 'Voltage',
        currentChannel: 'Current',
        startMarker: 'start',
        endMarker: 'end',
        applicationVersion: 'test'
      },
      { onProgress: (update) => progress.push(update.status) }
    );

    expect(result.results.get(valid.id)?.values.energy).toBe(4);
    expect(result.failures.size).toBe(1);
    expect(progress).toEqual(['complete', 'failed']);
  });

  it('yields to cancellation between shots', async () => {
    const session = createSession('Cancelable batch');
    for (let index = 0; index < 3; index += 1) {
      const shot = createShot(`Shot ${index}`, index);
      shot.channels.push(channel(`v-${index}`, 'Voltage', [2, 2, 2]));
      shot.channels.push(channel(`i-${index}`, 'Current', [1, 1, 1]));
      session.shots.push(shot);
    }
    const controller = new AbortController();
    const run = new BatchAnalyzer().run(
      session,
      {
        id: 'pulse',
        voltageChannel: 'Voltage',
        currentChannel: 'Current',
        applicationVersion: 'test'
      },
      {
        signal: controller.signal,
        onProgress: () => controller.abort()
      }
    );

    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('uses the full voltage region when the current channel has a lower sample rate', async () => {
    const session = createSession('Mixed rates');
    const shot = createShot('Shot', 1);
    const voltageTime = Float64Array.from({ length: 2000 }, (_, index) => index / 1000);
    const currentTime = Float64Array.from({ length: 1000 }, (_, index) => index / 500);
    shot.channels.push({
      id: 'voltage',
      name: 'Voltage',
      unit: 'V',
      timeUnit: 's',
      time: voltageTime,
      values: new Float64Array(voltageTime.length).fill(1),
      quality: new Uint16Array(voltageTime.length),
      calibration: { scale: 1, offset: 0 },
      timingOffsetSeconds: 0
    });
    shot.channels.push({
      id: 'current',
      name: 'Current',
      unit: 'A',
      timeUnit: 's',
      time: currentTime,
      values: new Float64Array(currentTime.length).fill(1),
      quality: new Uint16Array(currentTime.length),
      calibration: { scale: 1, offset: 0 },
      timingOffsetSeconds: 0
    });
    session.shots.push(shot);

    const result = await new BatchAnalyzer().run(session, {
      id: 'mixed',
      voltageChannel: 'Voltage',
      currentChannel: 'Current',
      applicationVersion: 'test'
    });

    expect(result.results.get(shot.id)?.values.energy).toBeCloseTo(1.999, 3);
  });

  it('maps authoritative markers through the voltage channel timing offset', async () => {
    const session = createSession('Offset markers');
    const shot = createShot('Shot', 1);
    const voltage = channel('voltage', 'Voltage', [1, 1, 1]);
    const current = channel('current', 'Current', [1, 1, 1]);
    voltage.timingOffsetSeconds = 10;
    current.timingOffsetSeconds = 10;
    shot.channels.push(voltage, current);
    shot.annotations.push(createAnnotation('start', 11), createAnnotation('end', 12));
    session.shots.push(shot);

    const result = await new BatchAnalyzer().run(session, {
      id: 'offset',
      voltageChannel: 'Voltage',
      currentChannel: 'Current',
      startMarker: 'start',
      endMarker: 'end',
      applicationVersion: 'test'
    });

    expect(result.results.get(shot.id)?.values.energy).toBeCloseTo(1, 12);
  });
});
