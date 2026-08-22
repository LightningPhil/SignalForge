type ComplexBuffers = {
  re: Float64Array;
  im: Float64Array;
};

export const FFT = {
  nextPowerOfTwo(n: number): number {
    return Math.pow(2, Math.ceil(Math.log(n) / Math.log(2)));
  },

  forward(data: ArrayLike<number>): ComplexBuffers {
    const n = this.nextPowerOfTwo(data.length);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < data.length; i++) re[i] = data[i];
    this.transform(re, im);
    return { re, im };
  },

  inverse(re: Float64Array, im: Float64Array, originalLength?: number): number[] {
    const n = re.length;
    const reWork = re.slice();
    const imWork = im.slice();
    for (let i = 0; i < n; i++) imWork[i] = -imWork[i];
    this.transform(reWork, imWork);

    const output: number[] = [];
    const length = originalLength ?? n;
    for (let i = 0; i < length; i++) {
      output.push(reWork[i] / n);
    }
    return output;
  },

  getMagnitudeDB(re: ArrayLike<number>, im: ArrayLike<number>): number[] {
    const n = re.length;
    const mags: number[] = [];
    for (let i = 0; i <= n / 2; i++) {
      const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
      mags.push(20 * Math.log10(mag + 1e-9));
    }
    return mags;
  },

  transform(re: Float64Array, im: Float64Array): void {
    const n = re.length;
    let target = 0;
    for (let i = 0; i < n - 1; i++) {
      if (i < target) {
        const tempRe = re[i];
        re[i] = re[target];
        re[target] = tempRe;
        const tempIm = im[i];
        im[i] = im[target];
        im[target] = tempIm;
      }
      let k = n >> 1;
      while (k <= target) {
        target -= k;
        k >>= 1;
      }
      target += k;
    }

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
        const tempWRe = wRe;
        wRe = wRe * multiplierRe - wIm * multiplierIm + wRe;
        wIm = wIm * multiplierRe + tempWRe * multiplierIm + wIm;
      }
    }
  }
};
