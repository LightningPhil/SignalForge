# Importing Files and Building Sessions

## Filename convention profiles

A profile extracts typed shot metadata from filenames:

```text
shot {shot:int} - {charge_voltage:quantity[V]} - {length:quantity[mm]} - {channel:text}.csv
```

Example matching filename:

```text
shot 7 - 25kV - 200mm - Voltage.csv
```

Quantities accept known unit synonyms and are stored separately as normalized
SI values and original text.

## Import without a convention

In **Multi-file Shot Import**, clear **Extract shot metadata from a filename
convention**. Any filename accepted by a supported importer can then be used.
Each file becomes its own shot and receives its filename stem as the shot name.

Filename flexibility does not bypass content-based format validation.

## Native oscilloscope files

SignalForge directly imports these supplied-fixture-backed variants:

- Tektronix little-endian WFM#003 ordinary analogue and FastFrame;
- Keysight/Agilent AG10 ordinary analogue BIN;
- R&S RTx float32, int8 and explicit-time paired exports;
- LeCroy LECROY_1_0/2_3 little-endian int16 TRC;
- Rigol DS1000B/C/D-E/Z, DS2000, DS4000, MSO5000 and DHO800 WFM/BIN.

Layout-tested beta paths include Tektronix ISF, AG01/AG03, R&S int16,
big-endian LeCroy TRC and PicoScope two-row CSV. The import preview displays
the evidence level.

Select both files from an R&S export: the XML description `.bin` and its
case-matched `.Wfm.bin` payload. Multi Import pairs them by content and name.
Tektronix FastFrame files create one shot per frame while storing source bytes
only once.

PSDATA is proprietary and returns PicoScope/BatchConvert guidance. HDF5 is
detected but remains unavailable until a bounded browser decoder and a
representative real PicoScope 7 fixture exist. Siglent, Tek WFM#001/#002 or
big-endian WFM, Rigol DS6000 and MSO7000/8000 remain provisional and are
rejected rather than partially decoded.

All binary readers run in a dedicated worker, validate declared extents before
allocation, preserve source bytes and invalid samples, and enforce named
sample/channel/memory budgets.

### Resource limits

These values are the implemented `ScopeImportLimits` and must stay in step
with the code:

| Budget                                                        | Limit                 |
| :------------------------------------------------------------ | :-------------------- |
| One selected source file (binary, text or companion)          | 64 MiB                |
| All files selected together for one multi-file preview/import | 64 MiB                |
| Raw bytes handed to one worker request (primary + companions) | 192 MiB               |
| Text (CSV/TSV) decoded to a string before parsing             | 32 MiB                |
| R&S XML description                                           | 16 MiB                |
| Decoded working set of one import                             | 192 MiB               |
| Predicted resident session bytes after an import              | 192 MiB               |
| Samples per channel / total channel-samples                   | 3,000,000 / 3,000,000 |
| Analogue channels per native file / delimited-text channels   | 4 / 64                |
| Records (frames) per file / files per multi-import preview    | 10,000 / 10,000       |
| Metadata string                                               | 4,096 bytes           |

Delimited text is bounded before parsing: the row count, channel count and
predicted row × channel memory are checked from the raw text, so an oversized
file fails with a budget error instead of allocating first. A first row that is
entirely numeric is treated as headerless (columns become `Time`, `Channel 1`, …)
so that no sample is consumed as a column name.

Trailing bytes: Tektronix WFM exports may carry a short vendor tail after the
declared EOF; it is reported as a warning and never decoded. LeCroy TRC files
with bytes beyond the declared logical blocks (other than a single trailing
line ending) are rejected. Tektronix ISF preambles must declare `XINCR` and
`YMULT`; other defaulted calibration fields are disclosed as warnings.

## Preview and conflict handling

- Preview importer choice, extracted fields, normalized SI values and warnings
  before import. The evidence level shown for a source is the level the decoder
  actually accepted, not the pre-decode signature guess.
- Correct extracted values manually when needed; corrections are re-parsed
  with the field's rules (a corrected `25 kV` becomes 25000 V) and unparsable
  corrections are flagged inline and block that file, not the whole selection.
- Files that do not match the active filename convention, orphan or ambiguous
  R&S halves, and files with grouping errors are listed as skipped and are not
  imported; the rest of the selection still imports.
- Files with conflicting shot-level metadata (including decoded acquisition
  metadata such as record length, sample interval and trigger position) are
  not silently merged.
- Failed files do not create empty shots.

## Sessions and review

A session contains shots, channels, source files, annotations, processing
settings and provenance-rich results.

- Navigate with Previous/Next or Alt+arrow keys.
- Add notes and accepted/excluded review status.
- Place markers directly or snap to samples, slope, curvature or change points.
- Treat accepted manual markers as authoritative.
- Use overlay, small-multiple, event-aligned and waterfall comparisons.
- Save locally in IndexedDB or export a `.signalforge` project archive.
