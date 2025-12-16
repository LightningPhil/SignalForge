# ProjectPlan.md — Signal Forge Feature Expansion Plan (Non-Breaking)

This plan is written to **layer new capabilities on top of the existing pipeline + math + Plotly UI** without breaking current workflows, saved workspaces, or exports. Each phase groups related work and can be implemented independently by Codex.

## Guiding principles

- **No breaking changes to existing state/config JSON**: add new keys with defaults; keep existing keys stable.
- **Deterministic processing**: same input + same settings → identical results.
- **Separation of concerns**:
  - `processing/*` = pure functions (no DOM, no State writes)
  - `ui/*` = rendering and interactions
  - `app/*` = orchestration, wiring, persistence glue
- **Performance**: keep LTTB for display; use full-res for analysis; allow analysis-on-selection to avoid huge recomputes.

---

## Phase 1 — Architecture groundwork (safe extension points)

### 1.1 Add “Analysis” subsystem scaffolding
**Goal:** Create a stable home for measurements, triggering, spectral metrics, and derived analyses.

- Add folder: `src/analysis/`
  - `analysisEngine.js` (orchestrator, no DOM)
  - `measurements.js` (time-domain metrics)
  - `spectralMetrics.js` (THD/SNR/etc)
  - `eventDetector.js` (post-acq triggering / event extraction)
  - `timeFrequency.js` (spectrogram/STFT later)
- Add a small typed-ish internal schema (plain JS objects) for:
  - `TraceRef` (columnId, source: raw/filtered/math, viewKey, xOffset)
  - `Selection` (xMin/xMax, sample indices)
  - `Event` (index, time, type, metadata)

**Touchpoints**
- New files only + a single import from `src/app/dataPipeline.js` or `src/ui/graph.js` later.

### 1.2 Extend `State` with non-breaking defaults
Add optional keys (all default to “off”):
- `State.config.analysis = { enabled: true, selectionOnly: true, impedanceOhms: 50, fftWindow: 'hann', fftZeroPad: true, fftDetrend: 'none', … }`
- `State.ui.analysis = { selection: null, events: [], activeEventIndex: 0 }`

**Acceptance**
- Existing load/save/export of settings still works.
- App runs identically with analysis disabled.

### 1.3 Add a simple “selection model” (no UI yet)
- Standardize how the app represents a selected region:
  - from Plotly relayout events → store in `State.ui.analysis.selection`
  - provide helpers: `getSelectionIndices(x, tArray)`.

**Touchpoints**
- `src/ui/graph.js`: capture Plotly zoom/range events (already partially exists) and store selection.
- `src/app/eventSetup.js`: wire selection updates to re-run analysis (debounced).

---

## Phase 2 — Time-domain measurement engine (scope-style metrics)

### 2.1 Implement a measurement library (pure functions)
Add to `src/analysis/measurements.js`:
- Basic: min, max, mean, RMS, p2p, stddev, median
- Timing: zero-crossings, frequency/period (robust estimator), duty cycle (threshold-based)
- Edge metrics: rise/fall time (configurable low/high thresholds), overshoot/undershoot
- Area/energy helpers: integrate y·dt, integrate abs(y)·dt

Design:
- Input: `{ t: Float64Array|Array, y: Float64Array|Array, selection?: {i0,i1}, options }`
- Output: `{ key: value, units?, warnings? }`

### 2.2 Add “Measurement Panel” UI (read-only v1)
- New UI component (sidebar section or modal) showing:
  - selected trace + domain (time)
  - selection bounds
  - computed metrics
- Add “measurement set presets”:
  - General (mean/RMS/p2p/freq)
  - Power electronics (rise/fall/overshoot/duty)
  - Pulsed (area/energy, peak timing)

**Touchpoints**
- `src/app/domElements.js` add element refs
- `src/app/eventSetup.js` bind toggles + recompute on selection/trace change
- `src/ui/graph.js` ensure selection state is updated consistently

**Acceptance**
- Metrics update when:
  - active tab changes
  - pipeline changes
  - selection changes
- No effect on existing plotting/export unless user opens panel.

---

## Phase 3 — Post-acquisition triggering & event navigation

### 3.1 Implement event detector (post-acq triggers)
Add to `src/analysis/eventDetector.js`:
- Trigger types (initial set):
  - Level crossing (rising/falling/both) with hysteresis
  - Edge detection with slope threshold
  - Pulse width (min/max width above threshold)
  - Runt / glitch (crosses high threshold but not sustain)
- Multi-event extraction:
  - returns array of events with time/index and metadata (width, peak, etc.)
- Operate on:
  - raw / filtered / math trace (user selectable)
  - optional selection region only

### 3.2 Event list + markers + navigation
- Show event markers on the time plot (Plotly shapes or scatter markers).
- Add “Events” panel:
  - filter by type
  - count, density
  - click to jump/zoom to event
  - next/prev buttons

**Touchpoints**
- `src/ui/graph.js` add overlay traces/shapes for events
- `src/app/toolbar.js` add “Events” toggle + next/prev
- `src/io/settingsManager.js` persist trigger config in settings JSON

### 3.3 Trigger-on-derived signals (differentiator)
- Allow triggers to run on:
  - `dy/dx` (already computed for display)
  - filtered trace
  - math trace output
- Provide a trigger “source selector” in UI.

**Acceptance**
- Post-triggering never changes underlying data; it only creates an **index**.
- Can export events as CSV (Phase 7).

---

## Phase 4 — FFT correctness & spectral UX upgrades

### 4.1 Windowing + detrending + scaling
Upgrade FFT pipeline & view to include:
- Window functions: rectangular, hann, hamming, blackman, blackman-harris, flattop, kaiser(beta)
- Optional detrend:
  - none
  - remove mean
  - remove linear trend (least squares)
- Explicit zero-padding control:
  - off / nextPow2 / factor (2x,4x)
- Correct amplitude handling:
  - coherent gain correction per window
  - ENBW exposed for noise calculations
- Frequency axis correctness:
  - infer `fs` from `t` (median dt; warn if non-uniform)
  - show Δf and Nyquist

**Touchpoints**
- `src/processing/fft.js`:
  - keep current FFT core
  - add helpers: `applyWindow(y, windowType, opts)`, `computeFreqAxis(n, fs)`
  - add `getPhase(re,im)` and linear magnitude (not only dB)
- `src/ui/graph.js` FFT view:
  - add phase plot toggle (magnitude/phase/both)
  - keep existing “one-click FFT” behavior as default (hann + remove mean)

### 4.2 Spectral markers & harmonic helpers
- Marker readout: frequency + amplitude at cursor
- Peak finding:
  - local maxima with prominence threshold
  - list top N peaks
- Harmonic markers based on selected f0

### 4.3 Spectral metrics (v1)
Add to `src/analysis/spectralMetrics.js`:
- Bandpower between f1–f2
- THD (fundamental + harmonics)
- SNR / SINAD (basic implementation, documented assumptions)
- Spur identification (largest non-harmonic peak)

**Acceptance**
- Default FFT display remains similar to current (non-breaking).
- Advanced controls are opt-in via a small “FFT Settings” drawer/modal.

---

## Phase 5 — Time–frequency analysis (Spectrogram/STFT)

### 5.1 Implement STFT engine (selection-first)
Add `src/analysis/timeFrequency.js`:
- STFT with window + overlap
- magnitude in dB
- frequency limits
- performance guardrails:
  - downsample before STFT if > N points
  - compute only on selection by default

### 5.2 UI: Spectrogram view as a tab/mode
- Add toolbar toggle: Time / FFT / Spectrogram
- Plotly heatmap for spectrogram
- Hover readouts: time, freq, magnitude

**Touchpoints**
- `src/ui/graph.js` add render mode & heatmap layout
- `src/app/toolbar.js` add mode toggle & settings

**Acceptance**
- Spectrogram mode does not affect pipeline; it’s a view/analysis mode only.

---

## Phase 6 — Cross-channel & system analysis (Bode/transfer/coherence)

### 6.1 Cross-correlation / alignment helpers
Add to `src/analysis/analysisEngine.js` or new `crossChannel.js`:
- cross-correlation to estimate delay between two traces
- optional alignment suggestion: set `State.traceConfigs[col].xOffset`

### 6.2 Transfer function / Bode plot (offline FRF)
- Compute FRF H(f)=Y/X using FFTs (with windowing)
- Show:
  - magnitude (dB)
  - phase (deg)
  - coherence (optional, strongly recommended for trust)
- UX: select input trace + output trace from dropdowns

**Touchpoints**
- New “System” panel/modal
- `src/ui/graph.js` add Bode render mode (two stacked Plotly plots OR single plot with toggle; keep simple initially)

**Acceptance**
- Works on selection region.
- Never modifies data unless user explicitly clicks “apply suggested alignment”.

---

## Phase 7 — Export/reporting enhancements (events, measurements, reproducibility)

### 7.1 Export measurements & events
Extend `src/io/exporter.js`:
- Export:
  - Measurements (JSON + CSV)
  - Events (CSV with time/index/metadata)
  - Spectral metrics summary

### 7.2 “Analysis snapshot” in settings
Update `src/io/settingsManager.js`:
- Persist analysis config:
  - FFT settings
  - trigger settings
  - selected presets
- Include a version tag:
  - `settingsVersion: 2` etc. with migration that preserves old saves.

### 7.3 Report template (lightweight)
- Generate a simple HTML report (download) containing:
  - key plots exported as SVG/PNG
  - measurement tables
  - event stats
  - settings summary (for reproducibility)

**Acceptance**
- Old settings JSON still loads (migration fills defaults).
- Export options remain backward compatible.

---

## Phase 8 — UX polish, performance hardening, QA

### 8.1 Performance
- Debounce analysis recompute separately from pipeline recompute.
- Cache:
  - FFT results per (traceId, selection, window, padding)
  - measurement results per (traceId, selection)
- Optional: Web Worker for heavy analyses (STFT, large FFTs) without UI freeze.

### 8.2 Reliability & numeric correctness
- Handle non-uniform timebases:
  - detect dt variance
  - warn and/or resample (optional feature flag)
- Add unit-aware display:
  - impedance for dBm conversion
  - time units formatting (ns/µs/ms/s)

### 8.3 Tests (minimal but valuable)
Add `src/analysis/__tests__/` (or a simple runner script) for:
- FFT window coherent gain checks
- Rise/fall time on synthetic edges
- Trigger detection on synthetic pulses
- Correlation delay detection

### 8.4 Help/docs updates
Update `src/ui/helpSystem.js`:
- New sections: measurements, events, FFT settings, spectrogram, Bode/coherence
- Add “Known limitations” section (important for trust)

**Acceptance**
- No regressions in core workflows:
  - load CSV
  - pipeline edit
  - math trace
  - export processed CSV
  - multi-view tabs

---

## Implementation notes (to avoid breaking what’s already there)

- **Keep current FFT pipeline filters** (`lowPassFFT`, `highPassFFT`, `notchFFT`) working exactly as today.
  - New FFT settings should primarily affect *FFT view and analysis metrics* first.
  - If later applied to FFT-based filters, do it behind a per-step “advanced” toggle.
- **Do not change existing pipeline step schema**; only add optional parameters.
- **Do not change CSV import semantics**; add “resample to uniform dt” only as an optional analysis step.
- **UI additive**: new panels/modals/toggles default to hidden/off.

---

## Suggested Phase order for Codex execution

1) Phase 1 (scaffolding)  
2) Phase 2 (measurements)  
3) Phase 3 (post-acq triggers/events)  
4) Phase 4 (FFT correctness + spectral metrics)  
5) Phase 7 (exports + persistence)  
6) Phase 5 (spectrogram)  
7) Phase 6 (cross-channel/Bode)  
8) Phase 8 (perf + QA + docs)

