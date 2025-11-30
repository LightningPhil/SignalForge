import { createModal } from '../ui/uiHelpers.js';
import { State } from '../state.js';
import { elements } from './domElements.js';
import { renderColumnTabs } from './tabs.js';

function showMathModal() {
    const { tabContainer } = elements;
    const headers = State.data.headers;
    const options = headers.map((h) => `<option value="${h}">${h}</option>`).join('');

    const html = `
        <h3>Add Virtual Trace</h3>

        <div class="panel">
            <label>New Trace Name</label>
            <input id="math-name" value="MathTrace ${State.config.mathDefinitions ? State.config.mathDefinitions.length + 1 : 1}">

            <h4 style="margin-top:20px; border-bottom:1px solid #444;">Operation</h4>

            <div style="display:flex; align-items:center; gap:10px; margin-top:10px;">
                <select id="math-col-a" style="flex:2">${options}</select>

                <select id="math-op" style="flex:1; text-align:center; font-weight:bold;">
                    <option value="div">/</option>
                    <option value="mul">*</option>
                    <option value="add">+</option>
                    <option value="sub">-</option>
                    <option value="sq">Square (A²)</option>
                    <option value="sqrt">Sqrt (√A)</option>
                </select>

                <div id="col-b-container" style="flex:2; display:flex; gap:5px;">
                    <select id="math-col-b" style="width:100%">${options}</select>
                    <input id="math-scalar" type="number" placeholder="Value" style="display:none; width:100%">
                </div>
            </div>

            <div style="margin-top:10px;">
                <label style="display:inline-flex; align-items:center;">
                    <input type="checkbox" id="use-scalar"> Use Scalar Value for B
                </label>
            </div>

            <div id="offset-container" style="margin-top:15px;">
                <label>Time Offset for Column B (Samples)</label>
                <input type="number" id="math-offset" value="0">
                <small style="color:#888">Positive shifts B to the right (Lag)</small>
            </div>

            <h4 style="margin-top:20px; border-bottom:1px solid #444;">Post-Processing</h4>
            <label>Apply Calculus</label>
            <select id="math-post">
                <option value="none">None</option>
                <option value="diff">Differentiate (dy/dx)</option>
                <option value="int">Integrate (Area)</option>
            </select>
        </div>

        <button id="btn-calc-math" class="primary">Create Trace</button>
    `;

    const modal = createModal(html);

    const opSel = modal.querySelector('#math-op');
    const colBCont = modal.querySelector('#col-b-container');
    const chkScalar = modal.querySelector('#use-scalar');
    const inpScalar = modal.querySelector('#math-scalar');
    const selColB = modal.querySelector('#math-col-b');
    const offCont = modal.querySelector('#offset-container');

    const updateUI = () => {
        const op = opSel.value;
        const isSingle = ['sq', 'sqrt'].includes(op);
        const isScalar = chkScalar.checked;

        if (isSingle) {
            colBCont.style.visibility = 'hidden';
            chkScalar.parentElement.style.visibility = 'hidden';
            offCont.style.display = 'none';
        } else {
            colBCont.style.visibility = 'visible';
            chkScalar.parentElement.style.visibility = 'visible';

            if (isScalar) {
                selColB.style.display = 'none';
                inpScalar.style.display = 'block';
                offCont.style.display = 'none';
            } else {
                selColB.style.display = 'block';
                inpScalar.style.display = 'none';
                offCont.style.display = 'block';
            }
        }
    };

    opSel.addEventListener('change', updateUI);
    chkScalar.addEventListener('change', updateUI);
    updateUI();

    modal.querySelector('#btn-calc-math').addEventListener('click', () => {
        const definition = {
            name: modal.querySelector('#math-name').value,
            colA: modal.querySelector('#math-col-a').value,
            op: opSel.value,
            postCalc: modal.querySelector('#math-post').value
        };

        if (!['sq', 'sqrt'].includes(definition.op)) {
            definition.isScalar = chkScalar.checked;
            if (definition.isScalar) {
                definition.scalarValue = parseFloat(inpScalar.value) || 0;
            } else {
                definition.colB = selColB.value;
                definition.offsetSamples = parseInt(modal.querySelector('#math-offset').value) || 0;
            }
        }

        State.addMathDefinition(definition);
        renderColumnTabs();

        const newTab = tabContainer?.querySelector(`[data-col="${definition.name}"]`);
        if (newTab) newTab.click();

        document.body.removeChild(modal.parentElement);
    });
}

export { showMathModal };
