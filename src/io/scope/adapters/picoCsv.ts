import Papa from 'papaparse';
import { validateRecordShape } from '../limits';
import { ScopeImportError, throwIfCancelled, type ImportedWaveformRecord, type ScopeImportRequest } from '../types';

const FORMAT = 'picoscope-csv' as const;
const MAX_PICO_TEXT_BYTES = 32 * 1024 * 1024;
const MAX_ROWS = 2_000_000;
const MAX_ROW_CHARACTERS = 64 * 1024;
const MAX_CELL_CHARACTERS = 1024;

function cleanUnit(value: string): string {
  return value
    .trim()
    .replace(/^\((.*)\)$/, '$1')
    .trim();
}

interface PicoUnit {
  unit: string;
  scale: number;
  time: boolean;
}

function picoUnit(raw: string): PicoUnit | null {
  const source = cleanUnit(raw).replace(/μ|µ/g, 'u');
  const aliases: Record<string, PicoUnit> = {
    s: { unit: 's', scale: 1, time: true },
    sec: { unit: 's', scale: 1, time: true },
    second: { unit: 's', scale: 1, time: true },
    seconds: { unit: 's', scale: 1, time: true },
    v: { unit: 'V', scale: 1, time: false },
    volt: { unit: 'V', scale: 1, time: false },
    volts: { unit: 'V', scale: 1, time: false },
    a: { unit: 'A', scale: 1, time: false },
    amp: { unit: 'A', scale: 1, time: false },
    amps: { unit: 'A', scale: 1, time: false },
    hz: { unit: 'Hz', scale: 1, time: false },
    w: { unit: 'W', scale: 1, time: false }
  };
  const direct = aliases[source.toLowerCase()];
  if (direct) return direct;
  const match = /^([pnumkMG]?)(s|V|A|Hz|W)$/.exec(source);
  if (!match) return null;
  const scales: Record<string, number> = {
    '': 1,
    p: 1e-12,
    n: 1e-9,
    u: 1e-6,
    m: 1e-3,
    k: 1e3,
    M: 1e6,
    G: 1e9
  };
  return {
    unit: match[2] === 's' ? 's' : match[2],
    scale: scales[match[1]],
    time: match[2] === 's'
  };
}

function failure(request: ScopeImportRequest, code: 'invalid-header' | 'decode-budget-exceeded', message: string) {
  return new ScopeImportError(code, message, {
    format: FORMAT,
    fileNames: [request.primary.name]
  });
}

function streamRows(
  text: string,
  request: ScopeImportRequest,
  onRow: (row: string[], rowIndex: number) => void
): number {
  let rowIndex = 0;
  let caught: ScopeImportError | null = null;
  Papa.parse<string[]>(text, {
    dynamicTyping: false,
    skipEmptyLines: true,
    step(result, parser) {
      if (caught) {
        parser.abort();
        return;
      }
      if (result.errors.length > 0) {
        caught = failure(request, 'invalid-header', `PicoScope CSV parse failed: ${result.errors[0].message}`);
        parser.abort();
        return;
      }
      if (request.signal?.aborted) {
        parser.abort();
        return;
      }
      try {
        onRow(result.data, rowIndex);
      } catch (error) {
        caught =
          error instanceof ScopeImportError
            ? error
            : failure(request, 'invalid-header', error instanceof Error ? error.message : String(error));
        parser.abort();
        return;
      }
      rowIndex += 1;
    }
  });
  throwIfCancelled(request.signal);
  if (caught) throw caught;
  return rowIndex;
}

function scaledValue(value: number, scale: number, context: string, request: ScopeImportRequest): number {
  const scaled = value * scale;
  if (Number.isFinite(value) && !Number.isFinite(scaled)) {
    throw failure(request, 'invalid-header', `${context} overflows after SI unit scaling.`);
  }
  return scaled;
}

function preflightTextShape(text: string, request: ScopeImportRequest): void {
  const carriageReturn = text.indexOf('\r');
  const lineFeed = text.indexOf('\n');
  const firstBreak = carriageReturn < 0 ? lineFeed : lineFeed < 0 ? carriageReturn : Math.min(carriageReturn, lineFeed);
  const firstLine = text.slice(0, Math.min(firstBreak < 0 ? text.length : firstBreak, MAX_ROW_CHARACTERS + 1));
  const delimiters = [',', '\t', ';'];
  const delimiter = delimiters.reduce((best, candidate) => {
    const count = firstLine.split(candidate).length;
    return count > firstLine.split(best).length ? candidate : best;
  }, ',');
  let inQuotes = false;
  let rowLength = 0;
  let cellLength = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    rowLength += 1;
    cellLength += 1;
    if (rowLength > MAX_ROW_CHARACTERS) {
      throw failure(request, 'decode-budget-exceeded', `PicoScope CSV row exceeds ${MAX_ROW_CHARACTERS} characters.`);
    }
    if (cellLength > MAX_CELL_CHARACTERS) {
      throw failure(request, 'decode-budget-exceeded', `PicoScope CSV cell exceeds ${MAX_CELL_CHARACTERS} characters.`);
    }
    if (character === '"') {
      if (inQuotes && text[index + 1] === '"') {
        index += 1;
        rowLength += 1;
        cellLength += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (!inQuotes && character === delimiter) {
      cellLength = 0;
    } else if (!inQuotes && (character === '\n' || character === '\r')) {
      rowLength = 0;
      cellLength = 0;
      if (character === '\r' && text[index + 1] === '\n') index += 1;
    }
    if (index % 65_536 === 0) throwIfCancelled(request.signal);
  }
  if (inQuotes) throw failure(request, 'invalid-header', 'PicoScope CSV contains an unterminated quoted cell.');
}

export function decodePicoCsv(request: ScopeImportRequest): ImportedWaveformRecord[] {
  throwIfCancelled(request.signal);
  if (request.primary.bytes.length > MAX_PICO_TEXT_BYTES) {
    throw new ScopeImportError('decode-budget-exceeded', 'PicoScope CSV exceeds the 32 MiB text limit.', {
      format: FORMAT,
      fileNames: [request.primary.name]
    });
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(request.primary.bytes);
  preflightTextShape(text, request);
  let names: string[] = [];
  let units: string[] = [];
  const totalRows = streamRows(text, request, (row, rowIndex) => {
    if (rowIndex === 0) names = row.map((value) => value.trim());
    else if (rowIndex === 1) units = row.map(cleanUnit);
    else if (rowIndex - 1 > MAX_ROWS) {
      throw failure(request, 'decode-budget-exceeded', `PicoScope CSV exceeds the ${MAX_ROWS}-row limit.`);
    } else if (row.length !== names.length) {
      throw failure(
        request,
        'invalid-header',
        `PicoScope CSV row ${rowIndex + 1} has ${row.length} cells; expected ${names.length}.`
      );
    }
  });
  if (totalRows < 3) {
    throw new ScopeImportError('invalid-header', 'PicoScope CSV requires name, unit, and sample rows.', {
      format: FORMAT,
      fileNames: [request.primary.name]
    });
  }
  if (names.length < 2 || units.length !== names.length) {
    throw new ScopeImportError('invalid-header', 'PicoScope CSV name and unit rows are not aligned.', {
      format: FORMAT,
      fileNames: [request.primary.name]
    });
  }
  const rowCount = totalRows - 2;
  validateRecordShape(rowCount, names.length - 1, text.length, FORMAT);
  const timeUnit = picoUnit(units[0]);
  if (!timeUnit?.time) {
    throw new ScopeImportError('unsupported-variant', `Unsupported PicoScope time unit "${units[0]}".`, {
      format: FORMAT,
      fileNames: [request.primary.name]
    });
  }
  const timeSeconds = new Float64Array(rowCount);
  const values = names.slice(1).map(() => new Float64Array(rowCount));
  const invalidMasks = names.slice(1).map(() => new Uint8Array(rowCount));
  const channelUnits = units.slice(1).map((unit) => picoUnit(unit));
  streamRows(text, request, (row, sourceRowIndex) => {
    if (sourceRowIndex < 2) return;
    const rowIndex = sourceRowIndex - 2;
    if (rowIndex % 65_536 === 0) request.onProgress?.(rowIndex / rowCount, 'Decoding PicoScope CSV');
    const rawTime = Number(row[0]);
    if (!Number.isFinite(rawTime)) {
      throw new ScopeImportError('invalid-header', `PicoScope timestamp at row ${rowIndex + 3} is invalid.`, {
        format: FORMAT,
        fileNames: [request.primary.name]
      });
    }
    timeSeconds[rowIndex] = scaledValue(rawTime, timeUnit.scale, `PicoScope timestamp at row ${rowIndex + 3}`, request);
    for (let channelIndex = 0; channelIndex < values.length; channelIndex += 1) {
      const raw = String(row[channelIndex + 1] ?? '').trim();
      const parsedValue = raw === '' ? Number.NaN : Number(raw);
      const scale = channelUnits[channelIndex]?.scale ?? 1;
      values[channelIndex][rowIndex] = scaledValue(
        parsedValue,
        scale,
        `PicoScope ${names[channelIndex + 1]} row ${rowIndex + 3}`,
        request
      );
      if (!Number.isFinite(parsedValue)) invalidMasks[channelIndex][rowIndex] = 1;
    }
  });
  const channels = names.slice(1).map((name, index) => {
    const definition = channelUnits[index];
    const scale = definition?.scale ?? 1;
    return {
      name: name || `Channel ${index + 1}`,
      values: values[index],
      unit: definition?.unit || units[index + 1],
      sourceUnit: units[index + 1],
      sourceToSiScale: scale,
      invalidMask: invalidMasks[index],
      calibrationSource: 'PicoScope two-row CSV numeric values scaled from the declared unit row.'
    };
  });
  throwIfCancelled(request.signal);
  request.onProgress?.(1, 'PicoScope CSV decoded');
  return [
    {
      sourceFormat: FORMAT,
      supportLevel: 'layout-tested',
      timeSeconds,
      channels,
      frameIndex: 0,
      metadata: {
        parser: 'picoscope-two-row-csv',
        row_count: rowCount,
        channel_count: channels.length,
        source_time_unit: units[0]
      },
      warnings: [
        'PicoScope two-row CSV support is layout-tested; locale-specific exports may require generic CSV import.'
      ]
    }
  ];
}
