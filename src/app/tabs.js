import { State } from '../state.js';
import { MathEngine } from '../processing/math.js';
import { elements } from './domElements.js';
import { runPipelineAndRender } from './dataPipeline.js';

function renderColumnTabs() {
    const { tabContainer } = elements;
    if (!tabContainer) return;

    const headers = State.data.headers;
    const xCol = State.data.timeColumn;
    const activeCol = State.data.dataColumn;
    const yCols = headers.filter((h) => h !== xCol);

    const virtualCols = MathEngine.getAvailableMathColumns();

    let html = '';

    yCols.forEach((col) => {
        const isActive = col === activeCol ? 'active' : '';
        const safeCol = col.replace(/"/g, '&quot;');
        html += `<div class="tab ${isActive}" data-col="${safeCol}">${safeCol}</div>`;
    });

    if (virtualCols.length > 0) {
        html += '<div style="border-left:1px solid #555; width:1px; height:20px; margin:0 5px;"></div>';
        virtualCols.forEach((col) => {
            const isActive = col === activeCol ? 'active' : '';
            const safeCol = col.replace(/"/g, '&quot;');
            html += `<div class="tab virtual ${isActive}" data-col="${safeCol}">${safeCol}</div>`;
        });
    }

    tabContainer.innerHTML = html;

    const tabs = tabContainer.querySelectorAll('.tab');
    tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            tabs.forEach((t) => t.classList.remove('active'));
            tab.classList.add('active');
            State.data.dataColumn = tab.getAttribute('data-col');
            runPipelineAndRender();
        });
    });
}

export { renderColumnTabs };
