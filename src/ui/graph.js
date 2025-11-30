import { State } from '../state.js';
import { Config } from '../config.js';
import { lttb } from '../processing/lttb.js';
import { FFT } from '../processing/fft.js';
import { Filter } from '../processing/filter.js';

const PLOT_ID = 'main-plot';
const STATUS_ID = 'graph-status';

/**
 * Graph Visualization Module
 */
export const Graph = {

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

        const { paperBg, plotBg, fontColor, gridColor } = this.getPlotStyling();
        Plotly.relayout(PLOT_ID, {
            paper_bgcolor: paperBg,
            plot_bgcolor: plotBg,
            'font.color': fontColor,
            'xaxis.gridcolor': gridColor,
            'yaxis.gridcolor': gridColor,
            'yaxis2.gridcolor': gridColor
        });

        if (State.data.raw.length && State.data.timeColumn && State.data.dataColumn) {
            this.triggerRefresh(null);
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

    getAxisFormat(format, axisType = 'linear') {
        const presets = {
            decimal: { exponentformat: 'none' },
            scientific: { exponentformat: 'e', showexponent: 'all' },
            integer: { tickformat: 'd', exponentformat: 'none' },
            currency: { tickprefix: '$', tickformat: ',.2f', exponentformat: 'none' },
            percentage: { tickformat: '.0%', exponentformat: 'none' },
            datetime: { type: 'date', hoverformat: '%Y-%m-%d %H:%M' },
            engineering: { tickformat: 's', exponentformat: 'SI' }
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
        const pipeline = State.config.pipeline;
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

    // --- Time Domain Renderer (Existing Logic) ---
    renderTimeDomain(rawX, rawY, filteredY, range) {
        const config = State.config.graph;
        const colors = this.getColorsForTheme();
        const { paperBg, plotBg, fontColor, gridColor } = this.getPlotStyling();

        const showDiff = config.showDifferential;
        const showRaw = (config.showRaw !== false);
        const allowDownsample = config.enableDownsampling;

        let displayX = rawX;
        let displayY = rawY;
        let displayF = filteredY || [];

        // Slicing
        if (range) {
            const startIndex = rawX.findIndex(val => val >= range[0]);
            let endIndex = rawX.findIndex(val => val > range[1]);
            
            if (startIndex !== -1) {
                if (endIndex === -1) endIndex = rawX.length;
                const buffer = 5;
                const safeStart = Math.max(0, startIndex - buffer);
                const safeEnd = Math.min(rawX.length, endIndex + buffer);

                displayX = rawX.slice(safeStart, safeEnd);
                displayY = rawY.slice(safeStart, safeEnd);
                if (filteredY) displayF = filteredY.slice(safeStart, safeEnd);
            }
        }

        const pointCount = displayX.length;
        let isDownsampled = false;

        // Downsampling
        if (allowDownsample && pointCount > config.maxDisplayPoints) {
            isDownsampled = true;
            const zippedRaw = displayX.map((x, i) => [x, displayY[i]]);
            const sampledRaw = lttb(zippedRaw, config.maxDisplayPoints);
            displayX = sampledRaw.map(p => p[0]);
            displayY = sampledRaw.map(p => p[1]);

            if (filteredY && displayF.length > 0) {
                const zippedF = displayF.map((y, i) => [i, y]); 
                const sampledF = lttb(zippedF, config.maxDisplayPoints);
                displayF = sampledF.map(p => p[1]);
            }
        }

        const traces = [];
        const rawColor = this.hexToRgba(colors.raw, config.rawOpacity || 0.5);
        const filtColor = colors.filtered;
        const diffRawColor = colors.diffRaw || colors.raw;
        const diffFiltColor = colors.diffFilt || colors.filtered;

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

        const xAxisFormat = this.getAxisFormat(config.xAxisFormat, 'linear');
        const yAxisBaseType = config.logScaleY ? 'log' : 'linear';
        const yAxisFormat = this.getAxisFormat(config.yAxisFormat, yAxisBaseType);
        const secondaryYAxisFormat = this.getAxisFormat(config.yAxisFormat, 'linear');

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
                range: range,
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

        if (event['xaxis.range[0]'] || event['xaxis.range']) {
            let min, max;
            if (event['xaxis.range']) {
                [min, max] = event['xaxis.range'];
            } else {
                min = event['xaxis.range[0]'];
                max = event['xaxis.range[1]'];
            }
            this.triggerRefresh([min, max]);
        }
        
        if (event['xaxis.autorange'] === true) {
            this.triggerRefresh(null);
        }
    },

    triggerRefresh(range) {
        const xCol = State.data.timeColumn;
        const yCol = State.data.dataColumn;
        if (!xCol || !yCol) return;

        const rawX = State.data.raw.map(r => parseFloat(r[xCol]));
        const rawY = State.data.raw.map(r => parseFloat(r[yCol]));
        
        const filteredY = State.data.processed.length > 0 ? State.data.processed : null;

        this.render(rawX, rawY, filteredY, range);
    }
};