import { State } from '../state.js';
import { createModal } from './uiHelpers.js';
import { runPipelineAndRender } from '../app/dataPipeline.js';

function parseCsvFile(file, onComplete) {
    if (!file) return;
    if (typeof Papa !== 'undefined') {
        Papa.parse(file, {
            complete: (results) => onComplete(results.data || [])
        });
        return;
    }

    const reader = new FileReader();
    reader.onload = () => {
        const text = reader.result || '';
        const rows = text.split(/\r?\n/).map((line) => line.split(',')).filter((r) => r.some(Boolean));
        onComplete(rows);
    };
    reader.readAsText(file);
}

export const ReferenceGrid = {
    show() {
        const modal = createModal(`
            <h3>Reference Curve</h3>
            <p class="hint">Enter X/Y coordinates or import from CSV. Only two columns are supported.</p>
            <div class="reference-grid-actions">
                <button id="ref-add-row">Add Row</button>
                <button id="ref-import">Import CSV</button>
                <button id="ref-clear-rows">Clear</button>
            </div>
            <label for="ref-name">Name</label>
            <input type="text" id="ref-name" value="Reference ${State.referenceTraces.length + 1}">
            <table class="data-grid-table reference-grid-table">
                <thead>
                    <tr><th>X</th><th>Y</th></tr>
                </thead>
                <tbody id="ref-grid-body"></tbody>
            </table>
            <div class="reference-grid-actions">
                <button class="primary" id="ref-apply">Add to Plot</button>
                <button id="ref-cancel">Close</button>
            </div>
            <input type="file" id="ref-file-input" accept=".csv,.txt" style="display:none;">
        `);

        const overlay = modal.parentElement;
        const tbody = modal.querySelector('#ref-grid-body');
        const fileInput = modal.querySelector('#ref-file-input');
        const nameInput = modal.querySelector('#ref-name');

        const addRow = (x = '', y = '') => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td><input type="text" value="${x}"></td>
                <td><input type="text" value="${y}"></td>
            `;
            tbody.appendChild(row);
        };

        const parseRows = () => {
            const points = [];
            tbody.querySelectorAll('tr').forEach((tr) => {
                const inputs = tr.querySelectorAll('input');
                if (inputs.length < 2) return;
                const xVal = parseFloat(inputs[0].value);
                const yVal = parseFloat(inputs[1].value);
                if (Number.isFinite(xVal) && Number.isFinite(yVal)) {
                    points.push({ x: xVal, y: yVal });
                }
            });
            return points;
        };

        const setRows = (rows) => {
            tbody.innerHTML = '';
            rows.forEach(([x, y]) => addRow(x ?? '', y ?? ''));
            if (!rows.length) {
                for (let i = 0; i < 5; i++) addRow();
            }
        };

        const handleFile = (file) => {
            parseCsvFile(file, (rows) => {
                const mapped = rows
                    .map((r) => r.slice(0, 2))
                    .filter((r) => r.length === 2 && r.some((cell) => cell !== ''));
                setRows(mapped);
            });
        };

        setRows([]);

        modal.querySelector('#ref-add-row')?.addEventListener('click', () => addRow());
        modal.querySelector('#ref-import')?.addEventListener('click', () => fileInput?.click());
        modal.querySelector('#ref-clear-rows')?.addEventListener('click', () => setRows([]));
        modal.querySelector('#ref-cancel')?.addEventListener('click', () => overlay.remove());

        fileInput?.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            fileInput.value = '';
        });

        modal.querySelector('#ref-apply')?.addEventListener('click', () => {
            const points = parseRows();
            if (!points.length) {
                alert('Please enter at least one valid coordinate pair.');
                return;
            }

            const name = (nameInput?.value || '').trim() || `Reference ${State.referenceTraces.length + 1}`;
            const x = points.map((p) => p.x);
            const y = points.map((p) => p.y);

            State.addReferenceTrace({ name, x, y });
            runPipelineAndRender();
            overlay.remove();
        });
    }
};
