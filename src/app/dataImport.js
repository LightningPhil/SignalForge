import { State } from '../state.js';
import { CsvParser } from '../io/csvParser.js';
import { renderColumnTabs } from './tabs.js';
import { runPipelineAndRender } from './dataPipeline.js';
import { renderComposerPanel } from './composerUi.js';

function handleFileSelection(file, onStatusChange) {
    if (!file) return;

    onStatusChange?.('Loading...');
    State.data.raw = [];
    State.data.processed = [];

    CsvParser.processFile(file, (results) => {
        State.setData(results.data, results.meta.fields);
        State.syncComposerForView(null, State.getActiveComposerColumns());
        renderColumnTabs();
        renderComposerPanel();
        runPipelineAndRender();
        onStatusChange?.('Ready');
    });
}

export { handleFileSelection };
