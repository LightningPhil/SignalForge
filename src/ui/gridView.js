import { State } from '../state.js';
import { Config } from '../config.js';
import { createModal } from './uiHelpers.js';

/**
 * Data Grid Visualization
 * Renders raw data in a table.
 */
export const GridView = {
    
    show() {
        if (!State.data.raw || State.data.raw.length === 0) {
            alert("No data loaded. Please load a CSV file first.");
            return;
        }

        const headers = State.data.headers;
        const data = State.data.raw;
        const limit = Config.limits.maxGridRows; 
        
        let html = `<h3>Data View</h3>
                    <p>Showing first ${Math.min(data.length, limit)} rows.</p>`;
        
        html += `<div class="data-grid-container">
                    <table class="data-grid-table">`;
        
        // --- Table Head ---
        html += `<thead><tr>`;
        headers.forEach(h => {
            html += `<th>${h}</th>`;
        });
        html += `</tr></thead>`;

        // --- Table Body ---
        html += `<tbody>`;
        
        const loopLimit = Math.min(data.length, limit);
        
        for(let i=0; i < loopLimit; i++) {
            html += `<tr>`;
            const row = data[i];
            
            headers.forEach(h => {
                let val = row[h];
                if(typeof val === 'number') {
                    val = parseFloat(val.toFixed(4)); 
                }
                html += `<td>${val}</td>`;
            });
            
            html += `</tr>`;
        }
        
        html += `</tbody></table></div>`;
        
        if (data.length > limit) {
             html += `<p style="color:orange; font-size:0.9em; margin-top:5px;">
                        Note: Dataset truncated for performance.
                      </p>`;
        }
        
        createModal(html);
    }
};