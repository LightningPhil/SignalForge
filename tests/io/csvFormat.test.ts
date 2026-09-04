import { describe, expect, it } from 'vitest';
import { csvCell, csvRow } from '../../src/io/csvFormat';

describe('CSV export cell formatting', () => {
  it('writes numbers and numeric-looking tokens verbatim, including negatives and exponents', () => {
    expect(csvCell(-1.5)).toBe('-1.5');
    expect(csvCell(1e-7)).toBe('1e-7');
    expect(csvCell(Number.NaN)).toBe('NaN');
    expect(csvCell('-1.2e3')).toBe('-1.2e3');
    expect(csvCell('+3')).toBe('+3');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('neutralises spreadsheet formula injection in text cells', () => {
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csvCell("+cmd|' /C calc'!A0")).toBe(`"'+cmd|' /C calc'!A0"`);
    expect(csvCell('-2+3+cmd')).toBe(`"'-2+3+cmd"`);
    expect(csvCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
    expect(csvCell('\tstart')).toBe(`"'\tstart"`);
  });

  it('quotes delimiters, quotes and line breaks per RFC 4180', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('CLIPPED')).toBe('CLIPPED');
  });

  it('keeps event metadata JSON inside a single cell', () => {
    const row = csvRow([3, 0.25, 'level', JSON.stringify({ direction: 'rising', level: 0.5 })]);
    expect(row.split(',').length).toBeGreaterThan(4);
    expect(row).toBe('3,0.25,level,"{""direction"":""rising"",""level"":0.5}"');
    // A CSV reader that honours quoting sees exactly four fields.
    const fields = row.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.filter((field) => field !== '') ?? [];
    expect(fields).toHaveLength(4);
  });
});
