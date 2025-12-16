import { State } from '../state.js';
import { Filter, applyXOffset } from './filter.js';

// Ensure math.js is available globally
const mathLib = (typeof math !== 'undefined') ? math : null;

/**
 * Advanced Math Engine powered by math.js
 */
export const MathEngine = {

    customFunctions: {
        diff: (arr) => {
            const values = Array.isArray(arr) ? arr : [arr];
            if (values.length === 0) return [];
            const out = new Array(values.length).fill(values[0]);
            for (let i = 1; i < values.length; i++) {
                out[i] = values[i] - values[i - 1];
            }
            return out;
        },

        cumsum: (arr) => {
            const values = Array.isArray(arr) ? arr : [arr];
            let sum = 0;
            return values.map((v) => {
                sum += v;
                return sum;
            });
        }
    },

    getDt(timeArray) {
        if (!Array.isArray(timeArray) || timeArray.length < 2) return 1;
        const span = timeArray[timeArray.length - 1] - timeArray[0];
        return span !== 0 ? span / (timeArray.length - 1) : 1;
    },

    getAvailableMathColumns() {
        if (!State.config.mathDefinitions) return [];
        return State.config.mathDefinitions.map((d) => d.name);
    },

    validateDefinition(def, rawTime = [], visited = new Set()) {
        const errors = [];

        if (!mathLib || typeof mathLib.evaluate !== 'function') {
            errors.push('math.js is not available in the current session.');
            return { ok: false, errors };
        }

        if (!def) {
            errors.push('Missing math definition.');
            return { ok: false, errors };
        }

        const expression = (def.expression || '').trim();
        if (!expression) {
            errors.push('Enter an expression to compute.');
        }

        if (!Array.isArray(def.variables) || def.variables.length === 0) {
            errors.push('Assign at least one variable.');
        }

        const scope = { ...this.customFunctions };
        const variableData = {};
        let minLen = Array.isArray(rawTime) && rawTime.length > 0 ? rawTime.length : Infinity;

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

            const mode = {
                sourceMode: sourceMode ?? 'raw',
                applyXOffset: applyShift ?? true
            };
            const data = this.resolveSeries(columnId, rawTime, mode, visitedWithCurrent);
            if (!data || data.length === 0) {
                errors.push(`No numeric samples found for column "${columnId}" mapped to ${sym}.`);
                return;
            }

            variableData[sym] = data;
            minLen = Math.min(minLen, data.length);
        });

        if (errors.length > 0) return { ok: false, errors };

        if (!Number.isFinite(minLen) || minLen === Infinity || minLen <= 0) {
            errors.push('No aligned samples available to evaluate the expression.');
            return { ok: false, errors };
        }

        Object.entries(variableData).forEach(([symbol, data]) => {
            scope[symbol] = data.slice(0, minLen);
        });

        if (Array.isArray(rawTime) && rawTime.length > 0) {
            scope.t = rawTime.slice(0, minLen);
            scope.dt = this.getDt(scope.t);
        }

        try {
            mathLib.parse(expression);
        } catch (err) {
            errors.push(`Syntax error: ${err.message}`);
            return { ok: false, errors };
        }

        let evaluated;
        try {
            evaluated = mathLib.evaluate(expression, scope);
        } catch (err) {
            errors.push(`Evaluation error: ${err.message}`);
            return { ok: false, errors };
        }

        const normalized = this.normalizeResult(evaluated, minLen);
        if (!normalized || normalized.length === 0) {
            errors.push('The expression returned no values. Ensure it outputs a scalar or array.');
            return { ok: false, errors };
        }

        const hasNonFinite = normalized.some((v) => !Number.isFinite(v));
        if (hasNonFinite) {
            errors.push('Expression produced non-finite values (NaN/Infinity). Check the inputs or guard against division by zero.');
            return { ok: false, errors };
        }

        return { ok: true, errors: [] };
    },

    getColumnData(columnId, rawTime, visited = new Set()) {
        return this.resolveSeries(columnId, rawTime, { sourceMode: 'raw', applyXOffset: false }, visited);
    },

    resolveSeries(columnId, rawTime = [], mode = {}, visited = new Set()) {
        if (!columnId) return [];

        const { sourceMode = 'raw', applyXOffset: applyShift = true } = mode;

        if (visited.has(columnId)) {
            console.warn(`Circular math reference detected for ${columnId}.`);
            return [];
        }

        const visitedWithCurrent = new Set(visited);
        visitedWithCurrent.add(columnId);

        const mathDef = State.getMathDefinition(columnId);
        let series = [];

        if (mathDef) {
            const result = this.calculateVirtualColumn(mathDef, rawTime, visitedWithCurrent);
            series = result.values || [];
        } else if (State.data.headers.includes(columnId)) {
            series = State.data.raw.map((r) => parseFloat(r[columnId]));
        }

        if (!Array.isArray(series)) series = [];

        if (sourceMode === 'filtered') {
            const pipeline = State.getPipelineForColumn(columnId);
            series = Filter.applyPipeline(series, rawTime, pipeline);
        }

        if (applyShift) {
            const { xOffset = 0 } = State.getTraceConfig(columnId);
            series = applyXOffset(series, xOffset);
        }

        return series;
    },

    normalizeResult(result, targetLength) {
        const toPlainArray = (val) => {
            if (Array.isArray(val)) return [...val];
            if (mathLib && typeof mathLib.isMatrix === 'function' && mathLib.isMatrix(val)) return val.toArray();
            if (ArrayBuffer.isView(val)) return Array.from(val);
            return val;
        };

        const plain = toPlainArray(result);

        if (typeof plain === 'number') {
            return new Array(targetLength).fill(plain);
        }

        if (!Array.isArray(plain)) return [];

        if (plain.length === 0) return [];

        const finalLength = Math.min(targetLength, plain.length);
        return plain.slice(0, finalLength);
    },

    calculateVirtualColumn(def, rawTime = [], visited = new Set()) {
        if (!mathLib || typeof mathLib.evaluate !== 'function') {
            console.error('math.js is not available.');
            return { values: [], time: [] };
        }

        if (!def || !Array.isArray(def.variables) || !def.expression) {
            return { values: [], time: [] };
        }

        const scope = { ...this.customFunctions };
        const variableData = {};
        let minLen = Array.isArray(rawTime) && rawTime.length > 0 ? rawTime.length : Infinity;

        const visitedWithCurrent = new Set(visited);
        if (def.name) visitedWithCurrent.add(def.name);

        def.variables.forEach(({ columnId, symbol, sourceMode, applyXOffset: applyShift }) => {
            const sym = (symbol || '').trim();
            if (!sym || !columnId) return;
            const mode = {
                sourceMode: sourceMode ?? 'raw',
                applyXOffset: applyShift ?? true
            };
            const data = this.resolveSeries(columnId, rawTime, mode, visitedWithCurrent);
            if (data.length === 0) return;
            variableData[sym] = data;
            minLen = Math.min(minLen, data.length);
        });

        if (!Number.isFinite(minLen) || minLen === Infinity || minLen <= 0) {
            return { values: [], time: [] };
        }

        Object.entries(variableData).forEach(([symbol, data]) => {
            scope[symbol] = data.slice(0, minLen);
        });

        if (Array.isArray(rawTime) && rawTime.length > 0) {
            scope.t = rawTime.slice(0, minLen);
            scope.dt = this.getDt(scope.t);
        }

        let evaluated;
        try {
            evaluated = mathLib.evaluate(def.expression, scope);
        } catch (err) {
            console.error('Math evaluation failed', err);
            return { values: [], time: rawTime.slice(0, minLen) };
        }

        const values = this.normalizeResult(evaluated, minLen);
        const time = Array.isArray(rawTime) && rawTime.length > 0 ? rawTime.slice(0, values.length) : [];

        return { values, time };
    }
};
