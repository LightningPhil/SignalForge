/// <reference types="vite/client" />

declare module 'plotly.js-dist-min' {
  import type Plotly from 'plotly.js';
  const PlotlyMin: typeof Plotly;
  export default PlotlyMin;
}
