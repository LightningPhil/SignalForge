import { State } from '../state.js';
import { MathEngine } from '../processing/math.js';
import { elements } from './domElements.js';
import { runPipelineAndRender } from './dataPipeline.js';
import { renderPipelineList, updateParamEditor } from './pipelineUi.js';
import { renderComposerPanel } from './composerUi.js';
import { showMathModal } from './mathModal.js';
import { createModal } from '../ui/uiHelpers.js';
import { Graph } from '../ui/graph.js';

function showPipelinePanels() {
    const pipelinePanel = elements.pipelineList?.closest('.panel');
    if (pipelinePanel) pipelinePanel.style.display = '';
    if (elements.pipelineList) elements.pipelineList.style.display = '';
    if (elements.pipelineActions) elements.pipelineActions.style.display = '';
    if (elements.mathTraceNote) elements.mathTraceNote.style.display = 'none';
    if (elements.paramPanel) elements.paramPanel.style.display = '';
    if (elements.traceSelectorPanel) elements.traceSelectorPanel.style.display = 'none';
}

function showMathPipelineNotice() {
    const pipelinePanel = elements.pipelineList?.closest('.panel');
    if (pipelinePanel) pipelinePanel.style.display = 'none';
    if (elements.pipelineList) elements.pipelineList.style.display = 'none';
    if (elements.pipelineActions) elements.pipelineActions.style.display = 'none';
    if (elements.paramPanel) elements.paramPanel.style.display = 'none';
    if (elements.mathTraceNote) elements.mathTraceNote.style.display = '';
    if (elements.traceSelectorPanel) elements.traceSelectorPanel.style.display = 'none';
    if (elements.composerPanel) elements.composerPanel.style.display = 'none';
}

function renderTraceSelector(view) {
    const { traceSelectorPanel, traceSelectorList } = elements;
    if (!traceSelectorPanel || !traceSelectorList) return;

    traceSelectorPanel.style.display = 'block';
    const pipelinePanel = elements.pipelineList?.closest('.panel');
    if (pipelinePanel) pipelinePanel.style.display = 'none';
    if (elements.paramPanel) elements.paramPanel.style.display = 'none';

    const headers = State.data.headers || [];
    const xCol = State.data.timeColumn;
    const yCols = headers.filter((h) => h !== xCol);
    const virtualCols = MathEngine.getAvailableMathColumns();
    const allCols = [...new Set([...yCols, ...virtualCols])];

    if (allCols.length === 0) {
        traceSelectorList.innerHTML = '<p>No numeric columns available.</p>';
        return;
    }

    const optionsHtml = allCols.map((col) => {
        const safeCol = col.replace(/"/g, '&quot;');
        const isChecked = view.activeColumnIds.includes(col) ? 'checked' : '';
        return `<label class="toggle-label"><input type="checkbox" data-col="${safeCol}" ${isChecked}> ${safeCol}</label>`;
    }).join('');

    traceSelectorList.innerHTML = optionsHtml;

    traceSelectorList.querySelectorAll('input[type="checkbox"]').forEach((chk) => {
        chk.addEventListener('change', () => {
            const colId = chk.getAttribute('data-col');
            State.toggleColumnInMultiView(view.id, colId);
            renderComposerPanel();
            runPipelineAndRender();
        });
    });
}

function getRightMostTabTarget() {
    const headers = State.data.headers || [];
    const xCol = State.data.timeColumn;
    const yCols = headers.filter((h) => h !== xCol);
    const virtualCols = MathEngine.getAvailableMathColumns();

    if (State.multiViews.length > 0) {
        const lastView = State.multiViews[State.multiViews.length - 1];
        return { columnId: null, multiViewId: lastView.id };
    }

    if (virtualCols.length > 0) {
        const lastVirtual = virtualCols[virtualCols.length - 1];
        return { columnId: lastVirtual, multiViewId: null };
    }

    if (yCols.length > 0) {
        const lastRaw = yCols[yCols.length - 1];
        return { columnId: lastRaw, multiViewId: null };
    }

    return null;
}

function activateTab({ columnId = null, multiViewId = null } = {}) {
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

        if (State.getMathDefinition(columnId)) {
            showMathPipelineNotice();
        } else {
            showPipelinePanels();
        }
    }

    const pipeline = State.getPipeline();
    const selectionExists = pipeline.some((s) => s.id === State.ui.selectedStepId);
    if (!selectionExists) {
        State.ui.selectedStepId = pipeline[0]?.id || null;
    }

    renderPipelineList();
    updateParamEditor();
    renderComposerPanel();

    const activeKey = rangeKey || State.getActiveViewKey();
    const savedRange = activeKey ? State.getViewRangeForKey(activeKey) : undefined;
    const rangeToApply = savedRange === undefined ? null : savedRange;

    if (savedRange === null) {
        Graph.lastRanges = { x: null, y: null };
    } else if (savedRange) {
        Graph.lastRanges = { x: savedRange.x ?? null, y: savedRange.y ?? null };
    } else {
        Graph.lastRanges = { x: null, y: null };
    }

    runPipelineAndRender(rangeToApply);
}

function renderColumnTabs() {
    const { tabContainer, btnAddMultiView } = elements;
    if (!tabContainer) return;

    const headers = State.data.headers || [];
    const xCol = State.data.timeColumn;
    const activeCol = State.data.dataColumn;
    const activeMulti = State.ui.activeMultiViewId;
    const yCols = headers.filter((h) => h !== xCol);

    const virtualCols = MathEngine.getAvailableMathColumns();

    let html = '';

    yCols.forEach((col) => {
        const isActive = (!activeMulti && col === activeCol) ? 'active' : '';
        const safeCol = col.replace(/"/g, '&quot;');
        html += `<div class="tab ${isActive}" data-col="${safeCol}" title="${safeCol}"><span class="tab-label">${safeCol}</span></div>`;
    });

    if (virtualCols.length > 0) {
        html += '<div class="tab-sep"></div>';
        virtualCols.forEach((col) => {
            const isActive = (!activeMulti && col === activeCol) ? 'active' : '';
            const safeCol = col.replace(/"/g, '&quot;');
            html += `<div class="tab virtual ${isActive}" data-col="${safeCol}" title="${safeCol}"><span class="tab-label">${safeCol}</span><span class="tab-edit" data-edit-math="${safeCol}" aria-label="Edit math trace">✎</span><span class="tab-close" data-remove-math="${safeCol}" aria-label="Remove math trace">×</span></div>`;
        });
    }

    if (State.multiViews.length > 0) {
        html += '<div class="tab-sep"></div>';
        State.multiViews.forEach((view) => {
            const isActive = view.id === activeMulti ? 'active' : '';
            const safeName = view.name.replace(/"/g, '&quot;');
            html += `<div class="tab multi ${isActive}" data-view="${view.id}" title="${safeName}"><span class="tab-label">${safeName}</span><span class="tab-close" data-remove="${view.id}" aria-label="Remove multi-view tab">×</span></div>`;
        });
    }

    tabContainer.innerHTML = html || '<div class="tab-placeholder">Load data to see columns</div>';

    const tabs = tabContainer.querySelectorAll('.tab[data-col]');
    const mvTabs = tabContainer.querySelectorAll('.tab[data-view]');
    tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            tabs.forEach((t) => t.classList.remove('active'));
            mvTabs.forEach((t) => t.classList.remove('active'));
            tab.classList.add('active');
            activateTab({ columnId: tab.getAttribute('data-col') });
        });
    });

    mvTabs.forEach((tab) => {
        const viewId = tab.getAttribute('data-view');
        const closeBtn = tab.querySelector('.tab-close');
        closeBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            State.removeMultiView(viewId);
            const target = getRightMostTabTarget();
            if (target) {
                activateTab(target);
            } else {
                showPipelinePanels();
                renderPipelineList();
                updateParamEditor();
                renderComposerPanel();
                runPipelineAndRender();
            }
            renderColumnTabs();
        });

        tab.addEventListener('click', () => {
            mvTabs.forEach((t) => t.classList.remove('active'));
            tabs.forEach((t) => t.classList.remove('active'));
            tab.classList.add('active');
            activateTab({ multiViewId: viewId });
        });
    });

    const mathCloseButtons = tabContainer.querySelectorAll('.tab-close[data-remove-math]');
    mathCloseButtons.forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const mathName = btn.getAttribute('data-remove-math');
            State.removeMathDefinition(mathName);
            const target = getRightMostTabTarget();
            if (target) {
                activateTab(target);
            } else {
                State.data.dataColumn = null;
                State.ui.activeMultiViewId = null;
                showPipelinePanels();
                renderPipelineList();
                updateParamEditor();
                renderComposerPanel();
                runPipelineAndRender();
            }
            renderColumnTabs();
        });
    });

    const mathEditButtons = tabContainer.querySelectorAll('.tab-edit[data-edit-math]');
    mathEditButtons.forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const mathName = btn.getAttribute('data-edit-math');
            const def = State.getMathDefinition(mathName);
            if (!def) return;
            showMathModal(def);
        });
    });

    if (btnAddMultiView) {
        btnAddMultiView.onclick = () => {
            if (yCols.length === 0 && virtualCols.length === 0) {
                alert('Load a dataset before adding a new tab.');
                return;
            }

            const html = `
                <h3>Add New View</h3>
                <p class="hint">Choose whether to stack multiple traces or build a math-derived trace.</p>
                <div class="add-tab-actions">
                    <button class="tab-option" id="btn-create-multiview">Multi-View Tab</button>
                    <button class="tab-option" id="btn-create-math">Math Trace Tab</button>
                </div>
            `;

            const modal = createModal(html);
            const overlay = modal.parentElement;

            const closeModal = () => overlay.remove();

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
}

export { renderColumnTabs, activateTab };
