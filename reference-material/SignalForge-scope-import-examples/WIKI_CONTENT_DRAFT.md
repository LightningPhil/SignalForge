# Built-in wiki draft: importing oscilloscope files

> Cursor: adapt this page to SignalForge's wiki component only after the fixture tests pass. Remove any row not implemented. Change no evidence level upward without adding a real fixture and test. Set the “last verified” date to the implementation date.

## Importing oscilloscope data

SignalForge reads supported files locally in your browser. Files are not uploaded to a server. Keep the original scope files with your project so an analysis can be traced back to its source.

Select all files belonging to one capture. Some Rohde & Schwarz exports consist of two files and both are required.

### What the evidence labels mean

| Label | Meaning |
|---|---|
| Verified | Tested with the named supplied vendor/hardware files. This does not imply every model or firmware. |
| Beta/layout-tested | The byte-layout branch passes a synthetic test, but needs a real file from the target scope. |
| Experimental | Based on a published export structure but still needs representative real exports. |
| Conversion required | Recognised as valid, but vendor software must export it to an open format first. |
| Not yet supported | SignalForge recognises or anticipates the variant and refuses to produce an incomplete waveform. |

Last verified: **[set during implementation]**

### Current format support

| Brand | Format/variant | Evidence | What works | Remaining limits |
|---|---|---|---|---|
| Tektronix | WFM#003 analogue | Verified | Single-frame and FastFrame; every supplied frame is retained | WFM#001/#002, big-endian, digital, IQ and histogram variants need fixtures |
| Tektronix | Binary ISF | Beta/layout-tested | Signed 16-bit big-endian example, preamble calibration and units | Preamble abbreviations and other sample types need real model-specific files |
| PicoScope | CSV/TSV text | Beta/layout-tested | Two-row analogue headings, SI-prefixed units and invalid samples | Locale, digital, maths and spectrum views need fixtures or column mapping |
| PicoScope | HDF5 | Experimental | Documented channel/buffer arrangement | Needs a real export from the PicoScope 7 version used at work |
| PicoScope | PSDATA | Conversion required | Valid PSDATA is identified and explained | It cannot be decoded directly; CSV/HDF5 conversion may not preserve the whole session |
| Keysight/Agilent | AG10 BIN | Verified | Ordinary single- and multi-channel analogue float32 records from DSO-X 1102G fixtures | Segmented, peak-detect/multi-buffer and logic/digital data are not yet imported |
| Keysight/Agilent | AG01/AG03 BIN | Beta/layout-tested | 32-bit AG01 and 64-bit AG03 container length branches | Needs real captures from named models/firmware |
| Rohde & Schwarz | RTx `.bin` + `.Wfm.bin` | Verified | Float32, int8 and explicit-time XYDOUBLEFLOAT analogue captures; one or two channels | Both files are mandatory; history, multiple acquisitions, digital, bus, maths and spectrum records are not supported |
| Rohde & Schwarz | RTx int16 | Beta/layout-tested | Integer decoding and XML calibration equation | Needs a real capture |
| Teledyne LeCroy | TRC `LECROY_1_0` / `LECROY_2_3` | Verified | Little-endian signed-word single-sweep traces, including an SCPI-prefixed file | Sequence/subarray timing, secondary arrays and peak-detect pairs need dedicated support |
| Teledyne LeCroy | Big-endian TRC | Beta/layout-tested | `LECROY_2_3` signed-word byte-order branch | Needs a real capture |
| Rigol | DS1000B/C/D-E/Z, DS2000, DS4000 WFM | Verified | The six supplied family layouts and their channel/timing calibration | Other model/firmware layouts are not implied by the `.wfm` extension |
| Rigol | MSO5000 BIN and DHO800 WFM/BIN | Verified | Supplied analogue captures | Unsupported blocks and logic records are rejected |
| Rigol | DS6000 WFM, MSO7000/8000 BIN | Not yet supported | Parser research is present | No real acceptance fixture in the hand-off |

### Important: an extension is not a format

Tektronix and Rigol both use `.wfm`. Keysight, Rohde & Schwarz and several Rigol families use `.bin`. SignalForge inspects file contents and embedded model/version information. Renaming a file does not convert it.

### Rohde & Schwarz two-file exports

RTP, RTO and RTE waveform saves can contain:

- `<capture>.bin` — XML description, settings and calibration; and
- `<capture>.Wfm.bin` — sample payload.

Select or drag both files together. SignalForge matches the names without case sensitivity and verifies that format code and hardware record length agree. If one is missing, export/copy the complete pair; do not rename an unrelated payload to force a match.

### PicoScope PSDATA

PSDATA is PicoScope's proprietary session format. SignalForge can recognise it but cannot safely decode it in a static browser application.

Preferred route:

1. Open the session in PicoScope 7.
2. Export CSV for broad compatibility, or HDF5 if available and validated for your PicoScope version.
3. Import the exported file into SignalForge.

PicoScope 7 also supplies a desktop `BatchConvert` command for bulk conversion. SignalForge cannot run desktop vendor software from GitHub Pages. Keep the PSDATA original because export may omit settings, rulers, notes, maths channels or measurements.

### What SignalForge preserves

- Imported samples as immutable raw values.
- NaN/missing samples as explicit invalid data, not repeated neighbouring values.
- Original file names, detected format/family and available model/firmware metadata.
- Channel labels, original units, SI conversion and calibration metadata.
- Original time origin and interval, or the complete explicit time array when stored.
- Every supported frame/record rather than only the first.
- Both members of a paired-file source in provenance.

### Why a file may be refused

SignalForge deliberately refuses files when:

- the file is truncated or a declared length is outside its bounds;
- a companion file is missing or does not match;
- a format variant contains records the importer cannot model correctly;
- the decoded result would exceed the browser's configured memory budget; or
- a format is proprietary and requires vendor conversion.

This is safer than drawing a plausible-looking but incorrectly scaled or incomplete waveform.

### Reporting a file that does not open

If you are able to share the data, provide:

- scope make and exact model;
- firmware and acquisition software version;
- file extension and how it was saved/exported;
- acquisition mode, enabled channels and record length;
- the original file plus a CSV export of the same waveform;
- expected sample interval, channel units and one or two known values;
- the full SignalForge error message.

Remove sensitive labels/notes only if this does not change the binary layout. See the project's fixture-collection checklist for a repeatable capture set.

