import { AnalysisEngine } from '../analysis/analysisEngine';
import { EventDetector } from '../analysis/eventDetector';
import { debounce, formatSeconds } from '../app/utils';
import { triggerGraphUpdateOnly } from '../app/dataPipeline';
import { State } from '../state';
import type { AnalysisSeries } from '../types';
import { Graph } from './graph';
import { cx, ui } from './classes';
import { escapeHtml, renderWarningList } from './uiHelpers';

const TYPE_LABELS: Record<string, string> = {
  level: 'Level Crossing',
  edge: 'Edge (slope)',
  pulse: 'Pulse Width',
  runt: 'Runt / Glitch'
};

const SOURCE_HINTS: Record<string, string> = {
  raw: 'Raw amplitude',
  filtered: 'Filtered amplitude',
  math: 'Math trace',
  derivative: 'Slope (units / second)'
};

function formatEvent(
  event: { time?: number | null; type?: string; metadata?: Record<string, unknown> } | null
): string {
  if (!event) return '—';
  const time = Number.isFinite(event.time) ? formatSeconds(event.time as number) : 'n/a';
  const meta = event.metadata || {};
  if (event.type === 'pulse' && meta.width !== undefined) return `${time} · width ${formatSeconds(Number(meta.width))}`;
  if (event.type === 'edge' && meta.slope !== undefined) return `${time} · slope ${Number(meta.slope).toPrecision(3)}`;
  if (meta.direction) return `${time} · ${String(meta.direction)}`;
  return time;
}

export const EventPanel = {
  lastSeries: null as AnalysisSeries | null,
  listEl: null as HTMLElement | null,
  countEl: null as HTMLElement | null,
  warningEl: null as HTMLElement | null,
  typeSelect: null as HTMLSelectElement | null,
  directionSelect: null as HTMLSelectElement | null,
  thresholdInput: null as HTMLInputElement | null,
  hysteresisInput: null as HTMLInputElement | null,
  slopeInput: null as HTMLInputElement | null,
  minWidthInput: null as HTMLInputElement | null,
  maxWidthInput: null as HTMLInputElement | null,
  minSeparationInput: null as HTMLInputElement | null,
  highThresholdInput: null as HTMLInputElement | null,
  lowThresholdInput: null as HTMLInputElement | null,
  sourceSelect: null as HTMLSelectElement | null,
  sourceHint: null as HTMLElement | null,
  slopeHint: null as HTMLElement | null,
  thresholdLabel: null as HTMLElement | null,
  useSelectionCheckbox: null as HTMLInputElement | null,
  showEventsToggle: null as HTMLInputElement | null,
  prevBtn: null as HTMLButtonElement | null,
  nextBtn: null as HTMLButtonElement | null,

  init(): void {
    this.listEl = document.getElementById('event-list');
    this.countEl = document.getElementById('event-count');
    this.warningEl = document.getElementById('event-warnings');
    this.typeSelect = document.getElementById('event-type') as HTMLSelectElement | null;
    this.directionSelect = document.getElementById('event-direction') as HTMLSelectElement | null;
    this.thresholdInput = document.getElementById('event-threshold') as HTMLInputElement | null;
    this.hysteresisInput = document.getElementById('event-hysteresis') as HTMLInputElement | null;
    this.slopeInput = document.getElementById('event-slope') as HTMLInputElement | null;
    this.minWidthInput = document.getElementById('event-min-width') as HTMLInputElement | null;
    this.maxWidthInput = document.getElementById('event-max-width') as HTMLInputElement | null;
    this.minSeparationInput = document.getElementById('event-min-separation') as HTMLInputElement | null;
    this.highThresholdInput = document.getElementById('event-high-threshold') as HTMLInputElement | null;
    this.lowThresholdInput = document.getElementById('event-low-threshold') as HTMLInputElement | null;
    this.sourceSelect = document.getElementById('event-source') as HTMLSelectElement | null;
    this.sourceHint = document.getElementById('event-source-hint');
    this.slopeHint = document.getElementById('event-slope-hint');
    this.thresholdLabel = document.querySelector('label[for="event-threshold"]');
    this.useSelectionCheckbox = document.getElementById('event-use-selection') as HTMLInputElement | null;
    this.showEventsToggle = document.getElementById('live-show-events') as HTMLInputElement | null;
    this.prevBtn = document.getElementById('btn-event-prev') as HTMLButtonElement | null;
    this.nextBtn = document.getElementById('btn-event-next') as HTMLButtonElement | null;

    this.syncInputs(State.ensureAnalysisConfig().trigger);
    this.bindInputs();
    AnalysisEngine.onSelectionChange(debounce(() => this.refresh(true), 120));
  },

  syncInputs(cfg: ReturnType<typeof State.ensureAnalysisConfig>['trigger']): void {
    if (this.typeSelect) this.typeSelect.value = cfg.type || 'level';
    if (this.directionSelect) this.directionSelect.value = cfg.direction || 'rising';
    if (this.thresholdInput) this.thresholdInput.value = String(cfg.threshold ?? 0);
    if (this.hysteresisInput) this.hysteresisInput.value = String(cfg.hysteresis ?? 0);
    if (this.slopeInput) this.slopeInput.value = String(cfg.slopeThreshold ?? 0);
    if (this.minWidthInput) this.minWidthInput.value = String(cfg.minWidth ?? 0);
    if (this.maxWidthInput) this.maxWidthInput.value = String(cfg.maxWidth ?? 1);
    if (this.minSeparationInput) this.minSeparationInput.value = String(cfg.minSeparation ?? 0);
    if (this.highThresholdInput) this.highThresholdInput.value = String(cfg.highThreshold ?? 1);
    if (this.lowThresholdInput) this.lowThresholdInput.value = String(cfg.lowThreshold ?? 0);
    if (this.sourceSelect) this.sourceSelect.value = cfg.source || 'raw';
    if (this.useSelectionCheckbox) this.useSelectionCheckbox.checked = cfg.selectionOnly !== false;
    if (this.showEventsToggle) this.showEventsToggle.checked = State.ensureAnalysisConfig().showEvents !== false;
    this.updateSourceHints();
  },

  bindInputs(): void {
    const debouncedUpdate = debounce(() => this.updateConfigFromInputs(), 120);
    [
      this.typeSelect,
      this.directionSelect,
      this.thresholdInput,
      this.hysteresisInput,
      this.slopeInput,
      this.minWidthInput,
      this.maxWidthInput,
      this.highThresholdInput,
      this.minSeparationInput,
      this.lowThresholdInput,
      this.sourceSelect,
      this.useSelectionCheckbox,
      this.showEventsToggle
    ].forEach((el) => {
      el?.addEventListener('input', debouncedUpdate);
      el?.addEventListener('change', debouncedUpdate);
    });
    this.prevBtn?.addEventListener('click', () => this.stepActive(-1));
    this.nextBtn?.addEventListener('click', () => this.stepActive(1));
  },

  updateConfigFromInputs(): void {
    const analysisCfg = State.ensureAnalysisConfig();
    const triggerCfg = analysisCfg.trigger;
    triggerCfg.type = (this.typeSelect?.value || triggerCfg.type) as typeof triggerCfg.type;
    triggerCfg.direction = (this.directionSelect?.value || triggerCfg.direction) as typeof triggerCfg.direction;
    triggerCfg.threshold = parseFloat(this.thresholdInput?.value || '0') || 0;
    triggerCfg.hysteresis = parseFloat(this.hysteresisInput?.value || '0') || 0;
    triggerCfg.slopeThreshold = parseFloat(this.slopeInput?.value || '0') || 0;
    triggerCfg.minWidth = parseFloat(this.minWidthInput?.value || '0') || 0;
    triggerCfg.maxWidth = parseFloat(this.maxWidthInput?.value || '1') || Infinity;
    triggerCfg.minSeparation = Math.max(0, parseFloat(this.minSeparationInput?.value || '0') || 0);
    triggerCfg.highThreshold = parseFloat(this.highThresholdInput?.value || String(triggerCfg.highThreshold));
    triggerCfg.lowThreshold = parseFloat(this.lowThresholdInput?.value || String(triggerCfg.lowThreshold));
    triggerCfg.source = (this.sourceSelect?.value || triggerCfg.source) as typeof triggerCfg.source;
    triggerCfg.selectionOnly = this.useSelectionCheckbox ? this.useSelectionCheckbox.checked : triggerCfg.selectionOnly;
    analysisCfg.showEvents = this.showEventsToggle ? this.showEventsToggle.checked : analysisCfg.showEvents;
    this.updateSourceHints();
    this.refresh(true);
  },

  updateSourceHints(): void {
    const source = this.sourceSelect?.value || 'raw';
    if (this.sourceHint) this.sourceHint.textContent = SOURCE_HINTS[source] || '';
    if (this.slopeHint) {
      this.slopeHint.textContent =
        source === 'derivative'
          ? 'Slope thresholds are expressed in units/second.'
          : 'Edge detection uses slope thresholds per second.';
    }
    if (this.thresholdLabel) {
      this.thresholdLabel.textContent = source === 'derivative' ? 'Slope Threshold' : 'Threshold';
    }
  },

  setSeries(series: AnalysisSeries | null): void {
    this.lastSeries = series;
    this.refresh(false);
  },

  clear(): void {
    this.lastSeries = null;
    this.renderList([]);
    this.renderWarnings([]);
    Graph.setEventOverlay([], { show: false });
  },

  refresh(redrawGraph = false): void {
    if (!this.lastSeries) {
      this.renderList([]);
      this.renderWarnings([]);
      Graph.setEventOverlay([], { show: false });
      return;
    }

    const triggerCfg = State.ensureAnalysisConfig().trigger;
    const detection = EventDetector.detect({
      trace: this.lastSeries,
      selection: State.getAnalysisSelection(),
      config: triggerCfg
    });

    State.setAnalysisEvents(detection.events);
    this.renderList(detection.events);
    this.renderWarnings(detection.warnings);
    Graph.setEventOverlay(detection.events, {
      show: State.ensureAnalysisConfig().showEvents,
      activeIndex: State.ui.analysis.activeEventIndex,
      amplitudes: detection.signal
    });
    if (redrawGraph) triggerGraphUpdateOnly();
  },

  renderWarnings(warnings: string[] = []): void {
    renderWarningList(this.warningEl, warnings);
  },

  renderList(events: Array<{ type: string; time?: number | null; metadata?: Record<string, unknown> }> = []): void {
    if (this.countEl) this.countEl.textContent = `${events.length} events`;
    if (!this.listEl) return;
    if (!events.length) {
      this.listEl.innerHTML = '<div class="text-xs text-muted">No events detected</div>';
      return;
    }
    const activeIdx = State.ui.analysis.activeEventIndex || 0;
    this.listEl.innerHTML = events
      .map(
        (evt, idx) => `
      <button type="button" class="${cx(ui.eventRow, idx === activeIdx && ui.eventRowActive)}" data-index="${idx}">
        <div class="font-semibold">${escapeHtml(TYPE_LABELS[evt.type] || evt.type)}</div>
        <div class="text-muted">${escapeHtml(formatEvent(evt))}</div>
      </button>
    `
      )
      .join('');
    this.listEl.querySelectorAll<HTMLElement>('[data-index]').forEach((row) => {
      row.addEventListener('click', () => this.setActiveIndex(Number(row.dataset.index), true));
    });
  },

  setActiveIndex(idx: number, zoom = false): void {
    State.setActiveEventIndex(idx);
    const events = State.getAnalysisEvents();
    this.renderList(events);
    const active = events[idx];
    if (active && zoom) Graph.zoomToEvent(active.time);
    Graph.setEventOverlay(events, {
      show: State.ensureAnalysisConfig().showEvents,
      activeIndex: idx,
      amplitudes:
        Graph.eventOverlay.amplitudes ||
        (this.lastSeries && !this.lastSeries.isMath && this.lastSeries.filteredY?.length
          ? this.lastSeries.filteredY
          : this.lastSeries?.rawY)
    });
    triggerGraphUpdateOnly();
  },

  stepActive(delta: number): void {
    const events = State.getAnalysisEvents();
    if (!events.length) return;
    const current = State.ui.analysis.activeEventIndex || 0;
    this.setActiveIndex((current + delta + events.length) % events.length, true);
  }
};
