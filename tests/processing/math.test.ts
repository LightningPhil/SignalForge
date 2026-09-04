import { beforeEach, describe, expect, it } from 'vitest';
import { QualityFlag } from '../../src/data/quality';
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

  it('keeps diff aligned to the timebase with a NaN leading sample', () => {
    expect(MathEngine.customFunctions.diff([5, 8, 14])).toEqual([Number.NaN, 3, 6]);
  });

  it('evaluates bare * / ^ between waveforms sample-by-sample instead of as matrix algebra', () => {
    const time = [0, 0.5, 1.5];
    const power: MathDefinition = {
      name: 'Power',
      expression: 'V * I',
      variables: [
        { columnId: 'Voltage', symbol: 'V' },
        { columnId: 'Current', symbol: 'I' }
      ]
    };
    expect(MathEngine.validateDefinition(power, time).ok).toBe(true);
    expect(MathEngine.calculateVirtualColumn(power, time).values).toEqual([2, 8, 32]);

    const ratio: MathDefinition = { ...power, name: 'Ratio', expression: 'V / I' };
    expect(MathEngine.calculateVirtualColumn(ratio, time).values).toEqual([2, 2, 2]);

    const squared: MathDefinition = { ...power, name: 'Squared', expression: 'V ^ 2 / 2' };
    expect(MathEngine.calculateVirtualColumn(squared, time).values).toEqual([2, 8, 32]);

    // Scalars keep ordinary arithmetic.
    const scaled: MathDefinition = { ...power, name: 'Scaled', expression: '(V * 3) / 2 + 2 ^ 2' };
    expect(MathEngine.calculateVirtualColumn(scaled, time).values).toEqual([7, 10, 16]);
  });

  it('keeps mean() as the scalar reducer so V - mean(V) removes the DC offset', () => {
    const time = [0, 0.5, 1.5];
    const definition: MathDefinition = {
      name: 'AC',
      expression: 'V - mean(V)',
      variables: [{ columnId: 'Voltage', symbol: 'V' }]
    };
    expect(MathEngine.validateDefinition(definition, time).ok).toBe(true);
    expect(MathEngine.calculateVirtualColumn(definition, time).values).toEqual([2 - 14 / 3, 4 - 14 / 3, 8 - 14 / 3]);

    const ensemble: MathDefinition = {
      name: 'Mean trace',
      expression: 'meanTraces(V, I)',
      variables: [
        { columnId: 'Voltage', symbol: 'V' },
        { columnId: 'Current', symbol: 'I' }
      ]
    };
    expect(MathEngine.calculateVirtualColumn(ensemble, time).values).toEqual([1.5, 3, 6]);
  });

  it('maps scalar functions such as sqrt/abs/exp over waveforms', () => {
    const time = [0, 0.5, 1.5];
    const definition: MathDefinition = {
      name: 'Root',
      expression: 'sqrt(V * V) + abs(-I)',
      variables: [
        { columnId: 'Voltage', symbol: 'V' },
        { columnId: 'Current', symbol: 'I' }
      ]
    };
    expect(MathEngine.calculateVirtualColumn(definition, time).values).toEqual([3, 6, 12]);
  });

  it('rejects symbols that shadow built-in helpers or the time axis', () => {
    const definition: MathDefinition = {
      name: 'Shadow',
      expression: 't * 2',
      variables: [{ columnId: 'Voltage', symbol: 't' }]
    };
    const validation = MathEngine.validateDefinition(definition, [0, 0.5, 1.5]);
    expect(validation.ok).toBe(false);
    expect(validation.errors.join(' ')).toContain('reserved');
  });

  it('never lets guardedDivide produce Infinity and keeps NaN runs local for integrate', () => {
    const scope = MathEngine.buildScope([0, 1, 2, 3, 4]);
    const divide = scope.guardedDivide as WaveformFunction;
    const integrate = scope.integrate as WaveformFunction;

    expect(divide([1, 2], [0, 0], 0)).toEqual([Number.NaN, Number.NaN]);
    expect(divide([1, 2], [Number.NaN, 4], 1e-12)).toEqual([Number.NaN, 0.5]);

    const integral = integrate([1, 1, Number.NaN, 1, 1]);
    expect(integral[0]).toBe(0);
    expect(integral[1]).toBe(1);
    expect(integral[2]).toBeNaN();
    // The invalid interval contributes nothing; the running sum resumes afterwards.
    expect(integral[3]).toBe(1);
    expect(integral[4]).toBe(2);
  });

  it('propagates input quality flags into the math result and marks non-finite outputs Invalid', () => {
    const time = [0, 0.5, 1.5];
    State.data.quality.Current = Uint16Array.from([0, QualityFlag.Clipped, 0]);
    const definition: MathDefinition = {
      name: 'Guarded',
      expression: 'guardedDivide(V, I - 4, 1e-9)',
      variables: [
        { columnId: 'Voltage', symbol: 'V' },
        { columnId: 'Current', symbol: 'I' }
      ]
    };
    const validation = MathEngine.validateDefinition(definition, time);
    expect(validation.ok).toBe(true);
    expect(validation.warnings?.join(' ')).toContain('1 sample(s) are NaN');

    const result = MathEngine.calculateVirtualColumn(definition, time);
    expect(result.values.map((value) => Number.isNaN(value))).toEqual([false, false, true]);
    expect(result.quality).toBeDefined();
    expect(result.quality![1] & QualityFlag.Clipped).toBeTruthy();
    expect(result.quality![2] & QualityFlag.Invalid).toBeTruthy();
    expect(result.quality![0] & QualityFlag.Processed).toBeTruthy();
    expect(result.quality![0] & (QualityFlag.Clipped | QualityFlag.Invalid)).toBe(0);
  });

  it('reports an error instead of silently returning an empty trace when evaluation fails', () => {
    const definition: MathDefinition = {
      name: 'Broken',
      expression: 'nosuchfn(V)',
      variables: [{ columnId: 'Voltage', symbol: 'V' }]
    };
    const result = MathEngine.calculateVirtualColumn(definition, [0, 0.5, 1.5]);
    expect(result.values).toEqual([]);
    expect(result.error).toMatch(/Evaluation error/);
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
