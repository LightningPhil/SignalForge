# Advanced Cursor & Analysis Suite Implementation Guide

This guide outlines how to add oscilloscope-style cursors, snap-to-trace interaction, and automated analysis workflows to FilterPro while keeping rendering responsive and code modular.

## Architectural Overview
- **Dedicated modules:**
  - `src/processing/analysis.js` for pure math utilities (edge detection, nearest-neighbor search, measurements).
  - `src/ui/cursorManager.js` for cursor state, mouse bindings, and Plotly shape rendering.
- **State-driven behavior:** Extend `src/state.js` with cursor state that persists across tab changes.
- **Plotly overlay layer:** Draw cursors with Plotly `shapes` and labels with `annotations`; avoid mutating trace data for visuals.

## Step-by-Step Implementation

### 1) Extend Global State
- In `src/state.js`, add fields:
  ```javascript
  cursors: [], // { id, axis: 'x' | 'y', value, color }
  activeCursorId: null,
  isSnappingEnabled: true,
  ```
- Provide helper methods to create, update, and remove cursors so UI modules do not mutate arrays directly.
- Store the last plotted dataset (e.g., `{ x: [], y: [] }`) in state when graphs render so snap-to-trace can access raw values.

### 2) Add Pure Analysis Utilities (`src/processing/analysis.js`)
- Implement a Schmitt-trigger edge detector that accepts arrays of Y values, matching X values, and optional thresholds. Return `{ index, x, type: 'rising' | 'falling' }` events.
- Implement `findNearestIndex(timeArray, targetX)` using binary search to support fast snapping on large datasets.
- Add helpers for measurements (delta X/Y, slope, duty cycle, peak-to-peak) that consume cursor definitions and data arrays.
- Keep this module dependency-free for easy testing.

### 3) Build the Cursor Manager (`src/ui/cursorManager.js`)
- **Initialization:** Export `initCursorInteractions(graphDiv)` to register `mousedown`, `mousemove`, and `mouseup` handlers on the Plotly container and document.
- **Coordinate conversion:** Use `graphDiv._fullLayout.xaxis.p2c()` and `yaxis.p2c()` to translate pixel positions to data coordinates. Guard against null layout during initial load.
- **Hit testing:** When `mousedown` occurs, check for nearby cursor lines using a tolerance based on the current axis range (e.g., 1% of span) and set `activeCursorId`.
- **Dragging:**
  - Convert mouse position to data X/Y depending on cursor axis.
  - If snapping is enabled, call `findNearestIndex` with `state.currentTraceData.x` to align the X cursor to a real sample and read Y from the matched index.
  - Update state via helper methods, then call `renderCursors()` and `updateReadouts()`.
- **Rendering:**
  - Build a `shapes` array for Plotly with lines anchored to data coordinates and `yref: 'paper'` (for X cursors) or `xref: 'paper'` (for Y cursors) so they span the plot.
  - Build `annotations` for per-cursor labels (e.g., "X1: 5.00 ms").
  - Call `Plotly.relayout(graphId, { shapes, annotations })` to avoid replotting traces.
- **Lifecycle:** Re-enable default Plotly drag/zoom on `mouseup`.

### 4) Wire into Existing Graph Rendering (`src/ui/graph.js`)
- After traces render, update `State.currentTraceData = { x: rawX, y: displayY }` to expose data for snapping.
- On range changes (zoom/pan), re-render cursor shapes to maintain correct placement.
- When tabs or multi-view selections change, reinitialize cursors as needed (either keep existing or reset based on product decision).

### 5) UI Controls and Readouts
- In `index.html`, add an "Analysis" or "Cursor HUD" section near the graph with buttons:
  - `Add X Cursor`, `Add Y Cursor`, `Delete Active`, `Snap to Trace` toggle.
- In `cursorManager.js`, implement `updateReadouts()` to:
  - List cursor positions with units.
  - When two X cursors exist, compute ΔX and frequency. When two Y cursors exist, compute ΔY.
  - Use nearest-neighbor to fetch Y values for any displayed X cursor.
- Keep DOM queries centralized in `src/app/domElements.js` to match existing patterns.

### 6) Automated Measurements
- Add a modal or dropdown for automated metrics (Rise Time, Period, Overshoot):
  - **Rise Time:** Use `findEdges` to locate rising transitions, then find 10%/90% indices and place cursors automatically.
  - **Period/Frequency:** Find consecutive rising edges and drop X cursors at those indices; compute ΔX and 1/ΔX.
  - **Overshoot:** Identify peak after a setpoint crossing; place a Y cursor at the setpoint and another at the peak, then compute percent overshoot.
- Expose these actions via buttons in the analysis panel, updating cursors and readouts for visual confirmation.

### 7) Performance Safeguards
- Avoid per-mouse-move scans over entire arrays; rely on binary search and cached state data.
- Only relayout shapes/annotations instead of calling `Plotly.react` to keep drag latency low.
- Debounce expensive calculations (e.g., automated metrics) and avoid running them during cursor drag.

### 8) Testing Checklist
- Verify snapping aligns with actual data points at various zoom levels.
- Confirm cursors scale correctly when zooming/panning and remain interactive after layout changes.
- Exercise automated metrics with noisy signals to ensure Schmitt-trigger thresholds prevent false triggers.
- Test multi-view scenarios to ensure cursor state isolates per view if required.

Following these steps will add a robust analysis overlay that stays performant and aligns with FilterPro's modular structure.
