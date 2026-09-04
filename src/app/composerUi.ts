import { State } from '../state';
import { ui } from '../ui/classes';
import { triggerGraphUpdateOnly } from './dataPipeline';
import { elements } from './domElements';

export function renderComposerPanel(): void {
  const { composerPanel, composerList } = elements;
  if (!composerPanel || !composerList) return;

  const activeColumns = State.getActiveComposerColumns();
  const isSingleMathTrace =
    !State.ui.activeMultiViewId && activeColumns.length === 1 && !!State.getMathDefinition(activeColumns[0]);

  if (isSingleMathTrace || !activeColumns.length) {
    composerPanel.classList.add('hidden');
    composerList.innerHTML = '';
    return;
  }

  const composer = State.getComposer(State.ui.activeMultiViewId || null);
  composerPanel.classList.remove('hidden');
  composerList.innerHTML = '';

  composer.traces.forEach((trace, index) => {
    const row = document.createElement('div');
    row.className = ui.composerRow;

    const label = document.createElement('div');
    label.className = 'mb-1.5 font-semibold text-main';
    label.textContent = trace.columnId || `Trace ${index + 1}`;
    row.appendChild(label);

    const xGroup = document.createElement('label');
    xGroup.className = 'flex flex-col gap-1 text-sm text-muted';
    xGroup.textContent = 'X Offset (Samples)';
    const xInput = document.createElement('input');
    xInput.type = 'number';
    xInput.step = '1';
    xInput.className = 'sf-field w-36';
    xInput.value = String(State.getTraceConfig(trace.columnId).xOffset ?? 0);
    xInput.setAttribute('aria-label', `X offset for ${trace.columnId}`);
    xGroup.appendChild(xInput);
    row.appendChild(xGroup);
    composerList.appendChild(row);

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    const commitOffset = (value: number) => {
      State.updateTraceConfig(trace.columnId, { xOffset: value });
      triggerGraphUpdateOnly();
    };

    xInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      if (xInput.value === '-' || xInput.value === '') return;
      const parsed = parseFloat(xInput.value);
      if (!Number.isFinite(parsed)) return;
      debounceTimer = setTimeout(() => commitOffset(Math.round(parsed)), 500);
    });

    xInput.addEventListener('blur', () => {
      clearTimeout(debounceTimer);
      const parsed = parseFloat(xInput.value);
      const invalid = xInput.value === '-' || xInput.value === '' || !Number.isFinite(parsed);
      const val = invalid ? 0 : Math.round(parsed);
      if (invalid) xInput.value = '0';
      commitOffset(val);
    });
  });
}

export function bindComposerEvents(): void {}
