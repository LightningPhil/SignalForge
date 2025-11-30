import { createModal } from './uiHelpers.js';

/**
 * Help & Documentation Module
 */
export const HelpSystem = {
    
    show() {
        const html = `
            <div class="help-container">
                <div class="help-sidebar">
                    <div class="help-tree">
                        <div class="tree-node expanded">
                            <div class="tree-node-header" data-toggle>
                                <span class="tree-caret">▾</span>
                                <span class="tree-title">Overview</span>
                            </div>
                            <div class="tree-children">
                                <div class="tree-item active" data-target="about">Welcome & Purpose</div>
                                <div class="tree-item" data-target="privacy">Local Processing & Privacy</div>
                            </div>
                        </div>

                        <div class="tree-node expanded">
                            <div class="tree-node-header" data-toggle>
                                <span class="tree-caret">▾</span>
                                <span class="tree-title">Workspace</span>
                            </div>
                            <div class="tree-children">
                                <div class="tree-item" data-target="loading-data">Loading Data</div>
                                <div class="tree-item" data-target="workspace-layout">Workspace Layout</div>
                                <div class="tree-item" data-target="plot-controls">Plot Controls</div>
                                <div class="tree-item" data-target="pipeline">Filter Pipeline Management</div>
                                <div class="tree-item" data-target="live-toolbar">Live Toolbar & Views</div>
                            </div>
                        </div>

                        <div class="tree-node expanded">
                            <div class="tree-node-header" data-toggle>
                                <span class="tree-caret">▾</span>
                                <span class="tree-title">Filter Library</span>
                            </div>
                            <div class="tree-children">
                                <div class="tree-item" data-target="filter-overview">How Filters Work Together</div>
                                <div class="tree-item" data-target="savitzky">Savitzky-Golay</div>
                                <div class="tree-item" data-target="moving-average">Moving Average</div>
                                <div class="tree-item" data-target="median">Median</div>
                                <div class="tree-item" data-target="iir-lowpass">IIR Low Pass</div>
                                <div class="tree-item" data-target="fft-lowpass">FFT Low Pass</div>
                                <div class="tree-item" data-target="fft-highpass">FFT High Pass</div>
                                <div class="tree-item" data-target="fft-notch">FFT Notch / Band-Stop</div>
                                <div class="tree-item" data-target="start-stop-norm">Start / Stop Normalization</div>
                            </div>
                        </div>

                        <div class="tree-node expanded">
                            <div class="tree-node-header" data-toggle>
                                <span class="tree-caret">▾</span>
                                <span class="tree-title">Reference</span>
                            </div>
                            <div class="tree-children">
                                <div class="tree-item" data-target="data-integrity">Data Integrity & Saving</div>
                                <div class="tree-item" data-target="troubleshooting">Troubleshooting Tips</div>
                                <div class="tree-item" data-target="license">License</div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="help-content">
                    <div id="content-about" class="help-section active">
                        <h3>Signal Processor Overview</h3>
                        <p>The application is designed for academic and professional engineers who need rapid, transparent analysis of oscilloscope or sensor data directly in the browser.</p>
                        <p>No uploads are performed; every operation runs locally, making the tool suitable for confidential or pre-publication datasets.</p>
                        <h4>Key capabilities</h4>
                        <ul>
                            <li><strong>Configurable pipelines:</strong> Chain multiple filters (for example, Median → Savitzky-Golay → FFT notch) to isolate noise, correct baselines, and highlight features.</li>
                            <li><strong>Dual-domain analysis:</strong> Switch seamlessly between time and frequency views to validate both waveform fidelity and spectral content.</li>
                            <li><strong>Differential and derived traces:</strong> Toggle dy/dx for slope inspection or compute custom metrics via the math engine (impedance, power, arbitrary expressions over columns).</li>
                            <li><strong>Reversible exploration:</strong> Enable or disable individual steps to understand each filter’s contribution without losing the configured parameters.</li>
                        </ul>
                    </div>

                    <div id="content-privacy" class="help-section">
                        <h3>Local Processing & Data Privacy</h3>
                        <ul>
                            <li><strong>In-browser computation:</strong> All CSV parsing, plotting, FFT operations, and math evaluations run in JavaScript on your machine.</li>
                            <li><strong>No network round trips:</strong> The tool does not transmit loaded datasets or filter parameters to external services.</li>
                            <li><strong>Session scope:</strong> Loaded data persists only for the current browser tab. Refreshing clears the workspace unless you export results.</li>
                        </ul>
                    </div>

                    <div id="content-loading-data" class="help-section">
                        <h3>Loading Data</h3>
                        <ol>
                            <li>Click <strong>Load</strong> and select a CSV file. The preview shows raw text so header rows are explicit.</li>
                            <li>Select the header row (e.g., <em>Time, Voltage</em>) to name your columns. Column names become plot tabs and filter targets.</li>
                            <li>Confirm delimiter detection; most files auto-detect, but you can re-open with corrected headers at any time.</li>
                            <li>Use the column tabs above the plot to choose which signal is currently processed. Other columns remain available for math expressions.</li>
                        </ol>
                    </div>

                    <div id="content-workspace-layout" class="help-section">
                        <h3>Workspace Layout</h3>
                        <ul>
                            <li><strong>Toolbar:</strong> Access loading, saving, undo/redo, and the help menu.</li>
                            <li><strong>Plot region:</strong> Central area for time-domain and frequency-domain visualizations with optional overlays for raw and derivative traces.</li>
                            <li><strong>Filter pipeline sidebar:</strong> Ordered list of processing steps with controls to insert, reorder, duplicate, or remove filters.</li>
                            <li><strong>Parameter panel:</strong> Contextual controls beneath the pipeline that expose sliders and numeric inputs for the selected step.</li>
                        </ul>
                    </div>

                    <div id="content-plot-controls" class="help-section">
                        <h3>Plot Controls</h3>
                        <ul>
                            <li><strong>Zoom:</strong> Drag to select a region. Mouse wheel zoom follows the cursor position for precision.</li>
                            <li><strong>Pan:</strong> Hold <kbd>Shift</kbd> and drag. Panning is available in both time and frequency views.</li>
                            <li><strong>Reset view:</strong> Double-click the background to restore full extents.</li>
                            <li><strong>Series selection:</strong> Tabs above the plot let you focus filtering and math on a specific column.</li>
                        </ul>
                    </div>

                    <div id="content-pipeline" class="help-section">
                        <h3>Filter Pipeline Management</h3>
                        <p>Filters execute from top to bottom. Each step receives the output of the previous one, enabling reproducible, publication-ready transformations.</p>
                        <ul>
                            <li><strong>Add:</strong> Insert a new filter at the end of the chain. Configure parameters immediately below.</li>
                            <li><strong>Reorder:</strong> Use arrow controls to move the selected filter up or down. Order affects results, especially when combining nonlinear steps.</li>
                            <li><strong>Delete:</strong> Remove the highlighted filter. Other steps remain unchanged.</li>
                            <li><strong>Bypass:</strong> Toggle the visibility icon to temporarily disable a step without discarding settings.</li>
                            <li><strong>Parameter tuning:</strong> Use sliders for quick exploration; numeric entry supports exact values for reproducibility.</li>
                        </ul>
                    </div>

                    <div id="content-live-toolbar" class="help-section">
                        <h3>Live Toolbar & Views</h3>
                        <ul>
                            <li><strong>Raw trace:</strong> Overlay the unprocessed signal to validate that key morphology is preserved.</li>
                            <li><strong>Derivative (dy/dx):</strong> Inspect slope changes, rising-edge rates, and inflection points without exporting to another tool.</li>
                            <li><strong>Frequency domain:</strong> Switch to FFT view to inspect harmonics, noise floors, and the effect of spectral filters.</li>
                            <li><strong>Math engine:</strong> Compute expressions across columns (e.g., <code>V*I</code> for power or <code>V/I</code> for impedance) and feed the results into the pipeline.</li>
                        </ul>
                    </div>

                    <div id="content-filter-overview" class="help-section">
                        <h3>Filter Library Overview</h3>
                        <p>Combine filters to match the structure of your signal. Linear filters are order-sensitive when paired with nonlinear steps like median filters.</p>
                        <ul>
                            <li><strong>Windowed smoothers:</strong> Moving Average and Savitzky-Golay reduce stochastic noise with minimal phase shift.</li>
                            <li><strong>Outlier rejection:</strong> Median filtering removes impulsive spikes before downstream smoothing.</li>
                            <li><strong>Recursive response:</strong> IIR Low Pass approximates analog RC behavior with adjustable cutoff.</li>
                            <li><strong>Spectral shaping:</strong> FFT-based high/low/notch filters target specific bands when the sample rate and periodicity are known.</li>
                        </ul>
                    </div>

                    <div id="content-savitzky" class="help-section">
                        <h3>Savitzky-Golay Filter</h3>
                        <p><strong>Ideal for:</strong> Preserving peak heights and widths while reducing broadband noise in spectroscopy, vibration, or transient capture.</p>
                        <p><strong>Mechanism:</strong> Fits a polynomial to each window using least squares and evaluates the central point. The fit respects curvature instead of averaging it away.</p>
                        <p><strong>Parameters:</strong></p>
                        <ul>
                            <li><em>Window size:</em> Odd number of samples used for each fit. Larger windows smooth more aggressively but can obscure rapid transitions.</li>
                            <li><em>Polynomial order:</em> Degree of the fitted curve. Orders 2–3 balance fidelity and stability; higher orders require wider windows.</li>
                            <li><em>Iterations:</em> Optional repeated passes to further suppress noise without the heavy distortion of broad windows.</li>
                        </ul>
                    </div>

                    <div id="content-moving-average" class="help-section">
                        <h3>Moving Average</h3>
                        <p><strong>Ideal for:</strong> Quick reduction of white noise when preserving only low-frequency trends.</p>
                        <p><strong>Mechanism:</strong> Replaces each point with the arithmetic mean of its neighbors.</p>
                        <p><strong>Considerations:</strong></p>
                        <ul>
                            <li>Expect peak flattening and edge lag proportional to the window size.</li>
                            <li>Use as an early-stage smoother before applying curve-preserving filters.</li>
                        </ul>
                    </div>

                    <div id="content-median" class="help-section">
                        <h3>Median Filter</h3>
                        <p><strong>Ideal for:</strong> Removing isolated spikes, shot noise, or defective samples without attenuating steady-state values.</p>
                        <p><strong>Mechanism:</strong> Replaces each sample with the median of the surrounding window, which ignores extreme outliers entirely.</p>
                        <p><strong>Considerations:</strong> Median filters are nonlinear; place them early in the chain to avoid contaminating later linear filters with impulsive noise.</p>
                    </div>

                    <div id="content-iir-lowpass" class="help-section">
                        <h3>IIR Low Pass</h3>
                        <p><strong>Ideal for:</strong> Emulating analog single-pole RC smoothing and reducing high-frequency noise while retaining slow trends.</p>
                        <p><strong>Mechanism:</strong> Recursive filter where each output depends on the previous output and current input.</p>
                        <p><strong>Parameters:</strong></p>
                        <ul>
                            <li><em>Alpha:</em> Blend factor controlling the cutoff. Smaller alpha lowers the cutoff for heavier smoothing; larger alpha increases responsiveness.</li>
                        </ul>
                    </div>

                    <div id="content-fft-lowpass" class="help-section">
                        <h3>FFT Low Pass</h3>
                        <p><strong>Ideal for:</strong> Removing broadband high-frequency noise while keeping low-frequency content such as drift, envelopes, or slow oscillations.</p>
                        <p><strong>Mechanism:</strong> Applies a frequency-domain mask that attenuates bins above the selected cutoff before performing the inverse FFT.</p>
                        <p><strong>Considerations:</strong></p>
                        <ul>
                            <li>Requires appropriate sampling frequency to interpret the cutoff accurately.</li>
                            <li>Use windowing or trimmed segments to minimize edge artifacts on non-periodic signals.</li>
                        </ul>
                    </div>

                    <div id="content-fft-highpass" class="help-section">
                        <h3>FFT High Pass</h3>
                        <p><strong>Ideal for:</strong> Suppressing DC offsets and slow drift to emphasize transient or high-frequency components.</p>
                        <p><strong>Mechanism:</strong> Zeros or attenuates frequency bins below the selected cutoff in the FFT, then reconstructs the waveform.</p>
                        <p><strong>Considerations:</strong></p>
                        <ul>
                            <li>Verify that important low-frequency content is not removed when selecting the cutoff.</li>
                            <li>Edge effects may introduce ringing; validate with the raw overlay.</li>
                        </ul>
                    </div>

                    <div id="content-fft-notch" class="help-section">
                        <h3>FFT Notch / Band-Stop</h3>
                        <p><strong>Ideal for:</strong> Removing narrow interference such as mains hum (50/60 Hz) or mechanical tones without affecting nearby spectrum.</p>
                        <p><strong>Mechanism:</strong> Attenuates a user-defined band (center frequency and width) in the FFT before inversion.</p>
                        <p><strong>Considerations:</strong></p>
                        <ul>
                            <li>Use the frequency-domain view to confirm the notch fully captures the interference.</li>
                            <li>For wide-band suppression, prefer paired high-pass and low-pass filters instead of an excessively broad notch.</li>
                        </ul>
                    </div>

                    <div id="content-start-stop-norm" class="help-section">
                        <h3>Start / Stop Normalization</h3>
                        <p><strong>Ideal for:</strong> Eliminating step changes at the boundaries before running FFT-based filters and for intentionally pinning the start and end of a trace to zero.</p>
                        <p><strong>Mechanism:</strong> Subtracts an offset from the full series, then applies independent sine tapers to the first and last portions of the data. The separate start and end lengths let you zero asymmetric boundaries without over-suppressing the opposite side.</p>
                        <p><strong>Parameters:</strong></p>
                        <ul>
                            <li><em>Start/End lengths:</em> Choose different taper widths to fade the opening and closing samples toward zero. Set either side to zero to bypass tapering there.</li>
                            <li><em>Offset:</em> Manually remove a DC level before tapering. Use the <em>Auto Start Offset</em> button to average the first N samples (configurable) and fill the offset automatically for signals with a biased leading edge.</li>
                            <li><em>Enable switches:</em> Toggle start or end processing independently if only one boundary needs correction.</li>
                        </ul>
                        <p><strong>Usage tips:</strong> Apply this step early in the pipeline when preparing for FFT operations to minimize wrap-around discontinuities that create ringing. Re-run <em>Auto Start Offset</em> after changing the data selection to keep the taper aligned with the current segment.</p>
                    </div>

                    <div id="content-data-integrity" class="help-section">
                        <h3>Data Integrity & Saving</h3>
                        <ul>
                            <li><strong>Non-destructive preview:</strong> The raw trace overlay remains unchanged, enabling direct comparison to processed results.</li>
                            <li><strong>Export options:</strong> Use export to download processed series or intermediate results for archival, publication figures, or external simulation.</li>
                            <li><strong>Reproducibility:</strong> Save filter chains with their parameters to rebuild the analysis sequence in subsequent sessions.</li>
                        </ul>
                    </div>

                    <div id="content-troubleshooting" class="help-section">
                        <h3>Troubleshooting Tips</h3>
                        <ul>
                            <li><strong>Empty plots after loading:</strong> Re-confirm the header row and ensure the selected column contains numeric data.</li>
                            <li><strong>Unexpected oscillations:</strong> Reduce aggressive FFT cutoffs or shrink Savitzky-Golay window sizes to avoid ringing.</li>
                            <li><strong>Slow interactions:</strong> Shorten window sizes or temporarily bypass expensive filters while iterating.</li>
                            <li><strong>Baseline drift after filtering:</strong> Apply Median first to remove spikes, then use IIR Low Pass or Savitzky-Golay with a modest window.</li>
                        </ul>
                    </div>

                    <div id="content-license" class="help-section">
                        <h3>License</h3>
                        <pre style="background:#111; padding:10px; font-size:0.8em; overflow:auto;">
MIT License

Copyright (c) 2025 Philip Leichauer (LightningPhil)

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

        // Tree behavior
        const treeItems = modalContent.querySelectorAll('.tree-item');
        const sections = modalContent.querySelectorAll('.help-section');
        const toggles = modalContent.querySelectorAll('[data-toggle]');

        treeItems.forEach(item => {
            item.addEventListener('click', () => {
                treeItems.forEach(i => i.classList.remove('active'));
                sections.forEach(s => s.classList.remove('active'));

                item.classList.add('active');
                const targetId = `content-${item.getAttribute('data-target')}`;
                const targetSection = modalContent.querySelector(`#${targetId}`);
                if (targetSection) {
                    targetSection.classList.add('active');
                }
            });
        });

        toggles.forEach(toggle => {
            toggle.addEventListener('click', () => {
                const parent = toggle.closest('.tree-node');
                parent.classList.toggle('expanded');
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