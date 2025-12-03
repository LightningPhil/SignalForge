# Feature Wishlist & Roadmap

This document outlines the planned feature set for **FilterPro**. It serves as a technical specification, detailing functionality, architectural implementation strategies, and concrete use cases to guide development.

## 1. Advanced Cursor & Analysis Suite
**Status:** Done  
**Priority:** High  
**Complexity:** High

### Description
Moving beyond simple visual inspection, this feature implements "Oscilloscope-style" analysis tools. It requires a dedicated "Overlay Layer" on top of the graph that translates mouse coordinates into data coordinates, capable of snapping to waveform data points.

### Architectural & Technical Strategy
*   **Layering:** Do not draw cursors on the main plot trace. Use Plotly’s `shapes` (lines) and `annotations` (text) API. This ensures cursors scale correctly when zooming.
*   **Snap-to-Trace:** Implement a "Nearest Neighbor" search. When a user drags a cursor, the X-coordinate should optionally "snap" to the closest actual data point in the array to ensure the Y-value reading is accurate, not interpolated.
*   **Edge Detection:** For automated metrics (Rise Time), use a simple Schmitt Trigger algorithm (hysteresis) to find crossing points, rather than simple thresholding, to avoid noise triggering false measurements.

### Use Cases
1.  **PWM Duty Cycle Analysis:** A user places two vertical cursors on the rising edges of a PWM signal. The UI calculates $\Delta X$ (Period) and $1/\Delta X$ (Frequency), allowing the user to confirm if the motor controller is outputting the correct 20kHz signal.
2.  **Audio Latency Measurement:** A user loads a trace containing a "Stimulus" spike and a "Response" spike. By placing Cursor A on the stimulus and Cursor B on the response, they measure the system lag (e.g., $150ms$) to validate Bluetooth synchronization.
3.  **Sensor Offset Drift:** A pressure sensor reads $0.05V$ at rest instead of $0V$. The user places a horizontal cursor at $Y=0$ and another at the signal baseline. The $\Delta Y$ readout provides the exact calibration offset needed for the firmware.
4.  **Ripple Voltage (Peak-to-Peak):** In a power supply unit (PSU) test, the signal is a DC rail with AC noise. The user places horizontal Cursor A on the noise trough and Cursor B on the peak to measure $V_{p-p}$ (Ripple), ensuring it is within the 50mV spec.
5.  **Step Response (Overshoot):** A control system tries to reach a setpoint. The user places a Y-cursor at the Target Value and another Y-cursor at the maximum peak of the overshoot. The system calculates the percentage overshoot automatically.

---

## 2. Pipeline Consistency: The "Null" Filter
**Status:** Done  
**Priority:** Critical (Prerequisite for Math)  
**Complexity:** Low

### Description
Currently, the "Filtered Data" array only exists if a filter is active. This creates an issue for the Math Engine, which expects an input. We must introduce an "Identity" or "Pass-Through" node in the pipeline.

### Architectural & Technical Strategy
*   **Pipeline Normalization:** The app structure should change from `Raw -> (Optional Filter) -> Output` to `Raw -> Pipeline -> Output`.
*   **Default State:** If no user filters are selected, the Pipeline contains exactly one node: the `NullFilter`. Its `process(data)` method simply returns `data`.
*   **Immutability:** Ensure the Null Filter passes a *copy* of the data, not a reference, to prevent subsequent math operations from mutating the original raw import.

### Use Cases
1.  **Math on Raw Data:** A user wants to calculate Power ($V \times I$) using raw, noisy data to see the "True" power input before any smoothing is applied. The Null filter exposes the raw data to the Math engine.
2.  **Filter Efficacy Comparison:** A user creates a Math trace: `Abs(Raw_Input - Filtered_Output)`. This visualizes exactly *what* the filter removed. This requires "Raw" to be treated as a pipeline object.
3.  **Logic Triggering:** A user wants to define a "Trigger" based on the raw spikes (which might be clipped by a filter), but view the smoothed data.
4.  **Exporting Baseline Data:** The user wants to export a CSV that strictly adheres to the "Processed" format, even if they haven't applied filters yet. The Null filter ensures the export function always finds a valid `outputArray`.
5.  **A/B Testing:** A user loads a dataset and applies a filter. They then toggle the filter "Off." Instead of the UI breaking or the trace disappearing, the pipeline seamlessly swaps the "Low Pass" for the "Null," instantly showing the raw signal again.

---

## 3. Advanced Waveform Math Engine
**Status:** Done  
**Priority:** High  
**Complexity:** Very High

### Description
A scripting engine allowing users to create new traces based on algebraic combinations of existing traces. This moves the tool from a "Viewer" to a "Processor."

### Architectural & Technical Strategy
*   **Library:** Do not write a parser from scratch. Use **Math.js**. It handles order of operations, array broadcasting, and secure evaluation.
*   **Variable Mapping:** The UI needs a "Variable Manager." The user selects "Trace 1" and assigns it variable `V`. They select "Trace 2" and assign `I`. The formula is then simply `V / I`.
*   **Array Broadcasting:** The engine must handle operations between Arrays and Scalars (e.g., `Array + 5`) and element-wise Array operations (`ArrayA + ArrayB`).
*   **Sanity Checks:** If Array A has 1000 points and Array B has 900 points, the engine must either throw a warning, trim to the shortest length, or pad with zeros/NaN. Trimming to the shortest length is usually the safest architectural decision.

### Use Cases
1.  **Impedance Singularity ($Z = V/I$):** When current $I$ crosses zero, Impedance $Z$ goes to infinity. The user writes a robust formula: `V / (I + 0.001)` or uses a ternary operator `(abs(I) > 0.01) ? (V/I) : 0` to prevent graph explosions.
2.  **Action Integral ($I^2t$):** A fuse engineer needs the energy let-through. The formula `cumsum(I^2) * dt` creates a trace that rises and plateaus, representing total energy accumulated over time.
3.  **Sensor Fusion (Averaging):** A user has 4 noisy sensors ($S1..S4$). They create a "Master Trace" defined as `mean(S1, S2, S3, S4)` to statistically reduce the noise floor by factor $\sqrt{N}$.
4.  **Differential Signaling:** A user captures `D+` and `D-` from a USB line. They define a new trace `(D+) - (D-)` to view the actual differential signal the microcontroller sees.
5.  **Power Factor Correction:** The user computes Instantaneous Power `P = V * I`. They then integrate this over one 50Hz cycle and divide by time to find the Real Power (Watts), comparing it to Apparent Power ($V_{rms} \times I_{rms}$).
6.  **Inductive compoent analysis:** The user desires to find the inductive component of a voltage signal. They have both V and I as a finction of t and know the system inductance. Thus the inductive component can be found from V_ind = L * dI/dt. The user may then wish to subtract the inductive component from the overall waveform to reveal the voltage dropped across the resistive part of the load as a new trace.

---

## 4. Multi-Waveform Composer (Visuals)
**Status:** Done  
**Priority:** Medium  
**Complexity:** Medium

### Description
Allows composition of multiple datasets into a single view with independent time-shifting.

Note the app already allows multi waveform views well. This feature is to add time offset controls to that AND the normal tabs.

### Architectural & Technical Strategy
*   **The "Composer" Object:** A new state object that lists which traces are visible.
*   **X-Axis Offsets:** This should be a visual offset only. Do not mutate the underlying data array to shift time, as this destroys the original timestamp integrity. Apply the offset during the Plotly render step (`x: xArray.map(t => t + offset)`).
*   **Y-Axis Stacking:** Allow an optional "Waterfall" mode where traces are automatically offset by a fixed Y-amount to prevent overlapping.

### Use Cases
1.  **Propagation Delay:** A user overlays "Input Signal" and "Output Signal." They adjust the "Time Offset" slider on the Output trace until the rising edges align visually. The slider value (e.g., `-20ns`) represents the propagation delay.
2.  **3-Phase Balance:** A user plots Phase A, Phase B, and Phase C voltages on one graph to visually check if the amplitudes are equal and the phase shifts are exactly 120 degrees.
3.  **PID Tuning:** A user overlays the "Setpoint" (a step change) and the "Process Variable" (the temperature). They can visually inspect how fast the temperature reacts to the requested change.
4.  **Before & After Report:** The user wants to prove their filter works. They overlay the "Raw Noisy" trace (in grey) and the "Filtered Clean" trace (in red) with a slight vertical offset, creating a compelling image for a PDF report.
5.  **Logic Analyzer View:** The user has 5 digital signals. They assume they are unrelated. By stacking them in the Composer view, they notice that Signal A going High always causes Signal B to go Low 5ms later—a correlation they missed when viewing tabs separately.

---

## 5. UI & Data Grid Improvements
**Status:** Planned  
**Priority:** Medium  
**Complexity:** Medium

### Description
Improving how data enters the application and how users interact with controls.

### Architectural & Technical Strategy
*   **Virtual Scrolling:** Rendering a HTML Table for 100k points crashes the DOM. Use a "Virtual List" approach (like `react-window` or custom logic) to only render the 20 rows currently visible on screen.
*   **Clipboard API:** For pasting data, intercept the `window.onpaste` event. Do not rely on the user clicking a text area. Parse the clipboard text (CSV/TSV) directly into memory strings, then parse to arrays. This bypasses the UI lag entirely.
*   **Debounced Inputs:** For filter inputs (e.g., Cutoff Frequency), ensure the recalculation triggers 300ms *after* the user stops typing, rather than on every keystroke, to prevent UI freezing.

### Use Cases
1.  **Rapid Excel Paste:** A user copies a column of thermal data from Excel. They click anywhere in FilterPro and press `Ctrl+V`. The app detects the data, parses it, and immediately graphs it without asking for a filename.
2.  **Manual Outlier Correction:** A specific data point is clearly a sensor glitch (reading 9999). The user finds that row in the Grid View, manually edits it to the previous value, and the graph updates to remove the spike.
3.  **Matlab/Python Interop:** A user processes data in Python and prints the array to the console. They copy the console output and paste it into FilterPro for better interactive zooming than `matplotlib` offers.
4.  **Precise Parameter Entry:** A slider is too coarse to set a filter to exactly "50.0 Hz". The user types the value into the numeric input. The slider visually jumps to that position, and the filter updates.
5.  **Reference Curve Entry:** A user wants to compare their data against a limit line. They manually type 5 rows of X/Y data into the grid (e.g., a "Limit Mask") to create a polygon shape on the graph.

---

## 6. Graphing & Export Engine
**Status:** Planned  
**Priority:** Low  
**Complexity:** Low

### Description
Tools to make the visual output suitable for publication and engineering reports.

### Architectural & Technical Strategy
*   **View vs. Data Scaling:** Keep the internal data in SI units (Seconds, Volts). Apply scaling *only* at the label formatter level. If the user selects "Nanoseconds," the axis displays `t * 1e9` but the internal math engine still processes `t`.
*   **Canvas Sizing:** When exporting to PNG, allow the user to define the `width` and `height` in the Plotly `toImage` config. This decouples the saved image resolution from the user's current screen size.

### Use Cases
1.  **Paper Publication:** A PhD student needs a vector image (SVG) with no gridlines and a white background for a LaTeX paper. They configure the "Clean View" export settings to strip UI elements.
2.  **Nano-Scale Inspection:** A user works with 2.4GHz RF signals. Reading "0.0000000041" on the axis is painful. They enable "Nanosecond Mode" to read "4.1 ns" while keeping the underlying math correct.
3.  **Pass/Fail Limits:** A user manually sets the Y-axis range to [4.75, 5.25]. If the 5V rail signal disappears off the top or bottom of the graph, they instantly know the test failed without needing cursors.
4.  **Standardized Reporting:** A corporate team mandates that all graphs in weekly reports must be exactly 800x400 pixels. The custom export size ensures every team member generates identical-looking images.
5.  **Comparing disparate signals:** A user wants to plot "Temperature (0-100)" and "Voltage (0-5)" on the same chart. They use the "Secondary Y-Axis" feature (Right side axis) to scale the voltage so both curves are visible and detailed.