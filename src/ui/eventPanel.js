import { State } from '../state.js';
import { EventDetector } from '../analysis/eventDetector.js';
import { AnalysisEngine } from '../analysis/analysisEngine.js';
import { Graph } from './graph.js';
import { debounce, formatSeconds } from '../app/utils.js';

const TYPE_LABELS = {
    level: 'Level Crossing',
    edge: 'Edge (slope)',
    pulse: 'Pulse Width',
    runt: 'Runt / Glitch'
};

function formatEvent(event) {
    if (!event) return '—';
    const time = Number.isFinite(event.time) ? formatSeconds(event.time) : 'n/a';
    const meta = event.metadata || {};
    if (event.type === 'pulse' && meta.width !== undefined) {
        return `${time} · width ${formatSeconds(meta.width)}`;
    }
    if (event.type === 'edge' && meta.slope !== undefined) {
        return `${time} · slope ${meta.slope.toPrecision(3)}`;
    }
    if (meta.direction) {
        return `${time} · ${meta.direction}`;
    }
    return `${time}`;
}

export const EventPanel = {
    lastSeries: null,

    init() {
        this.panelEl = document.getElementById('events-panel');
        this.listEl = document.getElementById('event-list');
        this.countEl = document.getElementById('event-count');
        this.warningEl = document.getElementById('event-warnings');

        this.typeSelect = document.getElementById('event-type');
        this.directionSelect = document.getElementById('event-direction');
        this.thresholdInput = document.getElementById('event-threshold');
        this.hysteresisInput = document.getElementById('event-hysteresis');
        this.slopeInput = document.getElementById('event-slope');
        this.minWidthInput = document.getElementById('event-min-width');
        this.maxWidthInput = document.getElementById('event-max-width');
        this.highThresholdInput = document.getElementById('event-high-threshold');
        this.lowThresholdInput = document.getElementById('event-low-threshold');
        this.sourceSelect = document.getElementById('event-source');
        this.useSelectionCheckbox = document.getElementById('event-use-selection');
        this.showEventsToggle = document.getElementById('live-show-events');
        this.prevBtn = document.getElementById('btn-event-prev');
        this.nextBtn = document.getElementById('btn-event-next');

        const triggerCfg = State.ensureAnalysisConfig().trigger || {};
        this.syncInputs(triggerCfg);
        this.bindInputs();

        AnalysisEngine.onSelectionChange(debounce(() => this.refresh(), 120));
    },

    syncInputs(cfg) {
        if (this.typeSelect) this.typeSelect.value = cfg.type || 'level';
        if (this.directionSelect) this.directionSelect.value = cfg.direction || 'rising';
        if (this.thresholdInput) this.thresholdInput.value = cfg.threshold ?? 0;
        if (this.hysteresisInput) this.hysteresisInput.value = cfg.hysteresis ?? 0;
        if (this.slopeInput) this.slopeInput.value = cfg.slopeThreshold ?? 0;
        if (this.minWidthInput) this.minWidthInput.value = cfg.minWidth ?? 0;
        if (this.maxWidthInput) this.maxWidthInput.value = cfg.maxWidth ?? 1;
        if (this.highThresholdInput) this.highThresholdInput.value = cfg.highThreshold ?? 1;
        if (this.lowThresholdInput) this.lowThresholdInput.value = cfg.lowThreshold ?? 0;
        if (this.sourceSelect) this.sourceSelect.value = cfg.source || 'auto';
        if (this.useSelectionCheckbox) this.useSelectionCheckbox.checked = cfg.selectionOnly !== false;
        const showEventsCfg = State.ensureAnalysisConfig().showEvents;
        if (this.showEventsToggle) this.showEventsToggle.checked = showEventsCfg !== false;
    },

    bindInputs() {
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

    updateConfigFromInputs() {
        const analysisCfg = State.ensureAnalysisConfig();
        const triggerCfg = analysisCfg.trigger || {};
        triggerCfg.type = this.typeSelect?.value || triggerCfg.type;
        triggerCfg.direction = this.directionSelect?.value || triggerCfg.direction;
        triggerCfg.threshold = parseFloat(this.thresholdInput?.value) || 0;
        triggerCfg.hysteresis = parseFloat(this.hysteresisInput?.value) || 0;
        triggerCfg.slopeThreshold = parseFloat(this.slopeInput?.value) || 0;
        triggerCfg.minWidth = parseFloat(this.minWidthInput?.value) || 0;
        triggerCfg.maxWidth = parseFloat(this.maxWidthInput?.value) || Infinity;
        triggerCfg.highThreshold = parseFloat(this.highThresholdInput?.value) || triggerCfg.highThreshold;
        triggerCfg.lowThreshold = parseFloat(this.lowThresholdInput?.value) || triggerCfg.lowThreshold;
        triggerCfg.source = this.sourceSelect?.value || triggerCfg.source;
        triggerCfg.selectionOnly = this.useSelectionCheckbox ? !!this.useSelectionCheckbox.checked : triggerCfg.selectionOnly;
        analysisCfg.showEvents = this.showEventsToggle ? !!this.showEventsToggle.checked : analysisCfg.showEvents;
        analysisCfg.trigger = triggerCfg;
        this.refresh();
    },

    setSeries(series) {
        this.lastSeries = series;
        this.refresh();
    },

    clear() {
        this.lastSeries = null;
        this.renderList([]);
        this.renderWarnings([]);
        Graph.setEventOverlay([], { show: false });
    },

    refresh() {
        if (!this.panelEl) return;
        if (!this.lastSeries) {
            this.renderList([]);
            this.renderWarnings([]);
            Graph.setEventOverlay([], { show: false });
            return;
        }

        const triggerCfg = State.ensureAnalysisConfig().trigger || {};
        const selection = State.getAnalysisSelection();
        let ySource = (!this.lastSeries.isMath && this.lastSeries.filteredY?.length)
            ? this.lastSeries.filteredY
            : this.lastSeries.rawY;

        if (triggerCfg.source === 'raw') {
            ySource = this.lastSeries.rawY;
        } else if (triggerCfg.source === 'filtered' && this.lastSeries.filteredY?.length) {
            ySource = this.lastSeries.filteredY;
        }

        const detection = EventDetector.detect({
            t: this.lastSeries.rawX,
            y: ySource,
            selection,
            config: triggerCfg
        });

        State.setAnalysisEvents(detection.events);
        this.renderList(detection.events);
        this.renderWarnings(detection.warnings);

        Graph.setEventOverlay(detection.events, {
            show: State.ensureAnalysisConfig().showEvents,
            activeIndex: State.ui.analysis.activeEventIndex,
            amplitudes: ySource
        });
        Graph.triggerRefresh(Graph.lastRanges);
    },

    renderWarnings(warnings = []) {
        if (!this.warningEl) return;
        if (!warnings.length) {
            this.warningEl.innerHTML = '';
            this.warningEl.style.display = 'none';
            return;
        }
        this.warningEl.style.display = 'block';
        this.warningEl.innerHTML = warnings.map((w) => `<li>${w}</li>`).join('');
    },

    renderList(events = []) {
        if (this.countEl) this.countEl.textContent = `${events.length} events`;
        if (!this.listEl) return;

        if (!events.length) {
            this.listEl.innerHTML = '<div class="event-empty">No events detected</div>';
            return;
        }

        const activeIdx = State.ui.analysis.activeEventIndex || 0;
        this.listEl.innerHTML = events.map((evt, idx) => {
            const label = TYPE_LABELS[evt.type] || evt.type;
            const detail = formatEvent(evt);
            const activeClass = idx === activeIdx ? 'active' : '';
            return `<div class="event-row ${activeClass}" data-index="${idx}"><div class="event-type">${label}</div><div class="event-detail">${detail}</div></div>`;
        }).join('');

        Array.from(this.listEl.querySelectorAll('.event-row')).forEach((row) => {
            row.addEventListener('click', () => {
                const idx = parseInt(row.dataset.index, 10);
                this.setActiveIndex(idx, true);
            });
        });
    },

    setActiveIndex(idx, zoom = false) {
        State.setActiveEventIndex(idx);
        const rows = this.listEl?.querySelectorAll('.event-row') || [];
        rows.forEach((row, i) => {
            row.classList.toggle('active', i === idx);
        });
        const events = State.getAnalysisEvents();
        const active = events[idx];
        if (active && zoom) {
            Graph.zoomToEvent(active.time);
        }
        Graph.setEventOverlay(events, {
            show: State.ensureAnalysisConfig().showEvents,
            activeIndex: idx,
            amplitudes: this.lastSeries && (!this.lastSeries.isMath && this.lastSeries.filteredY?.length)
                ? this.lastSeries.filteredY
                : this.lastSeries?.rawY
        });
        Graph.triggerRefresh(Graph.lastRanges);
    },

    stepActive(delta) {
        const events = State.getAnalysisEvents();
        if (!events || !events.length) return;
        const current = State.ui.analysis.activeEventIndex || 0;
        const next = (current + delta + events.length) % events.length;
        this.setActiveIndex(next, true);
    }
};
