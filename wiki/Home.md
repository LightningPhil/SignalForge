# SignalForge Wiki

SignalForge is a browser-based engineering workspace for importing, reviewing,
filtering, and analysing waveform sessions without uploading data to a server.

## Start here

- [Getting Started](Getting-Started)
- [Importing Files and Building Sessions](Importing-and-Sessions)
- [Filters and Data Integrity](Filters-and-Data-Integrity)
- [Scientific Analysis](Scientific-Analysis)
- [Development and Deployment](Development-and-Deployment)

## Current guarantees

- Strict TypeScript, Vite, Tailwind and Plotly remain the application
  foundation.
- Imported source bytes and parsed originals are retained separately from
  repairs and processed values.
- Frequency analysis uses arbitrary-length FFT support, padding-invariant
  amplitude, PSD normalization, non-uniform-time resampling and Welch-averaged
  coherence.
- Filter pipelines report changed-sample counts and preserve non-finite gaps as
  independent runs.
- Sessions, shots, channels, annotations and results persist in IndexedDB and
  can be transferred in checksum-verified `.signalforge` archives.
- Specification-driven Kaiser FIR and calibrated IIR filters expose measured
  response, delay, quality propagation and provenance.

## Support boundaries

CSV, TSV and delimited text are supported. Native oscilloscope formats remain
fixture-gated: a manufacturer extension alone is not evidence that a model or
firmware variant can be decoded correctly.
