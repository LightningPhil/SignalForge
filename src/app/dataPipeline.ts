import { Filter } from '../processing/filter';
import { State } from '../state';
import { Graph } from '../ui/graph';
import { getRawSeries } from './traceData';

export function hasData(alertUser = true): boolean {
  if (!State.data.raw.length) {
    if (alertUser) alert('Please load a CSV file first.');
    return false;
  }
  return true;
}

export function runPipelineAndRender(range: import('../types').ViewRange | null = null): void {
  if (!hasData(false)) return;

  if (State.ui.activeMultiViewId) {
    Graph.renderMultiViewFromState(range);
    return;
  }

  const { rawX, rawY } = getRawSeries();
  if (!rawX.length || !rawY.length) return;

  const isMath = !!State.getMathDefinition(State.data.dataColumn);
  if (isMath) {
    State.data.processed = [];
    Graph.render(rawX, rawY, null, range, { isMath: true, seriesName: State.data.dataColumn || 'Series' });
    return;
  }

  const filteredY = Filter.applyPipeline(rawY, rawX, State.getPipeline());
  State.data.processed = filteredY;
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
