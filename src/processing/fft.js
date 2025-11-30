/**
 * Fast Fourier Transform (FFT) Module
 * Implements standard Radix-2 Cooley-Tukey Algorithm (Iterative).
 */
export const FFT = {
    
    /**
     * Calculates the Next Power of Two for padding.
     */
    nextPowerOfTwo(n) {
        return Math.pow(2, Math.ceil(Math.log(n) / Math.log(2)));
    },

    /**
     * Forward FFT
     * @param {Array<number>} data - Real input data
     * @returns {Object} { re: Array, im: Array } - Real and Imaginary parts
     */
    forward(data) {
        const n = this.nextPowerOfTwo(data.length);
        
        // Initialize arrays (Zero-padded)
        const re = new Float64Array(n);
        const im = new Float64Array(n);
        
        for(let i=0; i<data.length; i++) re[i] = data[i];

        this.transform(re, im);
        return { re, im };
    },

    /**
     * Inverse FFT
     * @param {Array<number>} re - Real part
     * @param {Array<number>} im - Imaginary part
     * @param {number} originalLength - Length to crop result to
     * @returns {Array<number>} Real part of the time-domain signal
     */
    inverse(re, im, originalLength) {
        const n = re.length;
        
        // Conjugate (invert imaginary)
        for(let i=0; i<n; i++) im[i] = -im[i];
        
        this.transform(re, im);
        
        // Conjugate again and Scale
        const output = [];
        for(let i=0; i<originalLength; i++) {
            // Real part is scaled by N, imaginary should be near 0
            output.push(re[i] / n); 
        }
        
        return output;
    },

    /**
     * Helper: Calculate Magnitude Spectrum in dB
     * Mag = sqrt(re^2 + im^2)
     * dB = 20 * log10(Mag)
     */
    getMagnitudeDB(re, im) {
        const n = re.length;
        const mags = [];
        // Only need first half (Nyquist)
        for(let i=0; i <= n/2; i++) {
            const mag = Math.sqrt(re[i]*re[i] + im[i]*im[i]);
            // Avoid log(0)
            const db = 20 * Math.log10(mag + 1e-9); 
            mags.push(db);
        }
        return mags;
    },

    /**
     * Core Cooley-Tukey Algorithm (In-Place)
     */
    transform(re, im) {
        const n = re.length;
        
        // Bit Reversal Permutation
        let target = 0;
        for (let i = 0; i < n - 1; i++) {
            if (i < target) {
                let tempRe = re[i]; re[i] = re[target]; re[target] = tempRe;
                let tempIm = im[i]; im[i] = im[target]; im[target] = tempIm;
            }
            let k = n >> 1;
            while (k <= target) {
                target -= k;
                k >>= 1;
            }
            target += k;
        }

        // Butterfly Computations
        for (let step = 1; step < n; step <<= 1) {
            const jump = step << 1;
            const deltaAngle = -Math.PI / step;
            const sine = Math.sin(0.5 * deltaAngle);
            const multiplierRe = -2.0 * sine * sine;
            const multiplierIm = Math.sin(deltaAngle);
            
            let wRe = 1.0;
            let wIm = 0.0;

            for (let group = 0; group < step; group++) {
                for (let pair = group; pair < n; pair += jump) {
                    const match = pair + step;
                    
                    const prodRe = wRe * re[match] - wIm * im[match];
                    const prodIm = wRe * im[match] + wIm * re[match];
                    
                    re[match] = re[pair] - prodRe;
                    im[match] = im[pair] - prodIm;
                    re[pair] += prodRe;
                    im[pair] += prodIm;
                }
                
                // Trignometric recurrence
                const tempWRe = wRe;
                wRe = wRe * multiplierRe - wIm * multiplierIm + wRe;
                wIm = wIm * multiplierRe + tempWRe * multiplierIm + wIm;
            }
        }
    }
};