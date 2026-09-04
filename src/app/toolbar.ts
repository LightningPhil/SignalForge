import { State } from '../state';
import type { ViewMode } from '../types';
import { elements } from './domElements';
import { triggerGraphUpdateOnly } from './dataPipeline';

export function bindToolbarEvents(): void {
  const { liveShowRaw, liveRawOpacity, liveShowDiff, liveShowResidual, liveViewMode, liveShowEvents, diffGroup } =
    elements;

  liveShowRaw?.addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    State.config.graph.showRaw = checked;
    if (liveRawOpacity) {
      liveRawOpacity.disabled = !checked;
      liveRawOpacity.parentElement?.classList.toggle('opacity-50', !checked);
    }
    triggerGraphUpdateOnly();
  });

  liveRawOpacity?.addEventListener('input', (e) => {
    State.config.graph.rawOpacity = parseFloat((e.target as HTMLInputElement).value);
    triggerGraphUpdateOnly();
  });

  liveShowDiff?.addEventListener('change', (e) => {
    State.config.graph.showDifferential = (e.target as HTMLInputElement).checked;
    triggerGraphUpdateOnly();
  });
  liveShowResidual?.addEventListener('change', (e) => {
    State.config.graph.showResidual = (e.target as HTMLInputElement).checked;
    triggerGraphUpdateOnly();
  });

  liveViewMode?.addEventListener('change', (e) => {
    const mode = ((e.target as HTMLSelectElement).value || 'time') as ViewMode;
    State.config.graph.viewMode = mode;
    State.config.graph.showFreqDomain = mode === 'fft';
    if (diffGroup) diffGroup.classList.toggle('hidden', mode !== 'time');
    triggerGraphUpdateOnly();
  });

  liveShowEvents?.addEventListener('change', (e) => {
    State.ensureAnalysisConfig().showEvents = (e.target as HTMLInputElement).checked;
    triggerGraphUpdateOnly();
  });
}

export function updateToolbarUIFromState(): void {
  const { liveShowRaw, liveRawOpacity, liveShowDiff, liveShowResidual, liveViewMode, liveShowEvents, diffGroup } =
    elements;
  const cfg = State.config.graph;
  const mode = cfg.viewMode || (cfg.showFreqDomain ? 'fft' : 'time');
  if (liveShowRaw) {
    liveShowRaw.checked = cfg.showRaw !== false;
    if (liveRawOpacity) liveRawOpacity.disabled = !liveShowRaw.checked;
  }
  if (liveRawOpacity) liveRawOpacity.value = String(cfg.rawOpacity || 0.5);
  if (liveShowDiff) liveShowDiff.checked = cfg.showDifferential;
  if (liveShowResidual) liveShowResidual.checked = cfg.showResidual;
  if (liveViewMode) liveViewMode.value = mode;
  if (diffGroup) diffGroup.classList.toggle('hidden', mode !== 'time');
  if (liveShowEvents) liveShowEvents.checked = State.ensureAnalysisConfig().showEvents !== false;
}
