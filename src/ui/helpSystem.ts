import { cx, ui } from './classes';
import { createModal } from './uiHelpers';

/**
 * Help & Documentation Module
 */
export const HelpSystem = {
  show(targetSection: string | null = null): void {
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
                                <div class="tree-item" data-target="multi-import">Multi-file Import</div>
                                <div class="tree-item" data-target="sessions-review">Sessions & Review</div>
                                <div class="tree-item" data-target="workspace-layout">Workspace Layout</div>
                                <div class="tree-item" data-target="plot-controls">Plot Controls</div>
                                <div class="tree-item" data-target="cursor-functions">Hover Readouts & Zoom</div>
                                <div class="tree-item" data-target="pipeline">Filter Pipeline Management</div>
                                <div class="tree-item" data-target="live-toolbar">Live Toolbar & Views</div>
                                <div class="tree-item" data-target="multi-view-tabs">Multi-View Tabs</div>
                                <div class="tree-item" data-target="math-trace-tabs">Math Trace Tabs</div>
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
                                <div class="tree-item" data-target="designed-fir">Designed Kaiser FIR</div>
                                <div class="tree-item" data-target="iir-lowpass">IIR Low Pass</div>
                                <div class="tree-item" data-target="designed-iir">Butterworth / Notch / Comb IIR</div>
                                <div class="tree-item" data-target="hampel-wavelet">Hampel & Wavelet Denoising</div>
                                <div class="tree-item" data-target="fft-lowpass">FFT Low Pass</div>
                                <div class="tree-item" data-target="fft-highpass">FFT High Pass</div>
                                <div class="tree-item" data-target="fft-notch">FFT Notch / Band-Stop</div>
                                <div class="tree-item" data-target="start-stop-norm">Start / Stop Normalization</div>
                            </div>
                        </div>

                        <div class="tree-node expanded">
                            <div class="tree-node-header" data-toggle>
                                <span class="tree-caret">▾</span>
                                <span class="tree-title">Analysis</span>
                            </div>
                            <div class="tree-children">
                                <div class="tree-item" data-target="analysis-measurements">Measurements</div>
                                <div class="tree-item" data-target="analysis-events">Events & Triggers</div>
                                <div class="tree-item" data-target="analysis-fft">FFT & Spectral Metrics</div>
                                <div class="tree-item" data-target="analysis-spectrogram">Spectrogram</div>
                                <div class="tree-item" data-target="analysis-system">Cross-Channel / FRF</div>
                                <div class="tree-item" data-target="filter-response">Residual & Filter Response</div>
                            </div>
                        </div>

                        <div class="tree-node expanded">
                            <div class="tree-node-header" data-toggle>
                                <span class="tree-caret">▾</span>
                                <span class="tree-title">Reference</span>
                            </div>
                            <div class="tree-children">
                                <div class="tree-item" data-target="data-integrity">Data Integrity & Saving</div>
                                <div class="tree-item" data-target="supported-formats">Supported Formats & Limits</div>
                                <div class="tree-item" data-target="troubleshooting">Troubleshooting Tips</div>
                                <div class="tree-item" data-target="license">License</div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="help-content">
                    <div id="content-about" class="help-section active">
                        <h3>Signal Forge Overview</h3>
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
                            <li><strong>Sessions:</strong> Reviewed sessions are stored in IndexedDB and can be exported as checksum-verified <code>.signalforge</code> project archives. Raw source bytes remain local.</li>
                        </ul>
                    </div>

                    <div id="content-loading-data" class="help-section">
                        <h3>Loading Data</h3>
                        <ol>
                            <li>Click <strong>Load</strong> and select a CSV file. The preview shows raw text so header rows are explicit.</li>
                            <li>Select the header row (e.g., <em>Time, Voltage</em>) to name your columns. Column names become plot tabs and filter targets. (In Multi Import, a text file whose first row is entirely numeric is treated as headerless: columns become <code>Time</code>, <code>Channel 1</code>, … and no sample is consumed as a name.)</li>
                            <li>Confirm delimiter detection; most files auto-detect, but you can re-open with corrected headers at any time.</li>
                            <li>Use the column tabs above the plot to choose which signal is currently processed. Other columns remain available for math expressions.</li>
                        </ol>
                    </div>

                    <div id="content-multi-import" class="help-section">
                        <h3>Multi-file Import</h3>
                        <p>Use <strong>Multi Import</strong> to build shots from several channel files.</p>
                        <ul>
                            <li><strong>Filename profile:</strong> A profile such as <code>shot {shot:int} - {charge_voltage:quantity[V]} - {length:quantity[mm]} - {channel:text}.csv</code> accepts a filename such as <code>shot 7 - 25kV - 200mm - Voltage.csv</code>.</li>
                            <li><strong>No convention:</strong> Clear <em>Extract shot metadata from a filename convention</em> to accept any supported filename. Each file becomes a separate shot.</li>
                            <li><strong>Preview first:</strong> Review normalized SI metadata, unmatched files, importer choice, and warnings before committing the import.</li>
                            <li>Native scope formats remain unavailable until representative model/firmware fixtures have been validated.</li>
                        </ul>
                    </div>

                    <div id="content-sessions-review" class="help-section">
                        <h3>Sessions & Manual Review</h3>
                        <ul>
                            <li>Sessions contain shots, calibrated channels, source files, quality flags, annotations, and provenance-rich results.</li>
                            <li>Use previous/next controls or <kbd>Alt</kbd>+arrow keys to review shots.</li>
                            <li>Place named markers manually or accept/reject automatic suggestions. Accepted manual markers are authoritative.</li>
                            <li><strong>Compare shots:</strong> Render event-aligned overlays, small multiples, waterfall heatmaps, and ringing frequency/decay versus extracted metadata.</li>
                            <li><strong>Batch all shots:</strong> Run the selected unit-aware voltage/current pulse calculation across the session with progress, cancellation, per-shot failures, and provenance.</li>
                            <li>Capture the current single-file workspace as a shot, or load/import/export complete sessions from the same panel.</li>
                            <li>Save to IndexedDB for local persistence or export a checksum-verified <code>.signalforge</code> archive.</li>
                        </ul>
                    </div>

                    <div id="content-workspace-layout" class="help-section">
                        <h3>Workspace Layout</h3>
                        <ul>
                            <li><strong>Header:</strong> Access Load, Multi Import, Sessions, grid view, graph settings, export, theme, and help.</li>
                            <li><strong>Plot region:</strong> Central area for time-domain and frequency-domain visualizations with raw, derivative, residual and event overlays.</li>
                            <li><strong>Filter pipeline sidebar:</strong> Ordered steps plus Sync All Tabs for global versus per-column pipelines.</li>
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

                    <div id="content-cursor-functions" class="help-section">
                        <h3>Hover Readouts & Zoom</h3>
                        <p>Zooming the time-domain plot also sets the analysis selection used by measurements, events, and spectral metrics.</p>
                        <ul>
                            <li><strong>Hover:</strong> Point at a trace to read time/frequency and amplitude at that sample.</li>
                            <li><strong>Box zoom:</strong> Drag to isolate a region. Double-click the plot to restore the full view and clear the selection.</li>
                            <li><strong>Measure tab:</strong> Shows RMS, duty cycle, rise/fall, and other stats for the current zoom window.</li>
                        </ul>
                    </div>

                    <div id="content-pipeline" class="help-section">
                        <h3>Filter Pipeline Management</h3>
                        <p>Filters execute from top to bottom. Each step receives the output of the previous one, enabling reproducible, publication-ready transformations.</p>
                        <ul>
                            <li><strong>Add:</strong> Insert a new filter at the end of the chain. Configure parameters immediately below.</li>
                            <li><strong>Reorder:</strong> Use arrow controls to move the selected filter up or down. Order affects results, especially when combining nonlinear steps.</li>
                            <li><strong>Delete:</strong> Remove the highlighted filter. Other steps remain unchanged.</li>
                            <li><strong>Bypass:</strong> Uncheck the step checkbox to disable it without discarding settings.</li>
                            <li><strong>Parameter tuning:</strong> Use sliders for quick exploration; numeric entry supports exact values for reproducibility.</li>
                        </ul>
                    </div>

                    <div id="content-live-toolbar" class="help-section">
                        <h3>Live Toolbar & Views</h3>
                        <ul>
                            <li><strong>Raw trace:</strong> Overlay the unprocessed signal to validate that key morphology is preserved.</li>
                            <li><strong>Residual:</strong> Plot raw minus processed values on a separate axis to expose removed structure and artifacts.</li>
                            <li><strong>Derivative (dy/dx):</strong> Inspect slope changes, rising-edge rates, and inflection points without exporting to another tool.</li>
                            <li><strong>View menu:</strong> Switch between time, windowed FFT, and spectrogram.</li>
                            <li><strong>Math engine:</strong> Prefer safe named waveform operations such as <code>power(V, I)</code>, <code>energy(V, I, t)</code>, and <code>guardedDivide(V, I, minimum)</code>. Bare <code>*</code> and <code>/</code> between waveform variables are matrix operations and are rejected.</li>
                        </ul>
                    </div>

                    <div id="content-multi-view-tabs" class="help-section">
                        <h3>Multi-View Tabs</h3>
                        <p>Create stacked composite views when you need to compare multiple traces side by side.</p>
                        <ul>
                            <li><strong>Creating:</strong> Click <em>Add New View</em> then choose <em>Multi-View Tab</em>. The new tab inherits the active column so you can start with a meaningful trace.</li>
                            <li><strong>Selecting traces:</strong> Inside the Multi-View tab, use the column checklist to toggle which raw or math traces render together.</li>
                            <li><strong>Managing:</strong> Each tab shows a small boxed <strong>×</strong> icon. Click it to remove the Multi-View entirely without touching your filters or data.</li>
                            <li><strong>Why use it:</strong> Perfect for overlaying filtered vs. raw data, comparing channels with shared timing, or keeping reference and experiment traces visible together.</li>
                        </ul>
                    </div>

                    <div id="content-math-trace-tabs" class="help-section">
                        <h3>Math Trace Tabs</h3>
                        <p>Math Trace tabs generate new series using the built-in math engine and place them alongside recorded columns. They are ideal for building custom measurements that mix existing traces, time, and scalar constants.</p>
                        <ol>
                            <li><strong>Open the builder:</strong> Choose <em>Add New View → Math Trace Tab</em> to map symbols to columns and author an expression.</li>
                            <li><strong>Map variables:</strong> Assign symbols (e.g., <code>V</code>, <code>I</code>, <code>REF</code>) to any combination of raw or math traces so expressions stay readable.</li>
                            <li><strong>Use physical helpers first:</strong> <code>derivative(V, t)</code>, <code>charge(I, t)</code>, <code>energy(V, I, t)</code>, <code>meanTraces(...)</code>, <code>pointwiseMultiply(...)</code>, and <code>guardedDivide(...)</code> preserve waveform semantics.</li>
                            <li><strong>Index-only helpers:</strong> <code>diff(x)</code> and <code>cumsum(x)</code> operate by sample index and are not substitutes for actual-time differentiation or integration.</li>
                            <li><strong>Time aliases:</strong> Reference <code>t</code> for the aligned time vector. <code>dt</code> is a representative scalar spacing for expert expressions, not a guarantee of uniform sampling.</li>
                        </ol>
                        <h4>Examples</h4>
                        <ul>
                            <li><code>derivative(V, t)</code> — derivative using the real, possibly non-uniform timebase.</li>
                            <li><code>charge(I, t)</code> — cumulative trapezoidal integration of current.</li>
                            <li><code>energy(V, I, t)</code> — cumulative energy from pointwise power on the real timebase.</li>
                            <li><code>abs(V)</code> — keep magnitudes from signed measurements (e.g., rectified sensor data).</li>
                            <li><code>meanTraces(V1, V2, V3)</code> — pointwise ensemble average across three probes.</li>
                            <li><code>(V - REF) / 10</code> — simple offset and scaling for calibration traces.</li>
                            <li><code>sqrt(Vx.^2 + Vy.^2)</code> — vector magnitude from orthogonal axes.</li>
                            <li><code>abs(diff(V))</code> — emphasize edge magnitudes while ignoring direction.</li>
                            <li><code>diff(V) ./ diff(t)</code> — alternative derivative using explicit time spacing.</li>
                            <li><code>abs(V - mean(V))</code> — magnitude of deviations from the average.</li>
                        </ul>
                        <p class="hint">Math traces appear as tabs with their own boxed <strong>×</strong> icon. Click the box to delete the virtual column without affecting the original data. See the <a href="https://mathjs.org/docs/index.html" target="_blank" rel="noopener">math.js documentation</a> for additional functions and syntax.</p>
                    </div>

                    <div id="content-filter-overview" class="help-section">
                        <h3>Filter Library Overview</h3>
                        <p>Combine filters to match the structure of your signal. Linear filters are order-sensitive when paired with nonlinear steps like median filters.</p>
                        <ul>
                            <li><strong>Windowed smoothers:</strong> Moving Average and Savitzky-Golay reduce stochastic noise with minimal phase shift.</li>
                            <li><strong>Outlier rejection:</strong> Median filtering removes impulsive spikes before downstream smoothing.</li>
                            <li><strong>Recursive response:</strong> The one-pole IIR uses a sample-rate-dependent alpha for lightweight causal smoothing. Use Butterworth when a cutoff in hertz is required.</li>
                            <li><strong>Designed FIR filters:</strong> Kaiser low/high/band-pass/band-stop filters derive odd linear-phase tap counts from ripple, attenuation and transition specifications.</li>
                            <li><strong>Designed IIR filters:</strong> Butterworth low/high/band-pass, notch, and comb filters provide explicit causal or forward/backward zero-phase processing.</li>
                            <li><strong>Transient cleanup:</strong> Hampel deglitching and wavelet denoising report their processing choices while preserving the raw record.</li>
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

                    <div id="content-designed-fir" class="help-section">
                        <h3>Designed Kaiser FIR</h3>
                        <p><strong>Families:</strong> Low-pass, high-pass, band-pass and band-stop filters with odd Type-I linear-phase coefficients.</p>
                        <ul>
                            <li><strong>Frequency specification:</strong> Set a passband edge for low/high pass, or a center and passband/stopband width for band filters. Transition width separates passband and stopband edges.</li>
                            <li><strong>Performance specification:</strong> Set maximum passband ripple and minimum stopband attenuation. SignalForge derives the tap count and Kaiser beta, then numerically verifies the realized response.</li>
                            <li><strong>Safety:</strong> Designs above 16,385 taps, a 512 MiB estimated working set, or the requested response fail explicitly; exact edges and response extrema are checked and specifications are never silently relaxed.</li>
                            <li><strong>Causal:</strong> Requires timestamps uniform to a <code>1e-9</code> relative interval tolerance, reports the constant <code>(taps − 1) / 2</code> sample delay, and assumes <code>taps − 1</code> samples of constant prehistory equal to the run’s first value.</li>
                            <li><strong>Centered zero-phase:</strong> Applies the symmetric kernel once with reflected boundaries. It has no phase delay and does not square the magnitude response. Non-uniform input uses offline resampling; the complete operation is time-varying, so its uniform-kernel response overlay is hidden.</li>
                            <li>The pipeline report exposes taps, beta, achieved ripple/attenuation and short-run boundary warnings. FFT view plots the exact FIR response and group delay.</li>
                        </ul>
                    </div>

                    <div id="content-iir-lowpass" class="help-section">
                        <h3>One-Pole IIR Smoother</h3>
                        <p><strong>Ideal for:</strong> Lightweight causal smoothing and RC-like exploratory behavior.</p>
                        <p><strong>Mechanism:</strong> Recursive filter where each output depends on the previous output and current input.</p>
                        <p><strong>Parameters:</strong></p>
                        <ul>
                            <li><em>Alpha:</em> A dimensionless per-sample smoothing coefficient. It is not a physical cutoff and changes meaning when sample rate changes.</li>
                            <li>Use a designed Butterworth low pass when a cutoff in hertz and auditable magnitude/phase response are required.</li>
                        </ul>
                    </div>

                    <div id="content-designed-iir" class="help-section">
                        <h3>Butterworth / Notch / Comb IIR</h3>
                        <ul>
                            <li>Butterworth low-, high-, and band-pass designs use normalized cascaded sections and honor the requested total order.</li>
                            <li>IIR notch and comb filters remove narrow interference at calibrated frequencies and harmonics.</li>
                            <li>SignalForge rejects broad or overlapping notch configurations when the complete cascade cannot retain both requested −3 dB bandwidth edges.</li>
                            <li><strong>Causal</strong> mode preserves real-time direction and has measurable phase/group delay. <strong>Zero-phase</strong> mode runs forward and backward for offline analysis and doubles the magnitude order.</li>
                            <li>The FFT view exposes each designed filter’s magnitude, phase, and group-delay response.</li>
                        </ul>
                    </div>

                    <div id="content-hampel-wavelet" class="help-section">
                        <h3>Hampel & Wavelet Denoising</h3>
                        <ul>
                            <li><strong>Hampel:</strong> Replaces isolated samples that exceed a configurable robust median/MAD threshold. It is intended for sparse glitches, not continuous noise.</li>
                            <li><strong>Wavelet:</strong> Applies multilevel Haar soft-thresholding with a robust threshold estimated independently at each detail scale, or an explicit user threshold.</li>
                            <li>Inspect the raw-minus-processed residual and changed-sample count before accepting either operation.</li>
                        </ul>
                    </div>

                    <div id="content-fft-lowpass" class="help-section">
                        <h3>FFT Low Pass</h3>
                        <p><strong>Ideal for:</strong> Removing broadband high-frequency noise while keeping low-frequency content such as drift, envelopes, or slow oscillations.</p>
                        <p><strong>Mechanism:</strong> Applies a frequency-domain mask that attenuates bins above the selected cutoff before performing the inverse FFT.</p>
                        <p><strong>Considerations:</strong></p>
                        <ul>
                            <li>Requires appropriate sampling frequency to interpret the cutoff accurately.</li>
                            <li>Slope sets the Butterworth-magnitude roll-off in dB/octave.</li>
                            <li>Finite runs are reflect-padded before transformation, and non-uniform timebases are resampled before filtering.</li>
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
                            <li>The requested bandwidth must be at least the finite run resolution (<code>sample rate / run length</code>); an unresolvable notch is rejected rather than reported as successful.</li>
                            <li>Invalid, duplicate, or decreasing timestamps split runs and are listed in the pipeline report.</li>
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

                    <div id="content-analysis-measurements" class="help-section">
                        <h3>Measurements</h3>
                        <p>The Measure sidebar tab computes scope-style statistics on the active trace. Zoom the plot to limit the calculation to a region. Presets switch between general, power-electronics, and pulsed metrics.</p>
                    </div>
                    <div id="content-analysis-events" class="help-section">
                        <h3>Events & Triggers</h3>
                        <p>Detect level crossings, edges, pulse widths, and runt pulses. Trigger on raw, filtered, math, or derivative data. Markers appear on the time plot; use previous/next to jump between events.</p>
                    </div>
                    <div id="content-analysis-fft" class="help-section">
                        <h3>FFT & Spectral Metrics</h3>
                        <p>The FFT view now uses a windowed, detrended spectrum with optional zero-padding. The Spectral tab reports peaks, harmonics, THD, SNR, bandpower, and the largest spur. These settings also drive the plotted FFT.</p>
                    </div>
                    <div id="content-analysis-spectrogram" class="help-section">
                        <h3>Spectrogram</h3>
                        <p>Choose <em>Spectrogram</em> in the toolbar View menu to render an STFT heatmap. Window size and overlap are in the Spectral tab. Large records are downsampled before the STFT to keep the UI responsive.</p>
                    </div>
                    <div id="content-analysis-system" class="help-section">
                        <h3>Cross-Channel / FRF</h3>
                        <p>The System / Bode panel estimates delay by cross-correlation and computes a transfer function with coherence. <em>Apply alignment</em> shifts the output trace by the estimated sample delay so the channels line up. Delay is measured on the currently offset traces, so a second apply is a no-op once they already match.</p>
                    </div>
                    <div id="content-filter-response" class="help-section">
                        <h3>Residual & Filter Response</h3>
                        <ul>
                            <li>Enable <strong>Residual</strong> in Time view to plot raw minus processed data on its own axis.</li>
                            <li>FFT view plots signal spectra and filter gain on the magnitude axis, raw/filtered/filter phase on the phase axis, and causal group delay on a dedicated axis.</li>
                            <li>Moving-average, Savitzky–Golay, Gaussian, one-pole, designed FIR and designed IIR responses are reported. Median, Hampel, wavelet and taper operations are nonlinear or time-varying and do not have one LTI transfer function.</li>
                            <li>Deep response nulls are masked from group-delay display because phase is undefined there.</li>
                        </ul>
                    </div>

                    <div id="content-data-integrity" class="help-section">
                        <h3>Data Integrity & Saving</h3>
                        <ul>
                            <li><strong>Immutable originals:</strong> Imported bytes and parsed values are retained separately from repairs and processed traces.</li>
                            <li><strong>Quality masks:</strong> Missing, invalid, clipped, saturated, interpolated, forward-filled, and edited samples remain traceable.</li>
                            <li><strong>Reversible repair:</strong> Grid interpolation and forward filling are explicit operations with undo and redo.</li>
                            <li><strong>Export options:</strong> Full CSV exports keep original, working, original-quality, working-quality, filtered-quality and filtered values distinct.</li>
                            <li><strong>Reproducibility:</strong> Save filter-chain workspace settings in localStorage/JSON, or preserve chains with waveform data, markers and results in an IndexedDB session or <code>.signalforge</code> archive. Settings alone are not session archives.</li>
                        </ul>
                    </div>

                    <div id="content-supported-formats" class="help-section">
                        <h3>Supported Formats & Limits</h3>
                        <ul>
                            <li><strong>Verified native:</strong> Tektronix little-endian WFM#003 analogue/FastFrame; Keysight AG10 analogue BIN; R&S RTx paired float32, int8 and explicit-time exports; LeCroy LECROY_1_0/2_3 little-endian TRC; fixture-backed Rigol DS1000B/C/D-E/Z, DS2000, DS4000, MSO5000 and DHO800 WFM/BIN.</li>
                            <li><strong>Layout-tested beta:</strong> Tektronix ISF, Keysight AG01/AG03, R&S int16, big-endian LeCroy TRC and PicoScope two-row CSV.</li>
                            <li>Detection is content-first. R&S requires both its description <code>.bin</code> and matching <code>.Wfm.bin</code>. FastFrame creates one shot per frame.</li>
                            <li><strong>Conversion/provisional:</strong> PSDATA requires PicoScope export/BatchConvert; HDF5 is detection-only; Siglent and unproved Tek/Rigol variants are rejected.</li>
                            <li>Native parsing runs in a dedicated cancellable worker with exact length checks and 64 MiB/file, four-channel, 3M samples/channel, 3M total-sample and 192 MiB end-to-end session-budget limits. Delimited text is limited to 32 MiB and 64 channels, and its row × channel memory is checked before parsing.</li>
                            <li>Multi-import preview accepts up to 10,000 files and 64 MiB aggregate source bytes; cumulative source/session arrays must remain within the 192 MiB persistence budget. The evidence level shown per source is what the decoder actually accepted.</li>
                            <li>Tektronix WFM vendor tails after the declared EOF are disclosed and ignored; LeCroy TRC files with undeclared trailing bytes and ISF preambles without <code>XINCR</code>/<code>YMULT</code> are rejected.</li>
                            <li>Pipeline processing moves to a cancellable worker at 100,000 samples; optional display downsampling defaults to 20,000 shared-index points.</li>
                            <li>The grid virtualizes records above 1,000 rows.</li>
                            <li>Mixed-rate records with fewer than 64 source samples return no anti-aliased engineering result rather than an unreliable value.</li>
                            <li>Production builds cache same-origin application resources for offline reuse. The cache is versioned per deployment: hashed assets are cache-first, everything else is network-first, and the previous deployment's cache is deleted on activation.</li>
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
                        <p>SignalForge is MIT licensed. Native oscilloscope format validation also uses BSD-3-Clause RigolWFM and Apache-2.0 Tektronix fixture material; full attribution is retained in repository <code>THIRD_PARTY_NOTICES.md</code> and deployed <code>THIRD_PARTY_NOTICES.txt</code>.</p>
                        <pre class="help-license">
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
    modalContent.className = cx(ui.modal, 'flex h-[min(38rem,90vh)] max-w-5xl flex-col p-0');

    const treeItems = modalContent.querySelectorAll<HTMLElement>('.tree-item');
    const sections = modalContent.querySelectorAll<HTMLElement>('.help-section');
    const toggles = modalContent.querySelectorAll<HTMLElement>('[data-toggle]');

    treeItems.forEach((item) => {
      item.setAttribute('role', 'button');
      item.tabIndex = 0;
      const activate = () => {
        treeItems.forEach((i) => i.classList.remove('active'));
        sections.forEach((s) => s.classList.remove('active'));
        item.classList.add('active');
        const targetId = `content-${item.getAttribute('data-target')}`;
        modalContent.querySelector(`#${targetId}`)?.classList.add('active');
      };
      item.addEventListener('click', activate);
      item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate();
        }
      });
    });

    toggles.forEach((toggle) => {
      toggle.setAttribute('role', 'button');
      toggle.tabIndex = 0;
      const parent = toggle.closest('.tree-node');
      const toggleNode = () => parent?.classList.toggle('expanded');
      toggle.addEventListener('click', toggleNode);
      toggle.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggleNode();
        }
      });
    });

    const setActiveSection = (targetName: string | null) => {
      if (!targetName) return;
      const targetItem = Array.from(treeItems).find((i) => i.getAttribute('data-target') === targetName);
      const targetContent = modalContent.querySelector(`#content-${targetName}`);
      if (!targetItem || !targetContent) return;
      treeItems.forEach((i) => i.classList.remove('active'));
      sections.forEach((s) => s.classList.remove('active'));
      targetItem.classList.add('active');
      targetContent.classList.add('active');
      targetItem.closest('.tree-node')?.classList.add('expanded');
    };

    if (targetSection) setActiveSection(targetSection);
  }
};
