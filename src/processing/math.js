import { State } from '../state.js';

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

    getColumnData(columnId, rawTime, visited = new Set()) {
        if (!columnId) return [];
        if (visited.has(columnId)) {
            console.warn(`Circular math reference detected for ${columnId}.`);
            return [];
        }

        const mathDef = State.getMathDefinition(columnId);
        if (mathDef) {
            visited.add(columnId);
            const result = this.calculateVirtualColumn(mathDef, rawTime, visited);
            return result.values;
        }

        if (!State.data.headers.includes(columnId)) return [];
        return State.data.raw.map((r) => parseFloat(r[columnId]));
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

        def.variables.forEach(({ columnId, symbol }) => {
            const sym = (symbol || '').trim();
            if (!sym || !columnId) return;
            const data = this.getColumnData(columnId, rawTime, visitedWithCurrent);
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
