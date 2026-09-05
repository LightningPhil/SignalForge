# SignalForge Development SSOT

This document is the single source of truth for development after version 6.0.
The existing strict TypeScript, Vite, Tailwind and Plotly application remains the
foundation. There will be no framework rewrite.

## Branch and release policy

- `dev` is the integration branch.
- New work is developed and stabilised on `dev`.
- `master` remains the production branch.
- Pull or merge `dev` into `master` only when every mandatory gate for the
  included phase passes.
- CI runs on both `dev` and `master`; GitHub Pages deploys only from `master`.
- Generated bundles are deployment artifacts, not source-controlled product
  code, once the Actions deployment is enabled.
- Numerical algorithms and import adapters must never claim support without
  reproducible fixtures and tests.

## Product constraints

- Preserve original imported bytes and parsed sample values.
- A manual marker accepted by the user is authoritative. Automated markers are
  suggestions only.
- Every derived result records inputs, units, processing recipe, markers,
  warnings, deskew and application version.
- Full-resolution data is used for analysis. Display downsampling cannot alter
  measurements.
- Invalid values remain invalid until an explicit, reversible repair step is
  applied.
- Designed FIR filters must use explicit passband/stopband specifications,
  derived bounded tap counts, verified realized responses and auditable
  causal/centered boundary behavior.
- Model-specific oscilloscope importers are fixture-gated.

## `dev` implementation snapshot

The first integrated implementation now exists on `dev`:

- Quality scripts, Vitest, Playwright, ESLint, Prettier, CI and an Actions-based
  Pages deployment are present.
- Arbitrary-length FFT, padding-invariant amplitude, one-sided PSD,
  Welch-averaged FRF/coherence, robust timebase inspection, uniform resampling,
  fractional delay and IIR anti-aliased decimation are implemented with
  deterministic tests.
- Imported bytes/values, typed numeric columns, quality masks, explicit repairs,
  undo/redo and original-plus-quality export paths are implemented.
- Safe waveform math, unit primitives, pulse-power calculations, robust events,
  shared-index display downsampling and large-record tests are implemented.
- Session/shot/channel/annotation models, IndexedDB persistence, project
  archives, filename profiles, multi-file grouping, review markers, comparison
  views and batch analysis are implemented.
- Multi-file import supports both typed filename conventions (with a generated
  filename example) and convention-free one-shot-per-file imports.
- Kaiser FIR low/high/band-pass/band-stop, Butterworth IIR, notch/comb, Hampel,
  wavelet and residual display are exposed in the product. Baseline
  subtraction, gating, blanking and reference subtraction are tested library
  primitives that still require typed annotation/channel UI and provenance
  wiring.
- Every shipped filter family has deterministic normalization, response,
  boundary, gap-containment or denoising reference tests.
- Worker protocols, cancellation/progress, lazy feature chunks and an offline
  runtime cache are implemented.
- User and developer documentation is mirrored in the versioned `wiki/`
  source directory.

This is an integration baseline, not a claim that every native format is
production-supported. Model-specific binary adapters and formal IEEE
conformance remain blocked by the external fixtures listed at the end of this
document.

### Gate status on `dev`

- **Gate 0:** implemented and locally green; production Pages-source cutover is
  still pending the stable merge.
- **Gates 1, 2 and 4:** implemented with deterministic scientific, integrity,
  event and pulse regressions.
- **Gate 3:** partial. Large-record reductions, shared-index display
  downsampling and worker protocols are present; CSV parsing remains on the
  main thread and pipeline work moves to a worker only at 100,000 samples.
- **Gate 5:** implemented with IndexedDB persistence, migration and bounded
  `.signalforge` archives.
- **Gate 6:** baseline implemented, including typed profiles and
  convention-free import; opt-in expert regular expressions remain unshipped.
- **Gate 7:** implemented and browser-tested, including derived review queues,
  progress and save-state summaries, keyboard marker review and event-aligned
  per-shot STFT comparison.
- **Gate 8:** implemented and reference-tested. Baseline subtraction, time
  gating, artifact blanking/interpolation and reference subtraction are
  marker/selection-aware pipeline steps with quality propagation, provenance,
  residual inspection and recipe undo/redo.
- **Gate 9:** adapter framework complete; model-specific native decoders remain
  fixture-required.
- **Gate 10:** implemented. CI, audit/dependency review, workers, lazy chunks,
  bounded archives, two-deployment service-worker testing, accessibility
  regressions, deterministic tracked-build verification, release-note
  configuration and 100k/1M synthetic performance budgets are present.

## Definition of stable

A phase is stable only when:

1. Type checking, linting, formatting checks, unit tests and the production
   build pass.
2. Browser smoke tests pass in Chromium.
3. New numerical behavior has synthetic reference tests with documented
   tolerances.
4. Existing import, plot, filter, math, export and settings workflows have no
   known regression.
5. New results expose units, provenance and warnings.
6. The working tree contains no accidental generated or secret files.

## Gate 0 — Quality and deployment foundation

### Deliverables

- Add separate `typecheck`, `test`, `test:watch`, `lint`, `format`,
  `format:check`, `test:e2e` and `check` scripts.
- Add Vitest with deterministic numerical fixtures.
- Add Playwright smoke tests for application startup, theme, dialogs and a
  synthetic CSV workflow.
- Add ESLint and Prettier.
- Declare the current Node.js LTS line in `engines` and CI.
- Add Actions jobs for install, typecheck, lint, tests and build.
- Deploy the `dist` artifact to GitHub Pages only after checks pass on
  `master`.
- Add a post-deploy HTTP smoke test for HTML, JavaScript and CSS.
- Keep the existing `master:/docs` deployment operational until the Actions
  workflow is merged and Pages is deliberately switched to GitHub Actions.

### Acceptance

- A clean checkout passes `npm ci && npm run check && npm run build`.
- CI rejects broken tests, types, lint or formatting before deployment.
- The production URL loads compiled assets beneath `/SignalForge/`.

## Gate 1 — Scientific correctness

No product feature phase may be considered stable until this gate passes.

### Fourier transform and spectra

- Make arbitrary input lengths safe. Use a validated radix-2 path for
  power-of-two lengths and Bluestein's algorithm for other lengths.
- Keep transform length separate from unpadded record length.
- Normalise single-sided amplitude by the unpadded sample count and coherent
  window gain. Zero-padding must not change a bin-centred tone amplitude.
- Calculate one-sided power spectral density as squared transform magnitude
  divided by sample rate and window energy, with correct DC and Nyquist
  handling.
- Expose window coherent gain, window power, equivalent noise bandwidth,
  unpadded length and transform length.
- Calculate bandpower by integrating PSD, not squared amplitude bins.
- Document SNR, THD and SINAD assumptions and signal-bin exclusion.
- Reject or resample unsuitable timebases before frequency analysis.

### Sampling and resampling

- Inspect every adjacent time interval, including duplicate, reversed and
  non-finite timestamps.
- Report robust median interval, MAD-based jitter and maximum deviation.
- Resample non-uniform series to a monotonic uniform timebase before FFT, STFT
  and Welch analysis.
- Before decimation, use the current tested pole-aware IIR low-pass cascade
  below the new Nyquist frequency. This internal implementation choice does not
  restrict user-selectable FIR pipeline filters.

### Transfer functions, coherence and delay

- Compute Welch-averaged `Sxx`, `Syy` and `Sxy` from overlapping windowed
  segments.
- Calculate `H1 = Sxy / Sxx` and magnitude-squared coherence
  `|Sxy|² / (Sxx*Syy)`.
- Require enough segments for a meaningful coherence estimate and warn
  otherwise.
- Remove each signal's mean before cross-correlation.
- Normalise correlation by overlap energy.
- Refine the peak with parabolic interpolation for fractional-sample delay.
- Record delay polarity and applied deskew explicitly.

### Reference tests

- Forward/inverse round trip for power-of-two and prime lengths.
- Non-power-of-two `zeroPadMode: none` completes and matches direct DFT
  reference values for small records.
- A bin-centred sine has amplitude error below 0.1% with 1x, 2x and 4x padding.
- Integrated PSD of white noise agrees with time-domain variance within 5% for
  sufficiently long deterministic fixtures.
- Identical delayed signals recover integer delay within 0.05 sample and
  fractional delay within 0.15 sample.
- Coherent input/output fixtures produce coherence above 0.98 in excited bins.
- Independent deterministic noise fixtures do not report broadband coherence
  above the documented statistical confidence bound.
- A tone above the post-decimation Nyquist frequency is attenuated before
  reduction and does not alias into a false dominant tone.

## Gate 2 — Immutable data and safe mathematics

### Data model

- Replace mutable row-object analysis paths with a columnar dataset:
  `Float64Array` numeric channels, original text/value records and per-channel
  quality flags.
- Keep immutable imported data separate from repair overlays and processed
  channels.
- Quality flags include missing, invalid, clipped, saturated, non-monotonic
  time, interpolated and user-edited.
- Make the default processing pipeline a single pass-through step.
- Parsing reports issues; it never silently forward-fills.
- Interpolation and forward-fill are explicit processing/repair operations.
- Every repair command records before/after values, affected count, user/time
  metadata and supports undo/redo.
- Export original values, quality flags and repaired/processed values as
  distinct fields.

### Safe named math operations

- Pointwise multiply, divide, add and subtract.
- Guarded division with configurable minimum denominator and quality output.
- Derivative on the actual timebase using one-sided endpoints and central
  interior estimates.
- Trapezoidal integration using every real time interval.
- Mean, median and trimmed mean across aligned traces.
- Power, energy, charge and action-integral operations.
- A scalar expression may not silently become a waveform unless the user
  explicitly chooses a constant trace.
- Free-form math remains an expert feature and warns when matrix multiplication
  or division syntax is used with waveform variables.
- Fix `diff()` semantics and replace uniform-`dt` shortcuts with time-aware
  named functions.

### Units

- Channels store unit symbol, SI dimension, scale, calibration and polarity.
- Compatible additions/subtractions are allowed; multiplication/division
  derives dimensions.
- Power, energy, charge, impedance and action integral expose SI units.
- Unknown units produce an explicit warning rather than false certainty.

### Acceptance

- Importing malformed/clipped data preserves exact originals and sets flags.
- Loading, viewing, filtering and exporting cannot mutate originals.
- Undo and redo round-trip repairs exactly.
- Non-uniform-time derivative and integral match analytic fixtures within
  documented tolerances.
- `V*I` cannot produce a plausible scalar waveform accidentally.

## Gate 3 — Large records, workers and cancellation

**Current status: partial.** Pipeline execution crosses to a cancellable worker
at 100,000 samples, and spectral/batch entry points use workers. Text parsing
still runs on the main thread, and smaller pipelines intentionally remain
in-process.

### Deliverables

- Replace spread-based min/max and similar reductions with iterative utilities.
- Return LTTB source indices and reuse the same indices for time-aligned raw,
  processed and residual traces.
- Compute derivatives, events and measurements before display downsampling.
- Move text parsing, pipeline execution, FFT/STFT/Welch and batch analysis to
  module Web Workers.
- Define typed worker request/response protocols with task IDs.
- Add progress events and cooperative cancellation.
- Use transferable typed-array buffers where ownership permits.
- Keep UI state responsive while a task runs and clearly mark stale results.

### Acceptance

- A 150,000-sample fixture does not overflow the call stack.
- Raw and processed peaks retain the same timestamps after display
  downsampling.
- Cancelling a task prevents stale results from replacing newer state.
- Browser smoke tests demonstrate responsive navigation during a large
  synthetic analysis.

## Gate 4 — Events and pulse measurements

Implement scope-style pulse analysis using publicly documentable principles
consistent with IEEE 181 terminology where applicable. Do not claim formal
standards compliance without a licensed conformance review.

### Events

- Preserve original source indices through validity filtering and selection.
- Interpolate threshold crossing times.
- Estimate baseline and top state robustly before deriving thresholds.
- Add explicit hysteresis and minimum event separation.
- Make zero slope/threshold defaults safe for flat and noisy records.
- Define a runt as a transition that crosses one state threshold but fails to
  reach the required opposite-state threshold before returning.
- Attach confidence, source indices and warnings to every suggested event.

### Measurements

- Pair time and amplitude validity; never compact them independently.
- Calculate 10–90% rise/fall time around a selected pulse, not global extrema.
- Add pulse width, peak voltage/current, maximum `dV/dt` and `dI/dt`.
- Add pre-trigger RMS and peak-to-peak noise.
- Add ringing frequency, logarithmic decrement/decay and estimated Q with fit
  quality.
- Add charge, energy, action integral, average/peak power and guarded dynamic
  impedance.
- Permit integration to a named marker.
- Deskew voltage/current before power calculations and record the delay.
- Emit warnings for clipping, invalid intervals, insufficient baseline,
  ambiguous states, low denominator and poor fit.

### Acceptance

- Synthetic clean, noisy, overshooting, multi-pulse and runt fixtures have
  expected event counts and timing tolerances.
- Removing invalid pairs cannot shift event indices.
- Every pulse calculation includes region, source channels, units and warnings.

## Gate 5 — Sessions, shots and persistence

### Domain model

- `Session`: experiment metadata, import profile, processing recipe and shots.
- `Shot`: source files, extracted metadata, review state and notes.
- `Channel`: waveform, units, calibration, probe, timing offset and quality.
- `Annotation`: named marker/region, author, source and acceptance state.
- `AnalysisResult`: immutable provenance, recipe hash, markers, warnings and app
  version.

### Persistence

- Store sessions, shots, channels and results in versioned IndexedDB stores.
- Keep appearance and small preferences in `localStorage`.
- Add schema migrations with rollback-safe transactions.
- Add a downloadable SignalForge project archive containing a versioned
  manifest, settings, metadata, annotations and lossless channel data.
- Validate archive paths, sizes, checksums and schema before import.
- Autosave safely and recover interrupted edits.

### Acceptance

- A multi-shot session survives reload without loss.
- Export/import preserves data, quality flags, metadata, markers and result
  provenance.
- Older supported project schemas migrate through tested fixtures.
- Corrupt or oversized archives fail safely with useful diagnostics.

## Gate 6 — Multi-file import and filename profiles

**Current status: baseline implemented.** The typed placeholder grammar and
convention-free mode ship; opt-in expert regular expressions do not.

### Deliverables

- Profile grammar such as
  `shot {shot:int} - {charge_voltage:quantity[V]} - {length:quantity[mm]}`.
- Unit synonym registry with explicit SI normalisation.
- Preserve original filename text and matched spans.
- Preview extracted values, units, unmatched files and ambiguities.
- Permit manual corrections before import.
- Group files into shots and channels by selected profile fields.
- Support opt-in expert regular expressions with timeout/complexity limits.
- Add an importer-adapter contract that returns calibrated channels, metadata,
  warnings and an identification confidence.

### Acceptance

- Deterministic profile fixtures cover alternate units, signs, decimals,
  whitespace, unmatched names and ambiguous names.
- Grouping never silently merges files with conflicting metadata.
- Manual corrections are retained in provenance.

## Gate 7 — Manual review workspace

**Current status: implemented.** Needs-review, warning-bearing, excluded and
all-shot queues are derived without changing session data. Review progress and
pending/saving/saved/error states are visible. Keyboard marker placement and
suggestion decisions are supported, and comparison offers both an amplitude
waterfall and bounded per-shot event-aligned STFT spectrograms.

### Deliverables

- Previous/next shot controls and keyboard navigation.
- Synchronised multi-channel waveform view.
- User-defined named point markers and marker-defined regions.
- Click placement with optional snap to sample, slope maximum, curvature
  maximum or change-point suggestion.
- Per-shot notes and include/exclude status.
- Suggested markers that can be accepted, moved or rejected.
- Review queue showing incomplete and warning-bearing shots.
- Overlay, small-multiple and event-aligned comparison modes.
- Event-aligned waterfall/spectrogram across shots.
- Parameter plots for ringing frequency and damping versus filename-derived
  metadata.

### Acceptance

- Accepted manual markers override suggestions in all calculations.
- Keyboard-only review is possible.
- Marker edits invalidate only dependent results.
- Review state persists and round-trips through project archives.

## Gate 8 — Noise and transient-preserving processing

**Current status: implemented.** Exposed FIR and IIR filters remain
reference-tested. Baseline subtraction, time gating, artifact
blanking/interpolation and reference/common-mode subtraction are now explicit
pipeline steps bound to plot selections, explicit bounds, named regions,
marker pairs or aligned reference channels. Pipeline reports preserve resolved
bounds, annotation IDs, quality effects and warnings; recipe undo/redo and the
raw-minus-processed residual provide reversible review.

### Deliverables

- Baseline subtraction from a named pre-trigger region.
- Hampel and median deglitching.
- Specification-driven Kaiser FIR low-pass, high-pass, band-pass and band-stop
  filters with derived odd tap counts and verified realized response.
- IIR Butterworth low-pass, high-pass and band-pass filters.
- Configurable IIR notch and comb filtering.
- Wavelet denoising with explicit boundary and threshold choices.
- Time gating and trigger-artifact blanking.
- Reference-channel/common-mode subtraction.
- Event-aligned mean, median and trimmed-mean waveforms across shots.
- Raw-minus-processed residual display.
- Magnitude, phase and group-delay display for every linear filter.
- Explicit causal, centered linear-phase and forward-backward zero-phase modes.

### Acceptance

- Filter reference tests compare magnitude/phase against analytic or trusted
  offline values.
- UI displays edge handling, causal/zero-phase choice and effective delay.
- No filter runs implicitly on import.
- Residual and original data remain available.

## Gate 9 — Native oscilloscope adapters

**Current status:** content-first detection, checked readers, decode budgets,
worker cancellation, multi-record/session mapping and cross-language fixture
oracles are implemented.

### Implemented fixture-backed paths

- Tektronix little-endian WFM#003 ordinary analogue and FastFrame.
- Keysight/Agilent AG10 ordinary analogue BIN.
- R&S RTx paired float32, int8 and XYDOUBLEFLOAT exports.
- LeCroy LECROY_1_0/2_3 little-endian int16 TRC.
- Rigol DS1000B/C/D-E/Z, DS2000, DS4000, MSO5000 and DHO800 WFM/BIN.
- Layout-tested beta paths: Tek ISF, AG01/AG03, R&S int16, big-endian
  LeCroy and PicoScope two-row CSV.

PSDATA remains conversion-required. PicoScope HDF5, Siglent and unproved
Tek/Rigol variants remain unavailable until representative fixtures and
bounded decoders exist.

For each exact model/firmware family, development requires representative files
covering channel count, sample type, endian mode, segmented acquisition,
scaling, timestamp metadata and known malformed cases. An adapter remains
`experimental` until its calibrated output matches a trusted vendor export.

### Acceptance

- Identification never relies on extension alone.
- Unsupported variants return diagnostics without partial silent decoding.
- Calibrated values, units, timing and metadata match trusted fixtures.
- Fuzzed/truncated inputs cannot hang the UI or allocate unbounded memory.

## Gate 10 — Batch analysis, offline use and release hardening

**Current status: implemented.** The service worker runtime cache is stamped
with the package version and built-entry hash. A two-deployment same-origin
Playwright test verifies activation, old-cache eviction, new content and
offline reuse. CI runs audit/dependency review, accessibility regressions and a
tracked-`dist` parity/reference/stamp check. Seeded 100k validation runs on the
normal gate; the one-million-sample structural suite and informational timing
report run on the scheduled/manual synthetic workflow.

- Queue batch processing by session/shot with deterministic recipe hashes.
- Cache immutable results and invalidate by dependency.
- Add progress, cancellation, retry and per-shot failure isolation.
- Split Plotly and heavy analysis code to reduce initial bundle cost.
- Maintain the two-deployment browser test for service-worker update/version
  behavior.
- Add dependency review and vulnerability audit to CI.
- Maintain seeded regression scenarios and locked numerical checksums.
- Keep report limitations, supported adapters and explicit uncertainty status
  synchronized with the implemented analysis.

## Implementation sequence

1. Gate 0: quality and deployment foundation.
2. Gate 1: numerical correctness.
3. Gate 2: immutable data and safe mathematics.
4. Gate 3: large records and workers.
5. Gate 4: events and pulse measurements.
6. Gate 5: sessions and persistence.
7. Gate 6: multi-file import and profiles.
8. Gate 7: manual review.
9. Gate 8: transient-preserving FIR/IIR noise processing.
10. Gate 9: native adapter framework, then fixture-gated adapters.
11. Gate 10: batch/offline/release hardening.

Feature gates are cumulative. Later work may be prototyped on `dev`, but it is
not eligible for `master` until all earlier mandatory gates pass.

## Required external fixtures

The following cannot be completed credibly from source code alone:

- Representative native files from every exact oscilloscope model and firmware
  family.
- Trusted reference exports for calibration comparison.
- Real multi-shot flashover sessions with expected markers and calculations.
- Agreed channel polarity and unit conventions.
- A licensed IEEE 181-2025 conformance review if formal compliance is required.

Until supplied, the repository will contain tested extension points,
diagnostics and synthetic fixtures, not fabricated format support or compliance
claims.
