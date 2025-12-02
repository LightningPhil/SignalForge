import { State } from '../state.js';
import { MathEngine } from '../processing/math.js';
import { elements } from './domElements.js';
import { runPipelineAndRender } from './dataPipeline.js';
import { renderPipelineList, updateParamEditor } from './pipelineUi.js';
import { renderComposerPanel } from './composerUi.js';
import { showMathModal } from './mathModal.js';
import { createModal } from '../ui/uiHelpers.js';

function showPipelinePanels() {
    const pipelinePanel = elements.pipelineList?.closest('.panel');
    if (pipelinePanel) pipelinePanel.style.display = '';
    if (elements.paramPanel) elements.paramPanel.style.display = '';
    if (elements.traceSelectorPanel) elements.traceSelectorPanel.style.display = 'none';
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
        html += `<div class="tab ${isActive}" data-col="${safeCol}">${safeCol}</div>`;
    });

    if (virtualCols.length > 0) {
        html += '<div style="border-left:1px solid #555; width:1px; height:20px; margin:0 5px;"></div>';
        virtualCols.forEach((col) => {
            const isActive = (!activeMulti && col === activeCol) ? 'active' : '';
            const safeCol = col.replace(/"/g, '&quot;');
            html += `<div class="tab virtual ${isActive}" data-col="${safeCol}">${safeCol}<span class="tab-close" data-remove-math="${safeCol}" aria-label="Remove math trace">×</span></div>`;
        });
    }

    if (State.multiViews.length > 0) {
        html += '<div style="border-left:1px solid #555; width:1px; height:20px; margin:0 5px;"></div>';
        State.multiViews.forEach((view) => {
            const isActive = view.id === activeMulti ? 'active' : '';
            const safeName = view.name.replace(/"/g, '&quot;');
            html += `<div class="tab multi ${isActive}" data-view="${view.id}">${safeName}<span class="tab-close" data-remove="${view.id}" aria-label="Remove multi-view tab">×</span></div>`;
        });
    }

    tabContainer.innerHTML = html || '<div class="tab-placeholder">Load data to see columns</div>';

    const tabs = tabContainer.querySelectorAll('.tab[data-col]');
    tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            tabs.forEach((t) => t.classList.remove('active'));
            tab.classList.add('active');
            State.ui.activeMultiViewId = null;
            State.data.dataColumn = tab.getAttribute('data-col');
            State.syncComposerForView(null, [State.data.dataColumn].filter(Boolean));

            const pipeline = State.getPipeline();
            const selectionExists = pipeline.some((s) => s.id === State.ui.selectedStepId);
            if (!selectionExists) {
                State.ui.selectedStepId = pipeline[0]?.id || null;
            }

            showPipelinePanels();
            renderPipelineList();
            updateParamEditor();
            renderComposerPanel();
            runPipelineAndRender();
        });
    });

    const mvTabs = tabContainer.querySelectorAll('.tab[data-view]');
    mvTabs.forEach((tab) => {
        const viewId = tab.getAttribute('data-view');
        const closeBtn = tab.querySelector('.tab-close');
        closeBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            State.removeMultiView(viewId);
            if (State.ui.activeMultiViewId === viewId) {
                State.ui.activeMultiViewId = null;
                showPipelinePanels();
                runPipelineAndRender();
            }
            renderColumnTabs();
            renderComposerPanel();
        });

        tab.addEventListener('click', () => {
            mvTabs.forEach((t) => t.classList.remove('active'));
            tabs.forEach((t) => t.classList.remove('active'));
            tab.classList.add('active');
            State.ui.activeMultiViewId = viewId;
            const view = State.multiViews.find((v) => v.id === viewId);
            if (view) {
                State.syncComposerForView(viewId, view.activeColumnIds);
                renderTraceSelector(view);
                renderComposerPanel();
                runPipelineAndRender();
            }
        });
    });

    const mathCloseButtons = tabContainer.querySelectorAll('.tab-close[data-remove-math]');
    mathCloseButtons.forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const mathName = btn.getAttribute('data-remove-math');
            State.removeMathDefinition(mathName);

            const headers = State.data.headers || [];
            const xCol = State.data.timeColumn;
            const yCols = headers.filter((h) => h !== xCol);
            const remainingVirtual = MathEngine.getAvailableMathColumns();
            const fallback = State.data.dataColumn === mathName
                ? (yCols[0] || remainingVirtual[0] || null)
                : State.data.dataColumn;

            State.data.dataColumn = fallback;
            State.ui.activeMultiViewId = null;

            renderColumnTabs();
            renderComposerPanel();
            renderPipelineList();
            updateParamEditor();
            runPipelineAndRender();
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
                    <button class="primary" id="btn-create-multiview">Multi-View Tab</button>
                    <button class="secondary math-tab-btn" id="btn-create-math">Math Trace Tab</button>
                </div>
            `;

            const modal = createModal(html);
            const overlay = modal.parentElement;

            const closeModal = () => overlay.remove();

            modal.querySelector('#btn-create-multiview')?.addEventListener('click', () => {
                const defaultCol = activeCol || yCols[0] || virtualCols[0];
                const view = State.addMultiView(null, defaultCol ? [defaultCol] : []);
                State.ui.activeMultiViewId = view.id;
                renderColumnTabs();
                renderTraceSelector(view);
                renderComposerPanel();
                runPipelineAndRender();
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

export { renderColumnTabs };
