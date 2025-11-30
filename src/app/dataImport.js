import { State } from '../state.js';
import { CsvParser } from '../io/csvParser.js';
import { renderColumnTabs } from './tabs.js';
import { runPipelineAndRender } from './dataPipeline.js';

function handleFileSelection(file, onStatusChange) {
    if (!file) return;

    onStatusChange?.('Loading...');
    State.data.raw = [];
    State.data.processed = [];

    CsvParser.processFile(file, (results) => {
        State.setData(results.data, results.meta.fields);
        renderColumnTabs();
        runPipelineAndRender();
        onStatusChange?.('Ready');
    });
}

export { handleFileSelection };
