# Signal Forge

Signal Forge is a high-performance, client-side application for visualizing, filtering, and analyzing time-series data. Designed specifically for engineers and scientists working with oscilloscope captures, sensor logs, and noisy datasets.

**Current Version:** 6.0

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Stack](https://img.shields.io/badge/tech-TypeScript%20%7C%20Vite%20%7C%20Tailwind%20%7C%20Plotly-green)

---

## 🌟 Key Features

### 1. Data Ingestion & Visualization
*   **Oscilloscope Friendly:** "Smart Parsing" allows you to skip metadata headers common in scope exports (Tektronix, Keysight, Siglent, etc.).
*   **Performance:** Handles large datasets (>100k points) using **LTTB (Largest-Triangle-Three-Buckets)** downsampling for rendering, while processing the full resolution data in the background.
*   **Frequency Domain:** Windowed FFT with detrend, zero-padding, peaks, and spectral metrics (THD, SNR, bandpower).
*   **Spectrogram:** STFT heatmap for time-varying spectra.
*   **Measurements & Events:** Zoom-linked stats plus level/edge/pulse/runt triggers with plot markers.
*   **Cross-Channel:** Delay estimation, FRF/coherence, and apply-alignment to a trace offset.
*   **Comparison:** Toggle between Raw, Filtered, and Differential (dy/dx) views instantly. Live opacity sliders allow for precise visual comparison.
*   **Hover & Zoom:** Inspect samples with Plotly hover readouts, box-zoom a region, and overlay raw vs filtered traces for comparison.
*   **Multi-View Tabs:** Create side-by-side composite tabs so multiple traces (raw, filtered, or math) stay visible together for overlays or channel comparisons.

### 2. The Filter Pipeline
Unlike simple tools that apply one filter at a time, this application uses a **Sequential Pipeline**. Data flows through a user-defined chain of filters.
*   **Reorderable:** Move steps up/down to change the processing order (e.g., *Despeckle* → *Smoothing* → *Notch Filter*).
*   **Live Tuning:** All parameters (Window Size, Alpha, Q-Factor, etc.) have sliders for fluid, real-time visual feedback.
*   **Time & Frequency Domain:** Mix time-domain smoothing with frequency-domain hard cuts in the same pipeline.
*   **Per-Column vs Global Pipelines:** Choose whether the same pipeline applies to every trace or maintain unique pipelines per column when channels need different conditioning.

### 3. The Math Engine (Virtual Traces)
Create new dynamic data columns based on math operations.
*   **Arithmetic:** Add, Subtract, Multiply, Divide (e.g., `Voltage / Current = Impedance`).
*   **Time Alignment:** Apply sample-based time offsets to correct for probe skew or cable length delays.
*   **Calculus:** Apply Differentiation ($dy/dx$) or Integration ($\int y dx$) to the result.
*   **Non-Destructive:** Math traces are calculated on the fly. Filter the source waveform first; math tabs do not have their own pipeline.
*   **Expression Library:** Use helpers like `diff(x)`, `cumsum(x)`, `mean(...)`, `abs(...)`, boolean comparisons, and `t`/`dt` for time-aware math. Combine raw and virtual traces freely.

### 4. Workspace & Appearance
*   **Theme Toggle:** Switch between light and dark modes from the toolbar.
*   **Display Calibration:** Calibrate pixels-per-centimeter with an on-screen ruler so exported images match a chosen physical size.
*   **Graph Layout:** Use the graph settings modal to change axes, grid visibility, and legends without touching code.

### 5. Data Entry & Management
*   **Grid Editing:** Open the grid view to inspect tabular data, paste datasets directly from spreadsheets, and edit cells inline.
*   **Clipboard Flexibility:** Pasting respects existing headers when they match, or prompts to replace datasets when they differ.
*   **Settings Persistence:** Save pipelines, math traces, theme, and display calibration to browser storage or export/import JSON for team sharing.

---

## 🚀 Quick Start

### Prerequisites
Node.js 20 or later.

```bash
npm install
npm run dev
```

Then open the local URL printed by Vite (typically `http://localhost:5173`).

| Script | Purpose |
| :--- | :--- |
| `npm run dev` | Start the Vite development server |
| `npm run build` | Type-check and produce a production build in `dist/` |
| `npm run preview` | Preview the production build locally |

---

## 📚 User Guide

### 1. The Interface
*   **Sidebar (Left):** Filter, Measure, Spectral, and Events panels, plus math/jitter controls. On smaller screens, open it with the menu button in the header.
*   **Main Area (Center):** The interactive Plotly graph.
*   **Tabs (Top of Graph):** Switches the *Active Column*. The pipeline applies to whichever column is selected here. Cyan tabs represent Virtual Math traces.
*   **Toolbar (Above Plot):** Live controls for Raw overlay, Differential, View (Time / FFT / Spectrogram), and Events.

### 2. Filter Types

#### Time Domain Filters
| Filter | Description | Best Use Case |
| :--- | :--- | :--- |
| **Savitzky-Golay** | Fits a polynomial to a moving window. | **General Purpose.** Preserves peak heights and signal width better than Moving Average. Supports iterations (1-16 passes). |
| **Moving Average** | Calculates the arithmetic mean of the window. | Reducing white noise / static. Note: May flatten sharp peaks. |
| **Median** | Replaces point with median of window. | **Despeckling.** Removes "shot noise" (single wild outliers) without blurring edges. |
| **IIR Low Pass** | Infinite Impulse Response (Single Pole). | Simulating an analog RC circuit. Controlled by `Alpha` (0.0 - 1.0). |
| **Gaussian** | Convolves data with a Gaussian kernel. | Very smooth, natural decay results. |
| **Start-Stop Norm** | Fades signal to 0 at edges. | Fixing boundary artifacts before performing FFT or Math operations. |

#### Frequency Domain (FFT) Filters
These convert the signal to the frequency domain, apply a mask, and convert back.
*   **Inputs:** Supports unit selection (Hz, kHz, MHz, GHz).
*   **Low Pass / High Pass:** Standard cutoff filters. You can adjust **Slope** (dB/Octave) and **Q-Factor** (Resonance).
*   **Notch:** Removes a specific frequency band (defined by Center Freq and Bandwidth). Ideal for removing 50Hz/60Hz mains hum.

### 3. Using the Math Engine
1.  Click the **➕** button next to the column tabs and choose **Math Trace**.
2.  **Assign variables:** Map each source trace to a short symbol (e.g., `V`, `I`, `D+`). Raw and math traces can be mixed.
3.  **Expression:** Enter any [math.js](https://mathjs.org/docs/expressions/parsing.html) expression. Helpers include `diff(x)` (derivative), `cumsum(x)` (discrete integral), `mean(...)`, absolute value `abs(...)`, and the time aliases `t` and `dt`.
    *   Derivatives: `diff(V)/dt` or `diff(V)./diff(t)` for slope per second.
    *   Integrals: `cumsum(I) * dt` to accumulate charge, or `cumsum(V .* I) * dt` for running energy.
    *   Magnitudes: `abs(V)` to rectify signed data, or `sqrt(Vx.^2 + Vy.^2)` for vector magnitude.
    *   Combo traces: `(V - REF) / 10` for calibration, `mean(V1, V2, V3)` for quick ensemble averages.
    *   Thresholding & logic: `V > 0.5` creates a boolean mask; combine with `mean(V > 0.5) * 100` for duty cycle (% high time).
    *   Alignment: `(shift(V, 3) - V) / dt` to compare a trace against a time-shifted copy (see *Tips*).
4.  **Name:** Give the output trace a label.
5.  Click **Create Trace**. The virtual trace appears as a new tab.

**Tips:**
* `shift(trace, samples)` and `delay(trace, seconds)` help align probes before differencing.
* `clip(x, min, max)` hard-limits excursions; use `abs(x)` to enforce magnitude-only math before FFT.
* Use `t` and `dt` to keep units consistent when mixing derivatives and integrals.

### 4. Exporting
*   **CSV:** Downloads the processed data.
    *   *Filtered Only:* Time + Active Column (Filtered).
    *   *Original + Filtered:* All raw columns + All numeric columns processed through the current pipeline.
*   **Analysis:** Measurements (JSON/CSV), events CSV, spectral JSON, system/FRF JSON, or a full HTML report with a plot snapshot.
*   **Images:** Save the current graph view as SVG (Vector) or PNG.
*   **Settings:** Save your pipeline configuration to a JSON file to reload later.
*   **Workspace Snapshots:** Use browser-memory save/load to persist pipelines, math traces, view ranges, theme, and calibration between sessions without downloading files.

### 5. Grid View & Clipboard Workflows
*   Open the **Grid** control to edit underlying data when quick fixes are faster than re-exporting CSVs.
*   Paste from spreadsheet tools (Excel, Sheets, LibreOffice); the app auto-detects comma vs. tab delimiters.
*   Keep existing headers to append rows, or replace the dataset when headers differ—Signal Forge will prompt before overwriting.
*   After edits or paste operations, pipelines and math traces recompute automatically so plots stay in sync.

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
│   ├── app/              # Tabs, pipeline UI, modals, event wiring
│   ├── io/               # CSV parsing, export, settings persistence
│   ├── processing/       # Filters, FFT, math, LTTB, sampling
│   └── ui/               # Graph, theme, help, grid, shared classes
```

### Key Libraries
*   **[Plotly.js](https://plotly.com/javascript/):** Scientific graphing, zooming, and image export.
*   **[PapaParse](https://www.papaparse.com/):** High-speed CSV parsing.
*   **[math.js](https://mathjs.org/):** Expression evaluation for math traces.
*   **[Tailwind CSS](https://tailwindcss.com/):** Utility-first styling.

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
