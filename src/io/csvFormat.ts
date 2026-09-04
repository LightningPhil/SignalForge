/**
 * CSV cell formatting shared by every export path.
 *
 * Numbers are written verbatim. Text is RFC 4180 quoted when it contains a delimiter, quote or line
 * break, and any text that a spreadsheet would interpret as a formula (leading `=`, `+`, `-`, `@`,
 * tab or carriage return) is neutralised with a leading apostrophe so that a hostile column label or
 * original token cannot execute when the export is opened in Excel/LibreOffice. Numeric-looking text
 * such as "-1.5e3" is left untouched so measured values stay machine-readable.
 */

const NUMERIC_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  let text = typeof value === 'string' ? value : String(value);
  if (FORMULA_LEAD.test(text) && !NUMERIC_TEXT.test(text.trim())) text = `'${text}`;
  return /[",\r\n\t]/.test(text) || text.startsWith("'") ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(values: readonly unknown[]): string {
  return values.map(csvCell).join(',');
}
