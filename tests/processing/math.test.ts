import { beforeEach, describe, expect, it } from 'vitest';
import { MathEngine } from '../../src/processing/math';
import { State } from '../../src/state';
import type { MathDefinition } from '../../src/types';

type WaveformFunction = (...args: unknown[]) => number[];

describe('safe waveform mathematics', () => {
  beforeEach(() => {
    State.setData(
      [
        { Time: 0, Voltage: 2, Current: 1 },
        { Time: 0.5, Voltage: 4, Current: 2 },
        { Time: 1.5, Voltage: 8, Current: 4 }
      ],
      ['Time', 'Voltage', 'Current']
    );
  });

  it('performs named pointwise and ensemble operations', () => {
    const scope = MathEngine.buildScope([0, 0.5, 1.5]);
    const multiply = scope.pointwiseMultiply as WaveformFunction;
    const divide = scope.guardedDivide as WaveformFunction;
    const mean = scope.meanTraces as WaveformFunction;

    expect(multiply([2, 4, 8], [1, 2, 4])).toEqual([2, 8, 32]);
    expect(divide([2, 4, 8], [1, 2, 4], 0.1)).toEqual([2, 2, 2]);
    expect(mean([0, 2, 4], [2, 4, 6])).toEqual([1, 3, 5]);
  });

  it('uses the actual timebase for derivatives and trapezoidal integration', () => {
    const time = [0, 0.5, 1.5, 3];
    const scope = MathEngine.buildScope(time);
    const derivative = scope.derivative as WaveformFunction;
    const integrate = scope.integrate as WaveformFunction;
    const linear = time.map((value) => 3 * value + 2);

    derivative(linear).forEach((value) => expect(value).toBeCloseTo(3, 12));
    expect(integrate(linear)).toEqual([0, 1.375, 6.375, 19.5]);
  });

  it('returns N-1 interval differences rather than copying the first sample', () => {
    expect(MathEngine.customFunctions.diff([5, 8, 14])).toEqual([3, 6]);
  });

  it('blocks ambiguous matrix operators between waveform variables', () => {
    const definition: MathDefinition = {
      name: 'Power',
      expression: 'V * I',
      variables: [
        { columnId: 'Voltage', symbol: 'V' },
        { columnId: 'Current', symbol: 'I' }
      ]
    };

    const validation = MathEngine.validateDefinition(definition, [0, 0.5, 1.5]);

    expect(validation.ok).toBe(false);
    expect(validation.errors.join(' ')).toContain('matrix multiplication');
  });

  it('supports pointwise mean across waveform variables', () => {
    const definition: MathDefinition = {
      name: 'Mean trace',
      expression: 'mean(V, I)',
      variables: [
        { columnId: 'Voltage', symbol: 'V' },
        { columnId: 'Current', symbol: 'I' }
      ]
    };

    expect(MathEngine.validateDefinition(definition, [0, 0.5, 1.5])).toEqual({ ok: true, errors: [] });
    expect(MathEngine.calculateVirtualColumn(definition, [0, 0.5, 1.5]).values).toEqual([1.5, 3, 6]);
  });

  it('requires explicit constantTrace for scalar waveforms', () => {
    const definition: MathDefinition = {
      name: 'Constant',
      expression: '2',
      variables: [{ columnId: 'Voltage', symbol: 'V' }]
    };

    expect(MathEngine.validateDefinition(definition, [0, 0.5, 1.5]).errors.join(' ')).toContain('constantTrace');
  });
});
