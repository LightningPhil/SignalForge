import { createModal } from '../ui/uiHelpers.js';

/**
 * CSV Ingestion Module
 * Handles file reading, header detection, and parsing.
 */
export const CsvParser = {
    
    processFile(file, onComplete) {
        const reader = new FileReader();
        
        reader.onload = (e) => {
            const text = e.target.result;
            const lines = text.split('\n').slice(0, 50); 
            this.showHeaderSelector(file, lines, onComplete);
        };
        
        // Read only the beginning of the file for the preview
        reader.readAsText(file.slice(0, 1024 * 5)); 
    },

    showHeaderSelector(file, lines, onComplete) {
        let html = `<h3>Select the Header Row</h3>
                    <p>Click the row that contains your column names (e.g., Time, Voltage).</p>
                    <div style="max-height: 400px; overflow-y: auto;">
                        <table class="header-picker-table">`;
        
        lines.forEach((line, index) => {
            if(line.trim() === "") return;
            const safeLine = line.replace(/</g, "&lt;").replace(/>/g, "&gt;");
            
            html += `<tr data-row="${index}">
                        <td>Row ${index + 1}</td>
                        <td>${safeLine.substring(0, 120)}...</td>
                     </tr>`;
        });
        html += `   </table>
                 </div>`;

        const modalContent = createModal(html);

        modalContent.querySelectorAll('tr').forEach(row => {
            row.addEventListener('click', () => {
                const skip = parseInt(row.getAttribute('data-row'));
                document.body.removeChild(modalContent.parentElement); 
                this.parseFullFile(file, skip, onComplete);
            });
        });
    },

    parseFullFile(file, skipLines, onComplete) {
        Papa.parse(file, {
            header: true,
            dynamicTyping: true, 
            skipEmptyLines: true,
            comments: "#", 
            
            beforeFirstChunk: (chunk) => {
                if (skipLines === 0) return chunk;
                const lines = chunk.split('\n');
                return lines.slice(skipLines).join('\n');
            },
            
            complete: (results) => {
                if(!results.meta.fields || results.meta.fields.length === 0) {
                    alert("Could not detect columns. Check your delimiter.");
                    return;
                }
                
                if(results.errors.length > 0) {
                    console.warn("CSV Parse Warnings:", results.errors);
                }

                onComplete(results);
            },
            
            error: (err) => {
                alert("Parse Error: " + err.message);
            }
        });
    }
};