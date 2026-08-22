import { State } from '../state';
import { elements } from './domElements';
import { triggerGraphUpdateOnly } from './dataPipeline';

export function bindToolbarEvents(): void {
  const { liveShowRaw, liveRawOpacity, liveShowDiff, liveFreqDomain, diffGroup } = elements;

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

  liveFreqDomain?.addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    State.config.graph.showFreqDomain = checked;
    if (diffGroup) diffGroup.classList.toggle('hidden', checked);
    triggerGraphUpdateOnly();
  });
}

export function updateToolbarUIFromState(): void {
  const { liveShowRaw, liveRawOpacity, liveShowDiff, liveFreqDomain, diffGroup } = elements;
  const cfg = State.config.graph;
  if (liveShowRaw) {
    liveShowRaw.checked = cfg.showRaw !== false;
    if (liveRawOpacity) liveRawOpacity.disabled = !liveShowRaw.checked;
  }
  if (liveRawOpacity) liveRawOpacity.value = String(cfg.rawOpacity || 0.5);
  if (liveShowDiff) liveShowDiff.checked = cfg.showDifferential;
  if (liveFreqDomain) liveFreqDomain.checked = cfg.showFreqDomain;
  if (diffGroup) diffGroup.classList.toggle('hidden', !!cfg.showFreqDomain);
}
