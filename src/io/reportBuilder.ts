import {
  collectLimitations,
  deduplicateWarnings,
  type LimitationSources,
  type QualitySummary,
  type RecipeSelection,
  type SystemWarningSource,
  type WarningSource
} from '../domain/provenance';
import { APP_BUILD_ID, APP_VERSION } from '../domain/version';

export interface ReportTrace {
  name?: string;
  columnId?: string | null;
  isMath?: boolean;
}

export interface ReportBuilderInput {
  generatedAt: string;
  applicationVersion?: string;
  buildId?: string;
  title?: string;
  trace?: ReportTrace | null;
  selection?: RecipeSelection | null;
  source?: unknown;
  processingRecipe?: unknown;
  processingRecipeHash?: string | null;
  analysisRecipe?: unknown;
  analysisRecipeHash?: string | null;
  quality?: QualitySummary | null;
  moduleQuality?: unknown;
  measurements?: unknown;
  events?: unknown;
  spectral?: unknown;
  system?: unknown;
  pipeline?: unknown;
  confidence?: unknown;
  uncertainty?: unknown;
  limitations?: readonly string[];
  plotImageDataUrl?: string | null;
}

export interface SignalForgeReport {
  format: 'signalforge-analysis-report';
  schemaVersion: 1;
  generatedAt: string;
  applicationVersion: string;
  buildId: string;
  title: string;
  trace: ReportTrace | null;
  selection: RecipeSelection | null;
  source: unknown;
  processingRecipe: unknown;
  processingRecipeHash: string | null;
  analysisRecipe: unknown;
  analysisRecipeHash: string | null;
  quality: QualitySummary | null;
  moduleQuality: unknown;
  measurements: unknown;
  events: unknown;
  spectral: unknown;
  system: unknown;
  pipeline: unknown;
  confidence: unknown;
  uncertainty: unknown;
  limitations: string[];
  plotImageDataUrl: string | null;
}

export interface ReportArtifacts {
  report: SignalForgeReport;
  html: string;
  json: string;
}

type JsonRecord = Record<string, unknown>;

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) {
      return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }
    return Array.from(value as unknown as ArrayLike<number>);
  }
  return value;
}

function jsonCopy<T>(value: T): T {
  const serialized = JSON.stringify(value, jsonReplacer);
  return (serialized === undefined ? null : JSON.parse(serialized)) as T;
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function asWarningSource(value: unknown): WarningSource {
  return Array.isArray(value) || asRecord(value) ? (value as WarningSource) : undefined;
}

function limitationSources(input: ReportBuilderInput): LimitationSources {
  return {
    measurements: asWarningSource(input.measurements),
    events: asWarningSource(input.events),
    spectral: asWarningSource(input.spectral),
    system: asRecord(input.system) ? (input.system as SystemWarningSource) : null,
    pipeline: (Array.isArray(input.pipeline) || asRecord(input.pipeline)
      ? input.pipeline
      : undefined) as LimitationSources['pipeline']
  };
}

export function buildReport(input: ReportBuilderInput): SignalForgeReport {
  if (typeof input.generatedAt !== 'string' || !input.generatedAt.trim()) {
    throw new TypeError('Report generatedAt must be a non-empty timestamp.');
  }
  const applicationVersion =
    typeof input.applicationVersion === 'string' && input.applicationVersion.trim()
      ? input.applicationVersion.trim()
      : APP_VERSION;
  const title =
    typeof input.title === 'string' && input.title.trim() ? input.title.trim() : 'SignalForge Analysis Report';
  const limitations = deduplicateWarnings([
    ...collectLimitations(limitationSources(input)),
    ...(input.limitations ?? [])
  ]);

  return {
    format: 'signalforge-analysis-report',
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    applicationVersion,
    buildId: input.buildId?.trim() || APP_BUILD_ID,
    title,
    trace: jsonCopy(input.trace ?? null),
    selection: jsonCopy(input.selection ?? null),
    source: jsonCopy(input.source ?? null),
    processingRecipe: jsonCopy(input.processingRecipe ?? null),
    processingRecipeHash: input.processingRecipeHash ?? null,
    analysisRecipe: jsonCopy(input.analysisRecipe ?? null),
    analysisRecipeHash: input.analysisRecipeHash ?? null,
    quality: jsonCopy(input.quality ?? null),
    moduleQuality: jsonCopy(input.moduleQuality ?? null),
    measurements: jsonCopy(input.measurements ?? null),
    events: jsonCopy(input.events ?? null),
    spectral: jsonCopy(input.spectral ?? null),
    system: jsonCopy(input.system ?? null),
    pipeline: jsonCopy(input.pipeline ?? null),
    confidence: jsonCopy(input.confidence ?? null),
    uncertainty: jsonCopy(
      input.uncertainty ?? {
        status: 'not-quantified',
        intervals: null,
        note: 'No calibrated uncertainty interval was computed for this report.'
      }
    ),
    limitations,
    plotImageDataUrl: input.plotImageDataUrl ?? null
  };
}

export const buildAnalysisReport = buildReport;

export function serializeReportJson(report: SignalForgeReport): string {
  return JSON.stringify(report, jsonReplacer, 2);
}

export const reportToJson = serializeReportJson;

export function escapeReportHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatNumber(value: number): string {
  const magnitude = Math.abs(value);
  return magnitude !== 0 && (magnitude < 0.001 || magnitude >= 1e6) ? value.toExponential(4) : value.toFixed(4);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'Unavailable';
  if (typeof value === 'number') return Number.isFinite(value) ? formatNumber(value) : 'Unavailable';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, jsonReplacer);
  } catch {
    return 'Unavailable';
  }
}

function cell(value: unknown): string {
  return escapeReportHtml(formatValue(value));
}

function rows(entries: ReadonlyArray<readonly [string, unknown]>): string {
  return entries
    .map(([label, value]) => `<tr><th scope="row">${escapeReportHtml(label)}</th><td>${cell(value)}</td></tr>`)
    .join('');
}

function selectionLabel(selection: RecipeSelection | null): string {
  if (!selection || selection.i0 === null || selection.i1 === null) return 'Full record';
  const indices = `${formatValue(selection.i0)}–${formatValue(selection.i1)}`;
  if (finiteNumber(selection.xMin) === null || finiteNumber(selection.xMax) === null) return indices;
  return `${indices} (${formatValue(selection.xMin)} to ${formatValue(selection.xMax)})`;
}

function sourceHtml(source: unknown): string {
  if (Array.isArray(source)) {
    if (source.length === 0) return '<p class="muted">Source provenance unavailable.</p>';
    return source.map((entry, index) => `<h3>Source ${index + 1}</h3>${sourceHtml(entry)}`).join('');
  }
  const record = asRecord(source);
  if (!record) return '<p class="muted">Source provenance unavailable.</p>';
  const entries: Array<readonly [string, unknown]> = [];
  if ('name' in record) entries.push(['Name', record.name]);
  if ('size' in record) entries.push(['Size (bytes)', record.size]);
  if ('lastModified' in record) entries.push(['Last modified', record.lastModified]);
  if ('sha256' in record) entries.push(['SHA-256', record.sha256]);
  if ('sourceFileId' in record) entries.push(['Source file ID', record.sourceFileId]);
  if ('adapterId' in record) entries.push(['Import adapter', record.adapterId]);
  if ('note' in record) entries.push(['Provenance note', record.note]);
  return entries.length > 0
    ? `<table><tbody>${rows(entries)}</tbody></table>`
    : '<p class="muted">Source provenance unavailable.</p>';
}

function qualityHtml(quality: QualitySummary | null): string {
  if (!quality) return '<p class="muted">Quality summary unavailable.</p>';
  const summaryRows: Array<readonly [string, unknown]> = [
    ['Selected samples', quality.selectedSampleCount],
    ['Clean samples', quality.cleanSampleCount],
    ['Flagged samples', quality.flaggedSampleCount],
    ['Analysis-excluded samples', quality.analysisExcludedSampleCount]
  ];
  const flagRows = Object.entries(quality.counts).map(([name, count]) => [`Flag: ${name}`, count] as const);
  return `<table><tbody>${rows([...summaryRows, ...flagRows])}</tbody></table>`;
}

function measurementsHtml(measurements: unknown): string {
  const metrics = asRecord(asRecord(measurements)?.metrics);
  if (!metrics || Object.keys(metrics).length === 0) {
    return '<p class="muted">Measurements unavailable.</p>';
  }
  return `<table><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody>${Object.entries(metrics)
    .map(([name, value]) => `<tr><td>${escapeReportHtml(name)}</td><td>${cell(value)}</td></tr>`)
    .join('')}</tbody></table>`;
}

function eventsHtml(eventsSection: unknown): string {
  const section = asRecord(eventsSection);
  const eventValue = section?.events;
  const events = Array.isArray(eventValue) ? eventValue.slice(0, 5000) : [];
  const totalEventCount = finiteNumber(section?.totalEventCount) ?? events.length;
  const omittedEventCount = Math.max(
    finiteNumber(section?.omittedEventCount) ?? totalEventCount - events.length,
    totalEventCount - events.length
  );
  if (totalEventCount === 0) return '<p class="muted">No events reported.</p>';
  const eventRows = events
    .map((event, ordinal) => {
      const record = asRecord(event);
      return `<tr><td>${cell(record?.index ?? ordinal)}</td><td>${cell(record?.time)}</td><td>${cell(record?.type)}</td><td>${cell(record?.metadata)}</td></tr>`;
    })
    .join('');
  return `<p>${totalEventCount} event${totalEventCount === 1 ? '' : 's'} reported; showing ${events.length}.${omittedEventCount > 0 ? ` ${omittedEventCount} omitted from this HTML summary.` : ''}</p><table><thead><tr><th>Index</th><th>Time</th><th>Type</th><th>Metadata</th></tr></thead><tbody>${eventRows}</tbody></table>`;
}

function spectralHtml(spectral: unknown): string {
  const record = asRecord(spectral);
  if (!record) return '<p class="muted">Spectral analysis unavailable.</p>';
  const snr = finiteNumber(record.snr);
  const thd = finiteNumber(record.thd);
  const entries: Array<readonly [string, unknown]> = [
    ['Fundamental (Hz)', record.fundamentalHz],
    ['THD (%)', thd === null ? null : thd * 100],
    ['SNR', snr !== null && snr > 0 ? `${formatNumber(10 * Math.log10(snr))} dB` : null],
    ['Band power', record.bandpower]
  ];
  return `<table><tbody>${rows(entries)}</tbody></table>`;
}

function hasOwn(record: JsonRecord, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, property);
}

function systemHtml(system: unknown): string {
  const record = asRecord(system);
  if (!record) return '<p class="muted">System / FRF analysis unavailable.</p>';
  const entries: Array<readonly [string, unknown]> = [];
  if (hasOwn(record, 'input')) entries.push(['Input', record.input]);
  if (hasOwn(record, 'output')) entries.push(['Output', record.output]);
  const delay = asRecord(record.delay);
  if (delay) {
    if (hasOwn(delay, 'delaySeconds')) entries.push(['Delay (s)', delay.delaySeconds]);
    if (hasOwn(delay, 'delaySamples')) entries.push(['Delay (samples)', delay.delaySamples]);
    if (hasOwn(delay, 'correlationPeak')) entries.push(['Correlation peak', delay.correlationPeak]);
    // Confidence is never inferred from correlation or warning counts. It is shown only when supplied.
    if (hasOwn(delay, 'confidence')) entries.push(['Confidence', delay.confidence]);
  }
  const frf = asRecord(record.frf);
  const meta = asRecord(frf?.meta);
  if (meta) {
    if (hasOwn(meta, 'segmentLength')) entries.push(['FRF segment length', meta.segmentLength]);
    if (hasOwn(meta, 'segmentCount')) entries.push(['FRF segment count', meta.segmentCount]);
  }
  return entries.length > 0
    ? `<table><tbody>${rows(entries)}</tbody></table>`
    : '<p class="muted">System / FRF analysis unavailable.</p>';
}

function prettyJson(value: unknown): string {
  if (value === null || value === undefined) return 'Unavailable';
  try {
    return JSON.stringify(value, jsonReplacer, 2);
  } catch {
    return 'Unavailable';
  }
}

function recipeHtml(label: string, recipe: unknown, hash: string | null): string {
  const hashLine = hash ? `<p><strong>SHA-256:</strong> <code>${escapeReportHtml(hash)}</code></p>` : '';
  return `<details><summary>${escapeReportHtml(label)}</summary>${hashLine}<pre>${escapeReportHtml(prettyJson(recipe))}</pre></details>`;
}

function limitationHtml(limitations: readonly string[]): string {
  if (limitations.length === 0) return '<p class="muted">No limitations were reported.</p>';
  return `<ul>${limitations.map((warning) => `<li>${escapeReportHtml(warning)}</li>`).join('')}</ul>`;
}

function safePlotImage(value: string | null): string | null {
  if (!value) return null;
  return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : null;
}

export function renderReportHtml(report: SignalForgeReport): string {
  const trace = asRecord(report.trace);
  const traceName = trace?.name ?? trace?.columnId ?? 'Unavailable';
  const traceKind = trace?.isMath === true ? ' (math)' : '';
  const image = safePlotImage(report.plotImageDataUrl);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeReportHtml(report.title)}</title>
<style>
  body { font-family: "Segoe UI", Arial, sans-serif; background: #f7f9fc; color: #102a43; margin: 20px; line-height: 1.4; }
  h1, h2 { color: #0b2545; }
  .card { background: #fff; border: 1px solid #d7deea; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { border: 1px solid #d7deea; padding: 6px 8px; text-align: left; vertical-align: top; }
  thead th { background: #f0f4f8; }
  tbody th { width: 32%; background: #f8fafc; }
  .muted { color: #627d98; }
  code, pre { overflow-wrap: anywhere; white-space: pre-wrap; }
  img { display: block; max-width: 100%; height: auto; }
</style>
</head>
<body>
  <h1>${escapeReportHtml(report.title)}</h1>
  <p class="muted">Generated ${escapeReportHtml(report.generatedAt)} with SignalForge ${escapeReportHtml(report.applicationVersion)} (build ${escapeReportHtml(report.buildId)})</p>
  <section class="card">
    <h2>Overview</h2>
    <p><strong>Trace:</strong> ${escapeReportHtml(traceName)}${traceKind}</p>
    <p><strong>Selection:</strong> ${escapeReportHtml(selectionLabel(report.selection))}</p>
    ${image ? `<img src="${escapeReportHtml(image)}" alt="Plot snapshot">` : '<p class="muted">Plot snapshot unavailable.</p>'}
  </section>
  <section class="card">
    <h2>Source provenance</h2>
    ${sourceHtml(report.source)}
  </section>
  <section class="card">
    <h2>Data quality</h2>
    ${qualityHtml(report.quality)}
    <h3>Per-analysis source and exclusions</h3>
    <pre>${escapeReportHtml(prettyJson(report.moduleQuality))}</pre>
  </section>
  <section class="card">
    <h2>Measurements</h2>
    ${measurementsHtml(report.measurements)}
  </section>
  <section class="card">
    <h2>Events</h2>
    ${eventsHtml(report.events)}
  </section>
  <section class="card">
    <h2>Spectral metrics</h2>
    ${spectralHtml(report.spectral)}
  </section>
  <section class="card">
    <h2>System / FRF</h2>
    ${systemHtml(report.system)}
  </section>
  <section class="card">
    <h2>Confidence and uncertainty</h2>
    <h3>Available confidence indicators</h3>
    <pre>${escapeReportHtml(prettyJson(report.confidence))}</pre>
    <h3>Uncertainty statement</h3>
    <pre>${escapeReportHtml(prettyJson(report.uncertainty))}</pre>
  </section>
  <section class="card">
    <h2>Processing pipeline</h2>
    <pre>${escapeReportHtml(prettyJson(report.pipeline))}</pre>
  </section>
  <section class="card">
    <h2>Limitations and warnings</h2>
    ${limitationHtml(report.limitations)}
  </section>
  <section class="card">
    <h2>Reproduction recipes</h2>
    ${recipeHtml('Processing recipe', report.processingRecipe, report.processingRecipeHash)}
    ${recipeHtml('Analysis recipe', report.analysisRecipe, report.analysisRecipeHash)}
  </section>
</body>
</html>`;
}

export const reportToHtml = renderReportHtml;

export function buildReportArtifacts(input: ReportBuilderInput): ReportArtifacts {
  const report = buildReport(input);
  return {
    report,
    html: renderReportHtml(report),
    json: serializeReportJson(report)
  };
}

export const ReportBuilder = {
  build: buildReport,
  buildArtifacts: buildReportArtifacts,
  toHtml: renderReportHtml,
  toJson: serializeReportJson
};
