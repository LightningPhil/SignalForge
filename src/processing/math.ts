import { evaluate, isMatrix, parse } from 'mathjs';
import { toNumber } from '../app/utils';
import { State } from '../state';
import type { MathDefinition, MathResult, MathValidation, ResolveMode } from '../types';
import { applyXOffset, Filter } from './filter';

type NumericLike = number | number[];
type Scope = Record<string, unknown>;

function asNumbers(arr: unknown): number[] {
  return Array.isArray(arr) ? arr.map((v) => Number(v)) : [Number(arr)];
}

export const MathEngine = {
  customFunctions: {
    diff: (arr: unknown): number[] => {
      const values = asNumbers(arr);
      if (values.length === 0) return [];
      const out = new Array<number>(values.length).fill(values[0]);
      for (let i = 1; i < values.length; i++) out[i] = values[i] - values[i - 1];
      return out;
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
      asNumbers(arr).map((v) => Math.min(max, Math.max(min, v)))
  },

  buildScope(dt = 1): Scope {
    return {
      ...this.customFunctions,
      delay: (arr: unknown, seconds = 0) => {
        const step = dt || 1;
        return applyXOffset(asNumbers(arr), Math.round((seconds || 0) / step));
      }
    };
  },

  getDt(timeArray: number[]): number {
    if (!Array.isArray(timeArray) || timeArray.length < 2) return 1;
    const span = timeArray[timeArray.length - 1] - timeArray[0];
    return span !== 0 ? span / (timeArray.length - 1) : 1;
  },

  getAvailableMathColumns(): string[] {
    return (State.config.mathDefinitions || []).map((d) => d.name);
  },

  validateDefinition(def: MathDefinition | null | undefined, rawTime: number[] = [], visited = new Set<string>()): MathValidation {
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
      const data = this.resolveSeries(columnId, rawTime, {
        sourceMode: sourceMode ?? 'raw',
        applyXOffset: applyShift ?? true
      }, visitedWithCurrent);
      if (!data.length) {
        errors.push(`No numeric samples found for column "${columnId}" mapped to ${sym}.`);
        return;
      }
      variableData[sym] = data;
      minLen = Math.min(minLen, data.length);
    });

    if (errors.length > 0) return { ok: false, errors };
    if (!Number.isFinite(minLen) || minLen === Infinity || minLen <= 0) {
      return { ok: false, errors: ['No aligned samples available to evaluate the expression.'] };
    }

    const timeSlice = rawTime.length > 0 ? rawTime.slice(0, minLen) : [];
    const scope = this.buildScope(this.getDt(timeSlice));
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
      return { ok: false, errors: ['The expression returned no values. Ensure it outputs a scalar or array.'] };
    }
    if (normalized.some((v) => !Number.isFinite(v))) {
      return { ok: false, errors: ['Expression produced non-finite values (NaN/Infinity). Check the inputs or guard against division by zero.'] };
    }

    return { ok: true, errors: [] };
  },

  resolveSeries(columnId: string, rawTime: number[] = [], mode: ResolveMode = {}, visited = new Set<string>()): number[] {
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
      series = State.data.raw.map((row) => toNumber(row[columnId]));
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
    if (typeof plain === 'number') return new Array<number>(targetLength).fill(plain);
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
      const data = this.resolveSeries(columnId, rawTime, {
        sourceMode: sourceMode ?? 'raw',
        applyXOffset: applyShift ?? true
      }, visitedWithCurrent);
      if (!data.length) return;
      variableData[sym] = data;
      minLen = Math.min(minLen, data.length);
    });

    if (!Number.isFinite(minLen) || minLen === Infinity || minLen <= 0) {
      return { values: [], time: [] };
    }

    const timeSlice = rawTime.length > 0 ? rawTime.slice(0, minLen) : [];
    const scope = this.buildScope(this.getDt(timeSlice));
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
