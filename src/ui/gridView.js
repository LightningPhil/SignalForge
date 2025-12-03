import { State } from '../state.js';
import { Config } from '../config.js';
import { createModal } from './uiHelpers.js';
import { runPipelineAndRender } from '../app/dataPipeline.js';

const ROW_HEIGHT = 32;
const BUFFER_ROWS = 10;

function parseClipboard(text) {
    const normalized = text.replace(/\r\n/g, '\n').trim();
    if (!normalized) return [];
    const delimiter = normalized.includes('\t') ? '\t' : ',';
    return normalized
        .split('\n')
        .map((line) => line.split(delimiter))
        .filter((row) => row.some((cell) => cell !== ''));
}

function convertRowsToObjects(headers, rows) {
    return rows.map((cols) => {
        const obj = {};
        headers.forEach((h, idx) => {
            const rawVal = cols[idx];
            const numVal = rawVal === '' ? '' : parseFloat(rawVal);
            obj[h] = Number.isFinite(numVal) ? numVal : (rawVal ?? '');
        });
        return obj;
    });
}

function getExistingValue(row, header) {
    if (!row || typeof row !== 'object') return '';
    return row[header] ?? '';
}

export const GridView = {
    selectedCell: null,

    setSelectedCell(row, col) {
        this.selectedCell = { row, col };
    },

    ensureColumns(headers, row) {
        if (!row) return {};
        headers.forEach((h) => {
            if (!(h in row)) row[h] = '';
        });
        return row;
    },

    updateStateData(newHeaders, newRaw) {
        State.data.headers = newHeaders;
        State.data.raw = newRaw;
        State.data.processed = [];

        if (!newHeaders.includes(State.data.timeColumn)) {
            State.data.timeColumn = newHeaders[0] || null;
        }

        if (!newHeaders.includes(State.data.dataColumn)) {
            State.data.dataColumn = newHeaders.find((h) => h !== State.data.timeColumn) || newHeaders[1] || null;
        }
    },

    applyPasteData(clipboardRows) {
        if (!clipboardRows.length) return;

        const headers = State.data.headers.slice();
        const raw = State.data.raw.slice();

        if (this.selectedCell) {
            const { row: startRow, col: startCol } = this.selectedCell;
            clipboardRows.forEach((cols, rIdx) => {
                const targetRow = startRow + rIdx;
                if (!raw[targetRow]) raw[targetRow] = {};
                const rowObj = this.ensureColumns(headers, raw[targetRow]);

                cols.forEach((val, cIdx) => {
                    const header = headers[startCol + cIdx];
                    if (!header) return;
                    const parsed = parseFloat(val);
                    rowObj[header] = Number.isFinite(parsed) ? parsed : val;
                });
                raw[targetRow] = rowObj;
            });

            this.updateStateData(headers, raw);
            runPipelineAndRender();
            return;
        }

        const incomingHeaders = clipboardRows[0];
        const dataRows = clipboardRows.slice(1);

        if (!State.data.headers.length || State.data.raw.length === 0) {
            const looksLikeHeader = incomingHeaders.some((cell) => Number.isNaN(parseFloat(cell))) || dataRows.length > 0;
            const cleanHeaders = looksLikeHeader
                ? incomingHeaders
                : incomingHeaders.map((_, idx) => `Col ${idx + 1}`);
            const rows = convertRowsToObjects(cleanHeaders, dataRows.length ? dataRows : clipboardRows);
            this.updateStateData(cleanHeaders, rows);
            runPipelineAndRender();
            return;
        }

        const headersMatch = incomingHeaders.length === headers.length
            && incomingHeaders.every((h, idx) => h === headers[idx]);

        if (headersMatch) {
            const newRows = convertRowsToObjects(headers, dataRows);
            this.updateStateData(headers, [...raw, ...newRows]);
            runPipelineAndRender();
            return;
        }

        const confirmReplace = confirm('Pasted data headers do not match. Replace existing dataset with pasted content?');
        if (!confirmReplace) return;

        const replacementRows = convertRowsToObjects(incomingHeaders, dataRows.length ? dataRows : clipboardRows);
        this.updateStateData(incomingHeaders, replacementRows);
        runPipelineAndRender();
    },

    renderVisibleRows(tableBody, headers, data, startIndex, endIndex) {
        const rows = [];
        for (let i = startIndex; i < endIndex; i++) {
            const row = data[i] || {};
            const cells = headers.map((h, colIdx) => {
                let val = getExistingValue(row, h);
                if (typeof val === 'number') val = parseFloat(val.toFixed(4));
                const isSelected = this.selectedCell
                    && this.selectedCell.row === i
                    && this.selectedCell.col === colIdx;
                return `<td data-row="${i}" data-col="${colIdx}" class="${isSelected ? 'selected' : ''}">${val}</td>`;
            }).join('');
            rows.push(`<tr>${cells}</tr>`);
        }
        tableBody.innerHTML = rows.join('');
    },

    attachSelectionHandler(viewTable) {
        viewTable.addEventListener('click', (e) => {
            const cell = e.target.closest('td');
            if (!cell) return;
            const row = parseInt(cell.getAttribute('data-row'), 10);
            const col = parseInt(cell.getAttribute('data-col'), 10);
            this.setSelectedCell(row, col);
            const tbody = viewTable.querySelector('tbody');
            if (!tbody) return;
            const data = State.data.raw;
            const headers = State.data.headers;
            const startIndex = parseInt(viewTable.dataset.start || '0', 10);
            const endIndex = parseInt(viewTable.dataset.end || '0', 10);
            this.renderVisibleRows(tbody, headers, data, startIndex, endIndex);
        });
    },

    show() {
        if (!State.data.raw || State.data.raw.length === 0) {
            alert('No data loaded. Please load a CSV file first.');
            return;
        }

        const limit = Config.limits.maxGridRows;
        const headers = State.data.headers;
        const data = State.data.raw;
        const totalRows = data.length;

        const content = createModal(`
            <h3>Data View</h3>
            <p>Virtualized grid for large datasets. Total rows: ${totalRows}</p>
            <div class="virtual-grid-shell">
                <table class="data-grid-table data-grid-header">
                    <thead>
                        <tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr>
                    </thead>
                </table>
                <div class="data-grid-viewport">
                    <div class="data-grid-spacer"></div>
                    <table class="data-grid-table data-grid-virtual">
                        <tbody></tbody>
                    </table>
                </div>
            </div>
            ${data.length > limit ? '<p class="hint">Virtualization enabled: rendering windowed rows only.</p>' : ''}
        `);

        const overlay = content.parentElement;
        const viewport = content.querySelector('.data-grid-viewport');
        const spacer = content.querySelector('.data-grid-spacer');
        const virtualTable = content.querySelector('.data-grid-virtual');
        const headerRow = content.querySelector('.data-grid-header thead tr');
        const tbody = virtualTable?.querySelector('tbody');

        if (!viewport || !spacer || !virtualTable || !tbody) return;

        spacer.style.height = `${State.data.raw.length * ROW_HEIGHT}px`;
        virtualTable.style.transform = 'translateY(0px)';

        const render = () => {
            const headers = State.data.headers;
            const data = State.data.raw;
            const totalRows = data.length;
            spacer.style.height = `${totalRows * ROW_HEIGHT}px`;
            if (headerRow) {
                const signature = headers.join('|');
                if (headerRow.dataset.signature !== signature) {
                    headerRow.innerHTML = headers.map((h) => `<th>${h}</th>`).join('');
                    headerRow.dataset.signature = signature;
                }
            }
            const visibleCount = Math.ceil(viewport.clientHeight / ROW_HEIGHT);
            const startIndex = Math.max(0, Math.floor(viewport.scrollTop / ROW_HEIGHT) - BUFFER_ROWS);
            const endIndex = Math.min(totalRows, startIndex + visibleCount + BUFFER_ROWS * 2);

            virtualTable.dataset.start = startIndex;
            virtualTable.dataset.end = endIndex;
            virtualTable.style.transform = `translateY(${startIndex * ROW_HEIGHT}px)`;
            this.renderVisibleRows(tbody, headers, data, startIndex, endIndex);
        };

        viewport.addEventListener('scroll', render);
        window.addEventListener('resize', render);
        this.attachSelectionHandler(virtualTable);

        const handlePaste = (event) => {
            if (!event.clipboardData) return;
            const text = event.clipboardData.getData('text');
            if (!text) return;
            event.preventDefault();
            const parsed = parseClipboard(text);
            if (parsed.length === 0) return;
            this.applyPasteData(parsed);
            spacer.style.height = `${State.data.raw.length * ROW_HEIGHT}px`;
            render();
        };

        const cleanup = () => {
            viewport.removeEventListener('scroll', render);
            window.removeEventListener('resize', render);
            window.removeEventListener('paste', handlePaste);
        };

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) cleanup();
        }, true);

        window.addEventListener('paste', handlePaste);
        render();
    }
};
