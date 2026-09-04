import Plotly from 'plotly.js-dist-min';
import type { Data, Layout } from 'plotly.js';
import { eventAlignShots } from '../analysis/ensemble';
import { analyzeRinging } from '../analysis/ringing';
import type { Session } from '../domain/session';
import { createModal, escapeHtml } from './uiHelpers';
import { ui } from './classes';

export const EnsembleView = {
  show(session: Session): void {
    const channelNames = [...new Set(session.shots.flatMap((shot) => shot.channels.map((channel) => channel.name)))];
    const markerNames = [
      ...new Set(session.shots.flatMap((shot) => shot.annotations.map((annotation) => annotation.name)))
    ];
    const metadataNames = [...new Set(session.shots.flatMap((shot) => Object.keys(shot.metadata)))];
    const content = createModal(`
      <h2 class="${ui.modalTitle}">Event-aligned Comparison</h2>
      <div class="mb-3 grid gap-2 md:grid-cols-3 lg:grid-cols-6">
        <label class="text-sm">Channel
          <select id="ensemble-channel" class="sf-field">${channelNames.map((name) => `<option>${escapeHtml(name)}</option>`).join('')}</select>
        </label>
        <label class="text-sm">Marker
          <select id="ensemble-marker" class="sf-field">${markerNames.map((name) => `<option>${escapeHtml(name)}</option>`).join('')}</select>
        </label>
        <label class="text-sm">View
          <select id="ensemble-mode" class="sf-field">
            <option value="overlay">Overlay</option>
            <option value="small-multiple">Small multiples</option>
            <option value="waterfall">Shot waterfall</option>
            <option value="ringing">Ringing vs metadata</option>
          </select>
        </label>
        <label class="text-sm">Before (s)<input id="ensemble-before" class="sf-field" type="number" step="any" value="0.00001"></label>
        <label class="text-sm">After (s)<input id="ensemble-after" class="sf-field" type="number" step="any" value="0.00005"></label>
        <label class="text-sm">Metadata x-axis
          <select id="ensemble-metadata" class="sf-field">${metadataNames.map((name) => `<option>${escapeHtml(name)}</option>`).join('')}</select>
        </label>
      </div>
      <button id="ensemble-render" class="sf-btn mb-2" type="button">Render comparison</button>
      <p id="ensemble-warning" class="text-sm text-amber-500"></p>
      <div id="ensemble-plot" class="h-[min(38rem,65vh)] min-h-80"></div>
    `);
    content.className = `${ui.modal} max-w-7xl`;
    content.querySelector('#ensemble-render')?.addEventListener('click', () => this.render(content, session));
    this.render(content, session);
  },

  render(content: HTMLElement, session: Session): void {
    const channelName = content.querySelector<HTMLSelectElement>('#ensemble-channel')?.value;
    const markerName = content.querySelector<HTMLSelectElement>('#ensemble-marker')?.value;
    const mode = content.querySelector<HTMLSelectElement>('#ensemble-mode')?.value || 'overlay';
    const beforeSeconds = Math.max(0, Number(content.querySelector<HTMLInputElement>('#ensemble-before')?.value) || 0);
    const afterSeconds = Math.max(0, Number(content.querySelector<HTMLInputElement>('#ensemble-after')?.value) || 0);
    const warning = content.querySelector<HTMLElement>('#ensemble-warning');
    if (!channelName || !markerName || beforeSeconds + afterSeconds <= 0) {
      if (warning) warning.textContent = 'Select a channel, accepted marker and nonzero time window.';
      return;
    }
    const ensemble = eventAlignShots(session.shots, channelName, markerName, {
      beforeSeconds,
      afterSeconds,
      sampleCount: 1000
    });
    if (warning) warning.textContent = ensemble.warnings.join(' ');
    const traces: Data[] = [];
    const layout: Partial<Layout> = {
      title: `${channelName} aligned to ${markerName}`,
      xaxis: { title: 'Time from marker (s)' },
      yaxis: { title: channelName },
      showlegend: true
    };

    if (mode === 'waterfall') {
      traces.push({
        type: 'heatmap',
        x: ensemble.relativeTime,
        y: ensemble.shots.map((shot) => shot.shotName),
        z: ensemble.shots.map((shot) => shot.values),
        colorscale: 'Turbo',
        hovertemplate: 'shot=%{y}<br>t=%{x:.6g}s<br>value=%{z:.6g}<extra></extra>'
      });
    } else if (mode === 'small-multiple') {
      ensemble.shots.forEach((shot, index) => {
        const axis = index === 0 ? 'y' : `y${index + 1}`;
        traces.push({ x: shot.relativeTime, y: shot.values, mode: 'lines', name: shot.shotName, yaxis: axis });
        const rowHeight = 1 / Math.max(1, ensemble.shots.length);
        (layout as Record<string, unknown>)[index === 0 ? 'yaxis' : `yaxis${index + 1}`] = {
          title: shot.shotName,
          domain: [1 - (index + 1) * rowHeight, 1 - index * rowHeight]
        };
      });
    } else if (mode === 'ringing') {
      const metadataName = content.querySelector<HTMLSelectElement>('#ensemble-metadata')?.value;
      const points = ensemble.shots
        .map((shot) => {
          const result = analyzeRinging(shot.relativeTime, shot.values);
          const metadata = metadataName ? shot.metadata[metadataName] : shot.shotName;
          return { shot, result, x: typeof metadata === 'number' ? metadata : Number(metadata) };
        })
        .filter((point) => Number.isFinite(point.x));
      traces.push({
        x: points.map((point) => point.x),
        y: points.map((point) => point.result.frequencyHz),
        mode: 'markers',
        name: 'Ringing frequency',
        text: points.map((point) => point.shot.shotName),
        yaxis: 'y'
      });
      traces.push({
        x: points.map((point) => point.x),
        y: points.map((point) => point.result.decayTimeConstant),
        mode: 'markers',
        name: 'Decay constant',
        text: points.map((point) => point.shot.shotName),
        yaxis: 'y2'
      });
      layout.xaxis = { title: metadataName || 'Metadata' };
      layout.yaxis = { title: 'Ringing frequency (Hz)' };
      layout.yaxis2 = { title: 'Decay constant (s)', overlaying: 'y', side: 'right' };
    } else {
      ensemble.shots.forEach((shot) => {
        traces.push({ x: shot.relativeTime, y: shot.values, mode: 'lines', name: shot.shotName });
      });
      traces.push({
        x: ensemble.relativeTime,
        y: ensemble.trimmedMean,
        mode: 'lines',
        name: 'Trimmed mean',
        line: { width: 3, color: '#f59e0b' }
      });
    }
    void Plotly.react(content.querySelector('#ensemble-plot') as HTMLElement, traces, layout, {
      responsive: true
    });
  }
};
