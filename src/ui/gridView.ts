import { runPipelineAndRender } from '../app/dataPipeline';
import { renderColumnTabs } from '../app/tabs';
import { Config } from '../config';
import { parseNumericValue } from '../data/quality';
import { buildForwardFillUpdates, buildLinearInterpolationUpdates } from '../data/repairs';
import { State } from '../state';
import '../session/workspace';
import type { CsvRow, CsvValue } from '../types';
import { ui } from './classes';
import { createModal, escapeHtml } from './uiHelpers';

const ROW_HEIGHT = 32;
const BUFFER_ROWS = 10;

interface CellCoord {
  row: number;
  col: number;
}

function parseClipboard(text: string): string[][] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const delimiter = normalized.includes('\t') ? '\t' : ',';
  return normalized
    .split('\n')
    .map((line) => line.split(delimiter))
    .filter((row) => row.some((cell) => cell !== ''));
}

function convertRowsToObjects(headers: string[], rows: string[][]): CsvRow[] {
  return rows.map((cols) => {
    const obj: CsvRow = {};
    headers.forEach((h, idx) => {
      const rawVal = cols[idx];
      const numVal = parseNumericValue(rawVal);
      obj[h] = numVal ?? rawVal ?? '';
    });
    return obj;
  });
}

function getExistingValue(row: CsvRow | undefined, header: string): CsvValue {
  if (!row) return '';
  return row[header] ?? '';
}

export const GridView = {
  selectedCell: null as CellCoord | null,

  setSelectedCell(row: number, col: number): void {
    this.selectedCell = { row, col };
  },

  updateStateData(newHeaders: string[], newRaw: CsvRow[]): void {
    State.setData(newRaw, newHeaders, {
      name: 'Pasted data',
      text: '',
      bytes: new Uint8Array(0),
      size: 0,
      lastModified: null
    });
  },

  applyPasteData(clipboardRows: string[][]): void {
    if (!clipboardRows.length) return;

    const headers = State.data.headers.slice();

    if (this.selectedCell) {
      const { row: startRow, col: startCol } = this.selectedCell;
      const previousLength = State.data.raw.length;
      const requiredRows = startRow + clipboardRows.length;
      const appendedRows = Array.from(
        { length: Math.max(0, requiredRows - previousLength) },
        () => Object.fromEntries(headers.map((header) => [header, ''])) as CsvRow
      );
      const updates: Array<{ rowIndex: number; columnId: string; value: CsvValue }> = [];
      clipboardRows.forEach((cols, rIdx) => {
        const targetRow = startRow + rIdx;
        cols.forEach((val, cIdx) => {
          const header = headers[startCol + cIdx];
          if (!header) return;
          const value = parseNumericValue(val) ?? val;
          if (targetRow >= previousLength) {
            appendedRows[targetRow - previousLength][header] = value;
          } else {
            updates.push({ rowIndex: targetRow, columnId: header, value });
          }
        });
      });
      if (
        appendedRows.length > 0 &&
        State.data.timeColumn &&
        appendedRows.some((row) => parseNumericValue(row[State.data.timeColumn as string]) === null)
      ) {
        alert('Rows can only be appended when the pasted range includes a finite timestamp for every new row.');
        return;
      }
      if (appendedRows.length > 0) State.appendDataRows(appendedRows);
      if (updates.length > 0) State.applyDataChanges('Grid paste', updates);
      renderColumnTabs();
      runPipelineAndRender();
      return;
    }

    const incomingHeaders = clipboardRows[0];
    const dataRows = clipboardRows.slice(1);

    if (!State.data.headers.length || State.data.raw.length === 0) {
      const looksLikeHeader = incomingHeaders.some((cell) => Number.isNaN(parseFloat(cell))) || dataRows.length > 0;
      const cleanHeaders = looksLikeHeader ? incomingHeaders : incomingHeaders.map((_, idx) => `Col ${idx + 1}`);
      const rows = convertRowsToObjects(cleanHeaders, dataRows.length ? dataRows : clipboardRows);
      this.updateStateData(cleanHeaders, rows);
      renderColumnTabs();
      runPipelineAndRender();
      return;
    }

    const headersMatch =
      incomingHeaders.length === headers.length && incomingHeaders.every((h, idx) => h === headers[idx]);

    if (headersMatch) {
      State.appendDataRows(convertRowsToObjects(headers, dataRows));
      renderColumnTabs();
      runPipelineAndRender();
      return;
    }

    if (!confirm('Pasted data headers do not match. Replace existing dataset with pasted content?')) return;
    this.updateStateData(
      incomingHeaders,
      convertRowsToObjects(incomingHeaders, dataRows.length ? dataRows : clipboardRows)
    );
    renderColumnTabs();
    runPipelineAndRender();
  },

  renderVisibleRows(
    tableBody: HTMLElement,
    headers: string[],
    data: CsvRow[],
    startIndex: number,
    endIndex: number
  ): void {
    const rows: string[] = [];
    for (let i = startIndex; i < endIndex; i++) {
      const row = data[i] || {};
      const cells = headers
        .map((h, colIdx) => {
          let val: CsvValue = getExistingValue(row, h);
          if (typeof val === 'number') val = parseFloat(val.toFixed(4));
          const isSelected = this.selectedCell && this.selectedCell.row === i && this.selectedCell.col === colIdx;
          return `<td data-row="${i}" data-col="${colIdx}" class="${isSelected ? 'selected' : ''}">${escapeHtml(val)}</td>`;
        })
        .join('');
      rows.push(`<tr>${cells}</tr>`);
    }
    tableBody.innerHTML = rows.join('');
  },

  attachSelectionHandler(viewTable: HTMLTableElement): void {
    viewTable.addEventListener('click', (e) => {
      const cell = (e.target as HTMLElement).closest('td');
      if (!cell) return;
      const row = parseInt(cell.getAttribute('data-row') || '', 10);
      const col = parseInt(cell.getAttribute('data-col') || '', 10);
      if (Number.isNaN(row) || Number.isNaN(col)) return;
      this.setSelectedCell(row, col);
      const tbody = viewTable.querySelector('tbody');
      if (!tbody) return;
      const startIndex = parseInt(viewTable.dataset.start || '0', 10);
      const endIndex = parseInt(viewTable.dataset.end || '0', 10);
      this.renderVisibleRows(tbody, State.data.headers, State.data.raw, startIndex, endIndex);
    });
  },

  show(): void {
    if (!State.data.raw || State.data.raw.length === 0) {
      alert('No data loaded. Please load a CSV file first.');
      return;
    }

    const limit = Config.limits.maxGridRows;
    const headers = State.data.headers;
    const totalRows = State.data.raw.length;

    const content = createModal(`
      <h3 class="${ui.modalTitle}">Data View</h3>
      <p class="mb-3 text-sm text-muted">Virtualized grid for large datasets. Total rows: ${totalRows}</p>
      <div class="mb-3 flex flex-wrap gap-2" aria-label="Data repair controls">
        <button type="button" id="grid-interpolate" class="sf-btn">Interpolate selected column</button>
        <button type="button" id="grid-forward-fill" class="sf-btn">Forward-fill selected column</button>
        <button type="button" id="grid-undo" class="sf-btn">Undo repair</button>
        <button type="button" id="grid-redo" class="sf-btn">Redo repair</button>
      </div>
      <p class="sf-hint mb-3">Repairs are explicit and reversible. Imported values remain preserved for export.</p>
      <div class="virtual-grid-shell">
        <table class="data-grid-table data-grid-header">
          <thead>
            <tr>${headers.map((h) => `<th scope="col">${escapeHtml(h)}</th>`).join('')}</tr>
          </thead>
        </table>
        <div class="data-grid-viewport" tabindex="0" aria-label="Data grid">
          <div class="data-grid-spacer"></div>
          <table class="data-grid-table data-grid-virtual">
            <tbody></tbody>
          </table>
        </div>
      </div>
      ${State.data.raw.length > limit ? '<p class="sf-hint mt-2">Virtualization enabled: rendering windowed rows only.</p>' : ''}
    `);

    const overlay = content.parentElement;
    const viewport = content.querySelector<HTMLElement>('.data-grid-viewport');
    const spacer = content.querySelector<HTMLElement>('.data-grid-spacer');
    const virtualTable = content.querySelector<HTMLTableElement>('.data-grid-virtual');
    const headerRow = content.querySelector<HTMLTableRowElement>('.data-grid-header thead tr');
    const tbody = virtualTable?.querySelector('tbody');

    if (!viewport || !spacer || !virtualTable || !tbody) return;

    spacer.style.height = `${State.data.raw.length * ROW_HEIGHT}px`;
    virtualTable.style.transform = 'translateY(0px)';

    const render = () => {
      const currentHeaders = State.data.headers;
      const data = State.data.raw;
      spacer.style.height = `${data.length * ROW_HEIGHT}px`;
      if (headerRow) {
        const signature = currentHeaders.join('|');
        if (headerRow.dataset.signature !== signature) {
          headerRow.innerHTML = currentHeaders.map((h) => `<th scope="col">${escapeHtml(h)}</th>`).join('');
          headerRow.dataset.signature = signature;
        }
      }
      const visibleCount = Math.ceil(viewport.clientHeight / ROW_HEIGHT);
      const startIndex = Math.max(0, Math.floor(viewport.scrollTop / ROW_HEIGHT) - BUFFER_ROWS);
      const endIndex = Math.min(data.length, startIndex + visibleCount + BUFFER_ROWS * 2);
      virtualTable.dataset.start = String(startIndex);
      virtualTable.dataset.end = String(endIndex);
      virtualTable.style.transform = `translateY(${startIndex * ROW_HEIGHT}px)`;
      this.renderVisibleRows(tbody, currentHeaders, data, startIndex, endIndex);
    };

    viewport.addEventListener('scroll', render);
    window.addEventListener('resize', render);
    this.attachSelectionHandler(virtualTable);

    const refreshAfterRepair = () => {
      runPipelineAndRender();
      render();
    };
    const selectedColumn = (): string | null =>
      this.selectedCell ? State.data.headers[this.selectedCell.col] || null : null;
    content.querySelector<HTMLButtonElement>('#grid-interpolate')?.addEventListener('click', () => {
      const columnId = selectedColumn();
      if (!columnId || !State.data.timeColumn || columnId === State.data.timeColumn) {
        alert('Select a non-time data column first.');
        return;
      }
      const updates = buildLinearInterpolationUpdates(State.data.raw, State.data.timeColumn, columnId);
      const repair = State.applyDataChanges(`Interpolate ${columnId}`, updates);
      alert(
        repair ? `Interpolated ${repair.changes.length} sample(s).` : 'No bounded gaps were available to interpolate.'
      );
      refreshAfterRepair();
    });
    content.querySelector<HTMLButtonElement>('#grid-forward-fill')?.addEventListener('click', () => {
      const columnId = selectedColumn();
      if (!columnId || columnId === State.data.timeColumn) {
        alert('Select a non-time data column first.');
        return;
      }
      const updates = buildForwardFillUpdates(State.data.raw, columnId);
      const repair = State.applyDataChanges(`Forward-fill ${columnId}`, updates);
      alert(repair ? `Forward-filled ${repair.changes.length} sample(s).` : 'No samples required forward filling.');
      refreshAfterRepair();
    });
    content.querySelector<HTMLButtonElement>('#grid-undo')?.addEventListener('click', () => {
      if (!State.undoDataRepair()) alert('There is no repair to undo.');
      refreshAfterRepair();
    });
    content.querySelector<HTMLButtonElement>('#grid-redo')?.addEventListener('click', () => {
      if (!State.redoDataRepair()) alert('There is no repair to redo.');
      refreshAfterRepair();
    });

    const handlePaste = (event: ClipboardEvent) => {
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

    overlay?.addEventListener(
      'click',
      (e) => {
        if (e.target === overlay) cleanup();
      },
      true
    );

    window.addEventListener('paste', handlePaste);
    render();
  }
};
