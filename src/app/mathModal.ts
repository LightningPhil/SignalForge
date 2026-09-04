import { MathEngine } from '../processing/math';
import { State } from '../state';
import type { MathDefinition, MathVariable, SourceMode } from '../types';
import { ui } from '../ui/classes';
import { HelpSystem } from '../ui/helpSystem';
import { createModal, escapeHtml } from '../ui/uiHelpers';
import { runPipelineAndRender } from './dataPipeline';
import { activateTab, renderColumnTabs } from './tabs';
import { getTimeArray } from './traceData';

const SUGGESTED_SYMBOLS = ['A', 'B', 'C', 'D', 'E', 'F'];

function buildVariableRow(
  columns: string[],
  symbol = '',
  selected = '',
  sourceMode: SourceMode = 'raw',
  applyXOffset = true
): HTMLDivElement {
  const row = document.createElement('div');
  row.className =
    'math-row grid gap-2 rounded-md border border-line bg-surface p-2 sm:grid-cols-[minmax(0,1fr)_7rem_7rem_auto_auto] sm:items-center';

  const select = document.createElement('select');
  select.className = 'sf-field';
  select.setAttribute('data-role', 'column');
  select.setAttribute('aria-label', 'Source column');
  columns.forEach((col) => {
    const option = document.createElement('option');
    option.value = col;
    option.textContent = col;
    if (col === selected) option.selected = true;
    select.appendChild(option);
  });

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'sf-field';
  input.placeholder = 'Symbol (e.g., V)';
  input.maxLength = 8;
  input.value = symbol;
  input.setAttribute('aria-label', 'Variable symbol');

  const sourceSelect = document.createElement('select');
  sourceSelect.className = 'sf-field';
  sourceSelect.setAttribute('data-role', 'source');
  sourceSelect.setAttribute('aria-label', 'Source mode');
  (['raw', 'filtered'] as const).forEach((mode) => {
    const option = document.createElement('option');
    option.value = mode;
    option.textContent = mode === 'raw' ? 'Raw' : 'Filtered';
    if (mode === sourceMode) option.selected = true;
    sourceSelect.appendChild(option);
  });

  const shiftToggle = document.createElement('label');
  shiftToggle.className = ui.toggleLabel;
  const shiftCheckbox = document.createElement('input');
  shiftCheckbox.type = 'checkbox';
  shiftCheckbox.className = 'h-4 w-4 accent-accent';
  shiftCheckbox.setAttribute('data-role', 'apply-x');
  shiftCheckbox.checked = applyXOffset;
  shiftToggle.append(shiftCheckbox, document.createTextNode('Apply X Shift'));

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'sf-btn';
  removeBtn.setAttribute('aria-label', 'Remove variable');
  removeBtn.textContent = '✖';
  removeBtn.addEventListener('click', () => row.remove());

  row.append(select, input, sourceSelect, shiftToggle, removeBtn);
  return row;
}

function validateVariables(rows: HTMLElement[]): MathVariable[] {
  const variables: MathVariable[] = [];
  const usedSymbols = new Set<string>();

  rows.forEach((row) => {
    const select = row.querySelector<HTMLSelectElement>('select[data-role="column"]');
    const input = row.querySelector<HTMLInputElement>('input[type="text"]');
    const sourceSelect = row.querySelector<HTMLSelectElement>('select[data-role="source"]');
    const shiftCheckbox = row.querySelector<HTMLInputElement>('input[data-role="apply-x"]');
    const symbol = input?.value.trim() ?? '';
    if (!symbol || !select) return;
    const safeSymbol = symbol.replace(/[^a-zA-Z0-9_]/g, '');
    if (!safeSymbol || usedSymbols.has(safeSymbol)) return;
    const source = sourceSelect?.value === 'filtered' ? 'filtered' : 'raw';
    variables.push({
      columnId: select.value,
      symbol: safeSymbol,
      sourceMode: source,
      applyXOffset: shiftCheckbox?.checked !== false
    });
    usedSymbols.add(safeSymbol);
  });

  return variables;
}

function showValidationErrors(errors: string[] = []): void {
  const html = `
    <h3 class="${ui.modalTitle}">Math Expression Errors</h3>
    <p class="mb-3 text-sm">Please address the following issues before creating the trace:</p>
    <ul class="mb-4 list-disc space-y-1 pl-5 text-sm text-muted">${errors.map((err) => `<li>${escapeHtml(err)}</li>`).join('')}</ul>
    <div class="${ui.modalActions}">
      <button class="sf-btn sf-btn-primary" id="btn-close-validation" type="button">Close</button>
    </div>
  `;
  const modal = createModal(html);
  modal.querySelector('#btn-close-validation')?.addEventListener('click', () => modal.parentElement?.remove());
}

export function showMathModal(existingDef: MathDefinition | null = null): void {
  const headers = State.data.headers || [];
  const timeCol = State.data.timeColumn;
  const baseColumns = headers.filter((h) => h !== timeCol);
  const availableColumns = [...new Set([...baseColumns, ...MathEngine.getAvailableMathColumns()])];

  if (availableColumns.length === 0) {
    alert('Load a dataset to build a math trace.');
    return;
  }

  const defaultName =
    existingDef?.name || `MathTrace ${State.config.mathDefinitions ? State.config.mathDefinitions.length + 1 : 1}`;
  const modalTitle = existingDef ? 'Edit Advanced Math Trace' : 'Create Advanced Math Trace';
  const submitLabel = existingDef ? 'Update Trace' : 'Create Trace';

  const html = `
    <h3 class="${ui.modalTitle}">${modalTitle}</h3>
    <p class="sf-hint mb-3">Map variables to traces, then enter a math.js expression. Helpers: <code>diff(x)</code>, <code>cumsum(x)</code>, <code>mean(...)</code>. Time arrays are available as <code>t</code> and timestep as <code>dt</code>.</p>
    <div class="mb-3">
      <button class="sf-btn" id="btn-open-math-help" type="button">Open math help</button>
    </div>
    <div class="mb-3 grid gap-2" id="math-var-grid"></div>
    <button class="sf-btn mb-4" id="btn-add-var" type="button">Add Variable</button>
    <label for="math-expression" class="sf-label">Expression</label>
    <textarea id="math-expression" class="sf-field font-mono" rows="3" placeholder="e.g. (V1 - V2) / 0.5"></textarea>
    <label for="math-name" class="sf-label">Trace Name</label>
    <input id="math-name" class="sf-field" value="${escapeHtml(defaultName)}" ${existingDef ? 'disabled' : ''}>
    <div class="${ui.modalActions}">
      <button class="sf-btn" id="btn-cancel-math" type="button">Cancel</button>
      <button class="sf-btn sf-btn-primary" id="btn-create-math" type="button">${submitLabel}</button>
    </div>
  `;

  const modal = createModal(html);
  const overlay = modal.parentElement;
  const grid = modal.querySelector('#math-var-grid');
  const addBtn = modal.querySelector('#btn-add-var');
  const exprInput = modal.querySelector<HTMLTextAreaElement>('#math-expression');
  const nameInput = modal.querySelector<HTMLInputElement>('#math-name');
  const cancelBtn = modal.querySelector('#btn-cancel-math');
  const createBtn = modal.querySelector('#btn-create-math');

  if (!grid || !addBtn || !exprInput || !nameInput || !cancelBtn || !createBtn) return;

  const addRow = (symbol = '', column = '', sourceMode: SourceMode = 'raw', applyXOffset = true) => {
    grid.appendChild(
      buildVariableRow(availableColumns, symbol, column || availableColumns[0], sourceMode, applyXOffset)
    );
  };

  if (existingDef && Array.isArray(existingDef.variables)) {
    existingDef.variables.forEach((v, idx) => {
      addRow(
        v.symbol || SUGGESTED_SYMBOLS[idx] || `V${idx + 1}`,
        v.columnId || availableColumns[0],
        v.sourceMode || 'raw',
        v.applyXOffset !== false
      );
    });
  } else {
    addRow(SUGGESTED_SYMBOLS[0] || 'A');
    if (availableColumns.length > 1) addRow(SUGGESTED_SYMBOLS[1] || 'B', availableColumns[1]);
  }

  addBtn.addEventListener('click', () => addRow());
  cancelBtn.addEventListener('click', () => overlay?.remove());
  modal.querySelector('#btn-open-math-help')?.addEventListener('click', () => HelpSystem.show('math-trace-tabs'));
  if (existingDef?.expression) exprInput.value = existingDef.expression;

  createBtn.addEventListener('click', () => {
    const rows = Array.from(grid.querySelectorAll<HTMLElement>('.math-row'));
    const variables = validateVariables(rows);
    const expression = exprInput.value.trim();
    const name = nameInput.value.trim() || defaultName;
    const rawTime = timeCol ? getTimeArray() : [];
    const validation = MathEngine.validateDefinition({ name, expression, variables }, rawTime);

    if (!validation.ok) {
      showValidationErrors(validation.errors);
      return;
    }
    if (variables.length === 0) {
      alert('Assign at least one variable.');
      return;
    }
    if (!expression) {
      alert('Enter an expression to compute.');
      return;
    }

    State.addMathDefinition({ name, expression, variables });

    if (!existingDef) {
      State.data.dataColumn = name;
      State.ui.activeMultiViewId = null;
      activateTab({ columnId: name });
      renderColumnTabs();
      overlay?.remove();
      return;
    }

    if (!State.ui.activeMultiViewId && State.data.dataColumn === existingDef.name) {
      activateTab({ columnId: name });
    } else {
      runPipelineAndRender();
    }
    renderColumnTabs();
    overlay?.remove();
  });
}
