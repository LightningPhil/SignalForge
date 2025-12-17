import { State } from '../state.js';
import { elements } from './domElements.js';
import { triggerGraphUpdateOnly } from './dataPipeline.js';

function bindToolbarEvents() {
    const { liveShowRaw, liveRawOpacity, liveShowDiff, liveViewMode, liveShowEvents } = elements;

    if (liveShowRaw) {
        liveShowRaw.addEventListener('change', (e) => {
            State.config.graph.showRaw = e.target.checked;
            if (liveRawOpacity) {
                liveRawOpacity.disabled = !e.target.checked;
                liveRawOpacity.parentElement.style.opacity = e.target.checked ? '1' : '0.5';
            }
            triggerGraphUpdateOnly();
        });
    }

    if (liveRawOpacity) {
        liveRawOpacity.addEventListener('input', (e) => {
            State.config.graph.rawOpacity = parseFloat(e.target.value);
            triggerGraphUpdateOnly();
        });
    }

    if (liveShowDiff) {
        liveShowDiff.addEventListener('change', (e) => {
            State.config.graph.showDifferential = e.target.checked;
            triggerGraphUpdateOnly();
        });
    }

    if (liveViewMode) {
        liveViewMode.addEventListener('change', (e) => {
            const mode = e.target.value || 'time';
            State.config.graph.viewMode = mode;
            State.config.graph.showFreqDomain = mode === 'fft';
            const diffGroup = liveShowDiff?.parentElement?.parentElement;
            if (diffGroup) diffGroup.style.display = mode === 'time' ? 'flex' : 'none';
            triggerGraphUpdateOnly();
        });
    }

    if (liveShowEvents) {
        liveShowEvents.addEventListener('change', (e) => {
            State.ensureAnalysisConfig().showEvents = e.target.checked;
            triggerGraphUpdateOnly();
        });
    }
}

function updateToolbarUIFromState() {
    const { liveShowRaw, liveRawOpacity, liveShowDiff, liveViewMode, liveShowEvents } = elements;
    const cfg = State.config.graph;
    const mode = cfg.viewMode || (cfg.showFreqDomain ? 'fft' : 'time');
    if (liveShowRaw) {
        liveShowRaw.checked = cfg.showRaw !== false;
        if (liveRawOpacity) liveRawOpacity.disabled = !liveShowRaw.checked;
    }
    if (liveRawOpacity) liveRawOpacity.value = cfg.rawOpacity || 0.5;
    if (liveShowDiff) liveShowDiff.checked = cfg.showDifferential;
    if (liveViewMode) liveViewMode.value = mode;
    const diffGroup = liveShowDiff?.parentElement?.parentElement;
    if (diffGroup) diffGroup.style.display = mode === 'time' ? 'flex' : 'none';
    if (liveShowEvents) liveShowEvents.checked = State.ensureAnalysisConfig().showEvents !== false;
}

export { bindToolbarEvents, updateToolbarUIFromState };
