import { createModal } from '../ui/uiHelpers.js';
import { State } from '../state.js';
import { MathEngine } from '../processing/math.js';
import { renderColumnTabs } from './tabs.js';
import { runPipelineAndRender } from './dataPipeline.js';
import { HelpSystem } from '../ui/helpSystem.js';

const SUGGESTED_SYMBOLS = ['A', 'B', 'C', 'D', 'E', 'F'];

function buildVariableRow(columns, symbol = '', selected = '') {
    const row = document.createElement('div');
    row.className = 'math-row';

    const select = document.createElement('select');
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

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'icon-button';
    removeBtn.textContent = '✖';

    row.appendChild(select);
    row.appendChild(input);
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
        const select = row.querySelector('select');
        const input = row.querySelector('input');
        const symbol = input.value.trim();

        if (!symbol) return;
        const safeSymbol = symbol.replace(/[^a-zA-Z0-9_]/g, '');
        if (!safeSymbol) return;
        if (usedSymbols.has(safeSymbol)) return;

        variables.push({ columnId: select.value, symbol: safeSymbol });
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

function showMathModal() {
    const headers = State.data.headers || [];
    const timeCol = State.data.timeColumn;
    const baseColumns = headers.filter((h) => h !== timeCol);
    const virtualCols = MathEngine.getAvailableMathColumns();
    const availableColumns = [...new Set([...baseColumns, ...virtualCols])];

    if (availableColumns.length === 0) {
        alert('Load a dataset to build a math trace.');
        return;
    }

    const defaultName = `MathTrace ${State.config.mathDefinitions ? State.config.mathDefinitions.length + 1 : 1}`;

    const html = `
        <h3>Create Advanced Math Trace</h3>
        <p class="hint">Map variables to traces, then enter a math.js expression. Helpers: <code>diff(x)</code>, <code>cumsum(x)</code>, <code>mean(...)</code>. Time arrays are available as <code>t</code> and timestep as <code>dt</code>.</p>
        <div class="inline-help-row"><button class="inline-help-button" id="btn-open-math-help" type="button">Open math help</button></div>
        <div class="math-grid" id="math-var-grid"></div>
        <button class="secondary" id="btn-add-var">Add Variable</button>
        <label for="math-expression" class="math-label">Expression</label>
        <textarea id="math-expression" rows="3" placeholder="e.g. (V1 - V2) / 0.5"></textarea>
        <label for="math-name" class="math-label">Trace Name</label>
        <input id="math-name" value="${defaultName}">
        <div class="modal-actions">
            <button class="secondary" id="btn-cancel-math">Cancel</button>
            <button class="primary" id="btn-create-math">Create Trace</button>
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

    const addRow = (symbol = '', column = '') => {
        const row = buildVariableRow(availableColumns, symbol, column || availableColumns[0]);
        grid.appendChild(row);
    };

    const seedRows = () => {
        if (availableColumns.length === 0) return;
        addRow(SUGGESTED_SYMBOLS[0] || 'A');
        if (availableColumns.length > 1) addRow(SUGGESTED_SYMBOLS[1] || 'B', availableColumns[1]);
    };

    addBtn.addEventListener('click', () => addRow());
    cancelBtn.addEventListener('click', () => overlay.remove());
    helpBtn?.addEventListener('click', () => HelpSystem.show('math-trace-tabs'));
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
        State.data.dataColumn = name;
        State.ui.activeMultiViewId = null;
        runPipelineAndRender();
        overlay.remove();
    });

    seedRows();
}

export { showMathModal };
