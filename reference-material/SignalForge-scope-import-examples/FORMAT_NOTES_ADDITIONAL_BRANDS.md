# Binary format notes: Keysight, Rohde & Schwarz, Teledyne LeCroy and Rigol

This note records the exact import path exercised by the Python reference and the supplied fixtures. It is an implementation guide, not a claim that a shared extension means one universal format. Always retain the original file and report unsupported variants rather than guessing.

The Python adapters use `RigolWFM==1.5.0` for Keysight, LeCroy and Rigol; the direct R&S reader follows its BSD-licensed logic while preserving explicit time values and enforcing exact byte counts. A copy of that project's working browser viewer and generated Kaitai JavaScript parsers is included under `third_party/rigolwfm_web_reference`. Its `app.js` contains content detection, calibration and normalisation code that Cursor can migrate into typed SignalForge adapters. Matching `.ksy` sources are under `third_party/rigolwfm_kaitai_schemas`.

## Content detection

| Family | Reliable content clue | Supplied examples |
|---|---|---|
| Keysight/Agilent AGxx | Bytes 0–1 are `AG`; bytes 2–3 are `01`, `03` or `10` | Two real AG10 files; synthetic AG01/AG03 |
| R&S RTP/RTO/RTE saved waveform | Primary `.bin` begins as XML with `<Database ... SaveItemType="Data">`; companion filename ends `.Wfm.bin` | Real float32, int8 and XYDOUBLEFLOAT pairs; synthetic int16 pair |
| Teledyne LeCroy | A plausible `WAVEDESC` block occurs in the file, possibly after an IEEE 488.2/SCPI prefix | Real `LECROY_1_0`/`2_3` LE files; synthetic `2_3` BE file |
| Rigol DS1000B | `a5 a5 a4 01` | DS1204B fixture |
| Rigol DS1000C | `a1 a5 00 00` | DS1202CA fixture |
| Rigol DS1000D/E | `a5 a5 00 00`; use header and total length to distinguish closely related layouts | DS1102D fixture |
| Rigol DS1000Z | `01 ff ff ff` | DS1054Z fixture |
| Rigol DS2000/4000/6000 | `a5 a5 38 00`; model string begins at offset 4 | DS2072A and DS4022 fixtures; DS6000 remains provisional |
| Rigol MSO5000/7000/8000 BIN | ASCII `RG01`; waveform-header size distinguishes families | MSO5000 fixture; 7000/8000 remain provisional |
| Rigol DHO800/1000 BIN | ASCII `RG03` | DHO824 BIN fixture |
| Rigol DHO800/1000 WFM | `02 00 00 00` and `.wfm` context | DHO824 fixture |

Do not route `.wfm` or `.bin` by extension alone. Tektronix and Rigol both use `.wfm`; Keysight, R&S and several Rigol families all use `.bin`.

## Keysight/Agilent AGxx `.bin`

The container is little-endian. The real hardware fixtures are AG10; small deterministic AG01 and AG03 fixtures prove their different length-field layouts but are not hardware evidence.

1. Validate the four-byte cookie: `AG01`, `AG03` or `AG10`.
2. Read the file header. AG01/AG10 use a 32-bit file-size field; AG03 uses 64 bits. Then read the waveform count.
3. For each waveform, read its declared waveform-header size, type, buffer count, point count, display range/origin, `xIncrement`, `xOrigin`, X/Y unit codes, model/serial frame string, waveform label, time tag and segment index.
4. For each buffer, read the declared data-header size, buffer type, bytes per point and buffer byte count. AG03 uses a 64-bit buffer byte count; AG01/AG10 use 32 bits.
5. Ordinary analogue buffers are little-endian float32 values and are already calibrated. Construct time as:

       time[i] = xOrigin + i * xIncrement

6. Preserve waveform labels and separate channel time axes. Reject point counts or byte lengths that do not agree with the headers.

Buffer types 1–3 are ordinary, maximum and minimum float32 data. Types 5–6 are logic/digital byte data. Peak-detect files can have minimum and maximum buffers; segmented captures can repeat a channel label with different time tags. The high-level Python reference currently accepts ordinary analogue records and rejects peak-detect, logic and segmented normalisation explicitly. The included low-level Kaitai parser retains those structures for a later implementation.

Browser reference: `AgilentAgxxBin.js`, plus `parseAgilentBin` and the AGxx branch in `detectAndParse` inside `app.js`.

## Rohde & Schwarz RTP/RTO/RTE `.bin` + `.Wfm.bin`

R&S officially describes this as a two-file save. The primary `.bin` is XML metadata; the sibling `.Wfm.bin` contains an eight-byte little-endian header followed by sample bytes.

1. Require both files with the same basename. In a browser, group all selected/dropped files by case-insensitive filename before parsing.
2. Parse the XML description and index elements by their `Name` attribute.
3. Read at least `SignalFormat`, `TraceType`, `NumberOfAcquisitions`, `SignalHardwareRecordLength`, `RecordLength`, `LeadingSettlingSamples`, `XStart`, `XStop` and the active source/channel fields.
4. Read the payload header: uint32 format code followed by uint32 hardware record length. Validate both against the XML before reading samples.
5. Supported payload codes in the included parser are 0=int8, 1=int16, 4=float32 and 6=XYDOUBLEFLOAT. All values are little-endian.
6. Float32 values are already calibrated. For int8/int16, use the XML scale:

       position = VerticalPosition * VerticalScale
       factor = StepFactor * VerticalScale / NofQuantisationLevels
       volts = raw * factor + (VerticalOffset - position)

7. For uniform X data:

       xIncrement = (XStop - XStart) / RecordLength
       time[i] = XStart + i * xIncrement

   Skip `LeadingSettlingSamples` in the hardware payload. XYDOUBLEFLOAT carries float64 time followed by one float32 value per active channel in every row.

The reference intentionally accepts single-acquisition analogue NORMAL/AVERAGE traces. The Python and browser reference paths preserve the complete float64 time array from XYDOUBLEFLOAT files; do not reconstruct it from a nominal increment. Float32, int8 and XYDOUBLEFLOAT have real fixtures. Int16 has a deterministic synthetic scaling fixture. The official `RTxReadBin` supports more, including history, digital channels, buses, maths, spectra and tracks. SignalForge must reject unimplemented cases clearly and retain both original files.

Browser reference: `RohdeSchwarzRtpWfmBin.js`, `rohdeSchwarzParseMetadata`, `rohdeSchwarzDecodeSingleAcquisition` and `parseRohdeSchwarzBin` in `app.js`.

## Teledyne LeCroy `.trc`

1. Search for a plausible `WAVEDESC` marker; SCPI transfers can prepend an IEEE 488.2 block header or other transport text.
2. Treat the marker as offset zero for the internal layout.
3. Read bytes 16–31 for the template name. The fixtures exercise `LECROY_1_0` (320-byte descriptor) and `LECROY_2_3` (normally 346 bytes).
4. Read the low byte of `COMM_ORDER` at WAVEDESC offset 34: 0 is big-endian/HIFIRST; 1 is little-endian/LOFIRST. Select the matching parser. `COMM_TYPE` at offset 32 selects signed 8-bit or signed 16-bit ADC samples.
5. Use the declared block lengths to skip WAVEDESC, optional user text, trigger-time and RIS arrays and reach `WAVE_ARRAY_1`. Do not assume the waveform follows a fixed 320/346-byte offset.
6. Calibrate each signed ADC sample:

       volts[i] = VERTICAL_GAIN * adc[i] - verticalOffset

   For `LECROY_1_0`, `verticalOffset` is `ACQ_VERT_OFFSET`; for `LECROY_2_3`, it is `VERTICAL_OFFSET`.
7. Build the horizontal axis:

       time[i] = HORIZ_OFFSET + i * HORIZ_INTERVAL

The descriptor also exposes instrument name, source channel, coupling, probe attenuation, valid-point range, subarray count and trigger-time data. The supplied high-level adapter plots the primary single-sweep array. Real fixtures cover both template generations in little-endian signed-word form; a synthetic fixture covers `LECROY_2_3` big-endian signed words. Sequence/subarray, peak-detect and secondary arrays need explicit record modelling before production support.

Browser reference: the four `Lecroy*Trc.js` files and `parseLeCroy` in `app.js`.

## Rigol `.wfm` and `.bin`

Rigol formats differ substantially by instrument family. Dispatch on signature and embedded model first, then use a family-specific parser. The included web reference contains separate generated parsers for DS1000B/C/D/E/Z, DS2000, DS4000, DS6000, MSO5000, MSO7000/8000 and DHO800/1000.

The common workflow is:

1. Validate the family signature, declared header size, record length, enabled-channel flags and payload bounds.
2. Decode the family-specific sample interval, time offset/origin, per-channel sample storage and calibration fields.
3. De-interleave channels where required. Some families store channel data in separate regions; others interleave bytes or carry compressed/block records.
4. Apply the exact family formula from the matching `parse*` function in `app.js`. The sign and ADC reference differ by family; a generic `raw * scale + offset` assumption is unsafe.
5. Retain model, firmware, channel scale/offset, coupling, probe factor, inversion and trigger metadata.

Examples of family formula differences in the browser reference include:

| Family | Calibrated value |
|---|---|
| DS1000B | `voltScale * (127 - raw) - voltOffset` |
| DS1000C/D/E | `voltScale * (125 - raw) - voltOffset` |
| DS1000Z | `yScale * (127 - raw) - yOffset` |
| DS2000/4000/6000 | `-voltScale * (127 - raw) - voltOffset` |
| Newer BIN/DHO | Decode the calibrated values and timing fields defined by that specific container; do not reuse the older byte formula |

The nine supplied Rigol primary files are chosen to catch accidental one-parser implementations. They exercise `wfm1000b`, `wfm1000c`, `wfm1000e`, `wfm1000z`, `wfm2000`, `wfm4000`, `bin5000`, DHO WFM and DHO BIN paths. DS6000 and MSO7000/8000 parser source is included but remains provisional because this hand-off has no real fixture for those paths.

Browser reference: `Rigol*.js` and the `parseB`, `parseC`, `parseE`, `parseZ`, `parse2000`, `parse4000`, `parse6000`, `parseBin*` and `parseDho*` functions in `app.js`.

## Validation rules for SignalForge

- Read into a Web Worker and transfer typed-array buffers back to the UI.
- Bounds-check every offset, declared size, sample count and multiplication before allocating.
- Cap file size, record count, channel count and total decoded samples to defend the static web app from corrupt input.
- Keep the original file bytes and imported samples immutable.
- Do not convert invalid values to zero and do not forward-fill.
- Preserve per-channel time axes; only group channels when their axes really match.
- Report the exact detected brand, family, parser and unsupported variant.
- Use `fixtures/manifest.json` hashes and expected values as cross-language acceptance tests.
