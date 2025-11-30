/**
 * Application Defaults
 */

export const Config = {
    // Default Graph Settings
    graph: {
        title: "Signal Analysis",
        xAxisTitle: "Time",
        yAxisTitle: "Amplitude",

        // Display
        xAxisFormat: 'scientific',
        yAxisFormat: 'scientific',
        currencySymbol: '£',
        significantFigures: 3,
        logScaleY: false,
        showDifferential: false,
        showGrid: true,
        showFreqDomain: false,
        
        // Raw Data Visibility
        showRaw: true,
        rawOpacity: 0.5,
        
        // Performance
        enableDownsampling: false, 
        maxDisplayPoints: 20000
    },

    // Pipeline Scope
    pipelineScope: true, // true = Global/Sync All Tabs, false = Per-Tab
    columnPipelines: {},

    // Default Pipeline (Updated per request)
    pipeline: [
        {
            id: 'default-1',
            type: 'startStopNorm',
            startLength: 200,
            endLength: 50,
            startOffset: 0,
            autoOffset: true,
            autoOffsetPoints: 200,
            applyStart: true,
            applyEnd: false,
            enabled: true
        },
        {
            id: 'default-2',
            type: 'savitzkyGolay',
            windowSize: 20,
            polyOrder: 2,
            iterations: 1,
            enabled: true
        }
    ],

    // Default Parameters for new filters
    defaults: {
        movingAverage: { windowSize: 5 },
        savitzkyGolay: { windowSize: 20, polyOrder: 2, iterations: 1 },
        median: { windowSize: 5 },
        iir: { alpha: 0.1 },
        gaussian: { sigma: 1.0, kernelSize: 5 },
        startStopNorm: {
            startLength: 50,
            endLength: 50,
            startOffset: 0,
            autoOffset: false,
            autoOffsetPoints: 200,
            applyStart: true,
            applyEnd: true
        },
        
        // Frequency Domain Defaults (100 MHz)
        lowPassFFT: { cutoffFreq: 100000000, slope: 12, qFactor: 0.707 },
        highPassFFT: { cutoffFreq: 100000000, slope: 12, qFactor: 0.707 },
        notchFFT: { centerFreq: 100000000, bandwidth: 1000000 } 
    },

    colors: {
        light: {
            raw: '#888888',
            filtered: '#0047AB',
            diffRaw: '#888888',
            diffFilt: '#0047AB',
            transfer: '#00bcd4'
        },
        dark: {
            raw: '#888888',
            filtered: '#ff9800',
            diffRaw: '#888888',
            diffFilt: '#ff9800',
            transfer: '#00bcd4'
        }
    },

    limits: {
        previewLines: 50,         
        maxGridRows: 1000         
    }
};