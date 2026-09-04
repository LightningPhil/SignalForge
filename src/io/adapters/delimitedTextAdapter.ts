import Papa from 'papaparse';
import { QualityFlag, classifyQuality, parseNumericValue } from '../../data/quality';
import type { SessionChannel, SourceFileRecord } from '../../domain/session';
import type { CsvRow } from '../../types';
import { isTimeUnit, timeScaleToSeconds } from '../../units/units';
import type {
  AdapterIdentification,
  AdapterImportResult,
  ImportAdapterOptions,
  ImportSource,
  WaveformImportAdapter
} from './types';

function extension(name: string): string {
  return name.slice(name.lastIndexOf('.')).toLowerCase();
}

function likelyHeaderRow(lines: string[]): number {
  let bestIndex = 0;
  let bestScore = -Infinity;
  lines.slice(0, 200).forEach((line, index) => {
    const cells = line.split(/[\t,;]/);
    const textCells = cells.filter((cell) => cell.trim() !== '' && !Number.isFinite(Number(cell))).length;
    const score = cells.length * 2 + textCells - Math.abs(index) * 0.01;
    if (cells.length >= 2 && score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function unitFromHeader(header: string): string {
  return header.match(/(?:\(|\[)\s*([^\])]+)\s*(?:\)|\])\s*$/)?.[1] || '';
}

function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export const DelimitedTextAdapter: WaveformImportAdapter = {
  id: 'delimited-text',
  name: 'Delimited text (CSV/TSV/TXT)',
  status: 'supported',

  identify(source: ImportSource): AdapterIdentification {
    const ext = extension(source.name);
    const prefix = new TextDecoder().decode(source.bytes.slice(0, 4096));
    const hasRows = /\r?\n/.test(prefix);
    const hasDelimiter = /[\t,;]/.test(prefix);
    const extensionConfidence = ['.csv', '.tsv', '.txt'].includes(ext) ? 0.75 : 0;
    return {
      confidence: hasRows && hasDelimiter ? Math.max(0.6, extensionConfidence) : 0,
      format: ext === '.tsv' ? 'TSV' : 'Delimited text',
      reason: hasRows && hasDelimiter ? 'Text contains multiple delimited rows.' : 'No delimited text signature.'
    };
  },

  async import(source: ImportSource, options: ImportAdapterOptions = {}): Promise<AdapterImportResult> {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(source.bytes);
    const lines = text.split(/\r\n|\n|\r/);
    const headerRow = Math.max(0, options.headerRow ?? likelyHeaderRow(lines));
    const body = lines.slice(headerRow).join('\n');
    const parsed = Papa.parse<CsvRow>(body, {
      comments: '#',
      delimiter: options.delimiter,
      dynamicTyping: false,
      header: true,
      skipEmptyLines: true
    });
    const headers = parsed.meta.fields || [];
    if (headers.length < 2)
      throw new Error('Delimited waveform input requires a time column and at least one channel.');
    const timeColumn = options.timeColumn && headers.includes(options.timeColumn) ? options.timeColumn : headers[0];
    const declaredTimeUnit = unitFromHeader(timeColumn) || 's';
    const timeScale = timeScaleToSeconds(declaredTimeUnit);
    const timeUnitKnown = isTimeUnit(declaredTimeUnit);
    const timeValues = parsed.data.map((row) => {
      const value = parseNumericValue(row[timeColumn]);
      return value === null ? Number.NaN : value * timeScale;
    });
    const channels: SessionChannel[] = [];

    for (const header of headers) {
      if (header === timeColumn) continue;
      const values = new Float64Array(parsed.data.length);
      const quality = new Uint16Array(parsed.data.length);
      const originalValueTokens: Record<number, string | boolean | null> = {};
      const originalTimeTokens: Record<number, string | boolean | null> = {};
      let finiteCount = 0;
      let previousFiniteTime = -Infinity;
      for (let index = 0; index < parsed.data.length; index += 1) {
        const rawTime = parsed.data[index][timeColumn];
        const rawValue = parsed.data[index][header];
        const value = parseNumericValue(rawValue);
        values[index] = value ?? Number.NaN;
        if (value === null) {
          originalValueTokens[index] = typeof rawValue === 'number' ? String(rawValue) : (rawValue ?? null);
        }
        if (parseNumericValue(rawTime) === null) {
          originalTimeTokens[index] = typeof rawTime === 'number' ? String(rawTime) : (rawTime ?? null);
        }
        if (value !== null) finiteCount += 1;
        quality[index] = classifyQuality(rawValue);
        const timeQuality = classifyQuality(rawTime);
        if (timeQuality !== QualityFlag.None) quality[index] |= timeQuality;
        if (Number.isFinite(timeValues[index])) {
          if (!(timeValues[index] > previousFiniteTime)) quality[index] |= QualityFlag.NonMonotonicTime;
          previousFiniteTime = timeValues[index];
        }
      }
      if (finiteCount === 0) continue;
      channels.push({
        id: id('channel'),
        name: header,
        unit: options.channelUnits?.[header] || unitFromHeader(header),
        timeUnit: 's',
        time: Float64Array.from(timeValues),
        originalTime: Float64Array.from(timeValues),
        values,
        originalValues: values.slice(),
        originalValueTokens,
        originalTimeTokens,
        quality,
        originalQuality: quality.slice(),
        calibration: { scale: 1, offset: 0, source: 'Values parsed from delimited text.' },
        timingOffsetSeconds: 0
      });
    }
    if (channels.length === 0) throw new Error('No numeric waveform channels were found.');
    const warnings = parsed.errors.map((error) => `Row ${error.row ?? '?'}: ${error.message}`);
    if (!timeUnitKnown) warnings.push(`Unknown time unit "${declaredTimeUnit}"; timestamps were treated as seconds.`);
    const sourceFile: SourceFileRecord = {
      id: id('source'),
      name: source.name,
      size: source.size,
      lastModified: source.lastModified,
      adapterId: this.id,
      bytes: source.bytes,
      metadata: { headerRow: headerRow + 1, delimiter: parsed.meta.delimiter, declaredTimeUnit },
      warnings
    };
    channels.forEach((channel) => {
      channel.sourceFileId = sourceFile.id;
    });
    return {
      adapterId: this.id,
      sourceFile,
      channels,
      metadata: { headerRow: headerRow + 1, delimiter: parsed.meta.delimiter, declaredTimeUnit },
      warnings
    };
  }
};
