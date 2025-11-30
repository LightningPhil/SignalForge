import { State } from './state.js';
import { Graph } from './ui/graph.js';
import { CsvParser } from './io/csvParser.js';
import { GridView } from './ui/gridView.js';
import { GraphConfig } from './ui/graphConfig.js';
import { HelpSystem } from './ui/helpSystem.js';
import { Filter } from './processing/filter.js';
import { MathEngine } from './processing/math.js';
import { Exporter } from './io/exporter.js';
import { SettingsManager } from './io/settingsManager.js';
import { createModal } from './ui/uiHelpers.js';

// --- DOM Elements ---
const fileInput = document.getElementById('file-input');
const btnLoad = document.getElementById('btn-load-file');
const btnViewGrid = document.getElementById('btn-view-grid');
const btnGraphConfig = document.getElementById('btn-graph-config');
const btnExport = document.getElementById('btn-export');
const btnHelp = document.getElementById('btn-help');
const btnMath = document.getElementById('btn-math-settings');

// Pipeline UI Elements
const pipelineList = document.getElementById('pipeline-list');
const btnAddStep = document.getElementById('btn-add-step');
const btnRemoveStep = document.getElementById('btn-remove-step');
const btnMoveUp = document.getElementById('btn-move-up');
const btnMoveDown = document.getElementById('btn-move-down');

// Parameter Inputs (Text)
const paramPanel = document.getElementById('param-editor'); 
const filterTypeDisplay = document.getElementById('step-type-display'); 

const inputWindow = document.getElementById('param-window');
const inputPoly = document.getElementById('param-poly'); 
const inputAlpha = document.getElementById('param-alpha');
const inputSigma = document.getElementById('param-sigma');
const inputIters = document.getElementById('param-iters');
const inputDecay = document.getElementById('param-decay');
const inputFreq = document.getElementById('param-freq');
const selFreqUnit = document.getElementById('unit-freq');
const inputSlope = document.getElementById('param-slope');
const inputQ = document.getElementById('param-q');
const inputBW = document.getElementById('param-bw');
const selBWUnit = document.getElementById('unit-bw');

// Parameter Sliders
const sliderWindow = document.getElementById('slider-window');
const sliderPoly = document.getElementById('slider-poly');
const sliderAlpha = document.getElementById('slider-alpha');
const sliderSigma = document.getElementById('slider-sigma');
const sliderIters = document.getElementById('slider-iters');
const sliderDecay = document.getElementById('slider-decay');
const sliderSlope = document.getElementById('slider-slope');
const sliderQ = document.getElementById('slider-q');

// Groups
const grpWindow = document.getElementById('group-window');
const grpPoly = document.getElementById('group-poly');
const grpAlpha = document.getElementById('group-alpha');
const grpSigma = document.getElementById('group-sigma');
const grpIters = document.getElementById('group-iters');
const grpDecay = document.getElementById('group-decay');
const grpFreq = document.getElementById('group-freq');
const grpSlope = document.getElementById('group-slope');
const grpQ = document.getElementById('group-q');
const grpBW = document.getElementById('group-bw');

// Graph Toolbar
const liveShowRaw = document.getElementById('live-show-raw');
const liveRawOpacity = document.getElementById('live-raw-opacity');
const liveShowDiff = document.getElementById('live-show-diff'); 
const liveFreqDomain = document.getElementById('live-freq-domain');
const liveStatus = document.getElementById('live-status');

const tabContainer = document.getElementById('column-tabs');

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    Graph.init();
    
    if(State.config.pipeline.length > 0) {
        State.ui.selectedStepId = State.config.pipeline[0].id;
    }

    const settingsLoaded = SettingsManager.loadFromBrowser();
    if(settingsLoaded) {
        console.log("Settings restored.");
        updateToolbarUIFromState();
    }

    setupEventListeners();
    renderPipelineList();
    updateParamEditor();
});

function setupEventListeners() {
    btnLoad.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        liveStatus.textContent = "Loading...";
        State.data.raw = [];
        State.data.processed = [];
        CsvParser.processFile(file, (results) => {
            State.setData(results.data, results.meta.fields);
            renderColumnTabs(); 
            runPipelineAndRender();
            liveStatus.textContent = "Ready";
        });
        fileInput.value = '';
    });

    btnViewGrid.addEventListener('click', () => GridView.show());
    btnGraphConfig.addEventListener('click', () => { if(hasData()) GraphConfig.show(); });
    btnMath.addEventListener('click', () => { if(hasData()) showMathModal(); });
    btnExport.addEventListener('click', showExportModal);
    btnHelp.addEventListener('click', () => HelpSystem.show());

    // Pipeline Controls
    btnAddStep.addEventListener('click', showAddStepMenu);
    
    btnRemoveStep.addEventListener('click', () => {
        if(!State.ui.selectedStepId) return;
        State.removeStep(State.ui.selectedStepId);
        renderPipelineList();
        updateParamEditor();
        runPipelineAndRender();
    });

    btnMoveUp.addEventListener('click', () => {
        if(!State.ui.selectedStepId) return;
        State.moveStep(State.ui.selectedStepId, -1);
        renderPipelineList();
        runPipelineAndRender();
    });

    btnMoveDown.addEventListener('click', () => {
        if(!State.ui.selectedStepId) return;
        State.moveStep(State.ui.selectedStepId, 1);
        renderPipelineList();
        runPipelineAndRender();
    });

    // --- Parameter Inputs Sync Logic ---
    const bindInput = (numInput, sliderInput) => {
        if(numInput) {
            numInput.addEventListener('input', () => {
                if(sliderInput) sliderInput.value = numInput.value;
                updateParamsFromUI();
            });
        }
        if(sliderInput) {
            sliderInput.addEventListener('input', () => {
                if(numInput) numInput.value = sliderInput.value;
                updateParamsFromUI();
            });
        }
    };

    bindInput(inputWindow, sliderWindow);
    bindInput(inputPoly, sliderPoly);
    bindInput(inputAlpha, sliderAlpha);
    bindInput(inputSigma, sliderSigma);
    bindInput(inputIters, sliderIters);
    bindInput(inputDecay, sliderDecay);
    bindInput(inputSlope, sliderSlope);
    bindInput(inputQ, sliderQ);

    [inputFreq, selFreqUnit, inputBW, selBWUnit].forEach(el => {
        if(el) el.addEventListener('input', updateParamsFromUI);
    });

    // Graph Toolbar
    liveShowRaw.addEventListener('change', (e) => {
        State.config.graph.showRaw = e.target.checked;
        liveRawOpacity.disabled = !e.target.checked;
        liveRawOpacity.parentElement.style.opacity = e.target.checked ? '1' : '0.5';
        triggerGraphUpdateOnly();
    });

    liveRawOpacity.addEventListener('input', (e) => {
        State.config.graph.rawOpacity = parseFloat(e.target.value);
        triggerGraphUpdateOnly();
    });

    liveShowDiff.addEventListener('change', (e) => {
        State.config.graph.showDifferential = e.target.checked;
        triggerGraphUpdateOnly();
    });

    liveFreqDomain.addEventListener('change', (e) => {
        State.config.graph.showFreqDomain = e.target.checked;
        const diffGroup = liveShowDiff.parentElement.parentElement;
        diffGroup.style.display = e.target.checked ? 'none' : 'flex';
        triggerGraphUpdateOnly();
    });
}

function updateParamsFromUI() {
    const id = State.ui.selectedStepId;
    if(!id) return;
    
    const params = {};
    const step = State.getSelectedStep();

    if(inputWindow) params.windowSize = clamp(inputWindow, 1, 9999);
    if(inputPoly) params.polyOrder = clamp(inputPoly, 1, 10);
    if(inputAlpha) params.alpha = clamp(inputAlpha, 0.001, 1.0);
    if(inputSigma) params.sigma = clamp(inputSigma, 0.1, 100.0);
    if(inputIters) params.iterations = clamp(inputIters, 1, 16);
    if(inputDecay) params.decayLength = clamp(inputDecay, 1, 10000);

    const fMult = parseFloat(selFreqUnit.value);
    const rawFreq = parseFloat(inputFreq.value) || 0;
    const hz = rawFreq * fMult;
    
    if(step.type === 'notchFFT') params.centerFreq = hz;
    else params.cutoffFreq = hz;

    const bMult = parseFloat(selBWUnit.value);
    const rawBW = parseFloat(inputBW.value) || 0;
    params.bandwidth = rawBW * bMult;

    if(inputSlope) params.slope = clamp(inputSlope, 6, 96);
    if(inputQ) params.qFactor = clamp(inputQ, 0.1, 20.0);

    State.updateStepParams(id, params);
    
    renderPipelineList(); 
    runPipelineAndRender();
}

function clamp(inputEl, min, max) {
    let val = parseFloat(inputEl.value);
    if (isNaN(val)) return min;
    if (val < min) { val = min; inputEl.value = min; }
    if (val > max) { val = max; inputEl.value = max; }
    return val;
}

function renderPipelineList() {
    pipelineList.innerHTML = '';
    
    State.config.pipeline.forEach((step, index) => {
        const el = document.createElement('div');
        el.className = 'pipeline-step';
        if (step.id === State.ui.selectedStepId) el.classList.add('selected');

        let desc = step.type;
        const fmtHz = (hz) => {
            if(hz >= 1e9) return (hz/1e9).toFixed(1) + 'G';
            if(hz >= 1e6) return (hz/1e6).toFixed(1) + 'M';
            if(hz >= 1e3) return (hz/1e3).toFixed(1) + 'k';
            return hz.toFixed(0);
        };

        if(step.type === 'movingAverage') desc = `Mov. Avg (Win: ${step.windowSize})`;
        if(step.type === 'savitzkyGolay') desc = `Sav-Gol (Win: ${step.windowSize}, x${step.iterations || 1})`;
        if(step.type === 'median') desc = `Median (Win: ${step.windowSize})`;
        if(step.type === 'iir') desc = `IIR (Alpha: ${step.alpha})`;
        if(step.type === 'gaussian') desc = `Gaussian (Sig: ${step.sigma})`;
        if(step.type === 'startStopNorm') desc = `Norm (Len: ${step.decayLength})`;
        
        if(step.type === 'lowPassFFT') desc = `Low Pass (${fmtHz(step.cutoffFreq)}Hz)`;
        if(step.type === 'highPassFFT') desc = `High Pass (${fmtHz(step.cutoffFreq)}Hz)`;
        if(step.type === 'notchFFT') desc = `Notch (${fmtHz(step.centerFreq)}Hz)`;

        el.innerHTML = `
            <span class="step-num">${index + 1}</span>
            <span class="step-desc">${desc}</span>
        `;

        el.addEventListener('click', () => {
            State.ui.selectedStepId = step.id;
            renderPipelineList();
            updateParamEditor();
        });

        pipelineList.appendChild(el);
    });
}

function updateParamEditor() {
    const step = State.getSelectedStep();
    if(!step) {
        paramPanel.style.opacity = '0.3';
        paramPanel.style.pointerEvents = 'none';
        filterTypeDisplay.textContent = "No Filter Selected";
        return;
    }

    paramPanel.style.opacity = '1';
    paramPanel.style.pointerEvents = 'auto';
    
    const niceNames = {
        movingAverage: "Moving Average",
        savitzkyGolay: "Savitzky-Golay",
        median: "Median",
        iir: "IIR Low Pass",
        gaussian: "Gaussian",
        startStopNorm: "Start/Stop Normalisation",
        lowPassFFT: "FFT Low Pass",
        highPassFFT: "FFT High Pass",
        notchFFT: "FFT Notch"
    };
    filterTypeDisplay.textContent = niceNames[step.type];

    const type = step.type;
    const isTime = ['movingAverage','savitzkyGolay','median','gaussian'].includes(type);
    const isFreq = ['lowPassFFT','highPassFFT'].includes(type);
    const isNotch = (type === 'notchFFT');

    grpWindow.style.display = isTime ? 'block' : 'none';
    grpPoly.style.display = (type === 'savitzkyGolay') ? 'block' : 'none';
    grpIters.style.display = (type === 'savitzkyGolay') ? 'block' : 'none';
    grpAlpha.style.display = (type === 'iir') ? 'block' : 'none';
    grpSigma.style.display = (type === 'gaussian') ? 'block' : 'none';
    grpDecay.style.display = (type === 'startStopNorm') ? 'block' : 'none';

    grpFreq.style.display = (isFreq || isNotch) ? 'block' : 'none';
    const lblFreq = document.querySelector('label[for="param-freq"]');
    if(lblFreq) lblFreq.textContent = isNotch ? "Center Frequency" : "Cutoff Frequency";

    grpSlope.style.display = isFreq ? 'block' : 'none';
    grpQ.style.display = isFreq ? 'block' : 'none';
    grpBW.style.display = isNotch ? 'block' : 'none';

    // Populate Values & Sliders
    const setVal = (inp, slider, val) => {
        if(inp) inp.value = val;
        if(slider) slider.value = val;
    };

    if(step.windowSize) setVal(inputWindow, sliderWindow, step.windowSize);
    if(step.polyOrder) setVal(inputPoly, sliderPoly, step.polyOrder);
    if(step.alpha) setVal(inputAlpha, sliderAlpha, step.alpha);
    if(step.sigma) setVal(inputSigma, sliderSigma, step.sigma);
    if(step.iterations) setVal(inputIters, sliderIters, step.iterations);
    if(step.decayLength) setVal(inputDecay, sliderDecay, step.decayLength);
    if(step.slope) setVal(inputSlope, sliderSlope, step.slope);
    if(step.qFactor) setVal(inputQ, sliderQ, step.qFactor);

    const setUnitInput = (hzValue, inputEl, unitEl) => {
        if(hzValue >= 1e9) { inputEl.value = hzValue/1e9; unitEl.value = 1e9; }
        else if(hzValue >= 1e6) { inputEl.value = hzValue/1e6; unitEl.value = 1e6; }
        else if(hzValue >= 1e3) { inputEl.value = hzValue/1e3; unitEl.value = 1e3; }
        else { inputEl.value = hzValue; unitEl.value = 1; }
    };

    if(step.cutoffFreq) setUnitInput(step.cutoffFreq, inputFreq, selFreqUnit);
    if(step.centerFreq) setUnitInput(step.centerFreq, inputFreq, selFreqUnit);
    if(step.bandwidth) setUnitInput(step.bandwidth, inputBW, selBWUnit);
}

function showAddStepMenu(e) {
    const html = `
        <h3>Add Filter Step</h3>
        <div style="display:grid; gap:10px;">
            <div style="border-bottom:1px solid #444; padding-bottom:10px; margin-bottom:5px;">
                <small style="color:#888">Time Domain</small>
                <button class="add-opt" data-type="movingAverage">Moving Average</button>
                <button class="add-opt" data-type="savitzkyGolay">Savitzky-Golay</button>
                <button class="add-opt" data-type="median">Median (Despeckle)</button>
                <button class="add-opt" data-type="iir">IIR Low Pass</button>
                <button class="add-opt" data-type="gaussian">Gaussian</button>
                <button class="add-opt" data-type="startStopNorm">Start/Stop Norm</button>
            </div>
            <div>
                <small style="color:#888">Frequency Domain (FFT)</small>
                <button class="add-opt" data-type="lowPassFFT">Low Pass</button>
                <button class="add-opt" data-type="highPassFFT">High Pass</button>
                <button class="add-opt" data-type="notchFFT">Notch Filter</button>
            </div>
        </div>
    `;
    const modal = createModal(html);
    modal.querySelectorAll('.add-opt').forEach(btn => {
        btn.addEventListener('click', () => {
            const type = btn.getAttribute('data-type');
            State.addStep(type);
            document.body.removeChild(modal.parentElement);
            renderPipelineList();
            updateParamEditor();
            runPipelineAndRender();
        });
    });
}

function runPipelineAndRender() {
    if (!hasData(false)) return; 
    
    // 1. Get Data from State
    const yCol = State.data.dataColumn;
    const xCol = State.data.timeColumn;
    if (!yCol || !xCol) return;

    // 2. Check if Virtual Column (Math)
    let rawY = [];
    const mathDef = State.getMathDefinition(yCol);
    const rawX = State.data.raw.map(r => parseFloat(r[xCol])); // Always need time

    if (mathDef) {
        // Compute Virtual Data on the fly
        rawY = MathEngine.calculateVirtualColumn(mathDef, rawX);
    } else {
        // Standard CSV Column
        rawY = State.data.raw.map(r => parseFloat(r[yCol]));
    }

    // 3. Apply Filter Pipeline
    const filteredY = Filter.applyPipeline(rawY, rawX, State.config.pipeline);
    State.data.processed = filteredY;

    // 4. Render
    Graph.render(rawX, rawY, filteredY, null);
}

function triggerGraphUpdateOnly() {
    // Re-use current State.data.processed to avoid re-calc
    if (!hasData(false)) return;
    const xCol = State.data.timeColumn;
    const yCol = State.data.dataColumn;
    
    const rawX = State.data.raw.map(r => parseFloat(r[xCol]));
    
    // Need Raw Y for display (Virtual or Real)
    let rawY = [];
    const mathDef = State.getMathDefinition(yCol);
    if(mathDef) {
        rawY = MathEngine.calculateVirtualColumn(mathDef, rawX);
    } else {
        rawY = State.data.raw.map(r => parseFloat(r[yCol]));
    }

    const filteredY = State.data.processed.length > 0 ? State.data.processed : null;
    Graph.render(rawX, rawY, filteredY, null);
}

function updateToolbarUIFromState() {
    const cfg = State.config.graph;
    if(liveShowRaw) {
        liveShowRaw.checked = (cfg.showRaw !== false);
        liveRawOpacity.disabled = !liveShowRaw.checked;
    }
    if(liveRawOpacity) liveRawOpacity.value = cfg.rawOpacity || 0.5;
    if(liveShowDiff) liveShowDiff.checked = cfg.showDifferential;
    if(liveFreqDomain) liveFreqDomain.checked = cfg.showFreqDomain;
}

function renderColumnTabs() {
    if(!tabContainer) return;
    const headers = State.data.headers;
    const xCol = State.data.timeColumn;
    const activeCol = State.data.dataColumn;
    const yCols = headers.filter(h => h !== xCol);

    // Get Virtual Columns
    const virtualCols = MathEngine.getAvailableMathColumns();

    let html = '';
    
    // Real Columns
    yCols.forEach(col => {
        const isActive = (col === activeCol) ? 'active' : '';
        const safeCol = col.replace(/"/g, '&quot;');
        html += `<div class="tab ${isActive}" data-col="${safeCol}">${safeCol}</div>`;
    });

    // Virtual Columns
    if (virtualCols.length > 0) {
        html += `<div style="border-left:1px solid #555; width:1px; height:20px; margin:0 5px;"></div>`; // Separator
        virtualCols.forEach(col => {
            const isActive = (col === activeCol) ? 'active' : '';
            const safeCol = col.replace(/"/g, '&quot;');
            // Add 'virtual' class for styling
            html += `<div class="tab virtual ${isActive}" data-col="${safeCol}">${safeCol}</div>`;
        });
    }

    tabContainer.innerHTML = html;

    const tabs = tabContainer.querySelectorAll('.tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            State.data.dataColumn = tab.getAttribute('data-col');
            runPipelineAndRender();
        });
    });
}

function hasData(alertUser = true) {
    if (!State.data.raw || State.data.raw.length === 0) {
        if(alertUser) alert("Please load a CSV file first.");
        return false;
    }
    return true;
}

function showMathModal() {
    const headers = State.data.headers;
    const options = headers.map(h => `<option value="${h}">${h}</option>`).join('');
    
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
    
    // UI Logic for Scalar / Single Op
    const opSel = modal.querySelector('#math-op');
    const colBCont = modal.querySelector('#col-b-container');
    const chkScalar = modal.querySelector('#use-scalar');
    const inpScalar = modal.querySelector('#math-scalar');
    const selColB = modal.querySelector('#math-col-b');
    const offCont = modal.querySelector('#offset-container');

    const updateUI = () => {
        const op = opSel.value;
        const isSingle = ['sq','sqrt'].includes(op);
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
    updateUI(); // Init

    modal.querySelector('#btn-calc-math').addEventListener('click', () => {
        const definition = {
            name: modal.querySelector('#math-name').value,
            colA: modal.querySelector('#math-col-a').value,
            op: opSel.value,
            postCalc: modal.querySelector('#math-post').value
        };

        if (!['sq','sqrt'].includes(definition.op)) {
            definition.isScalar = chkScalar.checked;
            if (definition.isScalar) {
                definition.scalarValue = parseFloat(inpScalar.value) || 0;
            } else {
                definition.colB = selColB.value;
                definition.offsetSamples = parseInt(modal.querySelector('#math-offset').value) || 0;
            }
        }

        State.addMathDefinition(definition);
        renderColumnTabs(); // Refresh tabs
        
        // Auto-switch to new tab
        const newTab = tabContainer.querySelector(`[data-col="${definition.name}"]`);
        if(newTab) newTab.click();

        document.body.removeChild(modal.parentElement);
    });
}

function showExportModal() { /* ... (Same as v5.0) ... */ }