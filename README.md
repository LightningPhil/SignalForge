# Signal Forge

Signal Forge is a high-performance, client-side application for visualizing, filtering, and analyzing time-series data. Designed specifically for engineers and scientists working with oscilloscope captures, sensor logs, and noisy datasets.

**Current Version:** 6.0

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Stack](https://img.shields.io/badge/tech-TypeScript%20%7C%20Vite%20%7C%20Tailwind%20%7C%20Plotly-green)

---

## 🌟 Key Features

### 1. Data Ingestion & Visualization

- **Oscilloscope CSV Friendly:** Header-row selection skips metadata commonly
  found in vendor CSV/text exports. Native vendor binary formats are separate,
  fixture-gated adapters.
- **Performance:** Handles large datasets (>100k points) using **LTTB (Largest-Triangle-Three-Buckets)** downsampling for rendering, while processing the full resolution data in the background.
- **Frequency Domain:** Windowed FFT with detrend, zero-padding, peaks, and spectral metrics (THD, SNR, bandpower).
- **Spectrogram:** STFT heatmap for time-varying spectra.
- **Measurements & Events:** Zoom-linked stats plus level/edge/pulse/runt triggers with plot markers.
- **Cross-Channel:** Delay estimation, FRF/coherence, and apply-alignment to a trace offset.
- **Comparison:** Toggle between Raw, Filtered, and Differential (dy/dx) views instantly. Live opacity sliders allow for precise visual comparison.
- **Hover & Zoom:** Inspect samples with Plotly hover readouts, box-zoom a region, and overlay raw vs filtered traces for comparison.
- **Multi-View Tabs:** Create side-by-side composite tabs so multiple traces (raw, filtered, or math) stay visible together for overlays or channel comparisons.

### 2. The Filter Pipeline

Unlike simple tools that apply one filter at a time, this application uses a **Sequential Pipeline**. Data flows through a user-defined chain of filters.

- **Reorderable:** Move steps up/down to change the processing order (e.g., _Despeckle_ → _Smoothing_ → _Notch Filter_).
- **Live Tuning:** Relevant window, smoothing, frequency, order, bandwidth,
  phase-mode and threshold controls update the result immediately.
- **Time & Frequency Domain:** Mix validated time-domain, designed-IIR and
  smooth FFT-domain operations in one pipeline.
- **Per-Column vs Global Pipelines:** Choose whether the same pipeline applies to every trace or maintain unique pipelines per column when channels need different conditioning.

### 3. The Math Engine (Virtual Traces)

Create new dynamic data columns based on math operations.

- **Safe pointwise arithmetic:** Use `pointwiseMultiply(V, I)` and
  `guardedDivide(V, I, minimum)`; bare waveform `*` and `/` are rejected as
  matrix operations.
- **Time Alignment:** Apply sample-based time offsets to correct for probe skew or cable length delays.
- **Calculus:** Apply Differentiation ($dy/dx$) or Integration ($\int y dx$) to the result.
- **Non-Destructive:** Math traces are calculated on the fly. Filter the source waveform first; math tabs do not have their own pipeline.
- **Expression Library:** Physical calculations lead with `derivative(V, t)`,
  `charge(I, t)`, `energy(V, I, t)`, `meanTraces(...)`, and guarded pointwise
  helpers. `diff()` and `cumsum()` remain sample-index utilities rather than
  substitutes for actual-time calculus.

### 4. Workspace & Appearance

- **Theme Toggle:** Switch between light and dark modes from the toolbar.
- **Display Calibration:** Calibrate pixels-per-centimeter with an on-screen ruler so exported images match a chosen physical size.
- **Graph Layout:** Use the graph settings modal to change axes, grid visibility, and legends without touching code.

### 5. Data Entry & Management

- **Grid Editing:** Open the grid view to inspect tabular data, paste datasets directly from spreadsheets, and edit cells inline.
- **Clipboard Flexibility:** Pasting respects existing headers when they match, or prompts to replace datasets when they differ.
- **Settings Persistence:** Save pipelines, math traces, theme, and display
  calibration as localStorage settings or JSON. Waveforms, shots, markers and
  results are persisted separately as IndexedDB sessions and `.signalforge`
  archives.

---

## 🚀 Quick Start

### Prerequisites

Node.js 24 LTS.

```bash
npm install
npm run dev
```

Then open the local URL printed by Vite (typically `http://localhost:5173`).

| Script              | Purpose                                                 |
| :------------------ | :------------------------------------------------------ |
| `npm run dev`       | Start the Vite development server                       |
| `npm run typecheck` | Run strict TypeScript checks                            |
| `npm run test:run`  | Run deterministic numerical and data-integrity tests    |
| `npm run test:e2e`  | Run Chromium workflow tests                             |
| `npm run check`     | Run types, lint, formatting and unit-test quality gates |
| `npm run build`     | Type-check and produce a production build in `dist/`    |
| `npm run preview`   | Preview the production build locally                    |

Development is integrated on `dev`. Only stable, fully checked work is merged
to `master`, which is the GitHub Pages production branch. See
[`ProjectPlan.md`](ProjectPlan.md) for the ordered scientific-correctness gates.
Versioned wiki source starts at [`wiki/Home.md`](wiki/Home.md).

---

## 📚 User Guide

### 1. The Interface

- **Header:** Load one file, Multi Import, Sessions, Grid, Graph, Export, Help,
  and theme controls.
- **Sidebar (Left):** Filter, Measure, Spectral, and Events panels, plus
  per-column/global pipeline synchronization and math/jitter controls. On
  smaller screens, open it with the menu button in the header.
- **Main Area (Center):** The interactive Plotly graph.
- **Tabs (Top of Graph):** Switches the _Active Column_. The pipeline applies to whichever column is selected here. Cyan tabs represent Virtual Math traces.
- **Toolbar (Above Plot):** Live controls for Raw, Differential, Residual, View
  (Time / FFT / Spectrogram), and Events.

### 2. Sessions and multi-file import

- **Single file:** Load a CSV/TSV/text capture and select its header row.
- **Multi-file with metadata:** Use a profile such as
  `shot {shot:int} - {charge_voltage:quantity[V]} - {length:quantity[mm]} - {channel:text}.csv`.
  A matching example is `shot 7 - 25kV - 200mm - Voltage.csv`.
- **Any filename:** Turn off filename-convention extraction. Every supported file
  is accepted regardless of its name and becomes a separate shot.
- **Review:** Open Sessions to navigate shots, place or accept authoritative
  markers, add notes, include/exclude shots, compare event-aligned traces, and
  run unit-aware pulse-power calculations.
- Sessions persist in IndexedDB and can be transferred as checksum-verified
  `.signalforge` archives.

### 3. Filter types

#### Time Domain Filters

| Filter              | Description                                                              | Best use                                                           |
| :------------------ | :----------------------------------------------------------------------- | :----------------------------------------------------------------- |
| **Savitzky–Golay**  | Stable QR least-squares polynomial smoothing with reflected boundaries.  | Preserve peak shape and low-order trends.                          |
| **Moving Average**  | Normalized, zero-phase box smoothing with O(n) rolling evaluation.       | Simple white-noise reduction where peak flattening is acceptable.  |
| **Median**          | Bounded odd-window median.                                               | Remove impulsive spikes without averaging across an edge.          |
| **Gaussian**        | Normalized symmetric Gaussian convolution.                               | Smooth broadband noise with a controlled kernel width.             |
| **Hampel**          | Median/MAD outlier replacement, including zero-MAD plateaus.             | Remove isolated glitches with explicit changed-sample reporting.   |
| **Wavelet Denoise** | Multilevel Haar soft-thresholding with per-level robust noise estimates. | Reduce nonstationary broadband noise while retaining transients.   |
| **Start/Stop Norm** | Explicit baseline subtraction and independent sine tapers.               | Prepare deliberately selected boundaries; never applied on import. |

#### Designed FIR filters

- **Kaiser low/high/band-pass/band-stop:** odd-tap Type-I linear-phase designs
  derived from passband edge/width, transition width, maximum passband ripple
  and minimum stopband attenuation.
- Tap count and Kaiser beta are derived—not hand-tuned—and every realized
  response is numerically checked against the requested ripple and attenuation.
  Designs above the 16,385-tap limit or 512 MiB estimated convolution working
  set fail explicitly.
- **Causal** mode reports the physical `(taps − 1) / 2` sample delay and assumes
  `taps − 1` samples of constant prehistory equal to the run's first value.
  It requires a timebase uniform to the FIR-specific `1e-9` relative interval
  tolerance.
- **Centered zero-phase** mode applies the symmetric kernel once with reflected
  boundaries, so it does not square the magnitude response. Non-uniform input
  is explicitly resampled offline; because that complete operation is
  time-varying, its uniform-kernel response overlay is hidden.
- The pipeline report records derived taps, beta, achieved specifications and
  boundary warnings. The FFT view plots FIR magnitude, phase and group delay.

#### IIR filters

- **One-pole low pass:** causal exponential smoothing through a
  sample-rate-dependent alpha; it is not a cutoff in hertz.
- **Butterworth low/high/band pass:** cascaded, normalized second-order sections
  with selectable causal or forward/backward zero-phase processing.
- **Notch and comb notch:** frequency-calibrated biquad sections for narrow
  interference and harmonics. Configurations whose sections overlap enough to
  miss either requested −3 dB edge are rejected instead of silently changing
  bandwidth.
- The FFT view reports designed IIR magnitude, phase, and group delay.

#### Frequency Domain (FFT) Filters

These resample non-uniform records to a uniform grid, reflect-pad finite runs,
apply a smooth zero-phase spectral response, and interpolate back.

- **Inputs:** Supports unit selection (Hz, kHz, MHz, GHz).
- **Low Pass / High Pass:** Butterworth-magnitude masks with selectable
  asymptotic slope in dB/octave.
- **Notch:** A stop band with raised-cosine transition shoulders to reduce
  ringing. Its bandwidth must be at least the finite record resolution
  (`sample rate / run length`); unresolvable requests fail explicitly. Prefer
  the IIR notch when causal behavior or a compact narrowband section is
  required.
- Non-finite gaps split every filter into independent finite runs so a missing
  sample cannot poison the remainder of a record.
- Frequency filters split at non-finite, duplicate, or decreasing timestamps;
  each skipped/split segment is reported.

### 4. Using the Math Engine

1.  Click the **➕** button next to the column tabs and choose **Math Trace**.
2.  **Assign variables:** Map each source trace to a short symbol (e.g., `V`, `I`, `D+`). Raw and math traces can be mixed.
3.  **Expression:** Prefer the safe waveform helpers. Bare `*` and `/` between waveform variables are math.js matrix operations and are rejected.
    - Derivatives: `derivative(V, t)` uses the real timebase.
    - Integrals: `charge(I, t)` and `energy(V, I, t)` use actual-time trapezoidal integration.
    - Pointwise operations: `pointwiseMultiply(V, I)` and `guardedDivide(V, I, minimum)`.
    - Magnitudes: `abs(V)` to rectify signed data, or `sqrt(Vx.^2 + Vy.^2)` for vector magnitude.
    - Combo traces: `(V - REF) / 10` for calibration, `meanTraces(V1, V2, V3)` for ensemble averages.
    - Thresholding & logic: `V > 0.5` creates a boolean mask; combine with `mean(V > 0.5) * 100` for duty cycle (% high time).
    - Alignment: `(shift(V, 3) - V) / dt` to compare a trace against a time-shifted copy (see _Tips_).
4.  **Name:** Give the output trace a label.
5.  Click **Create Trace**. The virtual trace appears as a new tab.

**Tips:**

- `shift(trace, samples)` and `delay(trace, seconds)` help align probes before differencing.
- `clip(x, min, max)` hard-limits excursions; use `abs(x)` to enforce magnitude-only math before FFT.
- Use `t` and `dt` to keep units consistent when mixing derivatives and integrals.

### 5. Exporting

- **CSV:** Downloads the processed data.
  - _Filtered Only:_ Time + Active Column (Filtered).
  - _Original + Filtered:_ Distinct immutable-original, repaired-working,
    original-quality, working-quality, filtered, and math columns.
- **Analysis:** Measurements (JSON/CSV), events CSV, spectral JSON, system/FRF JSON, or a full HTML report with a plot snapshot.
- **Images:** Save the current graph view as SVG (Vector) or PNG.
- **Settings:** Save your pipeline configuration to a JSON file to reload later.
- **Workspace settings:** Browser-memory save/load persists pipelines, math
  traces, view ranges, theme, and calibration only. It does not contain
  waveform sessions, shots, markers, notes, or analysis results.

### 6. Grid View & Clipboard Workflows

- Open the **Grid** control to edit underlying data when quick fixes are faster than re-exporting CSVs.
- Paste from spreadsheet tools (Excel, Sheets, LibreOffice); the app auto-detects comma vs. tab delimiters.
- Keep existing headers to append rows, or replace the dataset when headers differ—Signal Forge will prompt before overwriting.
- After edits or paste operations, pipelines and math traces recompute automatically so plots stay in sync.

### 7. Data quality and repairs

- Import classifies missing, invalid, clipped, saturated and non-monotonic
  samples without silently replacing them.
- Grid interpolation and forward fill are explicit repair actions with undo and
  redo.
- Processed quality flags propagate through each filter’s contamination
  footprint.
- Full CSV exports keep immutable original, repaired working, original quality,
  working quality, filtered quality and filtered values distinct.

### 8. Supported formats and limits

- **Verified native import:** Tektronix little-endian WFM#003 analogue
  (including FastFrame), Keysight/Agilent AG10 analogue BIN, R&S RTx paired
  waveform exports, LeCroy LECROY_1_0/2_3 little-endian TRC, and the supplied
  Rigol DS1000B/C/D-E/Z, DS2000, DS4000, MSO5000 and DHO800 WFM/BIN families.
- **Layout-tested beta:** Tektronix ISF, Keysight AG01/AG03, R&S int16,
  big-endian LeCroy TRC, and PicoScope two-row analogue CSV.
- Detection is content-first. Shared `.bin` and `.wfm` extensions never choose
  a brand parser by filename alone. R&S exports require both the description
  `.bin` and matching `.Wfm.bin` payload.
- PicoScope PSDATA is detected with conversion guidance because it is
  proprietary. PicoScope HDF5 is detected but not decoded until a bounded
  browser reader and representative real export are available. Siglent and
  unproved Tek/Rigol variants remain provisional.
- Direct **Load** opens supported single files; **Multi Import** handles R&S
  pairs, multi-channel files, filename grouping and one shot per FastFrame
  record.
- Multi-import preview is limited to 10,000 files and 64 MB aggregate source
  bytes; cumulative source/session arrays must also remain within the 192 MB
  persistence budget.
- Native files are limited to 64 MB each, four analogue channels, 3 million
  samples per channel, 3 million total channel-samples and a 192 MB predicted
  decode working set.
- Pipeline processing moves to a cancellable Web Worker at 100,000 samples.
- Display downsampling defaults to 20,000 shared-index points when enabled, and
  the data grid virtualizes records above 1,000 rows.
- Mixed-rate records shorter than 64 source samples fail safely instead of
  producing an unreliable anti-aliased result.
- SNR excludes deterministic harmonic bins; it is reported as unavailable when
  no measurable non-harmonic noise remains.

### 9. Offline use and deployment

The production service worker caches same-origin SignalForge resources for
offline reuse. Development builds do not register it.

The current public site remains on the `master:/docs` fallback until this
development branch is merged and GitHub Pages is switched to **GitHub
Actions**. The Actions workflow then deploys the tested `dist` artifact and
runs a post-deploy asset smoke test.

---

## 🛠 Technical Architecture

The project is a **Vite + TypeScript** client-side app. There is no backend.

### File Structure

```text
/
├── index.html            # Entry point / UI skeleton
├── src/
│   ├── main.ts           # Bootloader
│   ├── styles.css        # Tailwind theme + a small set of structural styles
│   ├── config.ts         # Default constants & colors
│   ├── state.ts          # Central state store
│   ├── types.ts          # Shared TypeScript types
│   ├── data/             # Quality masks and reversible data repairs
│   ├── domain/           # Session, shot, channel and annotation model
│   ├── app/              # Tabs, pipeline UI, modals, event wiring
│   ├── io/               # Import adapters, filename profiles and export
│   ├── persistence/      # IndexedDB and project archives
│   ├── processing/       # Filters, FFT, math, LTTB, sampling
│   ├── session/          # Session workspace orchestration
│   ├── units/            # SI unit normalization and dimensions
│   ├── workers/          # Cancellable background analysis
│   └── ui/               # Graph, theme, help, grid, shared classes
├── tests/                # Vitest numerical and integrity fixtures
└── e2e/                  # Playwright browser workflows
```

### Key Libraries

- **[Plotly.js](https://plotly.com/javascript/):** Scientific graphing, zooming, and image export.
- **[PapaParse](https://www.papaparse.com/):** High-speed CSV parsing.
- **[math.js](https://mathjs.org/):** Expression evaluation for math traces.
- **[Tailwind CSS](https://tailwindcss.com/):** Utility-first styling.

---

## 📄 License

**MIT License**

Copyright (c) 2025 Philip Leichauer

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
