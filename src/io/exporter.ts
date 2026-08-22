import Plotly from 'plotly.js-dist-min';
import type { Data, Layout, PlotlyHTMLElement } from 'plotly.js';
import { applyComposerOffsets, getComposerTrace } from '../processing/composer';
import { Filter } from '../processing/filter';
import { MathEngine } from '../processing/math';
import { State } from '../state';
import type { ImageExportOptions, ThemeName } from '../types';
import { getColorsForTheme, hexToRgba } from '../ui/colors';
import { getPixelsPerCm } from '../ui/displayCalibration';
import { downloadText } from './download';

const THEME_STYLES: Record<ThemeName, { paperBg: string; plotBg: string; fontColor: string; gridColor: string }> = {
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

interface ProcessedColumn {
  raw: number[];
  filtered: number[];
  isMath?: boolean;
}

export const Exporter = {
  downloadCSV(includeOriginal: boolean): void {
    const rawData = State.data.raw;
    const headers = State.data.headers;
    const xCol = State.data.timeColumn;

    if (!rawData.length || !xCol) {
      alert('No data to export.');
      return;
    }

    const numericCols = headers.filter((h) => {
      if (h === xCol) return false;
      return rawData.some((row) => {
        const val = row[h];
        if (val === undefined || val === null) return false;
        return Number.isFinite(parseFloat(String(val)));
      });
    });

    const rawTime = rawData.map((r) => parseFloat(String(r[xCol])));
    const activeViewId = State.ui.activeMultiViewId || null;
    const activeView = activeViewId ? State.multiViews.find((v) => v.id === activeViewId) : null;
    const activeComposer = State.getComposer(activeViewId);

    const processedDataMap: Record<string, ProcessedColumn> = {};
    const mathCols = (State.config.mathDefinitions || []).map((def) => def.name);

    numericCols.forEach((col) => {
      const rawCol = rawData.map((r) => parseFloat(String(r[col])));
      const pipeline = State.getPipelineForColumn(col);
      const filtered = Filter.applyPipeline(rawCol, rawTime, pipeline);

      let alignedRaw = rawCol;
      let alignedFiltered = filtered;

      if (activeView && activeView.activeColumnIds.includes(col)) {
        const trace = activeComposer?.traces?.find((t) => t.columnId === col) || { columnId: col };
        const aligned = applyComposerOffsets(rawCol, filtered, { columnId: col, yOffset: trace.yOffset || 0 });
        alignedRaw = aligned.adjustedRawY;
        alignedFiltered = aligned.adjustedFilteredY;
      } else if (!activeViewId && State.data.dataColumn === col) {
        const trace = getComposerTrace(null, col);
        const aligned = applyComposerOffsets(rawCol, filtered, trace);
        alignedRaw = aligned.adjustedRawY;
        alignedFiltered = aligned.adjustedFilteredY;
      }

      processedDataMap[col] = { raw: alignedRaw, filtered: alignedFiltered };
    });

    mathCols.forEach((name) => {
      const def = State.getMathDefinition(name);
      if (!def) return;
      const result = MathEngine.calculateVirtualColumn(def, rawTime);
      processedDataMap[name] = { raw: result.values || [], filtered: result.values || [], isMath: true };
    });

    const outputHeaders = [xCol];
    if (includeOriginal) numericCols.forEach((h) => outputHeaders.push(h));
    numericCols.forEach((h) => outputHeaders.push(`${h} (Filtered)`));
    mathCols.forEach((name) => outputHeaders.push(name));

    const quoteCsv = (val: unknown): string => {
      if (val === undefined || val === null) return '';
      const text = String(val);
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const lines = [outputHeaders.map(quoteCsv).join(',')];
    for (let i = 0; i < rawData.length; i++) {
      const rowData = [quoteCsv(rawData[i][xCol])];
      if (includeOriginal) {
        numericCols.forEach((col) => rowData.push(quoteCsv(processedDataMap[col].raw[i])));
      }
      numericCols.forEach((col) => rowData.push(quoteCsv(processedDataMap[col].filtered[i])));
      mathCols.forEach((name) => rowData.push(quoteCsv(processedDataMap[name]?.raw[i])));
      lines.push(rowData.join(','));
    }

    downloadText(
      lines.join('\r\n'),
      includeOriginal ? 'data_export_pipeline_full.csv' : 'data_export_pipeline.csv',
      'text/csv;charset=utf-8'
    );
  },

  hexToRgba,
  getColorsForTheme,

  downloadImage(format: 'png' | 'svg' | 'jpeg' | 'webp', options: ImageExportOptions = {}): void {
    const { theme, transparent = false, widthCm, heightCm, useWindowSize = true } = options;
    const graphDiv = document.getElementById('main-plot') as PlotlyHTMLElement | null;

    if (!graphDiv || !graphDiv.layout) {
      alert('Graph not initialized.');
      return;
    }

    const selectedTheme: ThemeName = theme === 'light' || theme === 'dark'
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

    const themedData = (graphDiv.data || []).map((trace) => {
      const clonedTrace: Data = { ...trace };
      const name = ('name' in trace && typeof trace.name === 'string' ? trace.name : '').toLowerCase();
      const existingLine = 'line' in trace && trace.line && typeof trace.line === 'object'
        ? trace.line as { color?: string; width?: number }
        : {};
      const line: { color?: string; width?: number } = { ...existingLine };

      if (name.includes('transfer')) line.color = transferColor;
      else if (name.includes('deriv') && name.includes('raw')) line.color = diffRawColor;
      else if (name.includes('deriv') && name.includes('filt')) line.color = diffFiltColor;
      else if (name.includes('raw')) line.color = rawLineColor;
      else if (name.includes('filt')) line.color = filteredLineColor;

      if (Object.keys(line).length > 0 && 'line' in clonedTrace) {
        clonedTrace.line = line;
      }
      return clonedTrace;
    });

    const layout = JSON.parse(JSON.stringify(graphDiv.layout || {})) as Partial<Layout>;
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
      if (widthCm && !Number.isNaN(widthCm)) targetWidth = Math.max(1, widthCm * pixelsPerCm);
      if (heightCm && !Number.isNaN(heightCm)) targetHeight = Math.max(1, heightCm * pixelsPerCm);
    }

    Plotly.toImage({ data: themedData, layout }, { format, height: targetHeight, width: targetWidth })
      .then((url) => {
        const link = document.createElement('a');
        link.setAttribute('href', url);
        link.setAttribute('download', `signal_graph_export.${format}`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      })
      .catch((err: unknown) => {
        console.error('Error exporting image', err);
        alert('Failed to export graph image.');
      });
  }
};
