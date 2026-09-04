# Scientific Analysis

## Spectrum and power

- Arbitrary record lengths use a radix-2 FFT or Bluestein transform.
- Tone amplitude is normalized by the unpadded record length and coherent
  window gain, so zero padding does not change reported amplitude.
- One-sided PSD uses sample rate and window energy normalization.
- Bandpower integrates PSD rather than squared amplitude bins.
- Non-uniform timebases are inspected across every interval and resampled
  before frequency analysis.

## Cross-channel analysis

- Delay estimation removes means, requires substantial overlap, applies
  multiple-lag confidence correction and refines the peak fractionally.
- FRF and magnitude-squared coherence use shared Welch segments.
- Channel timing offsets are applied relatively before voltage-current
  calculations.

## Pulse-power calculations

Structured calculations include peak voltage/current, rise/fall time, pulse
width, dV/dt, dI/dt, charge, energy, action integral, power and guarded dynamic
impedance.

Calculations:

- use actual timestamps and trapezoidal integration;
- align different channel timebases before multiplication;
- anti-alias when reducing sample rate;
- fail safely when a record is too short for reliable anti-aliasing;
- record polarity, markers, quality warnings and applied deskew.

## Events and markers

Level crossings are interpolated at the active hysteresis boundary. Edge
thresholds can be estimated robustly. Pulse direction, runt thresholds and
minimum event separation are explicit.

Automatic events and marker suggestions are aids. An accepted manual marker is
authoritative for downstream analysis.

## Standards statement

Pulse terminology follows publicly documentable engineering practice where
applicable. SignalForge does not claim formal IEEE 181-2025 conformance without
a licensed conformance review and representative validation captures.
