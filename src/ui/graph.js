import { State } from '../state.js';
import { Config } from '../config.js';
import { lttb } from '../processing/lttb.js';
import { FFT } from '../processing/fft.js';
import { Filter } from '../processing/filter.js';
import { MathEngine } from '../processing/math.js';
import { applyComposerOffsets, getComposerTrace } from '../processing/composer.js';
import { AnalysisEngine } from '../analysis/analysisEngine.js';
import { SpectralMetrics } from '../analysis/spectralMetrics.js';
import { TimeFrequency } from '../analysis/timeFrequency.js';
import { SystemPanel } from './systemPanel.js';
import { WorkerManager } from '../analysis/workerManager.js';

const PLOT_ID = 'main-plot';
const STATUS_ID = 'graph-status';

/**
 * Graph Visualization Module
 */
export const Graph = {

    lastRanges: { x: null, y: null },
    currentEvents: [],
    eventOverlay: { show: true, activeIndex: null, amplitudes: null },
    pendingSpectrogram: null,
    pendingSpectrogramJobId: null,
    pendingFreqJobs: [],

    getPlotStyling() {
        const styles = getComputedStyle(document.documentElement);
        const paperBg = styles.getPropertyValue('--plot-bg').trim() || '#1e1e1e';
        const plotBg = styles.getPropertyValue('--plot-bg').trim() || '#1e1e1e';
        const fontColor = styles.getPropertyValue('--text-main').trim() || '#e0e0e0';
        const gridColor = styles.getPropertyValue('--plot-grid').trim() || '#333';
        return { paperBg, plotBg, fontColor, gridColor };
    },

    getViewMode() {
        const cfg = State.config.graph || {};
        if (cfg.viewMode) return cfg.viewMode;
        return cfg.showFreqDomain ? 'fft' : 'time';
    },

    getActiveTheme() {
        const theme = document.documentElement.getAttribute('data-theme');
        if (theme === 'light' || theme === 'dark') return theme;
        return 'dark';
    },

    getColorsForTheme(theme = this.getActiveTheme()) {
        const configColors = State.config.colors || Config.colors;
        const defaults = (Config.colors[theme]) || Config.colors.dark || {};

        if (configColors[theme]) {
            return { ...defaults, ...configColors[theme] };
        }

        if (configColors.raw || configColors.filtered) {
            return {
                ...defaults,
                raw: configColors.raw || defaults.raw,
                filtered: configColors.filtered || defaults.filtered,
                diffRaw: configColors.diffRaw || configColors.raw || defaults.diffRaw,
                diffFilt: configColors.diffFilt || configColors.filtered || defaults.diffFilt,
                transfer: configColors.transfer || defaults.transfer
            };
        }

        return defaults;
    },

    init() {
        const { paperBg, plotBg, fontColor, gridColor } = this.getPlotStyling();
        const config = {
            responsive: true,
            displayModeBar: true,
            modeBarButtonsToRemove: ['lasso2d', 'select2d'],
            toImageButtonOptions: {
                format: 'svg',
                filename: 'graph_export',
                height: 600,
                width: 1000,
                scale: 1
            }
        };

        const layout = {
            paper_bgcolor: paperBg,
            plot_bgcolor: plotBg,
            font: { color: fontColor },
            xaxis: { title: Config.graph.xAxisTitle, gridcolor: gridColor },
            yaxis: { title: Config.graph.yAxisTitle, gridcolor: gridColor }
        };

        Plotly.newPlot(PLOT_ID, [], layout, config);
        
        const plotElement = document.getElementById(PLOT_ID);
        plotElement.on('plotly_relayout', this.handleZoom.bind(this));

        window.addEventListener('resize', () => {
            const el = document.getElementById(PLOT_ID);
            if (el && window.Plotly && Plotly.Plots && typeof Plotly.Plots.resize === 'function') {
                Plotly.Plots.resize(el);
            }
        });
    },

    updateTheme() {
        const plotElement = document.getElementById(PLOT_ID);
        if (!plotElement || !plotElement.data) return;

        const xRange = (plotElement.layout && plotElement.layout.xaxis && plotElement.layout.xaxis.range)
            ? [...plotElement.layout.xaxis.range]
            : null;
        const yRange = (plotElement.layout && plotElement.layout.yaxis && plotElement.layout.yaxis.range)
            ? [...plotElement.layout.yaxis.range]
            : null;

        const { paperBg, plotBg, fontColor, gridColor } = this.getPlotStyling();
        Plotly.relayout(PLOT_ID, {
            paper_bgcolor: paperBg,
            plot_bgcolor: plotBg,
            'font.color': fontColor,
            'xaxis.gridcolor': gridColor,
            'yaxis.gridcolor': gridColor,
            'yaxis2.gridcolor': gridColor,
            'yaxis3.gridcolor': gridColor,
            ...(xRange ? { 'xaxis.range': xRange } : {}),
            ...(yRange ? { 'yaxis.range': yRange } : {})
        });

        if (State.data.raw.length && State.data.timeColumn && (State.data.dataColumn || State.ui.activeMultiViewId)) {
            const rangePayload = {};
            if (xRange) rangePayload.x = xRange;
            if (yRange) rangePayload.y = yRange;
            const hasRange = !!(xRange || yRange);
            this.triggerRefresh(hasRange ? rangePayload : null);
        }
    },

    calculateDerivative(x, y) {
        if (!x || !y || x.length < 2) return [];
        const dY = [];
        for (let i = 0; i < x.length - 1; i++) {
            const diffX = x[i + 1] - x[i];
            const diffY = y[i + 1] - y[i];
            const slope = (diffX !== 0) ? diffY / diffX : 0;
            dY.push(slope);
        }
        dY.push(dY[dY.length - 1]);
        return dY;
    },

    hexToRgba(hex, alpha) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    },

    setEventOverlay(events = [], options = {}) {
        this.currentEvents = Array.isArray(events) ? events : [];
        this.eventOverlay = {
            show: options.show !== false,
            activeIndex: Number.isInteger(options.activeIndex) ? options.activeIndex : null,
            amplitudes: options.amplitudes || null
        };
    },

    getEventAmplitude(event, fallbackY = []) {
        if (!event) return 0;
        if (this.eventOverlay?.amplitudes && Number.isFinite(this.eventOverlay.amplitudes[event.index])) {
            return this.eventOverlay.amplitudes[event.index];
        }
        if (event.metadata && Number.isFinite(event.metadata.amplitude)) return event.metadata.amplitude;
        if (Number.isInteger(event.index) && Number.isFinite(fallbackY[event.index])) return fallbackY[event.index];
        return 0;
    },

    zoomToEvent(time) {
        if (!Number.isFinite(time)) return;
        const plotElement = document.getElementById(PLOT_ID);
        if (!plotElement || !plotElement.layout || !plotElement.data) return;
        const currentRange = plotElement.layout.xaxis?.range;
        const rawX = State.data.raw.map((r) => parseFloat(r[State.data.timeColumn]));
        const span = currentRange && currentRange.length === 2
            ? (currentRange[1] - currentRange[0])
            : Math.max(1e-9, (rawX[rawX.length - 1] || 0) - (rawX[0] || 0)) / 10;
        const half = span / 2;
        const nextRange = [time - half, time + half];
        this.lastRanges = { x: nextRange, y: this.lastRanges.y };
        Plotly.relayout(PLOT_ID, { 'xaxis.range': nextRange });
    },

    getAxisFormat(format, axisType = 'linear', currencySymbol = '£', significantFigures = 3) {
        const sig = Math.max(1, Number.parseInt(significantFigures, 10) || 3);
        const sciPrecision = Math.max(0, sig - 1);

        const presets = {
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
            const { type, ...rest } = selected;
            return rest;
        }

        return selected;
    },

    render(rawX, rawY, filteredY = null, range = null, options = {}) {
        if (!rawX || rawX.length === 0) return;

        const isMath = options.isMath || !!State.getMathDefinition(State.data.dataColumn);
        const seriesName = options.seriesName || State.data.dataColumn || 'Series';

        const composerTrace = getComposerTrace(State.ui.activeMultiViewId || null, State.data.dataColumn);
        const { adjustedRawY, adjustedFilteredY } = applyComposerOffsets(rawY, filteredY, composerTrace);

        const config = State.config.graph;
        const mode = this.getViewMode();

        if (mode === 'bode') {
            this.renderSystemBode();
            return;
        }

        // --- Mode Switching ---
        if (mode === 'fft') {
            this.renderFreqDomain(rawX, adjustedRawY, isMath ? null : adjustedFilteredY, { isMath, seriesName });
        } else if (mode === 'spectrogram') {
            this.renderSpectrogram(rawX, adjustedRawY, isMath ? null : adjustedFilteredY, { isMath, seriesName });
        } else {
            this.renderTimeDomain(rawX, adjustedRawY, isMath ? null : adjustedFilteredY, range, { isMath, seriesName });
        }
    },

    renderMultiView(rawX, seriesList, ranges = null, viewId = null) {
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
        } else if (mode === 'bode') {
            this.renderSystemBode();
        } else {
            this.renderMultiTimeDomain(rawX, seriesList, ranges, viewId);
        }
    },

    renderSystemBode() {
        const result = SystemPanel.getResult();
        const { paperBg, plotBg, fontColor, gridColor } = this.getPlotStyling();
        const colors = this.getColorsForTheme();
        const plotElement = document.getElementById(PLOT_ID);
        const statusEl = document.getElementById(STATUS_ID);

        if (!result || !result.frf || !result.frf.freq.length) {
            if (plotElement) Plotly.react(PLOT_ID, [], { paper_bgcolor: paperBg, plot_bgcolor: plotBg });
            if (statusEl) statusEl.textContent = 'Select input/output for Bode view';
            return;
        }

        const { freq, magnitudeDb, phaseDeg, coherence } = result.frf;
        const traces = [
            { x: freq, y: magnitudeDb, mode: 'lines', name: '|H(f)|', line: { color: colors.filtered }, xaxis: 'x', yaxis: 'y' },
            { x: freq, y: phaseDeg, mode: 'lines', name: 'Phase', line: { color: colors.transfer || '#00bcd4', dash: 'dot' }, xaxis: 'x2', yaxis: 'y2' },
            { x: freq, y: coherence, mode: 'lines', name: 'Coherence', line: { color: '#9ccc65' }, xaxis: 'x2', yaxis: 'y3' }
        ];

        const layout = {
            paper_bgcolor: paperBg,
            plot_bgcolor: plotBg,
            font: { color: fontColor },
            grid: { rows: 2, columns: 1, pattern: 'independent', roworder: 'top to bottom' },
            xaxis: { title: 'Frequency (Hz)', type: 'log', gridcolor: gridColor },
            yaxis: { title: 'Magnitude (dB)', gridcolor: gridColor },
            xaxis2: { title: 'Frequency (Hz)', type: 'log', gridcolor: gridColor, anchor: 'y2' },
            yaxis2: { title: 'Phase (deg)', gridcolor: gridColor, domain: [0, 0.4] },
            yaxis3: { title: 'Coherence', gridcolor: gridColor, overlaying: 'y2', side: 'right', range: [0, 1] },
            height: 600,
            legend: { orientation: 'h' }
        };

        Plotly.react(PLOT_ID, traces, layout);

        if (statusEl) {
            const delayText = Number.isFinite(result.delaySeconds) ? `${result.delaySeconds.toExponential(3)} s` : 'n/a';
            const corrText = Number.isFinite(result.correlationPeak) ? result.correlationPeak.toFixed(3) : 'n/a';
            const confText = Number.isFinite(result.confidence) ? ` · conf ${result.confidence.toFixed(2)}` : '';
            statusEl.textContent = `Bode: ${result.input} → ${result.output} · delay ${delayText} · corr ${corrText}${confText}`;
        }
    },

    renderMultiTimeDomain(rawX, seriesList, ranges, viewId = null) {
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
            this.lastRanges = { x: xRange ? [...xRange] : null, y: yRange ? [...yRange] : null };
        }

        const traces = [];
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
                const zippedRaw = originalX.map((x, i) => [x, seriesY[i]]);
                const sampledRaw = lttb(zippedRaw, config.maxDisplayPoints);
                seriesX = sampledRaw.map(p => p[0]);
                seriesY = sampledRaw.map(p => p[1]);

                if (!isMathSeries && seriesF.length > 0) {
                    const zippedF = originalX.map((x, i) => [x, seriesF[i]]);
                    const sampledF = lttb(zippedF, config.maxDisplayPoints);
                    seriesF = sampledF.map(p => p[1]);
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

        const layout = {
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
                ...xAxisFormat
            },
            yaxis: {
                title: config.yAxisTitle,
                type: yAxisBaseType,
                showgrid: config.showGrid,
                gridcolor: gridColor,
                domain: showDiff ? [0.55, 1] : [0, 1],
                ...(yRange ? { range: yRange } : { autorange: true }),
                ...yAxisFormat
            },
            yaxis2: {
                title: "Derivative (dy/dx)",
                domain: [0, 0.45],
                anchor: 'x',
                showgrid: config.showGrid,
                gridcolor: gridColor,
                ...secondaryYAxisFormat
            }
        };

        Plotly.react(PLOT_ID, traces, layout);

        const statusEl = document.getElementById(STATUS_ID);
        if (statusEl) {
            const seriesCount = seriesList.filter((s) => s && s.rawY && s.rawY.length).length;
            let statusText = seriesCount > 0
                ? `Multi-View: ${seriesCount} trace(s) visible`
                : 'No traces selected';
            if (isDownsampled) statusText += ' (Downsampled)';
            statusEl.textContent = statusText;
        }
    },

    // --- Frequency Domain Renderer ---
    renderFreqDomain(timeX, rawY, filteredY, options = {}) {
        const config = State.config.graph;
        const colors = this.getColorsForTheme();
        const { paperBg, plotBg, fontColor, gridColor } = this.getPlotStyling();
        const { isMath = false, seriesName = 'Series' } = options || {};
        const analysis = State.ensureAnalysisConfig();
        const selection = analysis.selectionOnly === false ? null : State.getAnalysisSelection();

        const baseOptions = {
            selection,
            windowType: analysis.fftWindow,
            detrend: analysis.fftDetrend,
            zeroPadMode: analysis.fftZeroPad,
            zeroPadFactor: analysis.fftZeroPadFactor
        };

        const cacheKeyBase = [
            seriesName || 'Series',
            isMath ? 'math' : 'raw',
            selection ? `${selection.i0}-${selection.i1}` : 'full',
            analysis.fftWindow,
            analysis.fftDetrend,
            analysis.fftZeroPad,
            analysis.fftZeroPadFactor
        ].join('|');

        const buildAndRender = (rawSpectrum, filteredSpectrum) => {
            if (!rawSpectrum) return;
            const freqAxis = rawSpectrum.freq;
            const traces = [];
            const showMagnitude = analysis.fftView !== 'phase';
            const showPhase = analysis.fftView === 'phase' || analysis.fftView === 'both';
            const primarySpec = filteredSpectrum || rawSpectrum;

            const showRawSpectrum = isMath ? true : (config.showRaw !== false);

            if (showMagnitude && showRawSpectrum) {
                traces.push({
                    x: freqAxis,
                    y: rawSpectrum.magnitude,
                    mode: 'lines',
                    name: isMath ? `${seriesName} Spectrum` : 'Raw Spectrum',
                    line: { color: isMath ? colors.filtered : this.hexToRgba(colors.raw, config.rawOpacity || 0.5), width: isMath ? 2 : 1 },
                    xaxis: 'x',
                    yaxis: 'y'
                });
            }

            if (!isMath && filteredSpectrum && showMagnitude) {
                traces.push({
                    x: freqAxis,
                    y: filteredSpectrum.magnitude,
                    mode: 'lines',
                    name: 'Filtered Spectrum',
                    line: { color: colors.filtered, width: 1.5 },
                    xaxis: 'x',
                    yaxis: 'y'
                });
            }

            if (showPhase) {
                traces.push({
                    x: freqAxis,
                    y: primarySpec.phase,
                    mode: 'lines',
                    name: 'Phase',
                    line: { color: colors.transfer || '#00bcd4', width: 1.2, dash: 'dot' },
                    xaxis: showMagnitude ? 'x2' : 'x',
                    yaxis: showMagnitude ? 'y2' : 'y'
                });
            }

            const pipeline = State.getPipeline();
            const hasFFTFilters = pipeline.some((p) => p.enabled && ['lowPassFFT', 'highPassFFT', 'notchFFT'].includes(p.type));
            if (hasFFTFilters && showMagnitude) {
                const transfer = Filter.calculateTransferFunction(pipeline, rawSpectrum.meta.fs, freqAxis.length * 2);
                const transferDB = transfer.map((g) => 20 * Math.log10(g + 1e-9));
                traces.push({
                    x: freqAxis,
                    y: transferDB.slice(0, freqAxis.length),
                    mode: 'lines',
                    name: 'Filter Transfer H(f)',
                    line: { color: colors.transfer || '#00bcd4', width: 1.8, dash: 'dash' },
                    xaxis: 'x',
                    yaxis: 'y'
                });
            }

            const peakList = SpectralMetrics.computePeaks(primarySpec.freq, primarySpec.linearMagnitude, {
                maxPeaks: analysis.fftPeakCount,
                prominence: analysis.fftPeakProminence
            });
            if (showMagnitude && peakList.length) {
                traces.push({
                    x: peakList.map((p) => p.freq),
                    y: peakList.map((p) => 20 * Math.log10(Math.max(p.magnitude, 1e-12))),
                    mode: 'markers',
                    name: 'Peaks',
                    marker: { size: 8, color: '#ff6f61', symbol: 'circle' },
                    xaxis: 'x',
                    yaxis: 'y',
                    hovertemplate: 'f=%{x:.3f} Hz<extra></extra>'
                });
            }

            if (analysis.fftShowHarmonics !== false && showMagnitude) {
                const fundamental = analysis.fftHarmonicFundamental || peakList[0]?.freq || null;
                const harmonics = SpectralMetrics.computeHarmonics(primarySpec.freq, primarySpec.linearMagnitude, fundamental, analysis.fftHarmonicCount);
                if (harmonics.length) {
                    traces.push({
                        x: harmonics.map((h) => h.freq),
                        y: harmonics.map((h) => 20 * Math.log10(Math.max(h.magnitude || 0, 1e-12))),
                        mode: 'markers',
                        name: 'Harmonics',
                        marker: { size: 7, color: '#7dd3fc', symbol: 'x' },
                        xaxis: 'x',
                        yaxis: 'y',
                        hovertemplate: 'h%{text}: %{x:.3f} Hz<extra></extra>',
                        text: harmonics.map((h) => h.order)
                    });
                }
            }

            const layout = {
                title: 'Frequency Domain (FFT)',
                paper_bgcolor: paperBg,
                plot_bgcolor: plotBg,
                font: { color: fontColor },
                showlegend: true,
                grid: showMagnitude && showPhase ? { rows: 2, columns: 1, pattern: 'independent', roworder: 'top to bottom' } : undefined,
                xaxis: {
                    title: 'Frequency (Hz)',
                    type: 'log',
                    autorange: true,
                    gridcolor: gridColor,
                    domain: showMagnitude && showPhase ? [0, 1] : undefined
                },
                yaxis: {
                    title: showMagnitude ? 'Magnitude (dB)' : 'Phase (deg)',
                    gridcolor: gridColor,
                    domain: showMagnitude && showPhase ? [0.55, 1] : [0, 1]
                },
                shapes: []
            };

            if (showMagnitude && showPhase) {
                layout.xaxis2 = {
                    title: 'Frequency (Hz)',
                    type: 'log',
                    anchor: 'y2',
                    gridcolor: gridColor,
                    match: 'x'
                };
                layout.yaxis2 = {
                    title: 'Phase (deg)',
                    anchor: 'x2',
                    gridcolor: gridColor,
                    domain: [0, 0.45]
                };
            }

            Plotly.react(PLOT_ID, traces, layout);

            const statusEl = document.getElementById(STATUS_ID);
            if (statusEl) {
                statusEl.textContent = `Frequency Analysis (Fs ≈ ${Math.round(primarySpec.meta.fs)} Hz · Δf ≈ ${primarySpec.meta.deltaF.toPrecision(3)} Hz)`;
            }
        };

        if (WorkerManager.shouldOffload(rawY.length)) {
            const statusEl = document.getElementById(STATUS_ID);
            if (statusEl) statusEl.textContent = 'Computing FFT…';
            this.pendingFreqJobs.forEach((jobId) => WorkerManager.cancel(jobId));
            this.pendingFreqJobs = [];
            const jobs = [
                WorkerManager.run('fft', { signal: rawY, time: timeX, options: { ...baseOptions, cacheKey: `${cacheKeyBase}|raw`, useWorker: false } })
            ];
            if (!isMath && filteredY && filteredY.length) {
                jobs.push(WorkerManager.run('fft', { signal: filteredY, time: timeX, options: { ...baseOptions, cacheKey: `${cacheKeyBase}|filtered`, useWorker: false } }));
            }
            this.pendingFreqJobs = jobs.map((job) => job.jobId).filter(Boolean);
            Promise.all(jobs)
                .then(([rawSpec, filteredSpec]) => buildAndRender(rawSpec, filteredSpec))
                .catch((err) => {
                    if (statusEl) statusEl.textContent = 'FFT worker failed';
                    console.error(err);
                })
                .finally(() => {
                    this.pendingFreqJobs.forEach((jobId) => WorkerManager.cancel(jobId));
                    this.pendingFreqJobs = [];
                });
            return;
        }

        const rawSpectrum = FFT.computeSpectrum(rawY, timeX, { ...baseOptions, cacheKey: `${cacheKeyBase}|raw` });
        const filteredSpectrum = (!isMath && filteredY && filteredY.length)
            ? FFT.computeSpectrum(filteredY, timeX, { ...baseOptions, cacheKey: `${cacheKeyBase}|filtered` })
            : null;

        buildAndRender(rawSpectrum, filteredSpectrum);
    },

    renderMultiFreqDomain(timeX, seriesList) {
        if (!seriesList || seriesList.length === 0) return;
        const config = State.config.graph;
        const analysis = State.ensureAnalysisConfig();
        const selection = analysis.selectionOnly === false ? null : State.getAnalysisSelection();
        const { paperBg, plotBg, fontColor, gridColor } = this.getPlotStyling();

        const baseOptions = {
            selection,
            windowType: analysis.fftWindow,
            detrend: analysis.fftDetrend,
            zeroPadMode: analysis.fftZeroPad,
            zeroPadFactor: analysis.fftZeroPadFactor
        };

        const traces = [];
        let referenceSpec = null;

        seriesList.forEach((series) => {
            const { rawY, filteredY, columnId, isMath } = series;
            if (!rawY || !rawY.length) return;

            const cacheKeyBase = [
                columnId || 'Series',
                isMath ? 'math' : 'raw',
                selection ? `${selection.i0}-${selection.i1}` : 'full',
                analysis.fftWindow,
                analysis.fftDetrend,
                analysis.fftZeroPad,
                analysis.fftZeroPadFactor
            ].join('|');

            const spectrum = FFT.computeSpectrum(rawY, timeX, { ...baseOptions, cacheKey: `${cacheKeyBase}|raw` });
            if (!referenceSpec) referenceSpec = spectrum;

            if (isMath || config.showRaw !== false) {
                traces.push({
                    x: spectrum.freq,
                    y: spectrum.magnitude,
                    mode: 'lines',
                    name: `${columnId} ${isMath ? 'Math' : 'Raw'} Spectrum`,
                    line: { width: isMath ? 2 : 1 }
                });
            }

            if (!isMath && filteredY && filteredY.length) {
                const filteredSpec = FFT.computeSpectrum(filteredY, timeX, { ...baseOptions, cacheKey: `${cacheKeyBase}|filtered` });
                traces.push({
                    x: filteredSpec.freq,
                    y: filteredSpec.magnitude,
                    mode: 'lines',
                    name: `${columnId} Filtered Spectrum`,
                    line: { width: 1.5 }
                });
            }
        });

        const layout = {
            title: 'Frequency Domain (FFT)',
            paper_bgcolor: paperBg,
            plot_bgcolor: plotBg,
            font: { color: fontColor },
            showlegend: true,
            xaxis: { title: 'Frequency (Hz)', type: 'log', autorange: true, gridcolor: gridColor },
            yaxis: { title: 'Magnitude (dB)', gridcolor: gridColor }
        };

        Plotly.react(PLOT_ID, traces, layout);

        const statusEl = document.getElementById(STATUS_ID);
        if (statusEl && referenceSpec) statusEl.textContent = `Frequency Analysis (Fs ≈ ${Math.round(referenceSpec.meta.fs)} Hz · Δf ≈ ${referenceSpec.meta.deltaF.toPrecision(3)} Hz)`;
    },

    // --- Time-Frequency Renderer (Spectrogram) ---
    renderSpectrogram(rawX, rawY, filteredY, options = {}) {
        const analysis = State.ensureAnalysisConfig();
        const selection = analysis.selectionOnly === false ? null : State.getAnalysisSelection();
        const { isMath = false, seriesName = 'Series' } = options || {};
        const { paperBg, plotBg, fontColor, gridColor } = this.getPlotStyling();

        let targetY = rawY;
        const preferredSource = analysis.spectrogramSource || analysis.fftSource || 'auto';
        if (!isMath && preferredSource === 'filtered' && filteredY && filteredY.length) {
            targetY = filteredY;
        } else if (!isMath && preferredSource === 'auto' && filteredY && filteredY.length) {
            targetY = filteredY;
        }

        const renderResult = (spectrogram) => {
            const colorscale = this.getActiveTheme() === 'light' ? 'Portland' : 'Turbo';

            const traces = [{
                x: spectrogram.timeBins,
                y: spectrogram.freqBins,
                z: spectrogram.magnitudeDb,
                type: 'heatmap',
                colorscale,
                colorbar: { title: 'Magnitude (dB)' },
                hovertemplate: 't=%{x:.6f}s<br>f=%{y:.3f}Hz<br>%{z:.2f} dB<extra></extra>'
            }];

            const layout = {
                title: `Spectrogram${seriesName ? ` — ${seriesName}` : ''}`,
                paper_bgcolor: paperBg,
                plot_bgcolor: plotBg,
                font: { color: fontColor },
                xaxis: { title: 'Time (s)', gridcolor: gridColor },
                yaxis: { title: 'Frequency (Hz)', gridcolor: gridColor },
                margin: { t: 60, r: 80, b: 60, l: 60 }
            };

            Plotly.react(PLOT_ID, traces, layout);

            const statusEl = document.getElementById(STATUS_ID);
            if (statusEl) {
                const parts = [];
                const frames = spectrogram.meta?.nFrames || 0;
                if (frames) parts.push(`${frames} frame(s)`);
                if (spectrogram.meta?.freqResolution) {
                    parts.push(`Δf ≈ ${spectrogram.meta.freqResolution.toPrecision(3)} Hz`);
                }
                if (spectrogram.meta?.hop && spectrogram.meta?.fs) {
                    const hopSeconds = spectrogram.meta.hop / spectrogram.meta.fs;
                    parts.push(`hop ≈ ${hopSeconds.toExponential(2)} s`);
                }
                const warnText = spectrogram.warnings && spectrogram.warnings.length
                    ? ` · ${spectrogram.warnings.join(' ')}`
                    : '';
                statusEl.textContent = `Spectrogram${parts.length ? ` (${parts.join(' · ')})` : ''}${warnText}`;
            }
        };

        const shouldOffload = WorkerManager.shouldOffload((targetY || []).length);
        const optionsPayload = {
            selection,
            windowSize: analysis.spectrogramSize,
            overlap: analysis.spectrogramOverlap,
            windowType: analysis.spectrogramWindow || analysis.fftWindow,
            detrend: analysis.fftDetrend,
            maxPoints: analysis.spectrogramMaxPoints,
            freqMin: analysis.spectrogramFreqMin,
            freqMax: analysis.spectrogramFreqMax
        };

        if (shouldOffload) {
            const token = `${Date.now()}`;
            this.pendingSpectrogram = token;
            if (this.pendingSpectrogramJobId) {
                WorkerManager.cancel(this.pendingSpectrogramJobId);
                this.pendingSpectrogramJobId = null;
            }
            const statusEl = document.getElementById(STATUS_ID);
            if (statusEl) statusEl.textContent = 'Computing spectrogram…';
            const job = WorkerManager.run('stft', { signal: targetY || [], time: rawX || [], options: { ...optionsPayload, useWorker: false } });
            this.pendingSpectrogramJobId = job.jobId;
            job.then((spec) => {
                    if (this.pendingSpectrogram !== token) return;
                    renderResult(spec);
                })
                .catch((err) => {
                    if (statusEl) statusEl.textContent = 'Spectrogram worker failed';
                    console.error(err);
                })
                .finally(() => {
                    if (this.pendingSpectrogramJobId) {
                        WorkerManager.cancel(this.pendingSpectrogramJobId);
                        this.pendingSpectrogramJobId = null;
                    }
                });
            return;
        }

        const spectrogram = TimeFrequency.computeSpectrogram(targetY || [], rawX || [], optionsPayload);
        renderResult(spectrogram);
    },

    // --- Time Domain Renderer (Existing Logic) ---
    renderTimeDomain(rawX, rawY, filteredY, range, options = {}) {
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
            this.lastRanges = { x: xRange ? [...xRange] : null, y: yRange ? [...yRange] : null };
        }

        // Slicing
        let sliceStart = 0;
        let sliceEnd = rawX.length;
        if (xRange) {
            const startIndex = rawX.findIndex(val => val >= xRange[0]);
            let endIndex = rawX.findIndex(val => val > xRange[1]);

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
            const zippedRaw = originalX.map((x, i) => [x, displayY[i]]);
            const sampledRaw = lttb(zippedRaw, config.maxDisplayPoints);
            displayX = sampledRaw.map(p => p[0]);
            displayY = sampledRaw.map(p => p[1]);

            if (!isMath && filteredY && displayF.length > 0) {
                const zippedF = originalX.map((x, i) => [x, displayF[i]]);
                const sampledF = lttb(zippedF, config.maxDisplayPoints);
                displayF = sampledF.map(p => p[1]);
            }
        }

        const traces = [];
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

        const overlay = this.eventOverlay || {};
        const eventShapes = [];
        if (overlay.show && this.currentEvents.length) {
            const amplitudeSource = displayF && displayF.length ? displayF : displayY;
            const markerTimes = this.currentEvents.map((evt) => evt.time);
            const markerAmps = this.currentEvents.map((evt) => this.getEventAmplitude(evt, amplitudeSource));
            const markerColors = this.currentEvents.map((_, idx) => (idx === overlay.activeIndex ? '#ff6f61' : '#7dd3fc'));
            traces.push({
                x: markerTimes,
                y: markerAmps,
                mode: 'markers',
                name: 'Events',
                marker: { size: 10, symbol: 'x', color: markerColors },
                hovertemplate: 't=%{x}<extra>Event</extra>',
                yaxis: 'y'
            });

            const activeEvent = Number.isInteger(overlay.activeIndex) ? this.currentEvents[overlay.activeIndex] : null;
            if (activeEvent && Number.isFinite(activeEvent.time)) {
                eventShapes.push({
                    type: 'line',
                    x0: activeEvent.time,
                    x1: activeEvent.time,
                    y0: 0,
                    y1: 1,
                    xref: 'x',
                    yref: 'paper',
                    line: { color: '#ff6f61', width: 1, dash: 'dot' }
                });
            }
        }

        const xAxisFormat = this.getAxisFormat(config.xAxisFormat, 'linear', config.currencySymbol, config.significantFigures);
        const yAxisBaseType = config.logScaleY ? 'log' : 'linear';
        const yAxisFormat = this.getAxisFormat(config.yAxisFormat, yAxisBaseType, config.currencySymbol, config.significantFigures);
        const secondaryYAxisFormat = this.getAxisFormat(config.yAxisFormat, 'linear', config.currencySymbol, config.significantFigures);

        const layout = {
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
                ...xAxisFormat
            },
            yaxis: {
                title: config.yAxisTitle,
                type: yAxisBaseType,
                showgrid: config.showGrid,
                gridcolor: gridColor,
                domain: showDiff ? [0.55, 1] : [0, 1],
                ...(yRange ? { range: yRange } : { autorange: true }),
                ...yAxisFormat
            },
            yaxis2: {
                title: "Derivative (dy/dx)",
                domain: [0, 0.45],
                anchor: 'x',
                showgrid: config.showGrid,
                gridcolor: gridColor,
                ...secondaryYAxisFormat
            },
            shapes: eventShapes
        };

        Plotly.react(PLOT_ID, traces, layout);

        const statusEl = document.getElementById(STATUS_ID);
        if (statusEl) {
            let statusText = `Displaying ${displayX.length} points`;
            if (isDownsampled) statusText += ` (LTTB Downsampled)`;
            else statusText += ` (Full Resolution)`;
            statusEl.textContent = statusText;
        }
    },

    handleZoom(event) {
        if (this.getViewMode() !== 'time') return; // Custom zoom only for time domain

        const ranges = { ...this.lastRanges };
        let xRangeUpdated = false;

        if (event['xaxis.range[0]'] || event['xaxis.range']) {
            let min, max;
            if (event['xaxis.range']) {
                [min, max] = event['xaxis.range'];
            } else {
                min = event['xaxis.range[0]'];
                max = event['xaxis.range[1]'];
            }
            ranges.x = [min, max];
            xRangeUpdated = true;
        }

        if (event['yaxis.range[0]'] || event['yaxis.range']) {
            let minY, maxY;
            if (event['yaxis.range']) {
                [minY, maxY] = event['yaxis.range'];
            } else {
                minY = event['yaxis.range[0]'];
                maxY = event['yaxis.range[1]'];
            }
            ranges.y = [minY, maxY];
        }

        if (event['xaxis.autorange'] === true || event['yaxis.autorange'] === true) {
            if (event['xaxis.autorange'] === true) {
                AnalysisEngine.clearSelection();
            }
            this.triggerRefresh(null);
            return;
        }

        if (xRangeUpdated && ranges.x) {
            const xCol = State.data.timeColumn;
            const timeArray = xCol ? State.data.raw.map((r) => parseFloat(r[xCol])) : [];
            AnalysisEngine.updateSelectionFromRange(ranges.x, timeArray);
        }

        this.triggerRefresh(ranges);
    },

    triggerRefresh(range) {
        if (range === null) {
            this.lastRanges = { x: null, y: null };
        } else if (Array.isArray(range)) {
            this.lastRanges = { x: [...range], y: this.lastRanges.y };
        } else if (range && typeof range === 'object') {
            this.lastRanges = {
                x: range.x ? [...range.x] : this.lastRanges.x,
                y: range.y ? [...range.y] : this.lastRanges.y
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

        const xCol = State.data.timeColumn;
        if (!xCol) return;

        if (State.ui.activeMultiViewId) {
            this.renderMultiViewFromState(this.lastRanges.x || this.lastRanges.y ? this.lastRanges : null);
            return;
        }

        const yCol = State.data.dataColumn;
        if (!yCol) return;

        const rawX = State.data.raw.map(r => parseFloat(r[xCol]));
        const rawY = State.data.raw.map(r => parseFloat(r[yCol]));

        const filteredY = State.data.processed.length > 0 ? State.data.processed : null;
        const isMath = !!State.getMathDefinition(yCol);

        this.render(rawX, rawY, isMath ? null : filteredY, this.lastRanges.x || this.lastRanges.y ? this.lastRanges : range, {
            isMath,
            seriesName: yCol
        });
    },

    getSeriesForColumn(columnId, rawX) {
        if (!columnId) return null;
        const mathDef = State.getMathDefinition(columnId);
        let rawY = [];
        let time = rawX;

        if (mathDef) {
            const result = MathEngine.calculateVirtualColumn(mathDef, rawX);
            rawY = result.values;
            time = result.time.length ? result.time : rawX.slice(0, rawY.length);
            return { columnId, rawY, filteredY: null, time, isMath: true };
        } else if (State.data.headers.includes(columnId)) {
            rawY = State.data.raw.map((r) => parseFloat(r[columnId]));
            time = rawX.slice(0, rawY.length);
        } else {
            return null;
        }

        const pipeline = State.getPipelineForColumn(columnId);
        const filteredY = Filter.applyPipeline(rawY, time, pipeline);

        return { columnId, rawY, filteredY, time, isMath: false };
    },

    renderMultiViewFromState(range = null) {
        const activeId = State.ui.activeMultiViewId;
        const view = State.multiViews.find((v) => v.id === activeId);
        const xCol = State.data.timeColumn;
        if (!view) {
            State.ui.activeMultiViewId = null;
            return;
        }
        if (!xCol) return;

        const rawX = State.data.raw.map((r) => parseFloat(r[xCol]));
        const composer = State.getComposer(activeId);

        const seriesList = view.activeColumnIds
            .map((col, idx) => {
                const series = this.getSeriesForColumn(col, rawX);
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
            .filter(Boolean);

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
        const trimmedSeries = seriesList.map((series) => ({
            ...series,
            rawY: series.rawY.slice(0, commonLength),
            filteredY: series.filteredY ? series.filteredY.slice(0, commonLength) : null
        }));

        this.renderMultiView(finalTime, trimmedSeries, range, activeId);
    }
};