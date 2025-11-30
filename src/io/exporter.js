import { State } from '../state.js';
import { Filter } from '../processing/filter.js';

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

        // 2. Pre-calculate Pipeline Data for ALL numeric columns
        const pipeline = State.config.pipeline;
        const processedDataMap = {}; 

        console.time("Export Pipeline");
        numericCols.forEach(col => {
            const rawCol = rawData.map(r => parseFloat(r[col]));
            // Apply full pipeline
            processedDataMap[col] = Filter.applyPipeline(rawCol, pipeline);
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

    downloadImage(format) {
        const graphDiv = document.getElementById('main-plot');
        
        if (!graphDiv || !graphDiv.layout) {
            alert("Graph not initialized.");
            return;
        }

        Plotly.downloadImage(graphDiv, {
            format: format,
            height: 600,
            width: 1000,
            filename: 'signal_graph_export'
        });
    }
};