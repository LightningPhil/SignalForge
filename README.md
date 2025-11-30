Here is a comprehensive `README.md` file for your project. It covers installation, usage, internal architecture, and detailed explanations of the mathematical and filtering algorithms.

You can save this as `README.md` in the root of your project folder.

***

```markdown
# Web-Based Signal Analysis Workstation

A high-performance, client-side application for visualizing, filtering, and analyzing time-series data. Designed specifically for engineers and scientists working with oscilloscope captures, sensor logs, and noisy datasets.

**Current Version:** 6.0

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Stack](https://img.shields.io/badge/tech-Vanilla%20JS%20%7C%20Plotly%20%7C%20PapaParse-green)

---

## 🌟 Key Features

### 1. Data Ingestion & Visualization
*   **Oscilloscope Friendly:** "Smart Parsing" allows you to skip metadata headers common in scope exports (Tektronix, Keysight, Siglent, etc.).
*   **Performance:** Handles large datasets (>100k points) using **LTTB (Largest-Triangle-Three-Buckets)** downsampling for rendering, while processing the full resolution data in the background.
*   **Frequency Domain:** One-click FFT (Fast Fourier Transform) view to analyze spectral content with Bode-plot style visualization (Log-Log).
*   **Comparison:** Toggle between Raw, Filtered, and Differential (dy/dx) views instantly. Live opacity sliders allow for precise visual comparison.

### 2. The Filter Pipeline
Unlike simple tools that apply one filter at a time, this application uses a **Sequential Pipeline**. Data flows through a user-defined chain of filters.
*   **Reorderable:** Drag and drop or move steps up/down to change the processing order (e.g., *Despeckle* → *Smoothing* → *Notch Filter*).
*   **Live Tuning:** All parameters (Window Size, Alpha, Q-Factor, etc.) have sliders for fluid, real-time visual feedback.
*   **Time & Frequency Domain:** Mix time-domain smoothing with frequency-domain hard cuts in the same pipeline.

### 3. The Math Engine (Virtual Traces)
Create new dynamic data columns based on math operations.
*   **Arithmetic:** Add, Subtract, Multiply, Divide (e.g., `Voltage / Current = Impedance`).
*   **Time Alignment:** Apply sample-based time offsets to correct for probe skew or cable length delays.
*   **Calculus:** Apply Differentiation ($dy/dx$) or Integration ($\int y dx$) to the result.
*   **Non-Destructive:** Math traces are calculated on the fly. You can apply the Filter Pipeline to these virtual traces just like raw data.

---

## 🚀 Quick Start

### Prerequisites
Because this project uses modern ES6 Modules (`import/export`), **it cannot be run by simply double-clicking `index.html`** due to browser CORS security policies. You must serve it via a local web server.

### Option A: VS Code (Recommended)
1.  Install the **Live Server** extension.
2.  Right-click `index.html` and select **"Open with Live Server"**.

### Option B: Python
Open a terminal in the project folder and run:
```bash
# Python 3
python -m http.server 8000
```
Then open `http://localhost:8000` in your browser.

---

## 📚 User Guide

### 1. The Interface
*   **Sidebar (Left):** Contains the Filter Pipeline and Math configuration.
*   **Main Area (Center):** The interactive Plotly graph.
*   **Tabs (Top of Graph):** Switches the *Active Column*. The pipeline applies to whichever column is selected here. Blue tabs represent Virtual Math traces.
*   **Toolbar (Above Plot):** Live controls for toggling Raw Data, Differential Plot, Opacity, and Frequency Domain view.

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
1.  Click **"Configure Math..."** in the sidebar.
2.  **Name:** Give your new trace a name (e.g., "Power").
3.  **Operation:** Select columns (e.g., `Col A * Col B`).
4.  **Offset:** If `Col B` lags behind `Col A` (e.g., current probe delay), enter a positive sample offset to align them.
5.  **Post-Process:** Optionally differentiate or integrate the result immediately.
6.  Click **Create Trace**. A new Blue Tab will appear above the graph.

### 4. Exporting
*   **CSV:** Downloads the processed data.
    *   *Filtered Only:* Time + Active Column (Filtered).
    *   *Original + Filtered:* All raw columns + All numeric columns processed through the current pipeline.
*   **Images:** Save the current graph view as SVG (Vector) or JPG.
*   **Settings:** Save your pipeline configuration to a JSON file to reload later.

---

## 🛠 Technical Architecture

The project is built as a **Modular Monolith** using vanilla JavaScript.

### File Structure
```text
/
├── index.html            # Entry point / UI Skeleton
├── css/                  # Styling
│   ├── style.css         # Layout & Theming
│   └── components.css    # Modals & Widgets
└── src/                  # Application Logic
    ├── main.js           # Bootloader & Event Wiring
    ├── config.js         # Default constants & colors
    ├── state.js          # Central State Store (Singleton)
    ├── io/
    │   ├── csvParser.js  # PapaParse wrapper (Header detection)
    │   ├── exporter.js   # CSV/Image generation
    │   └── settingsManager.js # JSON/LocalStorage persistence
    ├── processing/
    │   ├── filter.js     # The Signal Processing Core
    │   ├── fft.js        # Custom Radix-2 FFT implementation
    │   ├── math.js       # Virtual Column arithmetic & Calculus
    │   └── lttb.js       # Downsampling algorithm for rendering
    └── ui/
        ├── graph.js      # Plotly wrapper & Rendering logic
        ├── graphConfig.js # Graph settings modal
        ├── gridView.js   # Data table view
        ├── helpSystem.js # Documentation modal
        └── uiHelpers.js  # DOM utilities
```

### Key Libraries
*   **[Plotly.js](https://plotly.com/javascript/):** Handles the scientific graphing, zooming, and SVG export.
*   **[PapaParse](https://www.papaparse.com/):** High-speed CSV parsing.

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
```