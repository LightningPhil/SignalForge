import { CsvParser } from '../io/csvParser';
import { State } from '../state';
import { renderComposerPanel } from './composerUi';
import { runPipelineAndRender } from './dataPipeline';
import { renderColumnTabs } from './tabs';

export function handleFileSelection(file: File | undefined, onStatusChange?: (status: string) => void): void {
  if (!file) return;
  onStatusChange?.('Loading...');
  State.data.raw = [];
  State.data.processed = [];

  CsvParser.processFile(file, (results) => {
    State.setData(results.data, results.meta.fields || []);
    State.syncComposerForView(null, State.getActiveComposerColumns());
    renderColumnTabs();
    renderComposerPanel();
    runPipelineAndRender();
    onStatusChange?.('Ready');
  });
}
