# Advanced Cursor & Analysis Suite Implementation Guide

This guide outlines how to add oscilloscope-style cursors, snap-to-trace interaction, and automated analysis workflows to FilterPro while keeping rendering responsive and code modular. It expands the earlier outline with concrete wiring notes so an engineer can build the feature with minimal ambiguity.

## Core Principles
- **Overlay-only drawing:** Cursors and labels must be rendered as Plotly `shapes` and `annotations` that live above the traces. Never mutate trace data or draw cursors directly into the plotted series; this keeps zoom/pan behavior correct and prevents visual jitter.
- **Data-first interaction:** Always convert mouse pixels to data coordinates before updating cursor state. When snapping is enabled, resolve the X coordinate to the nearest data sample to avoid interpolated Y values.
- **Deterministic state:** Cursor positions, active cursor id, and snap toggle all live in `state.js` so the UI remains predictable when switching tabs or re-plotting.
- **Performance:** Binary search is mandatory for snap-to-trace on large datasets. `Plotly.relayout` with `shapes/annotations` is the only redraw path during drag.

## Step-by-Step Implementation

### 1) Extend Global State
- In `src/state.js`, add fields:
  ```javascript
  cursors: [], // { id, axis: 'x' | 'y', value, color }
  activeCursorId: null,
  isSnappingEnabled: true,
  currentTraceData: null // { x: [], y: [] } populated by graph rendering
  ```
- Provide helper methods to create, update, and remove cursors so UI modules do not mutate arrays directly (e.g., `addCursor({ axis })`, `updateCursor(id, value)`, `deleteCursor(id)`).
- Ensure `currentTraceData` is updated every time the graph draws so snap-to-trace always references the latest dataset.

### 2) Add Pure Analysis Utilities (`src/processing/analysis.js`)
- Implement a Schmitt-trigger edge detector that accepts arrays of Y values, matching X values, and optional thresholds. Return `{ index, x, type: 'rising' | 'falling' }` events. Auto-compute thresholds with 10%/90% of the signal range when none are passed.
- Implement `findNearestIndex(timeArray, targetX)` using binary search. Validate inputs (non-empty array, sorted X) and prefer returning the lower neighbor when equidistant to make snapping deterministic.
- Add helpers for measurements (ΔX/ΔY, slope, duty cycle, peak-to-peak, overshoot percentage) that consume cursor definitions and data arrays and return plain objects so the UI can format units separately.
- Keep this module dependency-free for easy testing and future reuse by automated metrics.

### 3) Build the Cursor Manager (`src/ui/cursorManager.js`)
- **Initialization:** Export `initCursorInteractions(graphDiv)` to register `mousedown`, `mousemove`, and `mouseup` handlers on the Plotly container and document.
- **Coordinate conversion:** Use `graphDiv._fullLayout.xaxis.p2c()` and `yaxis.p2c()` to translate pixel positions to data coordinates. Guard against null layout during initial load. If `_fullLayout` is unavailable, fall back to manual math using `range` and the bounding client rect.
- **Hit testing:** When `mousedown` occurs, check for nearby cursor lines using a tolerance based on the current axis range (e.g., 1% of span) and set `activeCursorId`. Include Y-axis cursors by comparing proximity along the Y dimension as well.
- **Dragging:**
  - Convert mouse position to data X/Y depending on cursor axis.
  - If snapping is enabled, call `findNearestIndex` with `state.currentTraceData.x` to align the X cursor to a real sample and read Y from the matched index; store the derived Y in a transient field for readouts.
  - Update state via helper methods, then call `renderCursors()` and `updateReadouts()`.
- **Rendering:**
  - Build a `shapes` array for Plotly with lines anchored to data coordinates and `yref: 'paper'` (for X cursors) or `xref: 'paper'` (for Y cursors) so they span the plot. Set `layer: 'above'` to keep lines above grid lines.
  - Build `annotations` for per-cursor labels (e.g., "X1: 5.00 ms") positioned near the axes to avoid covering the waveform.
  - Call `Plotly.relayout(graphId, { shapes, annotations })` to avoid replotting traces.
- **Lifecycle:** Re-enable default Plotly drag/zoom on `mouseup`. If a drag begins, temporarily set `dragmode: false` to keep interactions deterministic.

### 4) Wire into Existing Graph Rendering (`src/ui/graph.js`)
- After traces render, update `state.currentTraceData = { x: rawX, y: displayY }` to expose data for snapping.
- Attach to Plotly events (`plotly_relayout`, `plotly_restyle`, `plotly_doubleclick`) to trigger `cursorManager.renderCursors()` so shapes stay aligned after zoom/pan/reset.
- When tabs or multi-view selections change, reinitialize cursors as needed (either keep existing or reset based on product decision) and ensure the analysis HUD updates to reflect the active dataset.

### 5) UI Controls and Readouts
- In `index.html`, add an "Analysis" or "Cursor HUD" section near the graph with buttons:
  - `Add X Cursor`, `Add Y Cursor`, `Delete Active`, `Snap to Trace` toggle, and a "Measure" button to launch automated metrics.
- In `cursorManager.js`, implement `updateReadouts()` to:
  - List cursor positions with units and labels matching their creation order (X1, X2, Y1, Y2...).
  - When two X cursors exist, compute ΔX and frequency; when two Y cursors exist, compute ΔY; when one X and one Y cursor exist, compute slope using matched Y samples via nearest-neighbor.
  - Surface per-use-case numbers:
    - **PWM Duty Cycle:** ΔX and 1/ΔX between two rising-edge X cursors.
    - **Latency:** ΔX between stimulus and response X cursors.
    - **Offset Drift:** ΔY between Y=0 and baseline cursors.
    - **Ripple Vpp:** ΔY between trough and peak Y cursors.
    - **Overshoot:** Percent overshoot using target Y cursor and peak Y cursor.
- Keep DOM queries centralized in `src/app/domElements.js` to match existing patterns and ease testing.

### 6) Automated Measurements
- Add a modal or dropdown for automated metrics (Rise Time, Period, Overshoot):
  - **Rise Time:** Use `findEdges` to locate rising transitions, then find 10%/90% indices and place cursors automatically. Show the measured rise time and the indices used in the HUD so users can verify placement.
  - **Period/Frequency:** Find consecutive rising edges and drop X cursors at those indices; compute ΔX and 1/ΔX. If multiple periods are found, consider averaging or letting the user select which cycle to measure.
  - **Overshoot:** Identify peak after a setpoint crossing; place a Y cursor at the setpoint and another at the peak, then compute percent overshoot.
- Expose these actions via buttons in the analysis panel, updating cursors and readouts for visual confirmation. Automated cursor placement should still respect the `state.cursors` schema for consistency.

### 7) Performance Safeguards
- Avoid per-mouse-move scans over entire arrays; rely on binary search and cached state data.
- Only relayout shapes/annotations instead of calling `Plotly.react` to keep drag latency low.
- Debounce expensive calculations (e.g., automated metrics) and avoid running them during cursor drag.
- Guard against empty datasets or missing `currentTraceData` before enabling snapping to prevent runtime errors.

### 8) Testing Checklist
- Verify snapping aligns with actual data points at various zoom levels.
- Confirm cursors scale correctly when zooming/panning and remain interactive after layout changes.
- Exercise automated metrics with noisy signals to ensure Schmitt-trigger thresholds prevent false triggers.
- Test multi-view scenarios to ensure cursor state isolates per view if required.
- Validate that HUD readouts match expected values for the five core use cases (PWM duty, latency, offset drift, ripple Vpp, overshoot) using synthetic fixtures in tests or demo traces.

Following these steps will add a robust analysis overlay that stays performant and aligns with FilterPro's modular structure.
