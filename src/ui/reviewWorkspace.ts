import Plotly from 'plotly.js-dist-min';
import type { Data, Layout, PlotMouseEvent, PlotlyHTMLElement } from 'plotly.js';
import { BatchAnalyzer } from '../analysis/batch';
import { CrossChannel } from '../analysis/crossChannel';
import { snapMarker, type MarkerSnapMode } from '../analysis/markerSnap';
import { calculatePulsePower, type PulsePowerResult } from '../analysis/pulsePower';
import { getRawSeries } from '../app/traceData';
import { runPipelineAndRender } from '../app/dataPipeline';
import { renderColumnTabs } from '../app/tabs';
import { downloadProjectArchive, importProjectArchive } from '../persistence/projectArchive';
import { sessionRepository } from '../persistence/sessionRepository';
import { interpolateToTimebase } from '../processing/sampling';
import type { Session, Shot } from '../domain/session';
import { SessionWorkspace } from '../session/workspace';
import { State } from '../state';
import { createModal, escapeHtml } from './uiHelpers';
import { ui } from './classes';
import { EnsembleView } from './ensembleView';

export const ReviewWorkspace = {
  content: null as HTMLElement | null,
  clickPlacementArmed: false,
  initialized: false,
  savedSessions: [] as Session[],
  pulseResult: null as PulsePowerResult | null,
  batchAnalyzer: new BatchAnalyzer(),
  batchController: null as AbortController | null,
  unsubscribeWorkspace: null as (() => void) | null,

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    const plot = document.getElementById('main-plot') as PlotlyHTMLElement | null;
    plot?.on('plotly_click', ((event: PlotMouseEvent) => {
      if (!this.clickPlacementArmed || !this.content) return;
      const time = Number(event.points[0]?.x);
      if (!Number.isFinite(time)) return;
      this.placeMarker(time);
      this.setClickPlacement(false);
      this.render();
    }) as (event: PlotMouseEvent) => void);
    window.addEventListener('keydown', (event) => {
      if (!this.content || !event.altKey) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        this.navigate(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        this.navigate(1);
      }
    });
  },

  show(): void {
    this.init();
    if (!SessionWorkspace.activeSession) SessionWorkspace.create('SignalForge session');
    this.content = createModal('<div id="review-workspace-root"></div>', {
      onClose: () => {
        this.content = null;
        this.clickPlacementArmed = false;
        this.unsubscribeWorkspace?.();
        this.unsubscribeWorkspace = null;
      }
    });
    this.content.className = `${ui.modal} h-[min(52rem,94vh)] max-w-7xl overflow-y-auto`;
    this.unsubscribeWorkspace?.();
    this.unsubscribeWorkspace = SessionWorkspace.onChange(() => {
      if (this.content) this.render();
    });
    this.render();
    void this.refreshSavedSessions();
  },

  async refreshSavedSessions(): Promise<void> {
    try {
      this.savedSessions = await sessionRepository.list();
      if (sessionRepository.listWarnings.length) {
        SessionWorkspace.persistenceError = sessionRepository.listWarnings.join(' ');
        window.dispatchEvent(
          new CustomEvent('signalforge:persistence-error', {
            detail: SessionWorkspace.persistenceError
          })
        );
      }
    } catch (error) {
      SessionWorkspace.persistenceError = error instanceof Error ? error.message : String(error);
      window.dispatchEvent(
        new CustomEvent('signalforge:persistence-error', {
          detail: SessionWorkspace.persistenceError
        })
      );
    }
    if (this.content) this.render();
  },

  render(): void {
    const root = this.content?.querySelector<HTMLElement>('#review-workspace-root');
    const session = SessionWorkspace.activeSession;
    const shot = SessionWorkspace.getActiveShot();
    if (!root || !session) return;
    const currentIndex = shot ? session.shots.findIndex((candidate) => candidate.id === shot.id) : -1;
    root.innerHTML = `
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 class="${ui.modalTitle} mb-1">Session Review</h2>
          <input id="review-session-name" class="sf-field max-w-md" value="${escapeHtml(session.name)}" aria-label="Session name">
        </div>
        <div class="flex flex-wrap gap-2">
          <select id="review-saved-session" class="sf-field w-48" aria-label="Saved sessions">
            <option value="">Saved sessions…</option>
            ${this.savedSessions
              .map((saved) => `<option value="${escapeHtml(saved.id)}">${escapeHtml(saved.name)}</option>`)
              .join('')}
          </select>
          <button id="review-load-saved" class="sf-btn" type="button">Load saved</button>
          <button id="review-import" class="sf-btn" type="button">Import project</button>
          <input id="review-import-file" type="file" accept=".signalforge" class="hidden">
          <button id="review-capture" class="sf-btn" type="button">Capture current data as shot</button>
          <button id="review-compare" class="sf-btn" type="button">Compare shots</button>
          <button id="review-save" class="sf-btn" type="button">Save session</button>
          <button id="review-export" class="sf-btn" type="button">Export project</button>
        </div>
      </div>
      ${
        SessionWorkspace.persistenceError
          ? `<p class="mb-3 rounded border border-red-500 bg-red-500/10 p-2 text-sm text-red-500">
              Session persistence failed: ${escapeHtml(SessionWorkspace.persistenceError)}
            </p>`
          : ''
      }
      <div class="grid gap-4 lg:grid-cols-[18rem_1fr]">
        <aside class="rounded border border-line bg-surface p-3">
          <h3 class="mb-2 font-semibold">Shots needing review</h3>
          <div class="grid gap-1">
            ${
              session.shots
                .map(
                  (candidate, index) => `
              <button class="sf-btn justify-between text-left ${candidate.id === shot?.id ? 'ring-2 ring-accent' : ''}"
                type="button" data-shot-id="${escapeHtml(candidate.id)}">
                <span>${escapeHtml(candidate.name)}</span>
                <span>${index + 1} · ${candidate.reviewStatus}</span>
              </button>`
                )
                .join('') || '<p class="text-sm text-muted">Capture or import a shot to begin review.</p>'
            }
          </div>
        </aside>
        <section>
          ${
            shot
              ? `
            <div class="mb-3 flex flex-wrap items-center gap-2">
              <button id="review-previous" class="sf-btn" type="button">← Previous</button>
              <strong>${escapeHtml(shot.name)} (${currentIndex + 1}/${session.shots.length})</strong>
              <button id="review-next" class="sf-btn" type="button">Next →</button>
              <span class="text-xs text-muted">Alt+← / Alt+→</span>
            </div>
            ${
              typeof shot.metadata.appendWarning === 'string'
                ? `<p class="mb-3 rounded border border-amber-500 bg-amber-500/10 p-2 text-sm text-amber-500">${escapeHtml(shot.metadata.appendWarning)}</p>`
                : ''
            }
            <div id="review-waveform-plot" class="mb-3 h-80 min-h-72 rounded border border-line"></div>
            <label class="sf-label" for="review-status">Review status</label>
            <select id="review-status" class="sf-field mb-3 max-w-xs">
              ${['unreviewed', 'in-progress', 'accepted', 'excluded']
                .map(
                  (status) =>
                    `<option value="${status}" ${shot.reviewStatus === status ? 'selected' : ''}>${status}</option>`
                )
                .join('')}
            </select>
            <label class="sf-label" for="review-notes">Shot notes</label>
            <textarea id="review-notes" class="sf-field mb-4 min-h-24">${escapeHtml(shot.notes)}</textarea>
            <div class="mb-3 rounded border border-line p-3">
              <h3 class="mb-2 font-semibold">Named markers</h3>
              <div class="grid gap-2 md:grid-cols-[1fr_9rem_9rem_11rem_auto_auto]">
                <input id="review-marker-name" class="sf-field" value="flashover" aria-label="Marker name">
                <input id="review-marker-time" class="sf-field" type="number" step="any" placeholder="Time (s)" aria-label="Marker time">
                <input id="review-marker-end" class="sf-field" type="number" step="any" placeholder="Region end (optional)" aria-label="Region end time">
                <select id="review-snap-mode" class="sf-field" aria-label="Marker snap mode">
                  ${['none', 'sample', 'slope', 'curvature', 'change-point']
                    .map((mode) => `<option value="${mode}">${mode}</option>`)
                    .join('')}
                </select>
                <button id="review-add-marker" class="sf-btn" type="button">Add</button>
                <button id="review-click-marker" class="sf-btn" type="button">${
                  this.clickPlacementArmed ? 'Click plot now…' : 'Place on plot'
                }</button>
              </div>
              <button id="review-suggest-marker" class="sf-btn mt-2" type="button">Suggest strongest edge</button>
              <div class="mt-3 grid gap-1">
                ${
                  shot.annotations
                    .map(
                      (annotation) => `
                  <div class="flex flex-wrap items-center justify-between gap-2 rounded bg-panel px-2 py-1 text-sm">
                    <span><strong>${escapeHtml(annotation.name)}</strong> · ${annotation.startTime.toPrecision(7)} s${
                      annotation.endTime === undefined ? '' : `–${annotation.endTime.toPrecision(7)} s`
                    } ·
                      ${escapeHtml(annotation.source)}${
                        annotation.suggestionState ? `/${escapeHtml(annotation.suggestionState)}` : ''
                      }</span>
                    <input class="sf-field w-36 py-1" type="number" step="any" value="${annotation.startTime}"
                      data-annotation-time="${escapeHtml(annotation.id)}" aria-label="Move ${escapeHtml(annotation.name)} marker">
                    ${
                      annotation.source === 'suggested' && annotation.suggestionState === 'pending'
                        ? `<span>
                            <button class="sf-btn px-2 py-0.5" data-annotation="${escapeHtml(annotation.id)}" data-state="accepted">Accept</button>
                            <button class="sf-btn px-2 py-0.5" data-annotation="${escapeHtml(annotation.id)}" data-state="rejected">Reject</button>
                          </span>`
                        : ''
                    }
                  </div>`
                    )
                    .join('') || '<p class="text-sm text-muted">No markers placed.</p>'
                }
              </div>
            </div>
            <div class="rounded border border-line p-3">
              <h3 class="mb-2 font-semibold">Pulse power calculation</h3>
              <div class="grid gap-2 md:grid-cols-3">
                <label class="text-sm">Voltage channel
                  <select id="review-voltage-channel" class="sf-field">
                    ${shot.channels.map((channel) => `<option value="${escapeHtml(channel.id)}">${escapeHtml(channel.name)}</option>`).join('')}
                  </select>
                </label>
                <label class="text-sm">Current channel
                  <select id="review-current-channel" class="sf-field">
                    ${shot.channels
                      .map(
                        (channel, index) =>
                          `<option value="${escapeHtml(channel.id)}" ${index === 1 ? 'selected' : ''}>${escapeHtml(channel.name)}</option>`
                      )
                      .join('')}
                  </select>
                </label>
                <label class="text-sm">Voltage polarity
                  <select id="review-voltage-polarity" class="sf-field">
                    <option value="1">Positive as recorded</option>
                    <option value="-1">Invert voltage</option>
                  </select>
                </label>
                <label class="text-sm">Current polarity
                  <select id="review-current-polarity" class="sf-field">
                    <option value="1">Positive as recorded</option>
                    <option value="-1">Invert current</option>
                  </select>
                </label>
                <label class="text-sm">Current delay (samples; positive means current lags)
                  <input id="review-current-delay" class="sf-field" type="number" step="any" value="0">
                  <button id="review-estimate-delay" class="sf-btn mt-1" type="button">Estimate fractional deskew</button>
                </label>
                <label class="text-sm">Start marker
                  <select id="review-start-marker" class="sf-field">
                    <option value="">Record start</option>
                    ${shot.annotations
                      .filter(
                        (annotation) => annotation.source === 'manual' || annotation.suggestionState === 'accepted'
                      )
                      .map(
                        (annotation) =>
                          `<option value="${escapeHtml(annotation.id)}">${escapeHtml(annotation.name)}</option>`
                      )
                      .join('')}
                  </select>
                </label>
                <label class="text-sm">End marker
                  <select id="review-end-marker" class="sf-field">
                    <option value="">Record end</option>
                    ${shot.annotations
                      .filter(
                        (annotation) => annotation.source === 'manual' || annotation.suggestionState === 'accepted'
                      )
                      .map(
                        (annotation) =>
                          `<option value="${escapeHtml(annotation.id)}">${escapeHtml(annotation.name)}</option>`
                      )
                      .join('')}
                  </select>
                </label>
                <label class="text-sm">Minimum current (A)
                  <input id="review-min-current" class="sf-field" type="number" min="0" step="any" value="0.001">
                </label>
              </div>
              <div class="mt-2 flex flex-wrap items-center gap-2">
                <button id="review-calculate-pulse" class="sf-btn" type="button">Calculate and record</button>
                <button id="review-batch-pulse" class="sf-btn" type="button">Batch all shots</button>
                <button id="review-cancel-batch" class="sf-btn" type="button" ${
                  this.batchController ? '' : 'disabled'
                }>Cancel batch</button>
                <span id="review-batch-status" class="text-sm text-muted"></span>
              </div>
              ${
                this.pulseResult
                  ? `<div class="mt-3 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                    ${Object.entries(this.pulseResult.metrics)
                      .map(
                        ([name, measurement]) =>
                          `<div class="rounded bg-panel px-2 py-1 text-sm"><strong>${escapeHtml(name)}</strong>: ${
                            measurement.value === null ? '—' : measurement.value.toPrecision(6)
                          } ${escapeHtml(measurement.unit)}</div>`
                      )
                      .join('')}
                    </div>
                    ${
                      this.pulseResult.warnings.length
                        ? `<p class="mt-2 text-sm text-amber-500">${escapeHtml(this.pulseResult.warnings.join(' '))}</p>`
                        : ''
                    }`
                  : ''
              }
            </div>
          `
              : '<p class="rounded border border-line p-4 text-muted">No active shot.</p>'
          }
        </section>
      </div>
    `;
    this.bind();
    if (shot) void this.renderWaveform(shot);
  },

  async renderWaveform(shot: Shot): Promise<void> {
    const element = this.content?.querySelector<HTMLElement>('#review-waveform-plot');
    if (!element) return;
    element.classList.toggle('ring-2', this.clickPlacementArmed);
    element.classList.toggle('ring-accent', this.clickPlacementArmed);
    const traces: Data[] = shot.channels.map((channel) => ({
      x: Array.from(channel.time, (time) => time + channel.timingOffsetSeconds),
      y: Array.from(channel.values),
      mode: 'lines',
      name: channel.name
    }));
    const shapes: NonNullable<Layout['shapes']> = shot.annotations
      .filter((annotation) => annotation.suggestionState !== 'rejected')
      .map((annotation) =>
        annotation.kind === 'region' && annotation.endTime !== undefined
          ? {
              type: 'rect' as const,
              x0: annotation.startTime,
              x1: annotation.endTime,
              y0: 0,
              y1: 1,
              yref: 'paper' as const,
              fillcolor: 'rgba(245, 158, 11, 0.14)',
              line: { color: '#f59e0b', dash: 'dot' as const }
            }
          : {
              type: 'line' as const,
              x0: annotation.startTime,
              x1: annotation.startTime,
              y0: 0,
              y1: 1,
              yref: 'paper' as const,
              line: {
                color: annotation.source === 'manual' ? '#f59e0b' : '#38bdf8',
                width: annotation.source === 'manual' ? 2 : 1,
                dash: annotation.source === 'manual' ? ('solid' as const) : ('dot' as const)
              }
            }
      );
    const plot = await Plotly.newPlot(
      element,
      traces,
      {
        title: shot.name,
        margin: { t: 45, r: 20, b: 45, l: 60 },
        xaxis: { title: 'Time (s)' },
        yaxis: { title: 'Amplitude' },
        legend: { orientation: 'h' },
        shapes
      },
      { responsive: true, displaylogo: false }
    );
    plot.on('plotly_click', ((event: PlotMouseEvent) => {
      if (!this.clickPlacementArmed) return;
      const time = Number(event.points[0]?.x);
      if (!Number.isFinite(time)) return;
      this.placeMarker(time);
      this.setClickPlacement(false);
      this.render();
    }) as (event: PlotMouseEvent) => void);
  },

  bind(): void {
    if (!this.content) return;
    this.content.querySelector<HTMLInputElement>('#review-session-name')?.addEventListener('change', (event) => {
      if (!SessionWorkspace.activeSession) return;
      SessionWorkspace.activeSession.name = (event.target as HTMLInputElement).value.trim() || 'Untitled session';
      SessionWorkspace.scheduleSave();
    });
    this.content.querySelector('#review-capture')?.addEventListener('click', () => {
      try {
        SessionWorkspace.captureCurrentData();
        this.render();
      } catch (error) {
        alert(error instanceof Error ? error.message : String(error));
      }
    });
    this.content.querySelector('#review-compare')?.addEventListener('click', () => {
      if (SessionWorkspace.activeSession) EnsembleView.show(SessionWorkspace.activeSession);
    });
    this.content.querySelector('#review-load-saved')?.addEventListener('click', async () => {
      const id = this.content?.querySelector<HTMLSelectElement>('#review-saved-session')?.value;
      if (!id) return;
      const session = await sessionRepository.get(id);
      if (session) {
        SessionWorkspace.setActive(session);
        renderColumnTabs();
        runPipelineAndRender();
      }
      this.render();
    });
    const importInput = this.content.querySelector<HTMLInputElement>('#review-import-file');
    this.content.querySelector('#review-import')?.addEventListener('click', () => importInput?.click());
    importInput?.addEventListener('change', async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      if (file.size > 512 * 1024 * 1024) {
        alert('Project import failed: archive exceeds the 512 MB input limit.');
        importInput.value = '';
        return;
      }
      try {
        let session = await importProjectArchive(new Uint8Array(await file.arrayBuffer()));
        const existing = await sessionRepository.get(session.id);
        if (existing) {
          const importedFromId = session.id;
          const now = new Date().toISOString();
          session = {
            ...session,
            id: `session-${crypto.randomUUID()}`,
            name: `${session.name} (imported copy)`,
            metadata: { ...session.metadata, importedFromSessionId: importedFromId },
            createdAt: now,
            updatedAt: now
          };
          alert('A session with this ID already exists. The archive was imported as a separate copy.');
        }
        const saved = await sessionRepository.save(session);
        SessionWorkspace.setActive(saved);
        renderColumnTabs();
        runPipelineAndRender();
        await this.refreshSavedSessions();
      } catch (error) {
        alert(error instanceof Error ? error.message : String(error));
      } finally {
        importInput.value = '';
      }
    });
    this.content.querySelector('#review-save')?.addEventListener('click', async () => {
      try {
        await SessionWorkspace.save();
      } catch (error) {
        alert(`Session save failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    this.content.querySelector('#review-export')?.addEventListener('click', () => {
      if (!SessionWorkspace.activeSession) return;
      void downloadProjectArchive(SessionWorkspace.activeSession).catch((error: unknown) => {
        alert(`Project export failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
    this.content.querySelector('#review-previous')?.addEventListener('click', () => this.navigate(-1));
    this.content.querySelector('#review-next')?.addEventListener('click', () => this.navigate(1));
    this.content.querySelector<HTMLSelectElement>('#review-status')?.addEventListener('change', (event) => {
      SessionWorkspace.updateShot({
        reviewStatus: (event.target as HTMLSelectElement).value as
          'unreviewed' | 'in-progress' | 'accepted' | 'excluded'
      });
      this.render();
    });
    this.content.querySelector<HTMLTextAreaElement>('#review-notes')?.addEventListener('input', (event) => {
      SessionWorkspace.updateShot({ notes: (event.target as HTMLTextAreaElement).value });
    });
    this.content.querySelector('#review-add-marker')?.addEventListener('click', () => {
      const time = Number(this.content?.querySelector<HTMLInputElement>('#review-marker-time')?.value);
      if (!Number.isFinite(time)) {
        alert('Enter a finite marker time.');
        return;
      }
      this.placeMarker(time);
      this.render();
    });
    this.content.querySelector('#review-click-marker')?.addEventListener('click', () => {
      this.setClickPlacement(!this.clickPlacementArmed);
      this.render();
    });
    this.content.querySelector('#review-suggest-marker')?.addEventListener('click', () => {
      const { rawX, rawY } = this.getReviewSeries();
      if (!rawX.length) return;
      const suggestion = snapMarker(rawX, rawY, (rawX[0] + rawX[rawX.length - 1]) / 2, 'slope', rawX.length);
      const name = this.content?.querySelector<HTMLInputElement>('#review-marker-name')?.value.trim() || 'event';
      if (suggestion) {
        SessionWorkspace.addMarker(name, suggestion.time, {
          source: 'suggested',
          suggestionState: 'pending',
          snapMode: 'slope'
        });
      }
      this.render();
    });
    this.content.querySelector('#review-calculate-pulse')?.addEventListener('click', () => {
      void this.calculateAndRecordPulse();
    });
    this.content.querySelector('#review-estimate-delay')?.addEventListener('click', () => {
      this.estimateActiveDelay();
    });
    this.content.querySelector('#review-batch-pulse')?.addEventListener('click', () => {
      void this.runBatchPulse();
    });
    this.content.querySelector('#review-cancel-batch')?.addEventListener('click', () => {
      this.batchController?.abort();
    });
    this.content.querySelectorAll<HTMLElement>('[data-shot-id]').forEach((button) => {
      button.addEventListener('click', () => {
        SessionWorkspace.openShot(button.dataset.shotId || '');
        this.pulseResult = null;
        renderColumnTabs();
        runPipelineAndRender();
        this.render();
      });
    });
    this.content.querySelectorAll<HTMLElement>('[data-annotation][data-state]').forEach((button) => {
      button.addEventListener('click', () => {
        const annotation = SessionWorkspace.getActiveShot()?.annotations.find(
          (candidate) => candidate.id === button.dataset.annotation
        );
        if (annotation) {
          annotation.suggestionState = button.dataset.state as 'accepted' | 'rejected';
          annotation.updatedAt = new Date().toISOString();
          SessionWorkspace.touchShot(true);
          this.batchAnalyzer.clearCache();
        }
        this.render();
      });
    });
    this.content.querySelectorAll<HTMLInputElement>('[data-annotation-time]').forEach((input) => {
      input.addEventListener('change', () => {
        const annotation = SessionWorkspace.getActiveShot()?.annotations.find(
          (candidate) => candidate.id === input.dataset.annotationTime
        );
        const time = Number(input.value);
        if (!annotation || !Number.isFinite(time)) return;
        annotation.startTime = time;
        annotation.source = 'manual';
        annotation.suggestionState = 'accepted';
        annotation.updatedAt = new Date().toISOString();
        SessionWorkspace.touchShot(true);
        this.batchAnalyzer.clearCache();
        this.render();
      });
    });
  },

  estimateActiveDelay(): void {
    const shot = SessionWorkspace.getActiveShot();
    if (!shot || !this.content) return;
    const voltageId = this.content.querySelector<HTMLSelectElement>('#review-voltage-channel')?.value;
    const currentId = this.content.querySelector<HTMLSelectElement>('#review-current-channel')?.value;
    const voltage = shot.channels.find((channel) => channel.id === voltageId);
    const current = shot.channels.find((channel) => channel.id === currentId);
    if (!voltage || !current || voltage.id === current.id) {
      alert('Select different voltage and current channels.');
      return;
    }
    const shiftedVoltageTime = Float64Array.from(voltage.time, (time) => time + voltage.timingOffsetSeconds);
    const alignedCurrent = interpolateToTimebase(
      current.time,
      current.values,
      shiftedVoltageTime,
      current.timingOffsetSeconds
    );
    const estimate = CrossChannel.estimateDelay(
      Array.from(shiftedVoltageTime),
      Array.from(voltage.values),
      alignedCurrent.values
    );
    const input = this.content.querySelector<HTMLInputElement>('#review-current-delay');
    if (input) input.value = String(estimate.delaySamples);
    const status = this.content.querySelector<HTMLElement>('#review-batch-status');
    if (status) {
      status.textContent = `Estimated current delay ${estimate.delaySamples.toPrecision(5)} samples · confidence ${estimate.confidence.toFixed(3)}`;
      if (alignedCurrent.warnings.length) status.textContent += ` · ${alignedCurrent.warnings.join(' ')}`;
    }
  },

  async runBatchPulse(): Promise<void> {
    const session = SessionWorkspace.activeSession;
    const shot = SessionWorkspace.getActiveShot();
    if (!session || !shot || !this.content) return;
    const voltageId = this.content.querySelector<HTMLSelectElement>('#review-voltage-channel')?.value;
    const currentId = this.content.querySelector<HTMLSelectElement>('#review-current-channel')?.value;
    const voltageName = shot.channels.find((channel) => channel.id === voltageId)?.name;
    const currentName = shot.channels.find((channel) => channel.id === currentId)?.name;
    if (!voltageName || !currentName || voltageName === currentName) {
      alert('Select different voltage and current channels.');
      return;
    }
    const startMarkerId = this.content.querySelector<HTMLSelectElement>('#review-start-marker')?.value;
    const endMarkerId = this.content.querySelector<HTMLSelectElement>('#review-end-marker')?.value;
    const startMarker = shot.annotations.find((annotation) => annotation.id === startMarkerId)?.name;
    const endMarker = shot.annotations.find((annotation) => annotation.id === endMarkerId)?.name;
    const currentDelaySamples =
      Number(this.content.querySelector<HTMLInputElement>('#review-current-delay')?.value) || 0;
    const minimumCurrent = Number(this.content.querySelector<HTMLInputElement>('#review-min-current')?.value) || 0;
    const voltagePolarity: 1 | -1 =
      this.content.querySelector<HTMLSelectElement>('#review-voltage-polarity')?.value === '-1' ? -1 : 1;
    const currentPolarity: 1 | -1 =
      this.content.querySelector<HTMLSelectElement>('#review-current-polarity')?.value === '-1' ? -1 : 1;
    const status = this.content.querySelector<HTMLElement>('#review-batch-status');
    const batchButton = this.content.querySelector<HTMLButtonElement>('#review-batch-pulse');
    const cancelButton = this.content.querySelector<HTMLButtonElement>('#review-cancel-batch');
    this.batchController?.abort();
    this.batchController = new AbortController();
    if (batchButton) batchButton.disabled = true;
    if (cancelButton) cancelButton.disabled = false;
    try {
      const batch = await this.batchAnalyzer.run(
        session,
        {
          id: 'pulse-power',
          voltageChannel: voltageName,
          currentChannel: currentName,
          startMarker,
          endMarker,
          currentDelaySamples,
          minimumCurrent,
          voltagePolarity,
          currentPolarity,
          applicationVersion: '6.0.0-dev'
        },
        {
          signal: this.batchController.signal,
          onProgress: (progress) => {
            if (status) {
              status.textContent = `${progress.completed}/${progress.total} · ${progress.status}`;
            }
          }
        }
      );
      for (const [shotId, result] of batch.results) {
        const target = session.shots.find((candidate) => candidate.id === shotId);
        if (target && !target.analysisResults.some((existing) => existing.id === result.id)) {
          target.analysisResults.push(result);
        }
      }
      session.updatedAt = new Date().toISOString();
      SessionWorkspace.scheduleSave();
      if (status) status.textContent = `Complete · ${batch.results.size} results · ${batch.failures.size} failures`;
    } catch (error) {
      if (status) {
        status.textContent =
          error instanceof DOMException && error.name === 'AbortError'
            ? 'Batch cancelled'
            : error instanceof Error
              ? error.message
              : String(error);
      }
    } finally {
      this.batchController = null;
      if (batchButton) batchButton.disabled = false;
      if (cancelButton) cancelButton.disabled = true;
    }
  },

  async calculateAndRecordPulse(): Promise<void> {
    const shot = SessionWorkspace.getActiveShot();
    if (!shot || !this.content) return;
    const voltageId = this.content.querySelector<HTMLSelectElement>('#review-voltage-channel')?.value;
    const currentId = this.content.querySelector<HTMLSelectElement>('#review-current-channel')?.value;
    const voltage = shot.channels.find((channel) => channel.id === voltageId);
    const current = shot.channels.find((channel) => channel.id === currentId);
    if (!voltage || !current || voltage.id === current.id) {
      alert('Select different voltage and current channels.');
      return;
    }
    const markerIndex = (annotationId: string | undefined, fallback: number): number => {
      const annotation = shot.annotations.find((candidate) => candidate.id === annotationId);
      if (!annotation) return fallback;
      let selected = fallback;
      let distance = Infinity;
      voltage.time.forEach((time, index) => {
        const candidate = Math.abs(time + voltage.timingOffsetSeconds - annotation.startTime);
        if (candidate < distance) {
          selected = index;
          distance = candidate;
        }
      });
      return selected;
    };
    const startMarkerId = this.content.querySelector<HTMLSelectElement>('#review-start-marker')?.value;
    const endMarkerId = this.content.querySelector<HTMLSelectElement>('#review-end-marker')?.value;
    const start = markerIndex(startMarkerId, 0);
    const end = markerIndex(endMarkerId, Math.min(voltage.values.length, voltage.time.length) - 1);
    const currentDelaySamples =
      Number(this.content.querySelector<HTMLInputElement>('#review-current-delay')?.value) || 0;
    const minimumCurrent = Number(this.content.querySelector<HTMLInputElement>('#review-min-current')?.value) || 0;
    const voltagePolarity: 1 | -1 =
      this.content.querySelector<HTMLSelectElement>('#review-voltage-polarity')?.value === '-1' ? -1 : 1;
    const currentPolarity: 1 | -1 =
      this.content.querySelector<HTMLSelectElement>('#review-current-polarity')?.value === '-1' ? -1 : 1;
    this.pulseResult = calculatePulsePower({
      time: voltage.time,
      voltage: voltage.values,
      current: current.values,
      currentTime: current.time,
      voltageTimingOffsetSeconds: voltage.timingOffsetSeconds,
      currentTimingOffsetSeconds: current.timingOffsetSeconds,
      voltageQuality: voltage.quality,
      currentQuality: current.quality,
      voltageUnit: voltage.unit,
      currentUnit: current.unit,
      currentDelaySamples,
      minimumCurrent,
      voltagePolarity,
      currentPolarity,
      region: {
        i0: Math.min(start, end),
        i1: Math.max(start, end),
        markerName: shot.annotations.find((annotation) => annotation.id === endMarkerId)?.name
      },
      pretriggerRegion: { i0: 0, i1: Math.max(0, Math.min(start, end) - 1) }
    });
    const recipe = JSON.stringify({
      voltageId,
      currentId,
      startMarkerId,
      endMarkerId,
      currentDelaySamples,
      minimumCurrent,
      voltagePolarity,
      currentPolarity,
      voltageTimingOffsetSeconds: voltage.timingOffsetSeconds,
      currentTimingOffsetSeconds: current.timingOffsetSeconds
    });
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(recipe));
    const recipeHash = Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join('');
    shot.analysisResults.push({
      id: `analysis-${crypto.randomUUID()}`,
      type: 'pulse-power',
      values: Object.fromEntries(
        Object.entries(this.pulseResult.metrics).map(([name, measurement]) => [name, measurement.value])
      ),
      units: Object.fromEntries(
        Object.entries(this.pulseResult.metrics).map(([name, measurement]) => [name, measurement.unit])
      ),
      provenance: {
        sourceChannelIds: [voltage.id, current.id],
        processingRecipeHash: recipeHash,
        annotationIds: [startMarkerId, endMarkerId].filter((id): id is string => Boolean(id)),
        warnings: this.pulseResult.warnings,
        applicationVersion: '6.0.0-dev',
        appliedDelaySeconds:
          current.timingOffsetSeconds -
          voltage.timingOffsetSeconds +
          currentDelaySamples * (voltage.time.length > 1 ? voltage.time[1] - voltage.time[0] : 0),
        createdAt: new Date().toISOString()
      }
    });
    shot.updatedAt = new Date().toISOString();
    SessionWorkspace.scheduleSave();
    this.render();
  },

  placeMarker(requestedTime: number): void {
    const { rawX, rawY } = this.getReviewSeries();
    const name = this.content?.querySelector<HTMLInputElement>('#review-marker-name')?.value.trim() || 'event';
    const mode =
      (this.content?.querySelector<HTMLSelectElement>('#review-snap-mode')?.value as MarkerSnapMode) || 'none';
    const snapped = snapMarker(rawX, rawY, requestedTime, mode);
    const endText = this.content?.querySelector<HTMLInputElement>('#review-marker-end')?.value.trim() || '';
    const endTime = endText === '' ? undefined : Number(endText);
    SessionWorkspace.addMarker(name, snapped?.time ?? requestedTime, {
      source: 'manual',
      snapMode: mode,
      kind: Number.isFinite(endTime) ? 'region' : 'marker',
      endTime: Number.isFinite(endTime) ? endTime : undefined
    });
  },

  getReviewSeries(): { rawX: number[]; rawY: number[] } {
    const shot = SessionWorkspace.getActiveShot();
    const selected = shot?.channels.find((channel) => channel.name === State.data.dataColumn) || shot?.channels[0];
    if (!selected) return getRawSeries();
    return {
      rawX: Array.from(selected.time, (time) => time + selected.timingOffsetSeconds),
      rawY: Array.from(selected.values)
    };
  },

  setClickPlacement(armed: boolean): void {
    this.clickPlacementArmed = armed;
    this.content?.querySelector('#review-waveform-plot')?.classList.toggle('ring-2', armed);
    this.content?.querySelector('#review-waveform-plot')?.classList.toggle('ring-accent', armed);
  },

  navigate(direction: number): void {
    SessionWorkspace.stepShot(direction);
    this.pulseResult = null;
    renderColumnTabs();
    runPipelineAndRender();
    this.render();
  }
};
