import { State } from '../state.js';
import { createModal } from './uiHelpers.js';
import { Graph } from './graph.js';
import { Config } from '../config.js';

/**
 * Graph Configuration UI
 */
export const GraphConfig = {
    
    show() {
        const config = State.config.graph;
        const colors = State.config.colors || Config.colors; 
        const headers = State.data.headers;
        
        const createOptions = (selectedVal) => {
            return headers.map(h => 
                `<option value="${h}" ${h === selectedVal ? 'selected' : ''}>${h}</option>`
            ).join('');
        };

        const html = `
            <h3>Graph Configuration</h3>
            
            <div style="display: flex; gap: 20px;">
                
                <!-- Left Column: Data & Axes -->
                <div style="flex: 1;">
                    <div class="panel">
                        <h4>Axes Setup</h4>
                        <label>X-Axis Column</label>
                        <select id="gc-x-col">${createOptions(State.data.timeColumn)}</select>
                        <small style="color:#666">Y-Axis is selected via Tabs above the graph.</small>
                    </div>

                    <div class="panel">
                        <h4>Labels</h4>
                        <label>Graph Title</label>
                        <input id="gc-title" type="text" value="${config.title}">
                        <label>X-Axis Label</label>
                        <input id="gc-xlabel" type="text" value="${config.xAxisTitle}">
                        <label>Y-Axis Label</label>
                        <input id="gc-ylabel" type="text" value="${config.yAxisTitle}">
                    </div>
                </div>

                <!-- Right Column: Visuals -->
                <div style="flex: 1;">
                    <div class="panel">
                        <h4>Trace Colors</h4>
                        <div style="display:flex; gap:10px; align-items:center; margin-bottom:10px;">
                            <input type="color" id="gc-col-raw" value="${colors.raw}" style="height:35px; width:50px; padding:0; border:none;">
                            <label style="margin:0;">Raw Data Color</label>
                        </div>
                        <div style="display:flex; gap:10px; align-items:center;">
                            <input type="color" id="gc-col-filt" value="${colors.filtered}" style="height:35px; width:50px; padding:0; border:none;">
                            <label style="margin:0;">Filtered Data Color</label>
                        </div>
                    </div>

                    <div class="panel">
                        <h4>Display Options</h4>
                        
                        <label style="display:flex; align-items:center;">
                            <input type="checkbox" id="gc-sci" style="width:auto; margin-right:10px;" ${config.useScientificNotation ? 'checked' : ''}>
                            Scientific Notation Axes
                        </label>

                        <label style="display:flex; align-items:center;">
                            <input type="checkbox" id="gc-log" style="width:auto; margin-right:10px;" ${config.logScaleY ? 'checked' : ''}>
                            Logarithmic Y-Scale
                        </label>

                        <hr style="border-color:#444; opacity: 0.5;">
                        <label style="display:flex; align-items:center;">
                            <input type="checkbox" id="gc-downsample" style="width:auto; margin-right:10px;" ${config.enableDownsampling ? 'checked' : ''}>
                            Smart Downsampling
                        </label>
                        <small style="color:#666">Improves performance for large datasets.</small>
                    </div>
                </div>
            </div>

            <button id="btn-save-gc" class="primary">Update Graph</button>
        `;

        const modal = createModal(html);

        // Save Action
        modal.querySelector('#btn-save-gc').addEventListener('click', () => {
            // Data
            State.data.timeColumn = modal.querySelector('#gc-x-col').value;

            // Settings
            const cfg = State.config.graph;
            cfg.title = modal.querySelector('#gc-title').value;
            cfg.xAxisTitle = modal.querySelector('#gc-xlabel').value;
            cfg.yAxisTitle = modal.querySelector('#gc-ylabel').value;
            cfg.useScientificNotation = modal.querySelector('#gc-sci').checked;
            cfg.logScaleY = modal.querySelector('#gc-log').checked;
            cfg.enableDownsampling = modal.querySelector('#gc-downsample').checked;

            // Colors
            if(!State.config.colors) State.config.colors = {};
            State.config.colors.raw = modal.querySelector('#gc-col-raw').value;
            State.config.colors.filtered = modal.querySelector('#gc-col-filt').value;
            State.config.colors.diffRaw = State.config.colors.raw;
            State.config.colors.diffFilt = State.config.colors.filtered;

            // Trigger Re-render
            const xCol = State.data.timeColumn;
            const yCol = State.data.dataColumn;
            
            const rawX = State.data.raw.map(r => parseFloat(r[xCol]));
            const rawY = State.data.raw.map(r => parseFloat(r[yCol]));
            
            // Fetch Filtered Data
            const filteredY = State.data.processed.length > 0 ? State.data.processed : null;

            Graph.render(rawX, rawY, filteredY);
            
            document.body.removeChild(modal.parentElement);
        });
    }
};