import { Filter } from '../processing/filter';
import { State } from '../state';
import type { AnalysisSeries, ViewRange } from '../types';
import { EventPanel } from '../ui/eventPanel';
import { Graph } from '../ui/graph';
import { MeasurementPanel } from '../ui/measurementPanel';
import { SpectralPanel } from '../ui/spectralPanel';
import { SystemPanel } from '../ui/systemPanel';
import { getRawSeries } from './traceData';

export function hasData(alertUser = true): boolean {
  if (!State.data.raw.length) {
    if (alertUser) alert('Please load a CSV file first.');
    return false;
  }
  return true;
}

function toAnalysisSeries(rawX: number[], rawY: number[], filteredY: number[] | null, seriesName: string, isMath: boolean): AnalysisSeries {
  return { rawX, rawY, filteredY, seriesName, columnId: seriesName, isMath };
}

function pushSeriesToPanels(series: AnalysisSeries | null): void {
  if (!series) {
    MeasurementPanel.clear();
    EventPanel.clear();
    SpectralPanel.clear();
    SystemPanel.refreshFromState();
    return;
  }
  MeasurementPanel.setSeries(series);
  EventPanel.setSeries(series);
  SpectralPanel.setSeries(series);
  SystemPanel.refreshFromState();
}

export function runPipelineAndRender(range: ViewRange | null = null): void {
  if (!hasData(false)) return;

  if (State.ui.activeMultiViewId) {
    const activeView = State.multiViews.find((v) => v.id === State.ui.activeMultiViewId);
    const targetCol = activeView?.activeColumnIds?.[0] || null;
    if (targetCol) {
      const { rawX, rawY } = getRawSeries(targetCol);
      const isMath = !!State.getMathDefinition(targetCol);
      const filteredY = isMath ? null : Filter.applyPipeline(rawY, rawX, State.getPipelineForColumn(targetCol));
      pushSeriesToPanels(toAnalysisSeries(rawX, rawY, filteredY, targetCol, isMath));
    } else {
      pushSeriesToPanels(null);
    }
    Graph.renderMultiViewFromState(range);
    return;
  }

  const { rawX, rawY } = getRawSeries();
  if (!rawX.length || !rawY.length) return;

  const isMath = !!State.getMathDefinition(State.data.dataColumn);
  const seriesName = State.data.dataColumn || 'Series';
  if (isMath) {
    State.data.processed = [];
    pushSeriesToPanels(toAnalysisSeries(rawX, rawY, null, seriesName, true));
    Graph.render(rawX, rawY, null, range, { isMath: true, seriesName });
    return;
  }

  const filteredY = Filter.applyPipeline(rawY, rawX, State.getPipeline());
  State.data.processed = filteredY;
  pushSeriesToPanels(toAnalysisSeries(rawX, rawY, filteredY, seriesName, false));
  Graph.render(rawX, rawY, filteredY, range);
}

export function triggerGraphUpdateOnly(): void {
  if (!hasData(false)) return;
  const range = Graph.lastRanges.x || Graph.lastRanges.y ? Graph.lastRanges : null;

  if (State.ui.activeMultiViewId) {
    Graph.renderMultiViewFromState(range);
    return;
  }

  const { rawX, rawY } = getRawSeries();
  const isMath = !!State.getMathDefinition(State.data.dataColumn);
  const filteredY = State.data.processed.length > 0 ? State.data.processed : null;
  Graph.render(rawX, rawY, isMath ? null : filteredY, range, {
    isMath,
    seriesName: State.data.dataColumn || 'Series'
  });
}

export { getRawSeries };
