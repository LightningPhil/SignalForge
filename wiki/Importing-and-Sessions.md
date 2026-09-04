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
sample/channel/memory budgets. Multi-file selection is capped at 64 MB of
source bytes, and cumulative decoded/session persistence must fit a conservative
192 MB peak-memory estimate.

## Preview and conflict handling

- Preview importer choice, extracted fields, normalized SI values and warnings
  before import.
- Correct extracted values manually when needed; corrections are recorded in
  metadata.
- Files with conflicting shot-level metadata are not silently merged.
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
