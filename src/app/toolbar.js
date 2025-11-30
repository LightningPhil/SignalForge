import { State } from '../state.js';
import { elements } from './domElements.js';
import { triggerGraphUpdateOnly } from './dataPipeline.js';

function bindToolbarEvents() {
    const { liveShowRaw, liveRawOpacity, liveShowDiff, liveFreqDomain } = elements;

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

    if (liveFreqDomain) {
        liveFreqDomain.addEventListener('change', (e) => {
            State.config.graph.showFreqDomain = e.target.checked;
            const diffGroup = liveShowDiff?.parentElement?.parentElement;
            if (diffGroup) diffGroup.style.display = e.target.checked ? 'none' : 'flex';
            triggerGraphUpdateOnly();
        });
    }
}

function updateToolbarUIFromState() {
    const { liveShowRaw, liveRawOpacity, liveShowDiff, liveFreqDomain } = elements;
    const cfg = State.config.graph;
    if (liveShowRaw) {
        liveShowRaw.checked = cfg.showRaw !== false;
        if (liveRawOpacity) liveRawOpacity.disabled = !liveShowRaw.checked;
    }
    if (liveRawOpacity) liveRawOpacity.value = cfg.rawOpacity || 0.5;
    if (liveShowDiff) liveShowDiff.checked = cfg.showDifferential;
    if (liveFreqDomain) liveFreqDomain.checked = cfg.showFreqDomain;
}

export { bindToolbarEvents, updateToolbarUIFromState };
