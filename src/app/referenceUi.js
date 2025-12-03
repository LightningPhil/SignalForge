import { State } from '../state.js';
import { elements } from './domElements.js';
import { runPipelineAndRender } from './dataPipeline.js';

function getActiveViewId() {
    return State.ui.activeMultiViewId || null;
}

function renderEmptyState(referenceList) {
    referenceList.innerHTML = '<p class="hint">Upload a reference curve to enable toggles.</p>';
}

export function renderReferencePanel() {
    const { referencePanel, referenceList } = elements;
    if (!referencePanel || !referenceList) return;

    const refs = State.referenceTraces || [];
    if (!refs.length) {
        referencePanel.style.display = 'none';
        renderEmptyState(referenceList);
        return;
    }

    referencePanel.style.display = 'block';
    const activeViewId = getActiveViewId();

    const rows = refs.map((ref) => {
        const checked = State.isReferenceVisible(activeViewId, ref.id) ? 'checked' : '';
        const safeName = ref.name.replace(/"/g, '&quot;');
        return `<label class="toggle-label"><input type="checkbox" data-ref="${ref.id}" ${checked}> ${safeName}</label>`;
    }).join('');

    if (!rows) {
        renderEmptyState(referenceList);
        return;
    }

    referenceList.innerHTML = rows;

    referenceList.querySelectorAll('input[type="checkbox"]').forEach((chk) => {
        chk.addEventListener('change', () => {
            const refId = chk.getAttribute('data-ref');
            State.setReferenceVisibility(activeViewId, refId, chk.checked);
            runPipelineAndRender();
        });
    });
}
