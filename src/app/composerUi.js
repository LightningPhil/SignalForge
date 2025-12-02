import { State } from '../state.js';
import { elements } from './domElements.js';
import { triggerGraphUpdateOnly } from './dataPipeline.js';

function renderComposerPanel() {
    const { composerPanel, composerList, chkWaterfall, inputWaterfallSpacing } = elements;
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

    if (chkWaterfall) chkWaterfall.checked = !!composer.waterfallMode;
    if (inputWaterfallSpacing) inputWaterfallSpacing.value = composer.waterfallSpacing ?? 0;

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

        xInput.addEventListener('input', () => {
            const val = Number.isFinite(parseFloat(xInput.value)) ? Math.round(parseFloat(xInput.value)) : 0;
            xInput.value = val;
            State.updateTraceConfig(trace.columnId, { xOffset: val });
            triggerGraphUpdateOnly();
        });
    });
}

function bindComposerEvents() {
    const { chkWaterfall, inputWaterfallSpacing } = elements;

    chkWaterfall?.addEventListener('change', () => {
        State.setComposerWaterfall(State.ui.activeMultiViewId || null, !!chkWaterfall.checked);
        renderComposerPanel();
        triggerGraphUpdateOnly();
    });

    inputWaterfallSpacing?.addEventListener('input', () => {
        const spacing = parseFloat(inputWaterfallSpacing.value);
        State.setComposerWaterfallSpacing(State.ui.activeMultiViewId || null, Number.isFinite(spacing) ? spacing : 0);
        renderComposerPanel();
        triggerGraphUpdateOnly();
    });
}

export { renderComposerPanel, bindComposerEvents };
