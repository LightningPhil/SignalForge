import { createModal } from './uiHelpers.js';

/**
 * Help & Documentation Module
 */
export const HelpSystem = {
    
    show() {
        const html = `
            <div class="help-container">
                <div class="help-sidebar">
                    <div class="help-tab active" data-target="about">About</div>
                    <div class="help-tab" data-target="ui-guide">UI Guide</div>
                    <div class="help-tab" data-target="filters">Filter Wiki</div>
                    <div class="help-tab" data-target="license">License</div>
                </div>
                <div class="help-content">
                    <div id="content-about" class="help-section active">
                        <h3>About Signal Processor</h3>
                        <p>This application is designed for engineers and scientists to clean, analyze, and process time-series data, specifically from oscilloscopes and sensors.</p>
                        <p>It performs signal processing entirely in your browser using JavaScript, meaning your data never leaves your computer.</p>
                        <h4>Key Features:</h4>
                        <ul>
                            <li><strong>Pipeline Processing:</strong> Chain multiple filters together (e.g., Median -> Savitzky-Golay).</li>
                            <li><strong>Frequency Domain:</strong> Visualize FFTs and apply High/Low/Notch filters.</li>
                            <li><strong>Differential Analysis:</strong> View the derivative (rate of change) of your signal alongside the data.</li>
                            <li><strong>Math Engine:</strong> Calculate Impedance, Power, or other derived metrics from raw columns.</li>
                        </ul>
                    </div>

                    <div id="content-ui-guide" class="help-section">
                        <h3>User Interface Guide</h3>
                        
                        <h4>1. Loading Data</h4>
                        <p>Click <strong>"Load"</strong> to open a CSV file. You will see a preview of the file text. Click on the row that contains your headers (e.g., "Time, Voltage") to parse the file.</p>

                        <h4>2. The Graph</h4>
                        <ul>
                            <li><strong>Zoom:</strong> Click and drag a box to zoom in.</li>
                            <li><strong>Pan:</strong> Hold Shift, then Click and Drag.</li>
                            <li><strong>Reset:</strong> Double-click the graph background.</li>
                            <li><strong>Tabs:</strong> Use the tabs above the graph to switch which column is currently being filtered.</li>
                        </ul>

                        <h4>3. The Filter Pipeline (Sidebar)</h4>
                        <p>Filters are applied from top to bottom.</p>
                        <ul>
                            <li><strong>Add:</strong> Adds a new processing step to the end of the chain.</li>
                            <li><strong>Arrow Buttons:</strong> Move the selected step up or down.</li>
                            <li><strong>Trash:</strong> Deletes the selected step.</li>
                        </ul>
                        <p>When you select a step, its parameters appear below. Use the sliders for fluid adjustment.</p>

                        <h4>4. Live Toolbar</h4>
                        <p>Located directly above the plot area.</p>
                        <ul>
                            <li><strong>Raw:</strong> Toggle the faint grey original trace.</li>
                            <li><strong>Diff:</strong> Toggle the derivative plot (dy/dx).</li>
                            <li><strong>Freq Domain:</strong> Switch to FFT view (Bode Plot style).</li>
                        </ul>
                    </div>

                    <div id="content-filters" class="help-section">
                        <h3>Filter Wiki</h3>
                        
                        <div class="wiki-entry">
                            <h4>Savitzky-Golay</h4>
                            <p><strong>Best for:</strong> General purpose smoothing, preserving peak heights/widths.</p>
                            <p><strong>How it works:</strong> Fits a polynomial to the data window using least-squares. Unlike a moving average, it doesn't just flatten peaks.</p>
                            <p><strong>Params:</strong>
                                <ul>
                                    <li><em>Window:</em> Width of the fit. Larger = smoother but less detail.</li>
                                    <li><em>Poly Order:</em> Complexity of the curve. 2 or 3 is standard.</li>
                                    <li><em>Iterations:</em> Running the filter multiple times for aggressive smoothing without distortion.</li>
                                </ul>
                            </p>
                        </div>

                        <div class="wiki-entry">
                            <h4>Moving Average</h4>
                            <p><strong>Best for:</strong> Reducing white noise (random static).</p>
                            <p><strong>Limitation:</strong> Tends to flatten sharp peaks and step responses.</p>
                        </div>

                        <div class="wiki-entry">
                            <h4>Median Filter</h4>
                            <p><strong>Best for:</strong> "Despeckling" or removing shot noise (single wild points).</p>
                            <p><strong>How it works:</strong> Replaces each point with the median value of its neighbors. Excellent at ignoring outliers completely.</p>
                        </div>

                        <div class="wiki-entry">
                            <h4>IIR Low Pass</h4>
                            <p><strong>Best for:</strong> Simulating an electronic RC circuit.</p>
                            <p><strong>How it works:</strong> Recursive filter. <em>Alpha</em> controls the cutoff frequency. Lower Alpha = Smoother (lower cutoff).</p>
                        </div>

                        <div class="wiki-entry">
                            <h4>FFT Filters (High/Low/Notch)</h4>
                            <p><strong>Best for:</strong> Removing specific frequency components (e.g., 50Hz mains hum).</p>
                            <p><strong>How it works:</strong> Converts data to Frequency Domain, multiplies by a mask, and converts back. Note that this assumes the signal is periodic or windowed, so edge artifacts may occur.</p>
                        </div>
                    </div>

                    <div id="content-license" class="help-section">
                        <h3>License</h3>
                        <pre style="background:#111; padding:10px; font-size:0.8em; overflow:auto;">
MIT License

Copyright (c) 2023 Philip J. McLachlan (LightningPhil)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
                        </pre>
                    </div>
                </div>
            </div>
        `;

        const modalContent = createModal(html);
        
        // Add Tab Logic
        const tabs = modalContent.querySelectorAll('.help-tab');
        const sections = modalContent.querySelectorAll('.help-section');

        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                // Deactivate all
                tabs.forEach(t => t.classList.remove('active'));
                sections.forEach(s => s.classList.remove('active'));
                
                // Activate clicked
                tab.classList.add('active');
                const targetId = `content-${tab.getAttribute('data-target')}`;
                modalContent.querySelector(`#${targetId}`).classList.add('active');
            });
        });
        
        // Adjust modal styling for this specific one
        modalContent.style.width = '800px';
        modalContent.style.maxWidth = '95vw';
        modalContent.style.height = '600px';
        modalContent.style.padding = '0'; // Custom layout handles padding
        modalContent.style.display = 'flex';
        modalContent.style.flexDirection = 'column';
    }
};