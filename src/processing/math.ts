import { isMatrix, isOperatorNode, OperatorNode, parse, type MathNode } from 'mathjs';
import { toNumber } from '../app/utils';
import { QualityFlag, combineQualityMasks } from '../data/quality';
import { State } from '../state';
import type { MathDefinition, MathResult, MathValidation, ResolveMode } from '../types';
import { applyXOffset, Filter, shiftQualityMask } from './filter';

type NumericLike = number | number[];
type Scope = Record<string, unknown>;

interface ResolvedSeries {
  values: number[];
  quality: Uint16Array;
}

function asNumbers(arr: unknown): number[] {
  if (Array.isArray(arr)) return arr.map((value) => Number(value));
  if (isMatrix(arr)) return (arr.toArray() as unknown[]).flat(Infinity).map((value) => Number(value));
  if (ArrayBuffer.isView(arr)) {
    return Array.from(arr as unknown as ArrayLike<number>, (value) => Number(value));
  }
  return [Number(arr)];
}

function isWaveform(value: unknown): boolean {
  return Array.isArray(value) || isMatrix(value) || ArrayBuffer.isView(value);
}

/**
 * Rewrites the bare `*`, `/` and `^` operators to their element-wise forms (`.*`, `./`, `.^`).
 * Waveforms are 1-D arrays, for which mathjs' default `multiply` is the dot product and `divide`
 * attempts a matrix inverse — both silently produce a plausible scalar (broadcast into a constant
 * trace by later arithmetic) instead of the intended sample-by-sample result. Scalars are unaffected.
 */
function toPointwiseTree(node: MathNode): MathNode {
  const mapped = node.map(toPointwiseTree);
  if (isOperatorNode(mapped) && mapped.args.length === 2) {
    if (mapped.op === '*' && mapped.fn === 'multiply') return new OperatorNode('.*', 'dotMultiply', mapped.args);
    if (mapped.op === '/' && mapped.fn === 'divide') return new OperatorNode('./', 'dotDivide', mapped.args);
    if (mapped.op === '^' && mapped.fn === 'pow') return new OperatorNode('.^', 'dotPow', mapped.args);
  }
  return mapped;
}

export function compileWaveformExpression(expression: string): { evaluate(scope: Scope): unknown } {
  return toPointwiseTree(parse(expression)).compile();
}

/** Wraps a scalar function so it maps over waveforms (mathjs ≥ 12 no longer does this implicitly). */
function elementwise(fn: (value: number, ...rest: number[]) => number) {
  return (value: unknown, ...rest: unknown[]): number | number[] => {
    const extra = rest.map((entry) => Number(entry));
    if (isWaveform(value)) return asNumbers(value).map((sample) => fn(sample, ...extra));
    return fn(Number(value), ...extra);
  };
}

const elementwiseFunctions: Record<string, (value: unknown, ...rest: unknown[]) => number | number[]> = {
  sqrt: elementwise(Math.sqrt),
  cbrt: elementwise(Math.cbrt),
  exp: elementwise(Math.exp),
  log: elementwise((value, base) =>
    base === undefined || Number.isNaN(base) ? Math.log(value) : Math.log(value) / Math.log(base)
  ),
  log10: elementwise(Math.log10),
  log2: elementwise(Math.log2),
  sin: elementwise(Math.sin),
  cos: elementwise(Math.cos),
  tan: elementwise(Math.tan),
  asin: elementwise(Math.asin),
  acos: elementwise(Math.acos),
  atan: elementwise(Math.atan),
  sinh: elementwise(Math.sinh),
  cosh: elementwise(Math.cosh),
  tanh: elementwise(Math.tanh),
  abs: elementwise(Math.abs),
  sign: elementwise(Math.sign),
  floor: elementwise(Math.floor),
  ceil: elementwise(Math.ceil),
  round: elementwise((value, digits) => {
    const scale = 10 ** (Number.isFinite(digits) ? Math.trunc(digits) : 0);
    return Math.round(value * scale) / scale;
  }),
  square: elementwise((value) => value * value),
  cube: elementwise((value) => value * value * value)
};

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
  // Invalid intervals (non-finite sample or non-increasing timestamp) contribute nothing and the
  // running sum carries across them; only the offending sample itself is NaN. A single masked
  // sample therefore does not poison the remainder of the cumulative result.
  const output = new Array<number>(length);
  let running = 0;
  output[0] = Number.isFinite(y[0]) && Number.isFinite(t[0]) ? 0 : Number.NaN;
  for (let index = 1; index < length; index += 1) {
    const dt = t[index] - t[index - 1];
    if (!Number.isFinite(y[index]) || !(dt > 0)) {
      output[index] = Number.NaN;
      continue;
    }
    if (Number.isFinite(y[index - 1])) running += ((y[index - 1] + y[index]) * dt) / 2;
    output[index] = running;
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

export const MathEngine = {
  customFunctions: {
    /**
     * Backward index difference aligned to the input: diff[0] is NaN and diff[i] = x[i] - x[i-1], so
     * the result keeps one sample per timestamp. Prefer derivative(x) for physical slopes.
     */
    diff: (arr: unknown): number[] => {
      const values = asNumbers(arr);
      return values.map((value, index) => (index === 0 ? Number.NaN : value - values[index - 1]));
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
    guardedDivide: (left: unknown, right: unknown, minimumDenominator = 1e-12): number[] => {
      // A zero threshold would let 0 through (0 >= 0) and produce Infinity; the guard is always positive.
      const threshold = Math.max(Number.MIN_VALUE, Math.abs(Number(minimumDenominator)) || Number.MIN_VALUE);
      return pointwise(left, right, (leftValue, rightValue) =>
        Number.isFinite(rightValue) && Math.abs(rightValue) >= threshold ? leftValue / rightValue : Number.NaN
      );
    },
    meanTraces: (...traces: unknown[]): number[] => aggregateTraces(traces, 'mean'),
    medianTraces: (...traces: unknown[]): number[] => aggregateTraces(traces, 'median'),
    trimmedMeanTraces: (trimFraction: number, ...traces: unknown[]): number[] =>
      aggregateTraces(traces, 'trimmed', Math.max(0, Math.min(0.49, trimFraction)))
  },

  buildScope(timeArray: number[] = [], sampleCount = timeArray.length): Scope {
    const dt = this.getDt(timeArray);
    const length = Math.max(0, Math.floor(sampleCount));
    return {
      ...elementwiseFunctions,
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
      // `mean`, `median`, `std`, `min`, `max`, `sum` deliberately stay the mathjs scalar reducers, so
      // `V - mean(V)` removes the DC offset. Sample-wise ensemble averages use meanTraces(...).
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

    const reserved = this.reservedSymbols();
    const prepared = this.prepareEvaluation(def, rawTime, visited, (message) => errors.push(message));
    for (const { symbol } of def.variables || []) {
      const sym = (symbol || '').trim();
      if (sym && reserved.has(sym)) {
        errors.push(`Symbol "${sym}" is reserved for a built-in helper or the time axis; choose another name.`);
      }
    }
    if (errors.length > 0) return { ok: false, errors };
    if (!prepared) return { ok: false, errors: ['No aligned samples available to evaluate the expression.'] };

    let compiled: { evaluate(scope: Scope): unknown };
    try {
      compiled = compileWaveformExpression(expression);
    } catch (err) {
      return { ok: false, errors: [`Syntax error: ${err instanceof Error ? err.message : String(err)}`] };
    }

    let evaluated: unknown;
    try {
      evaluated = compiled.evaluate(prepared.scope);
    } catch (err) {
      return { ok: false, errors: [`Evaluation error: ${err instanceof Error ? err.message : String(err)}`] };
    }

    const normalized = this.normalizeResult(evaluated, prepared.sampleCount);
    if (!normalized.length) {
      return {
        ok: false,
        errors: [
          'The expression returned a scalar or no values. Use constantTrace(value) to create an explicit constant waveform.'
        ]
      };
    }
    if (normalized.length !== prepared.sampleCount) {
      return {
        ok: false,
        errors: [
          `The expression returned ${normalized.length} sample(s) but the aligned inputs have ${prepared.sampleCount}; every output must stay aligned to the timebase.`
        ]
      };
    }
    if (normalized.some((v) => v === Infinity || v === -Infinity)) {
      return {
        ok: false,
        errors: [
          'Expression produced infinite values; use guardedDivide(numerator, denominator, minimum) for divisions.'
        ]
      };
    }
    const nonFinite = normalized.reduce((count, value) => count + (Number.isNaN(value) ? 1 : 0), 0);
    if (nonFinite === normalized.length) {
      return { ok: false, errors: ['Every sample of the expression is NaN; check the inputs and guards.'] };
    }

    return {
      ok: true,
      errors: [],
      warnings:
        nonFinite > 0
          ? [`${nonFinite} sample(s) are NaN (missing inputs or guarded divisions) and will be excluded from analysis.`]
          : []
    };
  },

  /** Names a variable may not use because the scope defines them (helpers, time axis, timestep). */
  reservedSymbols(): Set<string> {
    return new Set([...Object.keys(this.buildScope([0, 1], 2)), 't', 'dt']);
  },

  /**
   * Resolves every variable (values and quality), truncates them to the common aligned length and
   * builds the evaluation scope. Returns null when nothing can be evaluated. Reported problems go to
   * `report` so validation can list them while evaluation simply fails.
   */
  prepareEvaluation(
    def: MathDefinition,
    rawTime: number[],
    visited: Set<string>,
    report: (message: string) => void = () => {}
  ): { scope: Scope; sampleCount: number; quality: Uint16Array } | null {
    const variableData: Record<string, ResolvedSeries> = {};
    let minLen = rawTime.length > 0 ? rawTime.length : Infinity;
    const visitedWithCurrent = new Set(visited);
    if (def.name) visitedWithCurrent.add(def.name);

    (def.variables || []).forEach(({ columnId, symbol, sourceMode, applyXOffset: applyShift }) => {
      const sym = (symbol || '').trim();
      if (!sym) {
        report('Each mapped column needs a symbol (e.g., V or I).');
        return;
      }
      if (!columnId) {
        report(`Select a column for symbol ${sym}.`);
        return;
      }
      const data = this.resolveSeriesWithQuality(
        columnId,
        rawTime,
        { sourceMode: sourceMode ?? 'raw', applyXOffset: applyShift ?? true },
        visitedWithCurrent
      );
      if (!data.values.length) {
        report(`No numeric samples found for column "${columnId}" mapped to ${sym}.`);
        return;
      }
      variableData[sym] = data;
      minLen = Math.min(minLen, data.values.length);
    });

    if (!Number.isFinite(minLen) || minLen <= 0 || Object.keys(variableData).length === 0) return null;

    const timeSlice = rawTime.length > 0 ? rawTime.slice(0, minLen) : [];
    const scope = this.buildScope(timeSlice, minLen);
    const quality = new Uint16Array(minLen).fill(QualityFlag.Processed);
    Object.entries(variableData).forEach(([symbol, data]) => {
      scope[symbol] = data.values.slice(0, minLen);
      for (let index = 0; index < minLen; index += 1) quality[index] |= data.quality[index] || 0;
    });
    if (timeSlice.length > 0) {
      scope.t = timeSlice;
      scope.dt = this.getDt(timeSlice);
    }
    return { scope, sampleCount: minLen, quality };
  },

  resolveSeries(
    columnId: string,
    rawTime: number[] = [],
    mode: ResolveMode = {},
    visited = new Set<string>()
  ): number[] {
    return this.resolveSeriesWithQuality(columnId, rawTime, mode, visited).values;
  },

  /**
   * Resolves a column's values together with its quality mask, following the same transformations
   * (filtered pipeline, x-offset) so the flags stay aligned with the samples they describe.
   */
  resolveSeriesWithQuality(
    columnId: string,
    rawTime: number[] = [],
    mode: ResolveMode = {},
    visited = new Set<string>()
  ): ResolvedSeries {
    if (!columnId) return { values: [], quality: new Uint16Array(0) };
    const { sourceMode = 'raw', applyXOffset: applyShift = true } = mode;
    if (visited.has(columnId)) {
      console.warn(`Circular math reference detected for ${columnId}.`);
      return { values: [], quality: new Uint16Array(0) };
    }

    const visitedWithCurrent = new Set(visited);
    visitedWithCurrent.add(columnId);

    const mathDef = State.getMathDefinition(columnId);
    let series: number[] = [];
    let quality: Uint16Array;
    if (mathDef) {
      const result = this.calculateVirtualColumn(mathDef, rawTime, visitedWithCurrent);
      series = result.values;
      quality = result.quality ? result.quality.slice(0, series.length) : new Uint16Array(series.length);
    } else if (State.data.headers.includes(columnId)) {
      series = State.data.columns[columnId]
        ? Array.from(State.data.columns[columnId])
        : State.data.raw.map((row) => toNumber(row[columnId]));
      quality = combineQualityMasks(series.length, State.data.quality[columnId]);
    } else {
      quality = new Uint16Array(0);
    }

    if (sourceMode === 'filtered') {
      const filtered = Filter.applyPipelineWithReport(series, rawTime, State.getPipelineForColumn(columnId), quality);
      series = filtered.values;
      quality = filtered.quality;
    }
    if (applyShift) {
      const offset = State.getTraceConfig(columnId).xOffset || 0;
      if (offset) {
        quality = shiftQualityMask(quality, offset, series);
        series = applyXOffset(series, offset);
      }
    }
    return { values: series, quality };
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

    const prepared = this.prepareEvaluation(def, rawTime, visited);
    if (!prepared) return { values: [], time: [], error: 'No aligned samples available to evaluate the expression.' };

    try {
      const values = this.normalizeResult(
        compileWaveformExpression(def.expression).evaluate(prepared.scope),
        prepared.sampleCount
      );
      if (values.length !== prepared.sampleCount) {
        return {
          values: [],
          time: [],
          error:
            values.length === 0
              ? 'The expression returned a scalar or no values.'
              : `The expression returned ${values.length} sample(s) for ${prepared.sampleCount} aligned inputs.`
        };
      }
      const quality = prepared.quality;
      for (let index = 0; index < values.length; index += 1) {
        if (!Number.isFinite(values[index])) quality[index] |= QualityFlag.Invalid;
      }
      return {
        values,
        time: rawTime.length > 0 ? rawTime.slice(0, values.length) : [],
        quality
      };
    } catch (err) {
      console.error('Math evaluation failed', err);
      return {
        values: [],
        time: [],
        error: `Evaluation error: ${err instanceof Error ? err.message : String(err)}`
      };
    }
  }
};
