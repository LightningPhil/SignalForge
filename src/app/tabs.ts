import { MathEngine } from '../processing/math';
import { State } from '../state';
import type { MultiView } from '../types';
import { cx, ui } from '../ui/classes';
import { Graph } from '../ui/graph';
import { createModal, escapeHtml } from '../ui/uiHelpers';
import { renderComposerPanel } from './composerUi';
import { runPipelineAndRender } from './dataPipeline';
import { elements } from './domElements';
import { showMathModal } from './mathModal';
import { renderPipelineList, updateParamEditor } from './pipelineUi';

export interface TabTarget {
  columnId?: string | null;
  multiViewId?: string | null;
}

let tabsScrollInit = false;
let isSyncingScroll = false;
let tabsResizeObserver: ResizeObserver | null = null;

function updateTabsOverflowState(): void {
  const { tabViewport, tabContainer, tabsWrapper, tabsScrollbarSpacer, tabsScrollbar } = elements;
  if (!tabViewport || !tabContainer || !tabsWrapper || !tabsScrollbarSpacer || !tabsScrollbar) return;

  tabsScrollbarSpacer.style.width = `${tabContainer.scrollWidth}px`;
  const hasOverflow = tabViewport.scrollWidth > tabViewport.clientWidth + 1;
  tabsWrapper.classList.toggle('no-tab-overflow', !hasOverflow);

  if (!hasOverflow) {
    tabViewport.scrollLeft = 0;
    tabsScrollbar.scrollLeft = 0;
  }

  if (!isSyncingScroll && tabsScrollbar.scrollLeft !== tabViewport.scrollLeft) {
    tabsScrollbar.scrollLeft = tabViewport.scrollLeft;
  }
}

function initTabsScrolling(): void {
  if (tabsScrollInit) return;
  tabsScrollInit = true;

  const { tabViewport, tabsScrollbar, tabContainer } = elements;
  if (!tabViewport || !tabsScrollbar) return;

  tabViewport.addEventListener('scroll', () => {
    if (isSyncingScroll) return;
    isSyncingScroll = true;
    tabsScrollbar.scrollLeft = tabViewport.scrollLeft;
    isSyncingScroll = false;
  });

  tabsScrollbar.addEventListener('scroll', () => {
    if (isSyncingScroll) return;
    isSyncingScroll = true;
    tabViewport.scrollLeft = tabsScrollbar.scrollLeft;
    isSyncingScroll = false;
  });

  tabsResizeObserver = new ResizeObserver(() => updateTabsOverflowState());
  if (tabContainer) tabsResizeObserver.observe(tabContainer);
  tabsResizeObserver.observe(tabViewport);
  window.addEventListener('resize', updateTabsOverflowState, { passive: true });
}

function showPipelinePanels(): void {
  elements.pipelinePanel?.classList.remove('hidden');
  elements.pipelineList?.classList.remove('hidden');
  elements.pipelineActions?.classList.remove('hidden');
  elements.mathTraceNote?.classList.add('hidden');
  elements.paramPanel?.classList.remove('hidden');
  elements.traceSelectorPanel?.classList.add('hidden');
}

function showMathPipelineNotice(): void {
  elements.pipelinePanel?.classList.add('hidden');
  elements.pipelineList?.classList.add('hidden');
  elements.pipelineActions?.classList.add('hidden');
  elements.paramPanel?.classList.add('hidden');
  elements.mathTraceNote?.classList.remove('hidden');
  elements.traceSelectorPanel?.classList.add('hidden');
  elements.composerPanel?.classList.add('hidden');
}

function renderTraceSelector(view: MultiView): void {
  const { traceSelectorPanel, traceSelectorList } = elements;
  if (!traceSelectorPanel || !traceSelectorList) return;

  traceSelectorPanel.classList.remove('hidden');
  elements.pipelinePanel?.classList.add('hidden');
  elements.paramPanel?.classList.add('hidden');
  elements.mathTraceNote?.classList.add('hidden');

  const headers = State.data.headers || [];
  const xCol = State.data.timeColumn;
  const yCols = headers.filter((h) => h !== xCol);
  const allCols = [...new Set([...yCols, ...MathEngine.getAvailableMathColumns()])];

  if (allCols.length === 0) {
    traceSelectorList.innerHTML = '<p class="text-sm text-muted">No numeric columns available.</p>';
    return;
  }

  traceSelectorList.innerHTML = allCols.map((col) => {
    const safeCol = escapeHtml(col);
    const isChecked = view.activeColumnIds.includes(col) ? 'checked' : '';
    return `<label class="${ui.toggleLabel}"><input type="checkbox" class="h-4 w-4 accent-accent" data-col="${safeCol}" ${isChecked}> ${safeCol}</label>`;
  }).join('');

  traceSelectorList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((chk) => {
    chk.addEventListener('change', () => {
      const colId = chk.getAttribute('data-col');
      if (!colId) return;
      State.toggleColumnInMultiView(view.id, colId);
      renderComposerPanel();
      runPipelineAndRender();
    });
  });
}

function getRightMostTabTarget(): TabTarget | null {
  const headers = State.data.headers || [];
  const xCol = State.data.timeColumn;
  const yCols = headers.filter((h) => h !== xCol);
  const virtualCols = MathEngine.getAvailableMathColumns();

  if (State.multiViews.length > 0) {
    return { columnId: null, multiViewId: State.multiViews[State.multiViews.length - 1].id };
  }
  if (virtualCols.length > 0) return { columnId: virtualCols[virtualCols.length - 1], multiViewId: null };
  if (yCols.length > 0) return { columnId: yCols[yCols.length - 1], multiViewId: null };
  return null;
}

export function activateTab({ columnId = null, multiViewId = null }: TabTarget = {}): void {
  const headers = State.data.headers || [];
  const xCol = State.data.timeColumn;
  const yCols = headers.filter((h) => h !== xCol);
  const rangeKey = State.getViewKeyFor(columnId, multiViewId);

  if (multiViewId) {
    const view = State.multiViews.find((v) => v.id === multiViewId);
    if (!view) return;
    State.ui.activeMultiViewId = multiViewId;
    State.syncComposerForView(view.id, view.activeColumnIds);
    renderTraceSelector(view);
  } else if (columnId) {
    if (!yCols.includes(columnId) && !MathEngine.getAvailableMathColumns().includes(columnId)) return;
    State.ui.activeMultiViewId = null;
    State.data.dataColumn = columnId;
    State.syncComposerForView(null, [State.data.dataColumn].filter(Boolean));
    if (State.getMathDefinition(columnId)) showMathPipelineNotice();
    else showPipelinePanels();
  }

  const pipeline = State.getPipeline();
  if (!pipeline.some((s) => s.id === State.ui.selectedStepId)) {
    State.ui.selectedStepId = pipeline[0]?.id || null;
  }

  renderPipelineList();
  updateParamEditor();
  renderComposerPanel();

  const activeKey = rangeKey || State.getActiveViewKey();
  const savedRange = activeKey ? State.getViewRangeForKey(activeKey) : undefined;
  const rangeToApply = savedRange === undefined ? null : savedRange;

  if (savedRange === null) Graph.lastRanges = { x: null, y: null };
  else if (savedRange) Graph.lastRanges = { x: savedRange.x ?? null, y: savedRange.y ?? null };
  else Graph.lastRanges = { x: null, y: null };

  runPipelineAndRender(rangeToApply);
}

function fallbackAfterTabRemoval(): void {
  const target = getRightMostTabTarget();
  if (target) {
    activateTab(target);
    return;
  }
  State.data.dataColumn = null;
  State.ui.activeMultiViewId = null;
  showPipelinePanels();
  renderPipelineList();
  updateParamEditor();
  renderComposerPanel();
  runPipelineAndRender();
}

export function renderColumnTabs(): void {
  const { tabContainer, btnAddMultiView } = elements;
  if (!tabContainer) return;

  initTabsScrolling();

  const headers = State.data.headers || [];
  const xCol = State.data.timeColumn;
  const activeCol = State.data.dataColumn;
  const activeMulti = State.ui.activeMultiViewId;
  const yCols = headers.filter((h) => h !== xCol);
  const virtualCols = MathEngine.getAvailableMathColumns();

  tabContainer.replaceChildren();

  const appendSep = () => {
    const sep = document.createElement('div');
    sep.className = ui.tabSep;
    sep.setAttribute('aria-hidden', 'true');
    tabContainer.appendChild(sep);
  };

  const makeTab = (opts: {
    label: string;
    active: boolean;
    virtual?: boolean;
    viewId?: string;
    columnId?: string;
  }): HTMLDivElement => {
    const tab = document.createElement('div');
    tab.className = cx(ui.tab, opts.active && ui.tabActive, opts.virtual && opts.active && ui.tabVirtualActive);
    tab.dataset.col = opts.columnId || '';
    if (opts.viewId) tab.dataset.view = opts.viewId;
    tab.title = opts.label;
    tab.setAttribute('role', 'tab');
    tab.tabIndex = 0;
    tab.setAttribute('aria-selected', opts.active ? 'true' : 'false');

    const label = document.createElement('span');
    label.className = 'min-w-0 truncate';
    label.textContent = opts.label;
    tab.appendChild(label);
    return tab;
  };

  const bindTabActivate = (tab: HTMLElement, activate: () => void) => {
    tab.addEventListener('click', activate);
    tab.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
      }
    });
  };

  yCols.forEach((col) => {
    const tab = makeTab({ label: col, active: !activeMulti && col === activeCol, columnId: col });
    bindTabActivate(tab, () => {
      activateTab({ columnId: col });
      renderColumnTabs();
      tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    tabContainer.appendChild(tab);
  });

  if (virtualCols.length > 0) {
    appendSep();
    virtualCols.forEach((col) => {
      const tab = makeTab({
        label: col,
        active: !activeMulti && col === activeCol,
        virtual: true,
        columnId: col
      });

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = ui.tabAction;
      edit.textContent = '✎';
      edit.setAttribute('aria-label', `Edit math trace ${col}`);
      edit.addEventListener('click', (e) => {
        e.stopPropagation();
        const def = State.getMathDefinition(col);
        if (def) showMathModal(def);
      });

      const close = document.createElement('button');
      close.type = 'button';
      close.className = ui.tabAction;
      close.textContent = '×';
      close.setAttribute('aria-label', `Remove math trace ${col}`);
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        State.removeMathDefinition(col);
        fallbackAfterTabRemoval();
        renderColumnTabs();
      });

      tab.append(edit, close);
      bindTabActivate(tab, () => {
        activateTab({ columnId: col });
        renderColumnTabs();
        tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
      tabContainer.appendChild(tab);
    });
  }

  if (State.multiViews.length > 0) {
    appendSep();
    State.multiViews.forEach((view) => {
      const tab = makeTab({
        label: view.name,
        active: view.id === activeMulti,
        viewId: view.id
      });
      const close = document.createElement('button');
      close.type = 'button';
      close.className = ui.tabAction;
      close.textContent = '×';
      close.setAttribute('aria-label', `Remove multi-view tab ${view.name}`);
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        State.removeMultiView(view.id);
        fallbackAfterTabRemoval();
        renderColumnTabs();
      });
      tab.appendChild(close);
      bindTabActivate(tab, () => {
        activateTab({ multiViewId: view.id });
        renderColumnTabs();
        tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
      tabContainer.appendChild(tab);
    });
  }

  if (tabContainer.childElementCount === 0) {
    const placeholder = document.createElement('div');
    placeholder.className = ui.tabPlaceholder;
    placeholder.textContent = 'Load data to see columns';
    tabContainer.appendChild(placeholder);
  }

  if (btnAddMultiView) {
    btnAddMultiView.onclick = () => {
      if (yCols.length === 0 && virtualCols.length === 0) {
        alert('Load a dataset before adding a new tab.');
        return;
      }

      const html = `
        <h3 class="${ui.modalTitle}">Add New View</h3>
        <p class="sf-hint mb-3">Choose whether to stack multiple traces or build a math-derived trace.</p>
        <div class="grid gap-2 sm:grid-cols-2">
          <button class="sf-btn" id="btn-create-multiview" type="button">Multi-View Tab</button>
          <button class="sf-btn" id="btn-create-math" type="button">Math Trace Tab</button>
        </div>
      `;
      const modal = createModal(html);
      const overlay = modal.parentElement;
      const closeModal = () => overlay?.remove();

      modal.querySelector('#btn-create-multiview')?.addEventListener('click', () => {
        const defaultCol = activeCol || yCols[0] || virtualCols[0];
        const view = State.addMultiView(null, defaultCol ? [defaultCol] : []);
        activateTab({ multiViewId: view.id });
        renderColumnTabs();
        closeModal();
      });

      modal.querySelector('#btn-create-math')?.addEventListener('click', () => {
        closeModal();
        showMathModal();
      });
    };
  }

  renderComposerPanel();
  tabContainer.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({
    block: 'nearest',
    inline: 'nearest'
  });
  updateTabsOverflowState();
}
