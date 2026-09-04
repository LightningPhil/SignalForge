import { elements } from './app/domElements';
import { setupEventListeners } from './app/eventSetup';
import { registerOfflineWorker } from './app/offline';
import { renderPipelineList, updateParamEditor } from './app/pipelineUi';
import { updateToolbarUIFromState } from './app/toolbar';
import { SettingsManager } from './io/settingsManager';
import { State } from './state';
import { applyStoredCalibration } from './ui/displayCalibration';
import { Graph } from './ui/graph';
import { Theme } from './ui/theme';
import './styles.css';

function bindSidebarToggle(): void {
  const { btnSidebarToggle, sidebar, sidebarBackdrop } = elements;
  if (!btnSidebarToggle || !sidebar) return;

  const close = () => {
    sidebar.classList.remove('translate-x-0');
    sidebar.classList.add('-translate-x-full');
    sidebarBackdrop?.classList.add('hidden');
    btnSidebarToggle.setAttribute('aria-expanded', 'false');
  };

  const open = () => {
    sidebar.classList.remove('-translate-x-full');
    sidebar.classList.add('translate-x-0');
    sidebarBackdrop?.classList.remove('hidden');
    btnSidebarToggle.setAttribute('aria-expanded', 'true');
  };

  btnSidebarToggle.addEventListener('click', () => {
    const expanded = btnSidebarToggle.getAttribute('aria-expanded') === 'true';
    if (expanded) close();
    else open();
  });

  sidebarBackdrop?.addEventListener('click', close);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && btnSidebarToggle.getAttribute('aria-expanded') === 'true') close();
  });
  window.addEventListener('resize', () => {
    if (window.matchMedia('(min-width: 1024px)').matches) close();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  applyStoredCalibration();
  Theme.init(elements.btnThemeToggle);
  Graph.init();
  bindSidebarToggle();

  State.ensureAnalysisConfig();
  const initialPipeline = State.getPipeline();
  if (initialPipeline.length > 0) {
    State.ui.selectedStepId = initialPipeline[0].id;
  }

  if (SettingsManager.loadFromBrowser()) {
    const restored = State.getPipeline();
    if (restored.length && !restored.some((step) => step.id === State.ui.selectedStepId)) {
      State.ui.selectedStepId = restored[0].id;
    }
    updateToolbarUIFromState();
  }

  setupEventListeners();
  renderPipelineList();
  updateParamEditor();
  registerOfflineWorker();
});
