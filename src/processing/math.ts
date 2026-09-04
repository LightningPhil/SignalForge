import { evaluate, isMatrix, parse } from 'mathjs';
import { toNumber } from '../app/utils';
import { State } from '../state';
import type { MathDefinition, MathResult, MathValidation, ResolveMode } from '../types';
import { applyXOffset, Filter } from './filter';

type NumericLike = number | number[];
type Scope = Record<string, unknown>;

function asNumbers(arr: unknown): number[] {
  if (Array.isArray(arr)) return arr.map((value) => Number(value));
  if (isMatrix(arr)) return (arr.toArray() as unknown[]).flat(Infinity).map((value) => Number(value));
  if (ArrayBuffer.isView(arr)) {
    return Array.from(arr as unknown as ArrayLike<number>, (value) => Number(value));
  }
  return [Number(arr)];
}

function pointwise(
  left: unknown,
  right: unknown,
  operation: (leftValue: number, rightValue: number, index: number) => number
): number[] {
  const leftValues = asNumbers(left);
  const rightValues = asNumbers(right);
  const length = Math.max(leftValues.length, rightValues.length);
  if (leftValues.length !== 1 && rightValues.length !== 1 && leftValues.length !== rightValues.length) {
    throw new Error(`Pointwise operands have different lengths (${leftValues.length} and ${rightValues.length}).`);
  }
  return Array.from({ length }, (_, index) =>
    operation(leftValues[leftValues.length === 1 ? 0 : index], rightValues[rightValues.length === 1 ? 0 : index], index)
  );
}

function derivativeActual(values: unknown, time: unknown): number[] {
  const y = asNumbers(values);
  const t = asNumbers(time);
  const length = Math.min(y.length, t.length);
  if (length === 0) return [];
  if (length === 1) return [Number.NaN];
  const output = new Array<number>(length);
  const firstDt = t[1] - t[0];
  output[0] = firstDt > 0 ? (y[1] - y[0]) / firstDt : Number.NaN;
  for (let index = 1; index < length - 1; index += 1) {
    const dt = t[index + 1] - t[index - 1];
    output[index] = dt > 0 ? (y[index + 1] - y[index - 1]) / dt : Number.NaN;
  }
  const lastDt = t[length - 1] - t[length - 2];
  output[length - 1] = lastDt > 0 ? (y[length - 1] - y[length - 2]) / lastDt : Number.NaN;
  return output;
}

function integrateActual(values: unknown, time: unknown): number[] {
  const y = asNumbers(values);
  const t = asNumbers(time);
  const length = Math.min(y.length, t.length);
  if (length === 0) return [];
  const output = new Array<number>(length).fill(0);
  for (let index = 1; index < length; index += 1) {
    const dt = t[index] - t[index - 1];
    output[index] =
      dt > 0 && Number.isFinite(y[index - 1]) && Number.isFinite(y[index])
        ? output[index - 1] + ((y[index - 1] + y[index]) * dt) / 2
        : Number.NaN;
  }
  return output;
}

function aggregateTraces(traces: unknown[], mode: 'mean' | 'median' | 'trimmed', trimFraction = 0.1): number[] {
  const arrays = traces.map(asNumbers);
  if (arrays.length === 0) return [];
  let length = Infinity;
  for (const values of arrays) length = Math.min(length, values.length);
  return Array.from({ length }, (_, index) => {
    const values = arrays
      .map((array) => array[index])
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    if (values.length === 0) return Number.NaN;
    if (mode === 'median') {
      const middle = Math.floor(values.length / 2);
      return values.length % 2 === 0 ? (values[middle - 1] + values[middle]) / 2 : values[middle];
    }
    const trim =
      mode === 'trimmed' ? Math.min(Math.floor(values.length / 2), Math.floor(values.length * trimFraction)) : 0;
    const retained = values.slice(trim, values.length - trim);
    return retained.reduce((sum, value) => sum + value, 0) / retained.length;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const MathEngine = {
  customFunctions: {
    diff: (arr: unknown): number[] => {
      const values = asNumbers(arr);
      return values.slice(1).map((value, index) => value - values[index]);
    },
    cumsum: (arr: unknown): number[] => {
      let sum = 0;
      return asNumbers(arr).map((v) => {
        sum += v;
        return sum;
      });
    },
    shift: (arr: unknown, samples = 0): number[] => applyXOffset(asNumbers(arr), samples),
    clip: (arr: unknown, min = -Infinity, max = Infinity): number[] =>
      asNumbers(arr).map((v) => Math.min(max, Math.max(min, v))),
    pointwiseAdd: (left: unknown, right: unknown): number[] =>
      pointwise(left, right, (leftValue, rightValue) => leftValue + rightValue),
    pointwiseSubtract: (left: unknown, right: unknown): number[] =>
      pointwise(left, right, (leftValue, rightValue) => leftValue - rightValue),
    pointwiseMultiply: (left: unknown, right: unknown): number[] =>
      pointwise(left, right, (leftValue, rightValue) => leftValue * rightValue),
    pointwiseDivide: (left: unknown, right: unknown): number[] =>
      pointwise(left, right, (leftValue, rightValue) => leftValue / rightValue),
    guardedDivide: (left: unknown, right: unknown, minimumDenominator = 1e-12): number[] =>
      pointwise(left, right, (leftValue, rightValue) =>
        Math.abs(rightValue) >= Math.abs(minimumDenominator) ? leftValue / rightValue : Number.NaN
      ),
    meanTraces: (...traces: unknown[]): number[] => aggregateTraces(traces, 'mean'),
    medianTraces: (...traces: unknown[]): number[] => aggregateTraces(traces, 'median'),
    trimmedMeanTraces: (trimFraction: number, ...traces: unknown[]): number[] =>
      aggregateTraces(traces, 'trimmed', Math.max(0, Math.min(0.49, trimFraction)))
  },

  buildScope(timeArray: number[] = []): Scope {
    const dt = this.getDt(timeArray);
    const length = timeArray.length;
    return {
      ...this.customFunctions,
      derivative: (arr: unknown, time: unknown = timeArray) => derivativeActual(arr, time),
      integrate: (arr: unknown, time: unknown = timeArray) => integrateActual(arr, time),
      power: (voltage: unknown, current: unknown) =>
        pointwise(voltage, current, (voltageValue, currentValue) => voltageValue * currentValue),
      energy: (voltage: unknown, current: unknown, time: unknown = timeArray) =>
        integrateActual(
          pointwise(voltage, current, (voltageValue, currentValue) => voltageValue * currentValue),
          time
        ),
      charge: (current: unknown, time: unknown = timeArray) => integrateActual(current, time),
      actionIntegral: (current: unknown, time: unknown = timeArray) =>
        integrateActual(
          pointwise(current, current, (left, right) => left * right),
          time
        ),
      mean: (...traces: unknown[]) => aggregateTraces(traces, 'mean'),
      constantTrace: (value: number) => new Array<number>(length).fill(Number(value)),
      delay: (arr: unknown, seconds = 0) => {
        const step = dt || 1;
        return applyXOffset(asNumbers(arr), (seconds || 0) / step);
      }
    };
  },

  getDt(timeArray: number[]): number {
    if (!Array.isArray(timeArray) || timeArray.length < 2) return 1;
    const deltas: number[] = [];
    for (let index = 0; index < timeArray.length - 1; index += 1) {
      const delta = timeArray[index + 1] - timeArray[index];
      if (Number.isFinite(delta) && delta > 0) deltas.push(delta);
    }
    if (deltas.length === 0) return 1;
    deltas.sort((a, b) => a - b);
    const middle = Math.floor(deltas.length / 2);
    return deltas.length % 2 === 0 ? (deltas[middle - 1] + deltas[middle]) / 2 : deltas[middle];
  },

  getAvailableMathColumns(): string[] {
    return (State.config.mathDefinitions || []).map((d) => d.name);
  },

  validateDefinition(
    def: MathDefinition | null | undefined,
    rawTime: number[] = [],
    visited = new Set<string>()
  ): MathValidation {
    const errors: string[] = [];
    if (!def) return { ok: false, errors: ['Missing math definition.'] };

    const expression = (def.expression || '').trim();
    if (!expression) errors.push('Enter an expression to compute.');
    if (!Array.isArray(def.variables) || def.variables.length === 0) {
      errors.push('Assign at least one variable.');
    }

    const variableData: Record<string, number[]> = {};
    let minLen = rawTime.length > 0 ? rawTime.length : Infinity;
    const visitedWithCurrent = new Set(visited);
    if (def.name) visitedWithCurrent.add(def.name);

    (def.variables || []).forEach(({ columnId, symbol, sourceMode, applyXOffset: applyShift }) => {
      const sym = (symbol || '').trim();
      if (!sym) {
        errors.push('Each mapped column needs a symbol (e.g., V or I).');
        return;
      }
      if (!columnId) {
        errors.push(`Select a column for symbol ${sym}.`);
        return;
      }
      const data = this.resolveSeries(
        columnId,
        rawTime,
        {
          sourceMode: sourceMode ?? 'raw',
          applyXOffset: applyShift ?? true
        },
        visitedWithCurrent
      );
      if (!data.length) {
        errors.push(`No numeric samples found for column "${columnId}" mapped to ${sym}.`);
        return;
      }
      variableData[sym] = data;
      minLen = Math.min(minLen, data.length);
    });

    const waveformSymbols = Object.keys(variableData);
    for (const left of waveformSymbols) {
      for (const right of waveformSymbols) {
        const unsafe = new RegExp(`\\b${escapeRegExp(left)}\\s*([*/])\\s*${escapeRegExp(right)}\\b`);
        const match = expression.match(unsafe);
        if (match?.[1] === '*') {
          errors.push(`Use pointwiseMultiply(${left}, ${right}) or ${left} .* ${right}; "*" is matrix multiplication.`);
        } else if (match?.[1] === '/') {
          errors.push(`Use guardedDivide(${left}, ${right}, minimum) or ${left} ./ ${right}; "/" is matrix division.`);
        }
      }
    }

    if (errors.length > 0) return { ok: false, errors };
    if (!Number.isFinite(minLen) || minLen === Infinity || minLen <= 0) {
      return { ok: false, errors: ['No aligned samples available to evaluate the expression.'] };
    }

    const timeSlice = rawTime.length > 0 ? rawTime.slice(0, minLen) : [];
    const scope = this.buildScope(timeSlice);
    Object.entries(variableData).forEach(([symbol, data]) => {
      scope[symbol] = data.slice(0, minLen);
    });
    if (timeSlice.length > 0) {
      scope.t = timeSlice;
      scope.dt = this.getDt(timeSlice);
    }

    try {
      parse(expression);
    } catch (err) {
      return { ok: false, errors: [`Syntax error: ${err instanceof Error ? err.message : String(err)}`] };
    }

    let evaluated: unknown;
    try {
      evaluated = evaluate(expression, scope);
    } catch (err) {
      return { ok: false, errors: [`Evaluation error: ${err instanceof Error ? err.message : String(err)}`] };
    }

    const normalized = this.normalizeResult(evaluated, minLen);
    if (!normalized.length) {
      return {
        ok: false,
        errors: [
          'The expression returned a scalar or no values. Use constantTrace(value) to create an explicit constant waveform.'
        ]
      };
    }
    if (normalized.some((v) => !Number.isFinite(v))) {
      return {
        ok: false,
        errors: [
          'Expression produced non-finite values (NaN/Infinity). Check the inputs or guard against division by zero.'
        ]
      };
    }

    return { ok: true, errors: [] };
  },

  resolveSeries(
    columnId: string,
    rawTime: number[] = [],
    mode: ResolveMode = {},
    visited = new Set<string>()
  ): number[] {
    if (!columnId) return [];
    const { sourceMode = 'raw', applyXOffset: applyShift = true } = mode;
    if (visited.has(columnId)) {
      console.warn(`Circular math reference detected for ${columnId}.`);
      return [];
    }

    const visitedWithCurrent = new Set(visited);
    visitedWithCurrent.add(columnId);

    const mathDef = State.getMathDefinition(columnId);
    let series: number[] = [];
    if (mathDef) {
      series = this.calculateVirtualColumn(mathDef, rawTime, visitedWithCurrent).values;
    } else if (State.data.headers.includes(columnId)) {
      series = State.data.columns[columnId]
        ? Array.from(State.data.columns[columnId])
        : State.data.raw.map((row) => toNumber(row[columnId]));
    }

    if (sourceMode === 'filtered') {
      series = Filter.applyPipeline(series, rawTime, State.getPipelineForColumn(columnId));
    }
    if (applyShift) {
      series = applyXOffset(series, State.getTraceConfig(columnId).xOffset || 0);
    }
    return series;
  },

  normalizeResult(result: unknown, targetLength: number): number[] {
    const toPlain = (val: unknown): unknown => {
      if (Array.isArray(val)) return [...val];
      if (isMatrix(val)) return val.toArray();
      if (ArrayBuffer.isView(val)) return Array.from(val as unknown as ArrayLike<number>);
      return val;
    };

    const plain = toPlain(result);
    if (typeof plain === 'number') return [];
    if (!Array.isArray(plain) || plain.length === 0) return [];
    return (plain as NumericLike[]).slice(0, Math.min(targetLength, plain.length)).map((v) => Number(v));
  },

  calculateVirtualColumn(def: MathDefinition, rawTime: number[] = [], visited = new Set<string>()): MathResult {
    if (!def || !Array.isArray(def.variables) || !def.expression) {
      return { values: [], time: [] };
    }

    const variableData: Record<string, number[]> = {};
    let minLen = rawTime.length > 0 ? rawTime.length : Infinity;
    const visitedWithCurrent = new Set(visited);
    if (def.name) visitedWithCurrent.add(def.name);

    def.variables.forEach(({ columnId, symbol, sourceMode, applyXOffset: applyShift }) => {
      const sym = (symbol || '').trim();
      if (!sym || !columnId) return;
      const data = this.resolveSeries(
        columnId,
        rawTime,
        {
          sourceMode: sourceMode ?? 'raw',
          applyXOffset: applyShift ?? true
        },
        visitedWithCurrent
      );
      if (!data.length) return;
      variableData[sym] = data;
      minLen = Math.min(minLen, data.length);
    });

    if (!Number.isFinite(minLen) || minLen === Infinity || minLen <= 0) {
      return { values: [], time: [] };
    }

    const timeSlice = rawTime.length > 0 ? rawTime.slice(0, minLen) : [];
    const scope = this.buildScope(timeSlice);
    Object.entries(variableData).forEach(([symbol, data]) => {
      scope[symbol] = data.slice(0, minLen);
    });
    if (timeSlice.length > 0) {
      scope.t = timeSlice;
      scope.dt = this.getDt(timeSlice);
    }

    try {
      const values = this.normalizeResult(evaluate(def.expression, scope), minLen);
      return {
        values,
        time: rawTime.length > 0 ? rawTime.slice(0, values.length) : []
      };
    } catch (err) {
      console.error('Math evaluation failed', err);
      return { values: [], time: rawTime.slice(0, minLen) };
    }
  }
};
