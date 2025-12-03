import { State } from '../state.js';
import { elements } from './domElements.js';
import { triggerGraphUpdateOnly } from './dataPipeline.js';

function renderComposerPanel() {
    const { composerPanel, composerList } = elements;
    if (!composerPanel || !composerList) return;

    const activeColumns = State.getActiveComposerColumns();
    if (!activeColumns.length) {
        composerPanel.style.display = 'none';
        composerList.innerHTML = '';
        return;
    }

    const activeViewId = State.ui.activeMultiViewId || null;
    const composer = State.getComposer(activeViewId);

    composerPanel.style.display = 'block';

    composerList.innerHTML = '';

    composer.traces.forEach((trace, index) => {
        const row = document.createElement('div');
        row.className = 'composer-row';

        const label = document.createElement('div');
        label.className = 'composer-label';
        label.textContent = trace.columnId || `Trace ${index + 1}`;
        row.appendChild(label);

        const controls = document.createElement('div');
        controls.className = 'composer-controls';

        const xGroup = document.createElement('label');
        xGroup.className = 'composer-control';
        xGroup.textContent = 'X Offset (Samples)';
        const xInput = document.createElement('input');
        xInput.type = 'number';
        xInput.step = '1';
        const config = State.getTraceConfig(trace.columnId);
        xInput.value = config?.xOffset ?? 0;
        xInput.setAttribute('data-col', trace.columnId);
        xGroup.appendChild(xInput);
        controls.appendChild(xGroup);

        row.appendChild(controls);
        composerList.appendChild(row);

        let pendingNegativeTimer = null;

        const clearPendingNegative = () => {
            if (pendingNegativeTimer) {
                clearTimeout(pendingNegativeTimer);
                pendingNegativeTimer = null;
            }
        };

        xInput.addEventListener('input', () => {
            clearPendingNegative();

            const rawValue = xInput.value;

            if (rawValue === '-') {
                pendingNegativeTimer = setTimeout(() => {
                    xInput.value = 0;
                    State.updateTraceConfig(trace.columnId, { xOffset: 0 });
                    triggerGraphUpdateOnly();
                    pendingNegativeTimer = null;
                }, 1000);
                return;
            }

            const parsed = parseFloat(rawValue);
            const val = Number.isFinite(parsed) ? Math.round(parsed) : 0;
            xInput.value = val;
            State.updateTraceConfig(trace.columnId, { xOffset: val });
            triggerGraphUpdateOnly();
        });
    });
}

function bindComposerEvents() {
}

export { renderComposerPanel, bindComposerEvents };
