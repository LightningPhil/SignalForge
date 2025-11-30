import { State } from '../state.js';

/**
 * Math Engine
 * Performs dynamic calculations between columns (Virtual Traces).
 */
export const MathEngine = {
    
    /**
     * Calculates the data array for a virtual column definition.
     * @param {Object} def - The math definition { name, colA, op, colB, offset, scalar, ... }
     * @param {Array} rawTime - Array of time values (for integration/differentiation)
     * @returns {Array} The computed Y-values
     */
    calculateVirtualColumn(def, rawTime) {
        const rawData = State.data.raw;
        if (!rawData || rawData.length === 0) return [];

        // Helper to get array from column name
        const getCol = (name) => rawData.map(r => parseFloat(r[name]) || 0);

        let dataA = getCol(def.colA);
        let result = [...dataA]; // Start with A

        // --- 1. Basic Operations (A op B or A op Scalar) ---
        if (['add','sub','mul','div'].includes(def.op)) {
            
            let dataB;
            if (def.isScalar) {
                // Scalar Operation
                const val = parseFloat(def.scalarValue) || 0;
                dataB = new Array(dataA.length).fill(val);
            } else {
                // Column Operation
                dataB = getCol(def.colB);
                
                // Apply Time Offset to B (shift indices)
                if (def.offsetSamples && def.offsetSamples !== 0) {
                    dataB = this.shiftArray(dataB, def.offsetSamples);
                }
            }

            for(let i=0; i<result.length; i++) {
                const a = dataA[i];
                const b = dataB[i];
                
                switch(def.op) {
                    case 'add': result[i] = a + b; break;
                    case 'sub': result[i] = a - b; break;
                    case 'mul': result[i] = a * b; break;
                    case 'div': result[i] = (b !== 0) ? a / b : 0; break;
                }
            }
        }
        else if (def.op === 'sq') {
            result = result.map(v => v * v);
        }
        else if (def.op === 'sqrt') {
            result = result.map(v => (v > 0) ? Math.sqrt(v) : 0);
        }

        // --- 2. Post-Process Calculus ---
        // These can be chained onto the result of Step 1
        if (def.postCalc === 'diff') {
            result = this.derivative(result, rawTime);
        } 
        else if (def.postCalc === 'int') {
            result = this.integrate(result, rawTime);
        }

        return result;
    },

    /**
     * Shifts array by N samples.
     * Positive N = Lag (Right shift). Fill with 0.
     */
    shiftArray(data, n) {
        const len = data.length;
        const result = new Array(len).fill(0);
        
        for(let i=0; i<len; i++) {
            const srcIdx = i - n;
            if(srcIdx >= 0 && srcIdx < len) {
                result[i] = data[srcIdx];
            }
        }
        return result;
    },

    /**
     * Calculate Derivative (dy/dx)
     */
    derivative(y, x) {
        const dY = [];
        for (let i = 0; i < y.length - 1; i++) {
            const slope = (x[i+1] - x[i] !== 0) 
                ? (y[i+1] - y[i]) / (x[i+1] - x[i]) 
                : 0;
            dY.push(slope);
        }
        dY.push(dY[dY.length-1]); // Pad
        return dY;
    },

    /**
     * Calculate Integral (Trapezoidal Rule)
     * Accumulates area under curve.
     */
    integrate(y, x) {
        const integ = [];
        let sum = 0;
        integ.push(0); // Start at 0

        for (let i = 0; i < y.length - 1; i++) {
            const dt = x[i+1] - x[i];
            const area = 0.5 * (y[i] + y[i+1]) * dt;
            sum += area;
            integ.push(sum);
        }
        return integ;
    },

    // --- Helpers used by UI ---
    getAvailableMathColumns() {
        if(!State.config.mathDefinitions) return [];
        return State.config.mathDefinitions.map(d => d.name);
    }
};