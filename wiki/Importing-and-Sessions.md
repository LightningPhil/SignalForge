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

Filename flexibility does not bypass format validation. Unsupported native
scope files remain fixture-gated.

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
