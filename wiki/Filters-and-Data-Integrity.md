# Filters and Data Integrity

## Processing rules

- Filters never run implicitly during import.
- Every step is deterministic and reports how many samples changed.
- Processed quality masks propagate source flags across each filter’s local or
  full-run contamination footprint and are included in full CSV exports.
- Non-finite gaps split processing into independent finite runs.
- Analysis remains full resolution; display downsampling uses shared indices.
- Raw-minus-processed residuals should be inspected before accepting a recipe.

## Time-domain processing

- **Moving average:** normalized symmetric box smoothing with rolling O(n)
  evaluation and reflected boundaries.
- **Savitzky–Golay:** QR-based least-squares coefficients preserve supported
  polynomial orders without normal-equation instability.
- **Median:** bounded odd-window rejection for isolated impulses.
- **Gaussian:** normalized symmetric kernel with validated sigma and size.
- **Hampel:** robust median/MAD deglitching, including exact plateaus where MAD
  is zero.
- **Wavelet:** multilevel Haar soft-thresholding with per-level robust noise
  estimates.
- **Start/Stop normalization:** explicit baseline subtraction and independent
  endpoint sine tapers.

## IIR filters

- The one-pole low pass provides causal RC-like smoothing through alpha.
- Butterworth low/high/band-pass filters use cascaded normalized sections.
- Notch and comb sections target calibrated interference frequencies and
  requested −3 dB edges. Infeasible broad notches and comb cascades whose
  overlap distorts those edges are rejected explicitly.
- **Causal** mode has physical phase and group delay.
- **Zero-phase** mode is offline forward/backward processing; it removes phase
  delay and squares the causal magnitude response.

## Designed FIR filters

Kaiser FIR low-pass, high-pass, band-pass and band-stop steps use explicit
engineering specifications:

- a passband edge or center/width;
- transition width;
- maximum passband ripple;
- minimum stopband attenuation.

SignalForge derives an odd Type-I tap count and Kaiser beta, enforces a
16,385-tap and 512 MiB estimated working-set safety limit, and verifies exact
edges plus response extrema before applying it. It never silently relaxes the
requested ripple or attenuation.

**Causal** mode uses past samples, reports the constant linear-phase delay of
`(taps − 1) / (2 × sample rate)`, and initializes each run with `taps − 1`
samples of constant prehistory equal to the first value. Causal FIR requires a
timebase uniform to a `1e-9` relative interval tolerance because offline
interpolation could otherwise consume future samples.

**Centered zero-phase** mode applies the symmetric kernel once using reflected
finite-run boundaries; unlike IIR forward/backward processing, its magnitude
response is not squared. A non-uniform record is resampled offline. That
complete operation is time-varying, so SignalForge hides the uniform-kernel
response overlay and reports the limitation.

The pipeline report records tap count, beta, achieved ripple/attenuation and
short-run boundary warnings. Quality masks follow the exact causal or centered
tap footprint on uniform runs and conservatively cover a complete run after
non-uniform resampling.

## FFT-domain filters

FFT low/high filters use smooth Butterworth-magnitude masks. FFT notch filters
use a flat stop region with raised-cosine shoulders. Finite runs are
reflect-padded to limit circular boundary artifacts. Non-uniform timebases are
resampled before filtering and returned to their original timestamps without
triggering a second anti-alias pass. FFT notch bandwidth must be at least the
finite run's record resolution (`sample rate / run length`).

Non-finite, duplicate, or decreasing timestamps split frequency-filter runs;
skipped and split segments are listed in the pipeline report.

For a compact narrowband rejection filter, prefer the designed IIR notch.

## Marker, region and reference processing

The pipeline exposes four non-destructive transient-processing steps:

- **Baseline subtract** uses a mean, median or 10% trimmed mean over a resolved
  region.
- **Time gate** zeros samples outside a resolved region.
- **Artifact blank** marks a region missing or explicitly interpolates between
  its finite neighbours.
- **Reference/common-mode subtract** aligns the selected channel by its
  timestamps and timing offset, removes the requested scale and propagates
  quality flags from both inputs.

Regions can come from the current plot selection, explicit times or indices, a
named accepted region, or an accepted marker pair. Manual annotations take
precedence over accepted suggestions; unresolved names pass through with a
warning instead of silently applying the wrong interval. Reports include
resolved indices/times, annotation IDs, changed samples and warnings.

These operations affect only the derived processed series. Imported originals
and repair history remain unchanged. Use pipeline Undo/Redo, step bypass or
removal to reverse recipe edits, and inspect the raw-minus-processed residual
before accepting a result. Artifact interpolation is marked `Interpolated` in
filtered quality; missing blanking is marked `Missing`.

## Quality and repairs

Quality masks distinguish missing, invalid, clipped, saturated, interpolated,
forward-filled and edited samples. Original values remain separate from working
repairs. Interpolation and forward fill are explicit, reversible actions.
