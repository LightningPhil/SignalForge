import { createModal } from '../ui/uiHelpers.js';
import { State } from '../state.js';
import { MathEngine } from '../processing/math.js';
import { renderColumnTabs } from './tabs.js';
import { runPipelineAndRender } from './dataPipeline.js';
import { HelpSystem } from '../ui/helpSystem.js';

const SUGGESTED_SYMBOLS = ['A', 'B', 'C', 'D', 'E', 'F'];

function buildVariableRow(columns, symbol = '', selected = '', sourceMode = 'raw', applyXOffset = true) {
    const row = document.createElement('div');
    row.className = 'math-row';

    const select = document.createElement('select');
    select.setAttribute('data-role', 'column');
    columns.forEach((col) => {
        const option = document.createElement('option');
        option.value = col;
        option.textContent = col;
        if (col === selected) option.selected = true;
        select.appendChild(option);
    });

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Symbol (e.g., V)';
    input.maxLength = 8;
    input.value = symbol;

    const sourceSelect = document.createElement('select');
    sourceSelect.setAttribute('data-role', 'source');
    ['raw', 'filtered'].forEach((mode) => {
        const option = document.createElement('option');
        option.value = mode;
        option.textContent = mode === 'raw' ? 'Raw' : 'Filtered';
        if (mode === sourceMode) option.selected = true;
        sourceSelect.appendChild(option);
    });

    const shiftToggle = document.createElement('label');
    shiftToggle.className = 'toggle-label math-shift-toggle';
    const shiftCheckbox = document.createElement('input');
    shiftCheckbox.type = 'checkbox';
    shiftCheckbox.setAttribute('data-role', 'apply-x');
    shiftCheckbox.checked = applyXOffset;
    shiftToggle.appendChild(shiftCheckbox);
    shiftToggle.appendChild(document.createTextNode('Apply X Shift'));

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'icon-button';
    removeBtn.textContent = '✖';

    row.appendChild(select);
    row.appendChild(input);
    row.appendChild(sourceSelect);
    row.appendChild(shiftToggle);
    row.appendChild(removeBtn);

    removeBtn.addEventListener('click', () => {
        row.remove();
    });

    return row;
}

function validateVariables(rows) {
    const variables = [];
    const usedSymbols = new Set();

    rows.forEach((row) => {
        const select = row.querySelector('select[data-role="column"]');
        const input = row.querySelector('input[type="text"]');
        const sourceSelect = row.querySelector('select[data-role="source"]');
        const shiftCheckbox = row.querySelector('input[data-role="apply-x"]');
        const symbol = input.value.trim();

        if (!symbol) return;
        const safeSymbol = symbol.replace(/[^a-zA-Z0-9_]/g, '');
        if (!safeSymbol) return;
        if (usedSymbols.has(safeSymbol)) return;

        variables.push({
            columnId: select.value,
            symbol: safeSymbol,
            sourceMode: sourceSelect?.value || 'raw',
            applyXOffset: shiftCheckbox?.checked !== false
        });
        usedSymbols.add(safeSymbol);
    });

    return variables;
}

function showValidationErrors(errors = []) {
    const listItems = errors.map((err) => `<li>${err}</li>`).join('');
    const html = `
        <h3>Math Expression Errors</h3>
        <p>Please address the following issues before creating the trace:</p>
        <ul class="error-list">${listItems}</ul>
        <div class="modal-actions">
            <button class="primary" id="btn-close-validation" type="button">Close</button>
        </div>
    `;

    const modal = createModal(html);
    const overlay = modal.parentElement;
    modal.querySelector('#btn-close-validation')?.addEventListener('click', () => overlay.remove());
}

function showMathModal(existingDef = null) {
    const headers = State.data.headers || [];
    const timeCol = State.data.timeColumn;
    const baseColumns = headers.filter((h) => h !== timeCol);
    const virtualCols = MathEngine.getAvailableMathColumns();
    const availableColumns = [...new Set([...baseColumns, ...virtualCols])];

    if (availableColumns.length === 0) {
        alert('Load a dataset to build a math trace.');
        return;
    }

    const defaultName = existingDef?.name
        || `MathTrace ${State.config.mathDefinitions ? State.config.mathDefinitions.length + 1 : 1}`;
    const modalTitle = existingDef ? 'Edit Advanced Math Trace' : 'Create Advanced Math Trace';
    const submitLabel = existingDef ? 'Update Trace' : 'Create Trace';

    const html = `
        <h3>${modalTitle}</h3>
        <p class="hint">Map variables to traces, then enter a math.js expression. Helpers: <code>diff(x)</code>, <code>cumsum(x)</code>, <code>mean(...)</code>. Time arrays are available as <code>t</code> and timestep as <code>dt</code>.</p>
        <div class="inline-help-row"><button class="inline-help-button" id="btn-open-math-help" type="button">Open math help</button></div>
        <div class="math-grid" id="math-var-grid"></div>
        <button class="secondary" id="btn-add-var">Add Variable</button>
        <label for="math-expression" class="math-label">Expression</label>
        <textarea id="math-expression" rows="3" placeholder="e.g. (V1 - V2) / 0.5"></textarea>
        <label for="math-name" class="math-label">Trace Name</label>
        <input id="math-name" value="${defaultName}" ${existingDef ? 'disabled' : ''}>
        <div class="modal-actions">
            <button class="secondary" id="btn-cancel-math">Cancel</button>
            <button class="primary" id="btn-create-math">${submitLabel}</button>
        </div>
    `;

    const modal = createModal(html);
    const overlay = modal.parentElement;
    const grid = modal.querySelector('#math-var-grid');
    const addBtn = modal.querySelector('#btn-add-var');
    const exprInput = modal.querySelector('#math-expression');
    const nameInput = modal.querySelector('#math-name');
    const cancelBtn = modal.querySelector('#btn-cancel-math');
    const createBtn = modal.querySelector('#btn-create-math');
    const helpBtn = modal.querySelector('#btn-open-math-help');

    const addRow = (symbol = '', column = '', sourceMode = 'raw', applyXOffset = true) => {
        const row = buildVariableRow(availableColumns, symbol, column || availableColumns[0], sourceMode, applyXOffset);
        grid.appendChild(row);
    };

    const seedRows = () => {
        if (availableColumns.length === 0) return;

        if (existingDef && Array.isArray(existingDef.variables)) {
            existingDef.variables.forEach((v, idx) => {
                const fallbackSymbol = SUGGESTED_SYMBOLS[idx] || `V${idx + 1}`;
                addRow(
                    v.symbol || fallbackSymbol,
                    v.columnId || availableColumns[0],
                    v.sourceMode || 'raw',
                    v.applyXOffset !== false
                );
            });
            return;
        }

        addRow(SUGGESTED_SYMBOLS[0] || 'A');
        if (availableColumns.length > 1) addRow(SUGGESTED_SYMBOLS[1] || 'B', availableColumns[1]);
    };

    addBtn.addEventListener('click', () => addRow());
    cancelBtn.addEventListener('click', () => overlay.remove());
    helpBtn?.addEventListener('click', () => HelpSystem.show('math-trace-tabs'));
    if (existingDef?.expression) exprInput.value = existingDef.expression;

    createBtn.addEventListener('click', () => {
        const rows = Array.from(grid.querySelectorAll('.math-row'));
        const variables = validateVariables(rows);
        const expression = exprInput.value.trim();
        const name = nameInput.value.trim() || defaultName;

        const rawTime = timeCol ? State.data.raw.map((r) => parseFloat(r[timeCol])) : [];
        const validation = MathEngine.validateDefinition({
            name,
            expression,
            variables
        }, rawTime);

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

        State.addMathDefinition({
            name,
            expression,
            variables
        });

        renderColumnTabs();
        const shouldActivate = !existingDef || State.data.dataColumn === existingDef.name;
        if (shouldActivate) {
            State.data.dataColumn = name;
            State.ui.activeMultiViewId = null;
        }
        runPipelineAndRender();
        overlay.remove();
    });

    seedRows();
}

export { showMathModal };
