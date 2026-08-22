import Plotly from 'plotly.js-dist-min';
import type { Data, Layout, PlotlyHTMLElement, PlotRelayoutEvent } from 'plotly.js';
import { State } from '../state';
import { Config } from '../config';
import { lttb } from '../processing/lttb';
import { FFT } from '../processing/fft';
import { Filter } from '../processing/filter';
import { applyComposerOffsets, getComposerTrace } from '../processing/composer';
import { estimateSampleRate, buildFrequencyAxis } from '../processing/sampling';
import { getActiveTheme, getColorsForTheme, hexToRgba } from './colors';
import { getRawSeries, getSeriesForColumn } from '../app/traceData';
import type {
  AxisFormat,
  AxisFormatOptions,
  PlotSeries,
  PlotStyling,
  RenderOptions,
  ViewRange
} from '../types';

const PLOT_ID = 'main-plot';
const STATUS_ID = 'live-status';

type RangeArg = ViewRange | Partial<ViewRange> | [number, number] | null | undefined;

function asRangePair(value: unknown): [number, number] {
  const pair = value as [number, number];
  return [pair[0], pair[1]];
}

function cloneRangePair(range: [number, number]): [number, number] {
  return [...range] as [number, number];
}

function toPlotAxis(format: AxisFormatOptions): Partial<Layout['xaxis']> {
  return format as Partial<Layout['xaxis']>;
}

/**
 * Graph Visualization Module
 */
export const Graph = {

  lastRanges: { x: null, y: null } as ViewRange,
  _ignoreRelayoutCount: 0,

  beginIgnoreRelayout(): void {
    this._ignoreRelayoutCount += 1;
  },

  endIgnoreRelayout(): void {
    this._ignoreRelayoutCount = Math.max(0, this._ignoreRelayoutCount - 1);
  },

  isIgnoringRelayout(): boolean {
    return this._ignoreRelayoutCount > 0;
  },

  reactPlot(traces: Data[], layout: Partial<Layout>): Promise<PlotlyHTMLElement> {
    this.beginIgnoreRelayout();
    const result = Plotly.react(PLOT_ID, traces, layout);
    Promise.resolve(result).finally(() => {
      this.endIgnoreRelayout();
    });
    return result;
  },

  setStatus(text: string): void {
    const statusEl = document.getElementById(STATUS_ID);
    if (statusEl) statusEl.textContent = text;
  },

  getPlotStyling(): PlotStyling {
    const styles = getComputedStyle(document.documentElement);
    const paperBg = styles.getPropertyValue('--plot-bg').trim() || '#1e1e1e';
    const plotBg = styles.getPropertyValue('--plot-bg').trim() || '#1e1e1e';
    const fontColor = styles.getPropertyValue('--text-main').trim() || '#e0e0e0';
    const gridColor = styles.getPropertyValue('--plot-grid').trim() || '#333';
    return { paperBg, plotBg, fontColor, gridColor };
  },

  getActiveTheme,

  getColorsForTheme,

  init(): void {
    const { paperBg, plotBg, fontColor, gridColor } = this.getPlotStyling();
    const config = {
      responsive: true,
      displayModeBar: true,
      modeBarButtonsToRemove: ['lasso2d', 'select2d'] as Array<'lasso2d' | 'select2d'>,
      toImageButtonOptions: {
        format: 'svg' as const,
        filename: 'graph_export',
        height: 600,
        width: 1000,
        scale: 1
      }
    };

    const layout: Partial<Layout> = {
      paper_bgcolor: paperBg,
      plot_bgcolor: plotBg,
      font: { color: fontColor },
      xaxis: { title: Config.graph.xAxisTitle, gridcolor: gridColor },
      yaxis: { title: Config.graph.yAxisTitle, gridcolor: gridColor }
    };

    Plotly.newPlot(PLOT_ID, [], layout, config);

    const plotElement = document.getElementById(PLOT_ID) as PlotlyHTMLElement;
    plotElement.on('plotly_relayout', this.handleZoom.bind(this) as (event: PlotRelayoutEvent) => void);

    window.addEventListener('resize', () => {
      Plotly.Plots.resize(PLOT_ID);
    });
  },

  updateTheme(): void {
    const plotElement = document.getElementById(PLOT_ID) as PlotlyHTMLElement | null;
    if (!plotElement || !plotElement.data) return;

    const xRange = (plotElement.layout && plotElement.layout.xaxis && plotElement.layout.xaxis.range)
      ? [...plotElement.layout.xaxis.range] as [number, number]
      : null;
    const yRange = (plotElement.layout && plotElement.layout.yaxis && plotElement.layout.yaxis.range)
      ? [...plotElement.layout.yaxis.range] as [number, number]
      : null;

    const { paperBg, plotBg, fontColor, gridColor } = this.getPlotStyling();
    this.beginIgnoreRelayout();
    Promise.resolve(Plotly.relayout(PLOT_ID, {
      paper_bgcolor: paperBg,
      plot_bgcolor: plotBg,
      'font.color': fontColor,
      'xaxis.gridcolor': gridColor,
      'yaxis.gridcolor': gridColor,
      'yaxis2.gridcolor': gridColor,
      ...(xRange ? { 'xaxis.range': xRange } : {}),
      ...(yRange ? { 'yaxis.range': yRange } : {})
    } as Partial<Layout>)).finally(() => {
      this.endIgnoreRelayout();
    });

    if (State.data.raw.length && State.data.timeColumn && (State.data.dataColumn || State.ui.activeMultiViewId)) {
      const rangePayload: Partial<ViewRange> = {};
      if (xRange) rangePayload.x = xRange;
      if (yRange) rangePayload.y = yRange;
      const hasRange = !!(xRange || yRange);
      this.triggerRefresh(hasRange ? rangePayload : null);
    }
  },

  calculateDerivative(x: ArrayLike<number> | null | undefined, y: ArrayLike<number> | null | undefined): number[] {
    if (!x || !y || x.length < 2) return [];
    const dY: number[] = [];
    for (let i = 0; i < x.length - 1; i++) {
      const diffX = x[i + 1] - x[i];
      const diffY = y[i + 1] - y[i];
      const slope = (diffX !== 0) ? diffY / diffX : 0;
      dY.push(slope);
    }
    dY.push(dY[dY.length - 1]);
    return dY;
  },

  hexToRgba,

  getAxisFormat(
    format: AxisFormat | string,
    axisType = 'linear',
    currencySymbol = '£',
    significantFigures: number | string = 3
  ): AxisFormatOptions {
    const sig = Math.max(1, Number.parseInt(String(significantFigures), 10) || 3);
    const sciPrecision = Math.max(0, sig - 1);

    const presets: Record<string, AxisFormatOptions> = {
      decimal: { tickformat: ',.6~f', exponentformat: 'none' },
      scientific: { tickformat: `.${sciPrecision}e`, exponentformat: 'e', showexponent: 'all' },
      integer: { tickformat: ',d', exponentformat: 'none' },
      currency: { tickprefix: currencySymbol || '', tickformat: ',.2f', exponentformat: 'none' },
      percentage: { tickformat: '.0%', exponentformat: 'none' },
      datetime: { type: 'date', hoverformat: '%Y-%m-%d %H:%M' },
      engineering: { tickformat: `.${sig}s`, exponentformat: 'SI' }
    };

    const selected = presets[format] || presets.decimal;

    if (axisType === 'log' && selected.type === 'date') {
      const { type: _type, ...rest } = selected;
      return rest;
    }

    return selected;
  },

  render(
    rawX: number[],
    rawY: number[],
    filteredY: number[] | null = null,
    range: RangeArg = null,
    options: RenderOptions = {}
  ): void {
    if (!rawX || rawX.length === 0) return;

    const isMath = options.isMath || !!State.getMathDefinition(State.data.dataColumn);
    const seriesName = options.seriesName || State.data.dataColumn || 'Series';

    const composerTrace = getComposerTrace(State.ui.activeMultiViewId || null, State.data.dataColumn);
    const { adjustedRawY, adjustedFilteredY } = applyComposerOffsets(rawY, filteredY, composerTrace);

    const config = State.config.graph;

    // --- Mode Switching ---
    if (config.showFreqDomain) {
      this.renderFreqDomain(rawX, adjustedRawY, isMath ? null : adjustedFilteredY, { isMath, seriesName });
    } else {
      this.renderTimeDomain(rawX, adjustedRawY, isMath ? null : adjustedFilteredY, range, { isMath, seriesName });
    }
  },

  renderMultiView(
    rawX: number[],
    seriesList: PlotSeries[],
    ranges: RangeArg = null,
    viewId: string | null = null
  ): void {
    if (!rawX || rawX.length === 0) return;
    const config = State.config.graph;

    if (config.showFreqDomain) {
      this.renderMultiFreqDomain(rawX, seriesList);
    } else {
      this.renderMultiTimeDomain(rawX, seriesList, ranges, viewId);
    }
  },

  renderMultiTimeDomain(
    rawX: number[],
    seriesList: PlotSeries[],
    ranges: RangeArg,
    _viewId: string | null = null
  ): void {
    const config = State.config.graph;
    const { paperBg, plotBg, fontColor, gridColor } = this.getPlotStyling();
    const showDiff = config.showDifferential;
    const showRaw = (config.showRaw !== false);
    const allowDownsample = config.enableDownsampling;

    const xRange = Array.isArray(ranges) ? ranges : (ranges && ranges.x ? ranges.x : null);
    const yRange = (!Array.isArray(ranges) && ranges && ranges.y) ? ranges.y : null;

    if (ranges === null) {
      this.lastRanges = { x: null, y: null };
    } else {
      this.lastRanges = { x: xRange ? cloneRangePair(xRange) : null, y: yRange ? cloneRangePair(yRange) : null };
    }

    const traces: Data[] = [];
    let isDownsampled = false;

    seriesList.forEach((series) => {
      if (!series || !series.rawY || series.rawY.length === 0) return;
      const name = series.columnId || 'Series';
      const isMathSeries = !!series.isMath;
      let seriesX = rawX;
      let seriesY = series.rawY;
      let seriesF = series.filteredY || [];

      if (xRange) {
        const startIndex = rawX.findIndex((val) => val >= xRange[0]);
        let endIndex = rawX.findIndex((val) => val > xRange[1]);

        if (startIndex !== -1) {
          if (endIndex === -1) endIndex = rawX.length;
          const buffer = 5;
          const sliceStart = Math.max(0, startIndex - buffer);
          const sliceEnd = Math.min(rawX.length, endIndex + buffer);
          seriesX = rawX.slice(sliceStart, sliceEnd);
          seriesY = seriesY.slice(sliceStart, sliceEnd);
          if (seriesF.length > 0) seriesF = seriesF.slice(sliceStart, sliceEnd);
        }
      }

      if (allowDownsample && seriesX.length > config.maxDisplayPoints) {
        isDownsampled = true;
        const originalX = seriesX;
        const zippedRaw = originalX.map((x, i): [number, number] => [x, seriesY[i]]);
        const sampledRaw = lttb(zippedRaw, config.maxDisplayPoints);
        seriesX = sampledRaw.map((p) => p[0]);
        seriesY = sampledRaw.map((p) => p[1]);

        if (!isMathSeries && seriesF.length > 0) {
          const zippedF = originalX.map((x, i): [number, number] => [x, seriesF[i]]);
          const sampledF = lttb(zippedF, config.maxDisplayPoints);
          seriesF = sampledF.map((p) => p[1]);
        }
      }

      if (isMathSeries) {
        traces.push({
          x: seriesX, y: seriesY, mode: 'lines', name: name,
          line: { width: 2 }, xaxis: 'x', yaxis: 'y'
        });

        if (showDiff) {
          const dMath = this.calculateDerivative(seriesX, seriesY);
          traces.push({
            x: seriesX, y: dMath, mode: 'lines', name: `${name} Deriv.`,
            line: { width: 1.5 }, xaxis: 'x', yaxis: 'y2'
          });
        }
      } else {
        if (showRaw) {
          traces.push({
            x: seriesX, y: seriesY, mode: 'lines', name: `${name} (Raw)`,
            line: { width: 1 }, xaxis: 'x', yaxis: 'y'
          });
        }

        if (seriesF && seriesF.length > 0) {
          traces.push({
            x: seriesX, y: seriesF, mode: 'lines', name: `${name} (Filtered)`,
            line: { width: 2 }, xaxis: 'x', yaxis: 'y'
          });
        }

        if (showDiff) {
          if (showRaw) {
            const dRaw = this.calculateDerivative(seriesX, seriesY);
            traces.push({
              x: seriesX, y: dRaw, mode: 'lines', name: `${name} Raw Deriv.`,
              line: { width: 1 }, xaxis: 'x', yaxis: 'y2'
            });
          }
          if (seriesF && seriesF.length > 0) {
            const dF = this.calculateDerivative(seriesX, seriesF);
            traces.push({
              x: seriesX, y: dF, mode: 'lines', name: `${name} Filt. Deriv.`,
              line: { width: 1.5 }, xaxis: 'x', yaxis: 'y2'
            });
          }
        }
      }
    });

    const xAxisFormat = this.getAxisFormat(config.xAxisFormat, 'linear', config.currencySymbol, config.significantFigures);
    const yAxisBaseType = config.logScaleY ? 'log' : 'linear';
    const yAxisFormat = this.getAxisFormat(config.yAxisFormat, yAxisBaseType, config.currencySymbol, config.significantFigures);
    const secondaryYAxisFormat = this.getAxisFormat(config.yAxisFormat, 'linear', config.currencySymbol, config.significantFigures);

    const layout: Partial<Layout> = {
      title: config.title,
      paper_bgcolor: paperBg,
      plot_bgcolor: plotBg,
      font: { color: fontColor },
      grid: {
        rows: showDiff ? 2 : 1,
        columns: 1,
        pattern: 'independent',
        roworder: 'top to bottom'
      },
      showlegend: true,
      legend: { orientation: 'h', y: -0.15 },
      xaxis: {
        title: config.xAxisTitle,
        ...(xRange ? { range: xRange } : { autorange: true }),
        showgrid: config.showGrid,
        gridcolor: gridColor,
        ...toPlotAxis(xAxisFormat)
      },
      yaxis: {
        title: config.yAxisTitle,
        type: yAxisBaseType,
        showgrid: config.showGrid,
        gridcolor: gridColor,
        domain: showDiff ? [0.55, 1] : [0, 1],
        ...(yRange ? { range: yRange } : { autorange: true }),
        ...toPlotAxis(yAxisFormat)
      },
      yaxis2: {
        title: 'Derivative (dy/dx)',
        domain: [0, 0.45],
        anchor: 'x',
        showgrid: config.showGrid,
        gridcolor: gridColor,
        ...toPlotAxis(secondaryYAxisFormat)
      }
    };

    this.reactPlot(traces, layout);

    const seriesCount = seriesList.filter((s) => s && s.rawY && s.rawY.length).length;
    let statusText = seriesCount > 0
      ? `Multi-View: ${seriesCount} trace(s) visible`
      : 'No traces selected';
    if (isDownsampled) statusText += ' (Downsampled)';
    this.setStatus(statusText);
  },

  // --- Frequency Domain Renderer ---
  renderFreqDomain(timeX: number[], rawY: number[], filteredY: number[] | null, options: RenderOptions = {}): void {
    const config = State.config.graph;
    const colors = this.getColorsForTheme();
    const { paperBg, plotBg, fontColor, gridColor } = this.getPlotStyling();
    const { isMath = false, seriesName = 'Series' } = options || {};

    const fs = estimateSampleRate(timeX);
    const { re: rawRe, im: rawIm } = FFT.forward(rawY);
    const rawMag = FFT.getMagnitudeDB(rawRe, rawIm);
    const { axis: freqAxis, nBins } = buildFrequencyAxis(rawRe.length, fs);

    const traces: Data[] = [];

    const showRawSpectrum = isMath ? true : (config.showRaw !== false);

    if (showRawSpectrum) {
      traces.push({
        x: freqAxis,
        y: rawMag,
        mode: 'lines',
        name: isMath ? `${seriesName} Spectrum` : 'Raw Spectrum',
        line: { color: isMath ? colors.filtered : this.hexToRgba(colors.raw, config.rawOpacity || 0.5), width: isMath ? 2 : 1 }
      });
    }

    if (!isMath && filteredY) {
      const { re: filtRe, im: filtIm } = FFT.forward(filteredY);
      const filtMag = FFT.getMagnitudeDB(filtRe, filtIm);

      traces.push({
        x: freqAxis, // Assumes same length
        y: filtMag,
        mode: 'lines',
        name: 'Filtered Spectrum',
        line: { color: colors.filtered, width: 1.5 }
      });
    }

    // Trace 3: Transfer Function (Filter Shape)
    // Only if we have active FFT filters
    const pipeline = State.getPipeline();
    const hasFFTFilters = pipeline.some((p) => p.enabled !== false && ['lowPassFFT', 'highPassFFT', 'notchFFT'].includes(p.type));

    if (hasFFTFilters) {
      const transfer = Filter.calculateTransferFunction(pipeline, fs, nBins, rawRe.length);
      // Convert to dB
      const transferDB = transfer.map((g) => 20 * Math.log10(g + 1e-9));

      // Shift Transfer curve visually?
      // Usually Transfer function is 0dB max. Data might be -40dB.
      // Plot on secondary Y axis? Or just overlay.
      // Let's put it on Y2 to avoid scaling issues.

      traces.push({
        x: freqAxis,
        y: transferDB,
        mode: 'lines',
        name: 'Filter Transfer H(f)',
        line: { color: colors.transfer || '#00bcd4', width: 2, dash: 'dot' },
        yaxis: 'y2'
      });
    }

    const layout: Partial<Layout> = {
      title: 'Frequency Domain (FFT)',
      paper_bgcolor: paperBg,
      plot_bgcolor: plotBg,
      font: { color: fontColor },
      showlegend: true,

      xaxis: {
        title: 'Frequency (Hz)',
        type: 'log',
        autorange: true,
        gridcolor: gridColor
      },
      yaxis: {
        title: 'Magnitude (dB)',
        gridcolor: gridColor
      },
      yaxis2: {
        title: 'Filter Gain (dB)',
        overlaying: 'y',
        side: 'right',
        range: [-100, 5], // Fixed range for transfer function
        showgrid: false
      }
    };

    this.reactPlot(traces, layout);
    this.setStatus(`Frequency Analysis (Fs ≈ ${Math.round(fs)} Hz)`);
  },

  renderMultiFreqDomain(timeX: number[], seriesList: PlotSeries[]): void {
    if (!seriesList || seriesList.length === 0) return;
    const config = State.config.graph;
    const { paperBg, plotBg, fontColor, gridColor } = this.getPlotStyling();

    const fs = estimateSampleRate(timeX);
    const traces: Data[] = [];

    seriesList.forEach((series) => {
      const { rawY, filteredY, columnId, isMath } = series;
      if (!rawY || rawY.length === 0) return;

      const { re: rawRe, im: rawIm } = FFT.forward(rawY);
      const rawMag = FFT.getMagnitudeDB(rawRe, rawIm);
      const { axis: freqAxis } = buildFrequencyAxis(rawRe.length, fs);

      if (isMath) {
        traces.push({
          x: freqAxis,
          y: rawMag,
          mode: 'lines',
          name: `${columnId} Spectrum`,
          line: { width: 2 }
        });
      } else {
        if (config.showRaw !== false) {
          traces.push({
            x: freqAxis,
            y: rawMag,
            mode: 'lines',
            name: `${columnId} Raw Spectrum`,
            line: { width: 1 }
          });
        }

        if (filteredY && filteredY.length > 0) {
          const { re: filtRe, im: filtIm } = FFT.forward(filteredY);
          const filtMag = FFT.getMagnitudeDB(filtRe, filtIm);
          traces.push({
            x: freqAxis,
            y: filtMag,
            mode: 'lines',
            name: `${columnId} Filtered Spectrum`,
            line: { width: 1.5 }
          });
        }
      }
    });

    const layout: Partial<Layout> = {
      title: 'Frequency Domain (FFT)',
      paper_bgcolor: paperBg,
      plot_bgcolor: plotBg,
      font: { color: fontColor },
      showlegend: true,
      xaxis: { title: 'Frequency (Hz)', type: 'log', autorange: true, gridcolor: gridColor },
      yaxis: { title: 'Magnitude (dB)', gridcolor: gridColor }
    };

    this.reactPlot(traces, layout);
    this.setStatus(`Frequency Analysis (Fs ≈ ${Math.round(fs)} Hz)`);
  },

  // --- Time Domain Renderer (Existing Logic) ---
  renderTimeDomain(
    rawX: number[],
    rawY: number[],
    filteredY: number[] | null,
    range: RangeArg,
    options: RenderOptions = {}
  ): void {
    const config = State.config.graph;
    const colors = this.getColorsForTheme();
    const { paperBg, plotBg, fontColor, gridColor } = this.getPlotStyling();
    const { isMath = false, seriesName = 'Series' } = options || {};

    const showDiff = config.showDifferential;
    const showRaw = (config.showRaw !== false);
    const allowDownsample = config.enableDownsampling;

    const xRange = Array.isArray(range) ? range : (range && range.x ? range.x : null);
    const yRange = (!Array.isArray(range) && range && range.y) ? range.y : null;

    let displayX = rawX;
    let displayY = rawY;
    let displayF = filteredY || [];

    if (range === null) {
      this.lastRanges = { x: null, y: null };
    } else {
      this.lastRanges = { x: xRange ? cloneRangePair(xRange) : null, y: yRange ? cloneRangePair(yRange) : null };
    }

    // Slicing
    let sliceStart = 0;
    let sliceEnd = rawX.length;
    if (xRange) {
      const startIndex = rawX.findIndex((val) => val >= xRange[0]);
      let endIndex = rawX.findIndex((val) => val > xRange[1]);

      if (startIndex !== -1) {
        if (endIndex === -1) endIndex = rawX.length;
        const buffer = 5;
        sliceStart = Math.max(0, startIndex - buffer);
        sliceEnd = Math.min(rawX.length, endIndex + buffer);

        displayX = rawX.slice(sliceStart, sliceEnd);
        displayY = rawY.slice(sliceStart, sliceEnd);
        if (filteredY) displayF = filteredY.slice(sliceStart, sliceEnd);
      }
    }

    const pointCount = displayX.length;
    let isDownsampled = false;

    // Downsampling
    if (allowDownsample && pointCount > config.maxDisplayPoints) {
      isDownsampled = true;
      const originalX = displayX;
      const zippedRaw = originalX.map((x, i): [number, number] => [x, displayY[i]]);
      const sampledRaw = lttb(zippedRaw, config.maxDisplayPoints);
      displayX = sampledRaw.map((p) => p[0]);
      displayY = sampledRaw.map((p) => p[1]);

      if (!isMath && filteredY && displayF.length > 0) {
        const zippedF = originalX.map((x, i): [number, number] => [x, displayF[i]]);
        const sampledF = lttb(zippedF, config.maxDisplayPoints);
        displayF = sampledF.map((p) => p[1]);
      }
    }

    const traces: Data[] = [];
    const rawColor = this.hexToRgba(colors.raw, config.rawOpacity || 0.5);
    const filtColor = colors.filtered;
    const diffRawColor = colors.diffRaw || colors.raw;
    const diffFiltColor = colors.diffFilt || colors.filtered;

    if (isMath) {
      traces.push({
        x: displayX, y: displayY, mode: 'lines', name: seriesName,
        line: { color: filtColor, width: 2 }, xaxis: 'x', yaxis: 'y'
      });

      if (showDiff) {
        const dMath = this.calculateDerivative(displayX, displayY);
        traces.push({
          x: displayX, y: dMath, mode: 'lines', name: `${seriesName} Deriv.`,
          line: { color: diffFiltColor, width: 1.5 }, xaxis: 'x', yaxis: 'y2'
        });
      }
    } else {
      if (showRaw) {
        traces.push({
          x: displayX, y: displayY, mode: 'lines', name: 'Raw Data',
          line: { color: rawColor, width: 1 }, xaxis: 'x', yaxis: 'y'
        });
      }

      if (filteredY && displayF.length > 0) {
        traces.push({
          x: displayX, y: displayF, mode: 'lines', name: 'Filtered',
          line: { color: filtColor, width: 2 }, xaxis: 'x', yaxis: 'y'
        });
      }

      if (showDiff) {
        if (showRaw) {
          const dRaw = this.calculateDerivative(displayX, displayY);
          traces.push({
            x: displayX, y: dRaw, mode: 'lines', name: 'Raw Deriv.',
            line: { color: this.hexToRgba(diffRawColor, config.rawOpacity || 0.5), width: 1 }, xaxis: 'x', yaxis: 'y2'
          });
        }
        if (filteredY && displayF.length > 0) {
          const dF = this.calculateDerivative(displayX, displayF);
          traces.push({
            x: displayX, y: dF, mode: 'lines', name: 'Filt. Deriv.',
            line: { color: diffFiltColor, width: 1.5 }, xaxis: 'x', yaxis: 'y2'
          });
        }
      }
    }

    const xAxisFormat = this.getAxisFormat(config.xAxisFormat, 'linear', config.currencySymbol, config.significantFigures);
    const yAxisBaseType = config.logScaleY ? 'log' : 'linear';
    const yAxisFormat = this.getAxisFormat(config.yAxisFormat, yAxisBaseType, config.currencySymbol, config.significantFigures);
    const secondaryYAxisFormat = this.getAxisFormat(config.yAxisFormat, 'linear', config.currencySymbol, config.significantFigures);

    const layout: Partial<Layout> = {
      title: config.title,
      paper_bgcolor: paperBg,
      plot_bgcolor: plotBg,
      font: { color: fontColor },
      grid: {
        rows: showDiff ? 2 : 1,
        columns: 1,
        pattern: 'independent',
        roworder: 'top to bottom'
      },
      showlegend: true,
      legend: { orientation: 'h', y: -0.15 },

      xaxis: {
        title: config.xAxisTitle,
        ...(xRange ? { range: xRange } : { autorange: true }),
        showgrid: config.showGrid,
        gridcolor: gridColor,
        ...toPlotAxis(xAxisFormat)
      },
      yaxis: {
        title: config.yAxisTitle,
        type: yAxisBaseType,
        showgrid: config.showGrid,
        gridcolor: gridColor,
        domain: showDiff ? [0.55, 1] : [0, 1],
        ...(yRange ? { range: yRange } : { autorange: true }),
        ...toPlotAxis(yAxisFormat)
      },
      yaxis2: {
        title: 'Derivative (dy/dx)',
        domain: [0, 0.45],
        anchor: 'x',
        showgrid: config.showGrid,
        gridcolor: gridColor,
        ...toPlotAxis(secondaryYAxisFormat)
      }
    };

    this.reactPlot(traces, layout);

    let statusText = `Displaying ${displayX.length} points`;
    if (isDownsampled) statusText += ` (LTTB Downsampled)`;
    else statusText += ` (Full Resolution)`;
    this.setStatus(statusText);
  },

  handleZoom(event: Record<string, unknown> | null | undefined): void {
    if (this.isIgnoringRelayout()) return;
    if (State.config.graph.showFreqDomain) return;
    if (!event) return;

    const hasX = event['xaxis.range[0]'] !== undefined || event['xaxis.range'] !== undefined || event['xaxis.autorange'] === true;
    const hasY = event['yaxis.range[0]'] !== undefined || event['yaxis.range'] !== undefined || event['yaxis.autorange'] === true;
    if (!hasX && !hasY) return;

    const ranges: ViewRange = { ...this.lastRanges };

    if (event['xaxis.range[0]'] || event['xaxis.range']) {
      let min: number;
      let max: number;
      if (event['xaxis.range']) {
        [min, max] = asRangePair(event['xaxis.range']);
      } else {
        min = event['xaxis.range[0]'] as number;
        max = event['xaxis.range[1]'] as number;
      }
      ranges.x = [min, max];
    }

    if (event['yaxis.range[0]'] || event['yaxis.range']) {
      let minY: number;
      let maxY: number;
      if (event['yaxis.range']) {
        [minY, maxY] = asRangePair(event['yaxis.range']);
      } else {
        minY = event['yaxis.range[0]'] as number;
        maxY = event['yaxis.range[1]'] as number;
      }
      ranges.y = [minY, maxY];
    }

    if (event['xaxis.autorange'] === true || event['yaxis.autorange'] === true) {
      this.triggerRefresh(null);
      return;
    }

    this.triggerRefresh(ranges);
  },

  triggerRefresh(range: RangeArg): void {
    if (range === null) {
      this.lastRanges = { x: null, y: null };
    } else if (Array.isArray(range)) {
      this.lastRanges = { x: cloneRangePair(range), y: this.lastRanges.y };
    } else if (range && typeof range === 'object') {
      this.lastRanges = {
        x: range.x ? cloneRangePair(range.x) : this.lastRanges.x,
        y: range.y ? cloneRangePair(range.y) : this.lastRanges.y
      };
    }

    const activeKey = State.getActiveViewKey();
    if (activeKey) {
      if (range === null) {
        State.setViewRangeForKey(activeKey, null);
      } else {
        State.setViewRangeForKey(activeKey, {
          x: this.lastRanges.x ?? null,
          y: this.lastRanges.y ?? null
        });
      }
    }

    if (!State.data.timeColumn) return;

    const appliedRange = this.lastRanges.x || this.lastRanges.y ? this.lastRanges : null;

    if (State.ui.activeMultiViewId) {
      this.renderMultiViewFromState(appliedRange);
      return;
    }

    const yCol = State.data.dataColumn;
    if (!yCol) return;

    const { rawX, rawY } = getRawSeries(yCol);
    const isMath = !!State.getMathDefinition(yCol);
    const filteredY = (!isMath && State.data.processed.length > 0) ? State.data.processed : null;

    this.render(rawX, rawY, filteredY, appliedRange, {
      isMath,
      seriesName: yCol
    });
  },

  getSeriesForColumn,

  renderMultiViewFromState(range: RangeArg = null): void {
    const activeId = State.ui.activeMultiViewId;
    const view = State.multiViews.find((v) => v.id === activeId);
    const xCol = State.data.timeColumn;
    if (!view) {
      State.ui.activeMultiViewId = null;
      return;
    }
    if (!xCol) return;

    const rawX = State.data.raw.map((r) => parseFloat(r[xCol] as string));
    const composer = State.getComposer(activeId);

    const seriesList = view.activeColumnIds
      .map((col): PlotSeries | null => {
        const series = getSeriesForColumn(col, rawX);
        if (!series) return null;

        const composerTrace = composer?.traces?.find((t) => t.columnId === col) || { columnId: col };
        const aligned = applyComposerOffsets(series.rawY, series.filteredY, {
          columnId: composerTrace.columnId,
          yOffset: composerTrace.yOffset || 0
        });

        return {
          columnId: col,
          rawY: aligned.adjustedRawY,
          filteredY: series.isMath ? null : aligned.adjustedFilteredY,
          time: series.time,
          isMath: series.isMath
        };
      })
      .filter((series): series is PlotSeries => series !== null);

    let commonLength = rawX.length;
    let referenceTime = rawX;

    seriesList.forEach((series) => {
      const timeArray = series.time && series.time.length ? series.time : referenceTime;
      commonLength = Math.min(commonLength, timeArray.length, series.rawY.length, series.filteredY ? series.filteredY.length : series.rawY.length);
      if (series.time && series.time.length) {
        referenceTime = series.time;
      }
    });

    const finalTime = referenceTime.slice(0, commonLength);
    const trimmedSeries: PlotSeries[] = seriesList.map((series) => ({
      ...series,
      rawY: series.rawY.slice(0, commonLength),
      filteredY: series.filteredY ? series.filteredY.slice(0, commonLength) : null
    }));

    this.renderMultiView(finalTime, trimmedSeries, range, activeId);
  }
};
