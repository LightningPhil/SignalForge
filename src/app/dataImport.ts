import { CsvParser } from '../io/csvParser';
import { State } from '../state';
import '../session/workspace';
import { renderComposerPanel } from './composerUi';
import { runPipelineAndRender } from './dataPipeline';
import { renderColumnTabs } from './tabs';

export function handleFileSelection(file: File | undefined, onStatusChange?: (status: string) => void): void {
  if (!file) return;
  onStatusChange?.('Loading...');

  CsvParser.processFile(file, (results, source) => {
    State.setData(results.data, results.meta.fields || [], source);
    State.syncComposerForView(null, State.getActiveComposerColumns());
    renderColumnTabs();
    renderComposerPanel();
    runPipelineAndRender();
    onStatusChange?.('Ready');
  });
}
