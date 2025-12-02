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

        const timeGroup = document.createElement('label');
        timeGroup.className = 'composer-control';
        timeGroup.textContent = 'Time Offset';
        const timeInput = document.createElement('input');
        timeInput.type = 'number';
        const sampleStep = State.estimateTimeStep();
        timeInput.step = sampleStep || '0.000001';
        timeInput.value = trace.timeOffset ?? 0;
        timeInput.setAttribute('data-col', trace.columnId);
        timeGroup.appendChild(timeInput);
        controls.appendChild(timeGroup);

        const yGroup = document.createElement('label');
        yGroup.className = 'composer-control';
        yGroup.textContent = 'Y Offset';
        const yInput = document.createElement('input');
        yInput.type = 'number';
        yInput.step = '0.1';
        yInput.value = trace.yOffset ?? 0;
        yInput.setAttribute('data-col', trace.columnId);
        yGroup.appendChild(yInput);
        controls.appendChild(yGroup);

        row.appendChild(controls);
        composerList.appendChild(row);

        timeInput.addEventListener('input', () => {
            const val = parseFloat(timeInput.value) || 0;
            const snap = sampleStep ? Math.round(val / sampleStep) * sampleStep : val;
            timeInput.value = snap;
            State.updateComposerTrace(activeViewId, trace.columnId, { timeOffset: snap });
            triggerGraphUpdateOnly();
        });

        yInput.addEventListener('input', () => {
            const val = parseFloat(yInput.value) || 0;
            State.updateComposerTrace(activeViewId, trace.columnId, { yOffset: val });
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
