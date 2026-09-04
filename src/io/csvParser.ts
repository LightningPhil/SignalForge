import Papa from 'papaparse';
import { Config } from '../config';
import type { CsvRow, DataSourceRecord } from '../types';
import { closeModal, createModal, escapeHtml } from '../ui/uiHelpers';

export const CsvParser = {
  processFile(file: File, onComplete: (results: Papa.ParseResult<CsvRow>, source: DataSourceRecord) => void): void {
    const reader = new FileReader();
    reader.onload = (e) => {
      const bytes = new Uint8Array(e.target?.result as ArrayBuffer);
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      const source = {
        name: file.name,
        text,
        bytes,
        size: file.size,
        lastModified: Number.isFinite(file.lastModified) ? file.lastModified : null
      };
      this.showHeaderSelector(text, text.split(/\r\n|\n|\r/), source, onComplete);
    };
    reader.onerror = () => alert(`Could not read ${file.name}.`);
    reader.readAsArrayBuffer(file);
  },

  showHeaderSelector(
    text: string,
    lines: string[],
    source: DataSourceRecord,
    onComplete: (results: Papa.ParseResult<CsvRow>, source: DataSourceRecord) => void
  ): void {
    const previewLimit = Config.limits.previewLines || 50;
    const candidates = lines.map((line, index) => ({ line, index })).filter((row) => row.line.trim() !== '');

    const html = `<h3 class="mb-2 border-b border-line pb-2 text-lg font-semibold">Select the Header Row</h3>
      <p class="mb-3 text-sm text-main">Click the row that contains your column names (e.g., Time, Voltage).</p>
      <div class="max-h-96 overflow-y-auto">
        <table id="header-preview" class="mt-2 w-full border-collapse font-mono text-sm"></table>
      </div>
      <p id="header-preview-note" class="sf-hint mt-3 hidden">
        <span data-note-text></span>
        <button type="button" id="btn-show-all-rows" class="sf-btn ml-2 px-2 py-0.5 text-xs">Show all rows</button>
      </p>`;

    const modalContent = createModal(html);
    const table = modalContent.querySelector<HTMLTableElement>('#header-preview');
    if (!table) return;
    const note = modalContent.querySelector<HTMLElement>('#header-preview-note');
    const noteText = modalContent.querySelector<HTMLElement>('[data-note-text]');

    const renderRows = (limit: number): void => {
      const visible = candidates.slice(0, limit);
      table.innerHTML = visible
        .map(({ line, index }) => {
          const safeLine = escapeHtml(line);
          const display = safeLine.length > 120 ? `${safeLine.substring(0, 120)}...` : safeLine;
          return `<tr class="cursor-pointer hover:bg-accent hover:text-white focus-visible:bg-accent focus-visible:text-white" data-row="${index}" tabindex="0" role="button" aria-label="Use row ${index + 1} as header">
        <td class="w-20 border border-line px-3 py-2 text-muted">Row ${index + 1}</td>
        <td class="border border-line px-3 py-2">${display}</td>
      </tr>`;
        })
        .join('');

      if (note && noteText) {
        note.classList.toggle('hidden', visible.length >= candidates.length);
        noteText.textContent = `Showing the first ${visible.length} of ${candidates.length} non-empty rows.`;
      }

      table.querySelectorAll<HTMLTableRowElement>('tr[data-row]').forEach((row) => {
        const choose = () => {
          const skip = parseInt(row.getAttribute('data-row') || '0', 10);
          closeModal(modalContent);
          this.parseFullFile(text, skip, source, onComplete);
        };
        row.addEventListener('click', choose);
        row.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            choose();
          }
        });
      });
    };

    modalContent
      .querySelector<HTMLButtonElement>('#btn-show-all-rows')
      ?.addEventListener('click', () => renderRows(candidates.length));

    renderRows(previewLimit);
  },

  parseFullFile(
    text: string,
    skipLines: number,
    sourceRecord: DataSourceRecord,
    onComplete: (results: Papa.ParseResult<CsvRow>, source: DataSourceRecord) => void
  ): void {
    const lines = text.split(/\r\n|\n|\r/);
    const source = skipLines > 0 ? lines.slice(skipLines).join('\n') : lines.join('\n');

    const config = {
      header: true,
      // Keep every cell as its source token: papaparse's dynamic typing turns ISO-8601 cells into
      // Date objects (which the quality classifier cannot represent) and would otherwise decide the
      // numeric interpretation before the quality flags are assigned.
      dynamicTyping: false,
      skipEmptyLines: true,
      comments: '#',
      complete: (results: Papa.ParseResult<CsvRow>) => {
        if (!results.meta.fields || results.meta.fields.length === 0) {
          alert('Could not detect columns. Check your delimiter.');
          return;
        }
        if (results.errors.length > 0) console.warn('CSV Parse Warnings:', results.errors);
        try {
          onComplete(results, sourceRecord);
        } catch (error) {
          console.error('CSV import failed', error);
          alert(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
      error: (err: Error) => {
        alert(`Parse Error: ${err.message}`);
      }
    };
    if (source.length > 1_000_000) {
      Papa.parse<CsvRow>(source, { ...config, worker: true });
    } else {
      Papa.parse<CsvRow>(source, config);
    }
  }
};
