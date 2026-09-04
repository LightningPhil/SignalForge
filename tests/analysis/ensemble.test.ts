import { describe, expect, it } from 'vitest';
import { eventAlignShots } from '../../src/analysis/ensemble';
import { createAnnotation, createShot, type SessionChannel } from '../../src/domain/session';

function channel(offset: number): SessionChannel {
  const time = Float64Array.from({ length: 101 }, (_, index) => index / 100);
  return {
    id: `channel-${offset}`,
    name: 'Voltage',
    unit: 'V',
    timeUnit: 's',
    time,
    values: Float64Array.from(time, (value) => value - offset),
    quality: new Uint16Array(time.length),
    calibration: { scale: 1, offset: 0 },
    timingOffsetSeconds: 0
  };
}

describe('event-aligned shot ensembles', () => {
  it('aligns shots to accepted markers and calculates aggregate waveforms', () => {
    const first = createShot('First', 1);
    first.channels.push(channel(0.4));
    first.annotations.push(createAnnotation('flashover', 0.4));
    const second = createShot('Second', 2);
    second.channels.push(channel(0.6));
    second.annotations.push(createAnnotation('flashover', 0.6));

    const ensemble = eventAlignShots([first, second], 'Voltage', 'flashover', {
      beforeSeconds: 0.1,
      afterSeconds: 0.1,
      sampleCount: 3
    });

    expect(ensemble.shots).toHaveLength(2);
    expect(ensemble.relativeTime).toEqual([-0.1, 0, 0.1]);
    ensemble.mean.forEach((value, index) => expect(value).toBeCloseTo(ensemble.relativeTime[index], 12));
    expect(ensemble.median).toEqual(ensemble.mean);
  });
});
