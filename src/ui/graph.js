import { State } from '../state.js';
import { Config } from '../config.js';
import { lttb } from '../processing/lttb.js';
import { FFT } from '../processing/fft.js';
import { Filter } from '../processing/filter.js';
import { MathEngine } from '../processing/math.js';

const PLOT_ID = 'main-plot';
const STATUS_ID = 'graph-status';

/**
 * Graph Visualization Module
 */
export const Graph = {

    lastRanges: { x: null, y: null },

    getPlotStyling() {
        const styles = getComputedStyle(document.documentElement);
        const paperBg = styles.getPropertyValue('--plot-bg').trim() || '#1e1e1e';
        const plotBg = styles.getPropertyValue('--plot-bg').trim() || '#1e1e1e';
        const fontColor = styles.getPropertyValue('--text-main').trim() || '#e0e0e0';
        const gridColor = styles.getPropertyValue('--plot-grid').trim() || '#333';
        return { paperBg, plotBg, fontColor, gridColor };
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
            Plotly.Plots.resize(PLOT_ID);
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

    render(rawX, rawY, filteredY = null, range = null) {
        if (!rawX || rawX.length === 0) return;

        const config = State.config.graph;

        // --- Mode Switching ---
        if (config.showFreqDomain) {
            this.renderFreqDomain(rawX, rawY, filteredY);
        } else {
            this.renderTimeDomain(rawX, rawY, filteredY, range);
        }
    },

    renderMultiView(rawX, seriesList, ranges = null) {
        if (!rawX || rawX.length === 0) return;
        const config = State.config.graph;

        if (config.showFreqDomain) {
            this.renderMultiFreqDomain(rawX, seriesList);
        } else {
            this.renderMultiTimeDomain(rawX, seriesList, ranges);
        }
    },

    renderMultiTimeDomain(rawX, seriesList, ranges) {
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
            const timeOffset = series.timeOffset || 0;
            const yOffset = series.yOffset || 0;
            let seriesX = rawX;
            let seriesY = series.rawY;
            let seriesF = series.filteredY || [];

            if (xRange) {
                const rangeForSeries = xRange.map((val) => val - timeOffset);
                const startIndex = rawX.findIndex((val) => val >= rangeForSeries[0]);
                let endIndex = rawX.findIndex((val) => val > rangeForSeries[1]);

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

                if (seriesF.length > 0) {
                    const zippedF = originalX.map((x, i) => [x, seriesF[i]]);
                    const sampledF = lttb(zippedF, config.maxDisplayPoints);
                    seriesF = sampledF.map(p => p[1]);
                }
            }

            const adjustedX = seriesX.map((x) => x + timeOffset);
            const adjustedY = seriesY.map((y) => y + yOffset);
            const adjustedF = seriesF.map((y) => y + yOffset);

            if (showRaw) {
                traces.push({
                    x: adjustedX, y: adjustedY, mode: 'lines', name: `${name} (Raw)`,
                    line: { width: 1 }, xaxis: 'x', yaxis: 'y'
                });
            }

            if (seriesF && seriesF.length > 0) {
                traces.push({
                    x: adjustedX, y: adjustedF, mode: 'lines', name: `${name} (Filtered)`,
                    line: { width: 2 }, xaxis: 'x', yaxis: 'y'
                });
            }

            if (showDiff) {
                if (showRaw) {
                    const dRaw = this.calculateDerivative(adjustedX, adjustedY);
                    traces.push({
                        x: adjustedX, y: dRaw, mode: 'lines', name: `${name} Raw Deriv.`,
                        line: { width: 1 }, xaxis: 'x', yaxis: 'y2'
                    });
                }
                if (seriesF && seriesF.length > 0) {
                    const dF = this.calculateDerivative(adjustedX, adjustedF);
                    traces.push({
                        x: adjustedX, y: dF, mode: 'lines', name: `${name} Filt. Deriv.`,
                        line: { width: 1.5 }, xaxis: 'x', yaxis: 'y2'
                    });
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
    renderFreqDomain(timeX, rawY, filteredY) {
        const config = State.config.graph;
        const colors = this.getColorsForTheme();
        const { paperBg, plotBg, fontColor, gridColor } = this.getPlotStyling();

        // 1. Calculate Sampling Rate (Fs) from current view
        // Use average delta of timeX
        let fs = 1.0;
        if(timeX.length > 1) {
            const limit = Math.min(100, timeX.length-1);
            let sum = 0;
            for(let i=0; i<limit; i++) sum += (timeX[i+1]-timeX[i]);
            if(sum > 0) fs = 1.0 / (sum/limit);
        }

        // 2. Perform FFT on Raw
        const { re: rawRe, im: rawIm } = FFT.forward(rawY);
        const rawMag = FFT.getMagnitudeDB(rawRe, rawIm);
        const n = rawMag.length;
        
        // Generate Freq Axis (0 to Nyquist)
        const freqAxis = [];
        const binWidth = (fs/2) / n;
        for(let i=0; i<n; i++) freqAxis.push(i * binWidth);

        const traces = [];

        // Trace 1: Raw Spectrum
        if (config.showRaw !== false) {
            traces.push({
                x: freqAxis,
                y: rawMag,
                mode: 'lines',
                name: 'Raw Spectrum',
                line: { color: this.hexToRgba(colors.raw, config.rawOpacity || 0.5), width: 1 }
            });
        }

        // Trace 2: Filtered Spectrum
        if (filteredY) {
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
        const hasFFTFilters = pipeline.some(p => p.enabled && ['lowPassFFT','highPassFFT','notchFFT'].includes(p.type));
        
        if (hasFFTFilters) {
            // Calculate theoretical curve
            const transfer = Filter.calculateTransferFunction(pipeline, fs, n);
            // Convert to dB
            const transferDB = transfer.map(g => 20 * Math.log10(g + 1e-9));
            
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

        const layout = {
            title: "Frequency Domain (FFT)",
            paper_bgcolor: paperBg,
            plot_bgcolor: plotBg,
            font: { color: fontColor },
            showlegend: true,

            xaxis: {
                title: "Frequency (Hz)",
                type: 'log',
                autorange: true,
                gridcolor: gridColor
            },
            yaxis: {
                title: "Magnitude (dB)",
                gridcolor: gridColor
            },
            yaxis2: {
                title: "Filter Gain (dB)",
                overlaying: 'y',
                side: 'right',
                range: [-100, 5], // Fixed range for transfer function
                showgrid: false
            }
        };

        Plotly.react(PLOT_ID, traces, layout);
        
        const statusEl = document.getElementById(STATUS_ID);
        if(statusEl) statusEl.textContent = `Frequency Analysis (Fs ≈ ${Math.round(fs)} Hz)`;
    },

    renderMultiFreqDomain(timeX, seriesList) {
        if (!seriesList || seriesList.length === 0) return;
        const config = State.config.graph;
        const { paperBg, plotBg, fontColor, gridColor } = this.getPlotStyling();

        let fs = 1.0;
        if(timeX.length > 1) {
            const limit = Math.min(100, timeX.length-1);
            let sum = 0;
            for(let i=0; i<limit; i++) sum += (timeX[i+1]-timeX[i]);
            if(sum > 0) fs = 1.0 / (sum/limit);
        }

        const traces = [];

        seriesList.forEach((series) => {
            const { rawY, filteredY, columnId } = series;
            if (!rawY || rawY.length === 0) return;

            const { re: rawRe, im: rawIm } = FFT.forward(rawY);
            const rawMag = FFT.getMagnitudeDB(rawRe, rawIm);

            const freqAxis = [];
            const binWidth = (fs/2) / rawMag.length;
            for(let i=0; i<rawMag.length; i++) freqAxis.push(i * binWidth);

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
        });

        const layout = {
            title: "Frequency Domain (FFT)",
            paper_bgcolor: paperBg,
            plot_bgcolor: plotBg,
            font: { color: fontColor },
            showlegend: true,
            xaxis: { title: "Frequency (Hz)", type: 'log', autorange: true, gridcolor: gridColor },
            yaxis: { title: "Magnitude (dB)", gridcolor: gridColor }
        };

        Plotly.react(PLOT_ID, traces, layout);

        const statusEl = document.getElementById(STATUS_ID);
        if(statusEl) statusEl.textContent = `Frequency Analysis (Fs ≈ ${Math.round(fs)} Hz)`;
    },

    // --- Time Domain Renderer (Existing Logic) ---
    renderTimeDomain(rawX, rawY, filteredY, range) {
        const config = State.config.graph;
        const colors = this.getColorsForTheme();
        const { paperBg, plotBg, fontColor, gridColor } = this.getPlotStyling();

        const composer = State.getComposer(State.ui.activeMultiViewId || null);
        const activeCol = State.data.dataColumn;
        const composerTrace = composer?.traces?.find((t) => t.columnId === activeCol) || { timeOffset: 0, yOffset: 0 };
        const timeOffset = composerTrace.timeOffset || 0;
        const yOffset = composerTrace.yOffset || 0;

        const showDiff = config.showDifferential;
        const showRaw = (config.showRaw !== false);
        const allowDownsample = config.enableDownsampling;

        const xRange = Array.isArray(range) ? range : (range && range.x ? range.x : null);
        const yRange = (!Array.isArray(range) && range && range.y) ? range.y : null;

        let displayX = rawX;
        let displayY = rawY;
        let displayF = filteredY || [];

        const normalizedRange = xRange ? xRange.map((val) => val - timeOffset) : null;

        if (range === null) {
            this.lastRanges = { x: null, y: null };
        } else {
            this.lastRanges = { x: xRange ? [...xRange] : null, y: yRange ? [...yRange] : null };
        }

        // Slicing
        let sliceStart = 0;
        let sliceEnd = rawX.length;
        if (normalizedRange) {
            const startIndex = rawX.findIndex(val => val >= normalizedRange[0]);
            let endIndex = rawX.findIndex(val => val > normalizedRange[1]);

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

            if (filteredY && displayF.length > 0) {
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

        const adjustedX = displayX.map((x) => x + timeOffset);
        const adjustedY = displayY.map((y) => y + yOffset);
        const adjustedF = displayF.map((y) => y + yOffset);

        if (showRaw) {
            traces.push({
                x: adjustedX, y: adjustedY, mode: 'lines', name: 'Raw Data',
                line: { color: rawColor, width: 1 }, xaxis: 'x', yaxis: 'y'
            });
        }

        if (filteredY && displayF.length > 0) {
            traces.push({
                x: adjustedX, y: adjustedF, mode: 'lines', name: 'Filtered',
                line: { color: filtColor, width: 2 }, xaxis: 'x', yaxis: 'y'
            });
        }

        if (showDiff) {
            if (showRaw) {
                const dRaw = this.calculateDerivative(adjustedX, adjustedY);
                traces.push({
                    x: adjustedX, y: dRaw, mode: 'lines', name: 'Raw Deriv.',
                    line: { color: this.hexToRgba(diffRawColor, config.rawOpacity || 0.5), width: 1 }, xaxis: 'x', yaxis: 'y2'
                });
            }
            if (filteredY && displayF.length > 0) {
                const dF = this.calculateDerivative(adjustedX, adjustedF);
                traces.push({
                    x: adjustedX, y: dF, mode: 'lines', name: 'Filt. Deriv.',
                    line: { color: diffFiltColor, width: 1.5 }, xaxis: 'x', yaxis: 'y2'
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
            }
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
        if(State.config.graph.showFreqDomain) return; // No custom zoom logic for FFT yet

        const ranges = { ...this.lastRanges };

        if (event['xaxis.range[0]'] || event['xaxis.range']) {
            let min, max;
            if (event['xaxis.range']) {
                [min, max] = event['xaxis.range'];
            } else {
                min = event['xaxis.range[0]'];
                max = event['xaxis.range[1]'];
            }
            ranges.x = [min, max];
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
            this.triggerRefresh(null);
            return;
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

        this.render(rawX, rawY, filteredY, this.lastRanges.x || this.lastRanges.y ? this.lastRanges : range);
    },

    getSeriesForColumn(columnId, rawX) {
        if (!columnId) return null;
        const mathDef = State.getMathDefinition(columnId);
        let rawY = [];

        if (mathDef) {
            rawY = MathEngine.calculateVirtualColumn(mathDef, rawX);
        } else if (State.data.headers.includes(columnId)) {
            rawY = State.data.raw.map((r) => parseFloat(r[columnId]));
        } else {
            return null;
        }

        const pipeline = State.getPipelineForColumn(columnId);
        const filteredY = Filter.applyPipeline(rawY, rawX, pipeline);

        return { columnId, rawY, filteredY };
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
        const waterfallMode = composer?.waterfallMode;
        const waterfallSpacing = composer?.waterfallSpacing || 0;

        const seriesList = view.activeColumnIds
            .map((col, idx) => {
                const series = this.getSeriesForColumn(col, rawX);
                if (!series) return null;

                const composerTrace = composer?.traces?.find((t) => t.columnId === col) || { timeOffset: 0, yOffset: 0 };
                const waterfallOffset = waterfallMode ? waterfallSpacing * idx : 0;

                return {
                    ...series,
                    timeOffset: composerTrace.timeOffset || 0,
                    yOffset: (composerTrace.yOffset || 0) + waterfallOffset
                };
            })
            .filter(Boolean);

        this.renderMultiView(rawX, seriesList, range);
    }
};