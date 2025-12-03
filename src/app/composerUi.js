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

        let debounceTimer;
        const commitOffset = (value) => {
            State.updateTraceConfig(trace.columnId, { xOffset: value });
            triggerGraphUpdateOnly();
        };

        xInput.addEventListener('input', () => {
            const rawValue = xInput.value;

            clearTimeout(debounceTimer);

            if (rawValue === '-' || rawValue === '') {
                return;
            }

            const parsed = parseFloat(rawValue);

            if (!Number.isFinite(parsed)) {
                return;
            }

            const val = Math.round(parsed);

            debounceTimer = setTimeout(() => {
                commitOffset(val);
            }, 500);
        });

        xInput.addEventListener('blur', () => {
            const rawValue = xInput.value;
            clearTimeout(debounceTimer);

            const parsed = parseFloat(rawValue);
            const isInvalid = rawValue === '-' || rawValue === '' || !Number.isFinite(parsed);
            const val = isInvalid ? 0 : Math.round(parsed);

            if (isInvalid) {
                xInput.value = '0';
            }

            commitOffset(val);
        });
    });
}

function bindComposerEvents() {
}

export { renderComposerPanel, bindComposerEvents };
