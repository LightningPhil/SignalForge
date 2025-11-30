import { State } from '../state.js';
import { Filter } from '../processing/filter.js';
import { getPixelsPerCm } from '../ui/displayCalibration.js';

const THEME_STYLES = {
    light: {
        paperBg: '#ffffff',
        plotBg: '#ffffff',
        fontColor: '#102a43',
        gridColor: '#d7deea'
    },
    dark: {
        paperBg: '#1e1e1e',
        plotBg: '#1e1e1e',
        fontColor: '#e0e0e0',
        gridColor: '#333333'
    }
};

/**
 * Export Module
 */
export const Exporter = {
    
    downloadCSV(includeOriginal) {
        const rawData = State.data.raw;
        const headers = State.data.headers;
        const xCol = State.data.timeColumn;

        if (!rawData.length) {
            alert("No data to export.");
            return;
        }

        // 1. Identify Numeric Columns to Filter
        const numericCols = headers.filter(h => {
            if (h === xCol) return false;
            const val = rawData[0][h];
            return !isNaN(parseFloat(val));
        });

        const rawTime = rawData.map((r) => parseFloat(r[xCol]));

        // 2. Pre-calculate Pipeline Data for ALL numeric columns
        const processedDataMap = {};

        console.time("Export Pipeline");
        numericCols.forEach(col => {
            const rawCol = rawData.map(r => parseFloat(r[col]));
            // Apply full pipeline
            const pipeline = State.getPipelineForColumn(col);
            processedDataMap[col] = Filter.applyPipeline(rawCol, rawTime, pipeline);
        });
        console.timeEnd("Export Pipeline");

        // 3. Construct Headers
        let outputHeaders = [];
        let csvContent = "data:text/csv;charset=utf-8,";

        outputHeaders.push(xCol);

        if (includeOriginal) {
            numericCols.forEach(h => outputHeaders.push(h));
        }

        numericCols.forEach(h => outputHeaders.push(`${h} (Filtered)`));

        csvContent += outputHeaders.join(",") + "\r\n";

        // 4. Construct Rows
        for (let i = 0; i < rawData.length; i++) {
            let rowData = [];
            
            // Time
            rowData.push(rawData[i][xCol]);

            // Original
            if (includeOriginal) {
                numericCols.forEach(col => {
                    let val = rawData[i][col];
                    if (typeof val === 'string' && val.includes(',')) val = `"${val}"`;
                    rowData.push(val);
                });
            }

            // Filtered
            numericCols.forEach(col => {
                const val = processedDataMap[col][i];
                rowData.push(val);
            });

            csvContent += rowData.join(",") + "\r\n";
        }

        // 5. Download
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        
        const filename = includeOriginal 
            ? "data_export_pipeline_full.csv" 
            : "data_export_pipeline.csv";
            
        link.setAttribute("download", filename);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    },

    hexToRgba(hex, alpha) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    },

    getColorsForTheme(theme) {
        const configColors = State.config.colors;
        const defaults = (configColors && configColors[theme]) || {};

        if (configColors && configColors[theme]) {
            return { ...defaults, ...configColors[theme] };
        }

        if (configColors && (configColors.raw || configColors.filtered)) {
            return {
                raw: configColors.raw,
                filtered: configColors.filtered,
                diffRaw: configColors.diffRaw || configColors.raw,
                diffFilt: configColors.diffFilt || configColors.filtered,
                transfer: configColors.transfer
            };
        }

        return defaults;
    },

    downloadImage(format, options = {}) {
        const { theme, transparent = false, widthCm, heightCm, useWindowSize = true } = options;
        const graphDiv = document.getElementById('main-plot');

        if (!graphDiv || !graphDiv.layout) {
            alert("Graph not initialized.");
            return;
        }

        const selectedTheme = theme === 'light' || theme === 'dark'
            ? theme
            : (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

        const themeStyles = THEME_STYLES[selectedTheme] || THEME_STYLES.dark;
        const colors = this.getColorsForTheme(selectedTheme);
        const config = State.config.graph;

        const rawLineColor = this.hexToRgba(colors.raw || '#888888', config.rawOpacity || 0.5);
        const filteredLineColor = colors.filtered || '#ff9800';
        const diffRawColor = this.hexToRgba(colors.diffRaw || colors.raw || '#888888', config.rawOpacity || 0.5);
        const diffFiltColor = colors.diffFilt || colors.filtered || '#ff9800';
        const transferColor = colors.transfer || '#00bcd4';

        const themedData = (graphDiv.data || []).map(trace => {
            const clonedTrace = { ...trace };
            const name = (trace.name || '').toLowerCase();
            const line = trace.line ? { ...trace.line } : {};

            if (name.includes('transfer')) {
                line.color = transferColor;
            } else if (name.includes('deriv') && name.includes('raw')) {
                line.color = diffRawColor;
            } else if (name.includes('deriv') && name.includes('filt')) {
                line.color = diffFiltColor;
            } else if (name.includes('raw')) {
                line.color = rawLineColor;
            } else if (name.includes('filt')) {
                line.color = filteredLineColor;
            }

            if (Object.keys(line).length > 0) clonedTrace.line = line;
            return clonedTrace;
        });

        const layout = JSON.parse(JSON.stringify(graphDiv.layout || {}));
        layout.paper_bgcolor = transparent ? 'rgba(0,0,0,0)' : themeStyles.paperBg;
        layout.plot_bgcolor = transparent ? 'rgba(0,0,0,0)' : themeStyles.plotBg;
        layout.font = { ...(layout.font || {}), color: themeStyles.fontColor };
        layout.xaxis = { ...(layout.xaxis || {}), gridcolor: themeStyles.gridColor, zerolinecolor: themeStyles.gridColor };
        layout.yaxis = { ...(layout.yaxis || {}), gridcolor: themeStyles.gridColor, zerolinecolor: themeStyles.gridColor };
        if (layout.yaxis2) {
            layout.yaxis2 = { ...layout.yaxis2, gridcolor: themeStyles.gridColor, zerolinecolor: themeStyles.gridColor };
        }

        const pixelsPerCm = getPixelsPerCm();
        let targetWidth = graphDiv.clientWidth || 1000;
        let targetHeight = graphDiv.clientHeight || 600;

        if (!useWindowSize) {
            if (widthCm && !isNaN(widthCm)) targetWidth = Math.max(1, widthCm * pixelsPerCm);
            if (heightCm && !isNaN(heightCm)) targetHeight = Math.max(1, heightCm * pixelsPerCm);
        }

        Plotly.toImage({ data: themedData, layout: layout }, { format: format, height: targetHeight, width: targetWidth })
            .then((url) => {
                const link = document.createElement('a');
                link.setAttribute('href', url);
                link.setAttribute('download', 'signal_graph_export.' + format);
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            })
            .catch((err) => {
                console.error('Error exporting image', err);
                alert('Failed to export graph image.');
            });
    }
};