import Plotly from 'plotly.js-dist-min';
import type { Data, Layout, PlotlyHTMLElement, PlotRelayoutEvent } from 'plotly.js';
import { State } from '../state';
import { Config } from '../config';
import { lttb } from '../processing/lttb';
import { FFT } from '../processing/fft';
import { Filter } from '../processing/filter';
import { applyComposerOffsets, getComposerTrace } from '../processing/composer';
import { estimateSampleRate, buildFrequencyAxis } from '../processing/sampling';
import { AnalysisEngine } from '../analysis/analysisEngine';
import { SpectralMetrics } from '../analysis/spectralMetrics';
import { TimeFrequency } from '../analysis/timeFrequency';
import { getActiveTheme, getColorsForTheme, hexToRgba } from './colors';
import { getRawSeries, getSeriesForColumn } from '../app/traceData';
import type {
  AnalysisEvent,
  AxisFormat,
  AxisFormatOptions,
  PlotSeries,
  PlotStyling,
  RenderOptions,
  ViewMode,
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
  currentEvents: [] as AnalysisEvent[],
  eventOverlay: { show: true, activeIndex: null as number | null, amplitudes: null as ArrayLike<number> | null },
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

  getViewMode(): ViewMode {
    const cfg = State.config.graph || {};
    if (cfg.viewMode) return cfg.viewMode;
    return cfg.showFreqDomain ? 'fft' : 'time';
  },

  setEventOverlay(events: AnalysisEvent[] = [], options: { show?: boolean; activeIndex?: number | null; amplitudes?: ArrayLike<number> | null } = {}): void {
    this.currentEvents = Array.isArray(events) ? events : [];
    this.eventOverlay = {
      show: options.show !== false,
      activeIndex: Number.isInteger(options.activeIndex) ? options.activeIndex as number : null,
      amplitudes: options.amplitudes || null
    };
  },

  getEventAmplitude(event: AnalysisEvent | null | undefined, fallbackY: ArrayLike<number> = []): number {
    if (!event) return 0;
    if (this.eventOverlay.amplitudes && Number.isInteger(event.index) && Number.isFinite(this.eventOverlay.amplitudes[event.index as number])) {
      return this.eventOverlay.amplitudes[event.index as number];
    }
    if (Number.isFinite(event.metadata?.amplitude as number)) return event.metadata.amplitude as number;
    if (Number.isInteger(event.index) && Number.isFinite(fallbackY[event.index as number])) return fallbackY[event.index as number];
    return 0;
  },

  eventsVisible(): boolean {
    return State.ensureAnalysisConfig().showEvents !== false && this.eventOverlay.show !== false;
  },

  appendEventTraces(traces: Data[], fallbackY: ArrayLike<number> = []): void {
    if (!this.eventsVisible() || !this.currentEvents.length) return;
    const times: number[] = [];
    const amps: number[] = [];
    const colors: string[] = [];
    this.currentEvents.forEach((event, idx) => {
      if (!Number.isFinite(event.time)) return;
      times.push(event.time as number);
      amps.push(this.getEventAmplitude(event, fallbackY));
      colors.push(idx === this.eventOverlay.activeIndex ? '#ff6f61' : '#7dd3fc');
    });
    if (!times.length) return;
    traces.push({
      x: times,
      y: amps,
      mode: 'markers',
      name: 'Events',
      marker: { size: 10, symbol: 'x', color: colors },
      hovertemplate: 't=%{x}<extra>Event</extra>',
      yaxis: 'y'
    });
  },

  buildEventShapes(): NonNullable<Layout['shapes']> {
    const shapes: NonNullable<Layout['shapes']> = [];
    if (!this.eventsVisible() || !this.currentEvents.length) return shapes;
    const activeEvent = Number.isInteger(this.eventOverlay.activeIndex)
      ? this.currentEvents[this.eventOverlay.activeIndex as number]
      : null;
    if (activeEvent && Number.isFinite(activeEvent.time)) {
      shapes.push({
        type: 'line',
        x0: activeEvent.time as number,
        x1: activeEvent.time as number,
        y0: 0,
        y1: 1,
        xref: 'x',
        yref: 'paper',
        line: { color: '#ff6f61', width: 1, dash: 'dot' }
      });
    }
    return shapes;
  },

  zoomToEvent(time: number | null | undefined): void {
    if (!Number.isFinite(time)) return;
    const plotElement = document.getElementById(PLOT_ID) as PlotlyHTMLElement | null;
    if (!plotElement?.layout) return;
    const currentRange = plotElement.layout.xaxis?.range as [number, number] | undefined;
    const rawX = State.data.timeColumn
      ? State.data.raw.map((r) => parseFloat(String(r[State.data.timeColumn as string])))
      : [];
    const span = currentRange && currentRange.length === 2
      ? (currentRange[1] - currentRange[0])
      : Math.max(1e-9, (rawX[rawX.length - 1] || 0) - (rawX[0] || 0)) / 10;
    const nextRange: [number, number] = [(time as number) - span / 2, (time as number) + span / 2];
    this.lastRanges = { x: nextRange, y: this.lastRanges.y };
    this.beginIgnoreRelayout();
    Promise.resolve(Plotly.relayout(PLOT_ID, { 'xaxis.range': nextRange })).finally(() => this.endIgnoreRelayout());
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

    const mode = this.getViewMode();
    if (mode === 'fft') {
      this.renderFreqDomain(rawX, adjustedRawY, isMath ? null : adjustedFilteredY, { isMath, seriesName });
    } else if (mode === 'spectrogram') {
      this.renderSpectrogram(rawX, adjustedRawY, isMath ? null : adjustedFilteredY, { isMath, seriesName });
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
    const mode = this.getViewMode();
    if (mode === 'fft') {
      this.renderMultiFreqDomain(rawX, seriesList);
    } else if (mode === 'spectrogram') {
      const primary = seriesList.find((s) => s && s.rawY && s.rawY.length);
      if (primary) {
        this.renderSpectrogram(rawX, primary.rawY, primary.isMath ? null : primary.filteredY, {
          isMath: primary.isMath,
          seriesName: primary.columnId || 'Series'
        });
      }
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

    this.appendEventTraces(traces);

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
      },
      shapes: this.buildEventShapes()
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
    const analysis = State.ensureAnalysisConfig();
    const colors = this.getColorsForTheme();
    const { paperBg, plotBg, fontColor, gridColor } = this.getPlotStyling();
    const { isMath = false, seriesName = 'Series' } = options || {};
    const selection = analysis.selectionOnly === false ? null : State.getAnalysisSelection();
    const showMagnitude = analysis.fftView !== 'phase';
    const showPhase = analysis.fftView === 'phase' || analysis.fftView === 'both';

    const baseOptions = {
      selection,
      windowType: analysis.fftWindow,
      detrend: analysis.fftDetrend,
      zeroPadMode: analysis.fftZeroPad,
      zeroPadFactor: analysis.fftZeroPadFactor
    };

    const rawSpectrum = FFT.computeSpectrum(rawY, timeX, { ...baseOptions, cacheKey: `${seriesName}|raw` });
    const filteredSpectrum = (!isMath && filteredY && filteredY.length)
      ? FFT.computeSpectrum(filteredY, timeX, { ...baseOptions, cacheKey: `${seriesName}|filtered` })
      : null;

    const traces: Data[] = [];
    const showRawSpectrum = isMath ? true : (config.showRaw !== false);

    if (showRawSpectrum && showMagnitude) {
      traces.push({
        x: rawSpectrum.freq,
        y: rawSpectrum.magnitude,
        mode: 'lines',
        name: isMath ? `${seriesName} Spectrum` : 'Raw Spectrum',
        line: { color: isMath ? colors.filtered : this.hexToRgba(colors.raw, config.rawOpacity || 0.5), width: isMath ? 2 : 1 }
      });
    }
    if (showRawSpectrum && showPhase) {
      traces.push({
        x: rawSpectrum.freq,
        y: rawSpectrum.phase,
        mode: 'lines',
        name: isMath ? `${seriesName} Phase` : 'Raw Phase',
        line: { width: 1, dash: 'dot' },
        yaxis: showMagnitude ? 'y2' : 'y'
      });
    }
    if (!isMath && filteredSpectrum && showMagnitude) {
      traces.push({
        x: filteredSpectrum.freq,
        y: filteredSpectrum.magnitude,
        mode: 'lines',
        name: 'Filtered Spectrum',
        line: { color: colors.filtered, width: 1.5 }
      });
    }

    const peaks = SpectralMetrics.computePeaks(rawSpectrum.freq, rawSpectrum.linearMagnitude, {
      maxPeaks: analysis.fftPeakCount,
      prominence: analysis.fftPeakProminence
    });
    if (showMagnitude && peaks.length) {
      traces.push({
        x: peaks.map((p) => p.freq),
        y: peaks.map((p) => 20 * Math.log10(Math.max(p.magnitude, 1e-12))),
        mode: 'markers',
        name: 'Peaks',
        marker: { size: 8, color: '#fbbf24', symbol: 'diamond' }
      });
    }
    if (showMagnitude && analysis.fftShowHarmonics) {
      const fundamental = analysis.fftHarmonicFundamental || peaks[0]?.freq || null;
      const harmonics = SpectralMetrics.computeHarmonics(rawSpectrum.freq, rawSpectrum.linearMagnitude, fundamental, analysis.fftHarmonicCount);
      if (harmonics.length) {
        traces.push({
          x: harmonics.map((h) => h.freq),
          y: harmonics.map((h) => 20 * Math.log10(Math.max(h.magnitude || 0, 1e-12))),
          mode: 'markers',
          name: 'Harmonics',
          marker: { size: 7, color: '#7dd3fc', symbol: 'x' },
          text: harmonics.map((h) => String(h.order))
        });
      }
    }

    const pipeline = State.getPipeline();
    const hasFFTFilters = pipeline.some((p) => p.enabled !== false && ['lowPassFFT', 'highPassFFT', 'notchFFT'].includes(p.type));
    if (hasFFTFilters && showMagnitude) {
      const { nBins } = buildFrequencyAxis(rawSpectrum.length || 1, rawSpectrum.meta.fs);
      const transfer = Filter.calculateTransferFunction(pipeline, rawSpectrum.meta.fs, nBins, rawSpectrum.length);
      traces.push({
        x: rawSpectrum.freq,
        y: transfer.map((g) => 20 * Math.log10(g + 1e-9)),
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
      xaxis: { title: 'Frequency (Hz)', type: 'log', autorange: true, gridcolor: gridColor },
      yaxis: {
        title: showMagnitude ? 'Magnitude (dB)' : 'Phase (deg)',
        gridcolor: gridColor,
        domain: showMagnitude && showPhase ? [0.55, 1] : [0, 1]
      },
      yaxis2: showMagnitude && showPhase
        ? { title: 'Phase (deg)', domain: [0, 0.45], anchor: 'x', gridcolor: gridColor }
        : {
          title: 'Filter Gain (dB)',
          overlaying: 'y',
          side: 'right',
          range: [-100, 5],
          showgrid: false
        }
    };

    this.reactPlot(traces, layout);
    this.setStatus(`Frequency Analysis (Fs ≈ ${Math.round(rawSpectrum.meta.fs)} Hz · Δf ≈ ${rawSpectrum.meta.deltaF.toPrecision(3)} Hz)`);
  },

  renderMultiFreqDomain(timeX: number[], seriesList: PlotSeries[]): void {
    if (!seriesList || seriesList.length === 0) return;
    const config = State.config.graph;
    const analysis = State.ensureAnalysisConfig();
    const { paperBg, plotBg, fontColor, gridColor } = this.getPlotStyling();
    const selection = analysis.selectionOnly === false ? null : State.getAnalysisSelection();
    const baseOptions = {
      selection,
      windowType: analysis.fftWindow,
      detrend: analysis.fftDetrend,
      zeroPadMode: analysis.fftZeroPad,
      zeroPadFactor: analysis.fftZeroPadFactor
    };

    const traces: Data[] = [];
    let referenceFs = estimateSampleRate(timeX);
    let referenceDf = 0;

    seriesList.forEach((series) => {
      const { rawY, filteredY, columnId, isMath } = series;
      if (!rawY || rawY.length === 0) return;
      const spectrum = FFT.computeSpectrum(rawY, timeX, { ...baseOptions, cacheKey: `${columnId}|raw` });
      referenceFs = spectrum.meta.fs;
      referenceDf = spectrum.meta.deltaF;
      if (isMath || config.showRaw !== false) {
        traces.push({
          x: spectrum.freq,
          y: spectrum.magnitude,
          mode: 'lines',
          name: `${columnId} ${isMath ? 'Math' : 'Raw'} Spectrum`,
          line: { width: isMath ? 2 : 1 }
        });
      }
      if (!isMath && filteredY && filteredY.length > 0) {
        const filteredSpec = FFT.computeSpectrum(filteredY, timeX, { ...baseOptions, cacheKey: `${columnId}|filtered` });
        traces.push({
          x: filteredSpec.freq,
          y: filteredSpec.magnitude,
          mode: 'lines',
          name: `${columnId} Filtered Spectrum`,
          line: { width: 1.5 }
        });
      }
    });

    this.reactPlot(traces, {
      title: 'Frequency Domain (FFT)',
      paper_bgcolor: paperBg,
      plot_bgcolor: plotBg,
      font: { color: fontColor },
      showlegend: true,
      xaxis: { title: 'Frequency (Hz)', type: 'log', autorange: true, gridcolor: gridColor },
      yaxis: { title: 'Magnitude (dB)', gridcolor: gridColor }
    });
    this.setStatus(`Frequency Analysis (Fs ≈ ${Math.round(referenceFs)} Hz${referenceDf ? ` · Δf ≈ ${referenceDf.toPrecision(3)} Hz` : ''})`);
  },

  renderSpectrogram(rawX: number[], rawY: number[], filteredY: number[] | null, options: RenderOptions = {}): void {
    const analysis = State.ensureAnalysisConfig();
    const selection = analysis.selectionOnly === false ? null : State.getAnalysisSelection();
    const { isMath = false, seriesName = 'Series' } = options || {};
    const { paperBg, plotBg, fontColor, gridColor } = this.getPlotStyling();
    const preferredSource = analysis.spectrogramSource || analysis.fftSource || 'auto';
    let targetY = rawY;
    if (!isMath && (preferredSource === 'filtered' || preferredSource === 'auto') && filteredY?.length) {
      targetY = filteredY;
    }

    const spectrogram = TimeFrequency.computeSpectrogram(targetY || [], rawX || [], {
      selection,
      windowSize: analysis.spectrogramSize,
      overlap: analysis.spectrogramOverlap,
      windowType: analysis.spectrogramWindow || analysis.fftWindow,
      detrend: analysis.fftDetrend,
      maxPoints: analysis.spectrogramMaxPoints,
      freqMin: analysis.spectrogramFreqMin,
      freqMax: analysis.spectrogramFreqMax
    });

    this.reactPlot([{
      x: spectrogram.timeBins,
      y: spectrogram.freqBins,
      z: spectrogram.magnitudeDb,
      type: 'heatmap',
      colorscale: this.getActiveTheme() === 'light' ? 'Portland' : 'Turbo',
      colorbar: { title: { text: 'Magnitude (dB)' } },
      hovertemplate: 't=%{x:.6f}s<br>f=%{y:.3f}Hz<br>%{z:.2f} dB<extra></extra>'
    }], {
      title: `Spectrogram${seriesName ? ` — ${seriesName}` : ''}`,
      paper_bgcolor: paperBg,
      plot_bgcolor: plotBg,
      font: { color: fontColor },
      xaxis: { title: 'Time (s)', gridcolor: gridColor },
      yaxis: { title: 'Frequency (Hz)', gridcolor: gridColor },
      margin: { t: 60, r: 80, b: 60, l: 60 }
    });

    const parts = [];
    if (spectrogram.meta.nFrames) parts.push(`${spectrogram.meta.nFrames} frame(s)`);
    if (spectrogram.meta.freqResolution) parts.push(`Δf ≈ ${spectrogram.meta.freqResolution.toPrecision(3)} Hz`);
    const warnText = spectrogram.warnings.length ? ` · ${spectrogram.warnings.join(' ')}` : '';
    this.setStatus(`Spectrogram${parts.length ? ` (${parts.join(' · ')})` : ''}${warnText}`);
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

    const amplitudeSource = !isMath && displayF.length ? displayF : displayY;
    this.appendEventTraces(traces, amplitudeSource);

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
      },
      shapes: this.buildEventShapes()
    };

    this.reactPlot(traces, layout);

    let statusText = `Displaying ${displayX.length} points`;
    if (isDownsampled) statusText += ` (LTTB Downsampled)`;
    else statusText += ` (Full Resolution)`;
    this.setStatus(statusText);
  },

  handleZoom(event: Record<string, unknown> | null | undefined): void {
    if (this.isIgnoringRelayout()) return;
    if (this.getViewMode() !== 'time') return;
    if (!event) return;

    const hasX = event['xaxis.range[0]'] !== undefined || event['xaxis.range'] !== undefined || event['xaxis.autorange'] === true;
    const hasY = event['yaxis.range[0]'] !== undefined || event['yaxis.range'] !== undefined || event['yaxis.autorange'] === true;
    if (!hasX && !hasY) return;

    const ranges: ViewRange = { ...this.lastRanges };

    if (event['xaxis.range'] !== undefined || event['xaxis.range[0]'] !== undefined) {
      let min: number;
      let max: number;
      if (event['xaxis.range'] !== undefined) {
        [min, max] = asRangePair(event['xaxis.range']);
      } else {
        min = event['xaxis.range[0]'] as number;
        max = event['xaxis.range[1]'] as number;
      }
      ranges.x = [min, max];
    }

    if (event['yaxis.range'] !== undefined || event['yaxis.range[0]'] !== undefined) {
      let minY: number;
      let maxY: number;
      if (event['yaxis.range'] !== undefined) {
        [minY, maxY] = asRangePair(event['yaxis.range']);
      } else {
        minY = event['yaxis.range[0]'] as number;
        maxY = event['yaxis.range[1]'] as number;
      }
      ranges.y = [minY, maxY];
    }

    if (event['xaxis.autorange'] === true || event['yaxis.autorange'] === true) {
      if (event['xaxis.autorange'] === true) AnalysisEngine.clearSelection();
      this.triggerRefresh(null);
      return;
    }

    if (ranges.x) {
      const xCol = State.data.timeColumn;
      const timeArray = xCol ? State.data.raw.map((r) => parseFloat(String(r[xCol]))) : [];
      AnalysisEngine.updateSelectionFromRange(ranges.x, timeArray);
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
