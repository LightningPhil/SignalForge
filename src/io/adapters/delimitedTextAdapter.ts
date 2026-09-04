import Papa from 'papaparse';
import { QualityFlag, classifyQuality, parseNumericValue } from '../../data/quality';
import type { SessionChannel, SourceFileRecord } from '../../domain/session';
import type { CsvRow } from '../../types';
import { isTimeUnit, timeScaleToSeconds } from '../../units/units';
import { ScopeImportLimits } from '../scope/limits';
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

/** Bytes retained per sample per channel: values + originalValues + time + originalTime (4 × f64) and two u16 masks. */
const RESIDENT_BYTES_PER_CHANNEL_SAMPLE = 4 * 8 + 2 * 2;

export function validateDelimitedShape(rowCount: number, channelCount: number, textLength: number, name: string): void {
  if (channelCount < 1) return; // reported separately as "requires a time column and at least one channel"
  if (channelCount > ScopeImportLimits.maxDelimitedChannels) {
    throw new Error(
      `${name} declares ${channelCount} channels; delimited text is limited to ${ScopeImportLimits.maxDelimitedChannels}.`
    );
  }
  if (rowCount > ScopeImportLimits.maxSamplesPerChannel) {
    throw new Error(
      `${name} has about ${rowCount} rows; delimited text is limited to ${ScopeImportLimits.maxSamplesPerChannel} samples per channel.`
    );
  }
  const predictedBytes = rowCount * channelCount * RESIDENT_BYTES_PER_CHANNEL_SAMPLE + textLength * 2;
  if (!Number.isSafeInteger(predictedBytes) || predictedBytes > ScopeImportLimits.maxDecodedBytes) {
    throw new Error(
      `${name} would need about ${predictedBytes} bytes for ${channelCount} channel(s) × ${rowCount} rows; the import budget is ${ScopeImportLimits.maxDecodedBytes} bytes.`
    );
  }
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
    // Shape and memory are bounded before any string, row or channel array is materialised so that a
    // wide or long text file fails with a budget error instead of allocating gigabytes first.
    if (source.bytes.byteLength > ScopeImportLimits.maxTextBytes) {
      throw new Error(
        `${source.name} is ${source.bytes.byteLength} bytes; delimited text is limited to ${ScopeImportLimits.maxTextBytes} bytes.`
      );
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(source.bytes);
    const lines = text.split(/\r\n|\n|\r/);
    const headerRow = Math.max(0, options.headerRow ?? likelyHeaderRow(lines));
    const splitter = options.delimiter ? options.delimiter : /[\t,;]/;
    const headerCells = (lines[headerRow] || '').split(splitter);
    const declaredColumns = headerCells.length;
    validateDelimitedShape(lines.length - headerRow, declaredColumns - 1, text.length, source.name);
    // A "header" made only of numbers is the first data row of a headerless file. Consuming it as
    // column names would silently drop a sample, so synthesise names and keep the row as data.
    const headerless =
      options.headerRow === undefined &&
      declaredColumns >= 2 &&
      headerCells.every((cell) => cell.trim() !== '' && Number.isFinite(Number(cell)));
    const rowDelimiter =
      typeof splitter === 'string' ? splitter : ((lines[headerRow] || '').match(/[\t,;]/)?.[0] ?? ',');
    const syntheticHeader = headerless
      ? headerCells.map((_, index) => (index === 0 ? 'Time' : `Channel ${index}`)).join(rowDelimiter)
      : null;
    const bodyLines = lines.slice(headerRow);
    const body = (syntheticHeader ? [syntheticHeader, ...bodyLines] : bodyLines).join('\n');
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
    validateDelimitedShape(parsed.data.length, headers.length - 1, text.length, source.name);
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
    if (headerless) {
      warnings.push(
        `No header row was found; columns were named ${headers.map((header) => `"${header}"`).join(', ')} and every row was kept as data.`
      );
    }
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
