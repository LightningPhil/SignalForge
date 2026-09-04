# SignalForge oscilloscope import reference

This bundle is a tested Python reference and implementation hand-off for importing and plotting Tektronix, PicoScope, Keysight, Rohde & Schwarz, Teledyne LeCroy and Rigol waveform files. It is intended to help Cursor implement equivalent browser-side TypeScript import adapters and truthful built-in wiki documentation in SignalForge.

Start with `START_HERE.md`. The authoritative implementation contract is `SIGNALFORGE_IMPORT_SSOT.md`; evidence-qualified claims are in `support_matrix.json`.

## Supported formats

| Brand and format | Python handling | SignalForge recommendation |
|---|---|---|
| Tektronix WFM | Verified against official WFM#003 single-frame and 100-frame FastFrame fixtures. The reference independently rejects truncated files that the vendor library can recover as shorter traces. | Port the required structures and validate every frame against the supplied golden results. Keep other WFM versions provisional. |
| Tektronix ISF | Direct parser; signed int16 big-endian synthetic fixture. | Port directly, but label the present evidence as layout-tested until real target-scope files are added. |
| PicoScope CSV | Direct parser with two-row headings, SI-prefixed units and explicit NaN retention; synthetic fixture. | Port directly and keep unusual locale/digital/maths variants outside the claim until tested. |
| PicoScope HDF5 | Parsed with h5py. The reader uses the documented channel-group and timing-dataset arrangement and tolerates common naming variations. | Use a browser HDF5 library. Treat this adapter as provisional until it has been tested against files from the exact PicoScope 7 release used at work. |
| PicoScope PSDATA | Detected, but not decoded. Optional conversion works when PicoScope 7 is installed. | Do not reverse-engineer PSDATA. Show a clear conversion instruction or accept an open export. |
| Keysight/Agilent AGxx BIN | Real AG10 single/two-channel fixtures plus synthetic AG01/AG03 length-field branches. | Verify AG10; label AG01/AG03 layout-tested. Reject segmented, logic and peak-detect variants explicitly. |
| Rohde & Schwarz RTP/RTO/RTE BIN | Direct paired-file reader. Real float32, int8 and XYDOUBLEFLOAT fixtures plus synthetic int16. Explicit float64 X values are preserved. | Require both files, verify exact byte counts and retain explicit time. Keep int16 labelled layout-tested. |
| Teledyne LeCroy TRC | Real `LECROY_1_0` and `LECROY_2_3` little-endian word files, plus a synthetic big-endian word fixture. | Port matching parser/calibration paths. Big-endian remains layout-tested; sequences/subarrays remain unsupported. |
| Rigol WFM/BIN | Nine fixture-proven paths: DS1000B/C/D-E/Z, DS2000, DS4000, MSO5000 BIN and DHO800 WFM/BIN. | Keep family-specific adapters. DS6000 and MSO7000/8000 remain provisional without real fixtures. |

Pico Technology describes PSDATA as a proprietary session format. Pico support states that third-party decoding is not available. PicoScope 7 provides a supported batch-conversion command for CSV, text and MATLAB exports. Recent PicoScope 7 releases also offer HDF5 export.

## Quick start

Use Python 3.11 or later.

`requirements.txt` contains supported version ranges. `requirements-lock.txt` records the exact environment used for this bundle's validation.

Windows PowerShell:

    py -m venv .venv
    .venv\Scripts\Activate.ps1
    python -m pip install -r requirements.txt
    python read_scope.py --all-fixtures --output-dir plots
    python -m pytest

Linux or macOS:

    python3 -m venv .venv
    source .venv/bin/activate
    python -m pip install -r requirements.txt
    python read_scope.py --all-fixtures --output-dir plots
    python -m pytest

The all-fixtures command reads 25 directly supported primary fixtures and creates PNG plots. It reports the PSDATA fixture as requiring PicoScope conversion. This is the expected result when PicoScope is not installed.

Read individual files:

    python read_scope.py fixtures\tektronix\analog_waveform.wfm --output-dir plots
    python read_scope.py fixtures\tektronix\representative_pulse.isf --output-dir plots
    python read_scope.py fixtures\picoscope\representative_pulse.csv --output-dir plots
    python read_scope.py fixtures\keysight\keysight_dsox1102g_two_channel.bin --output-dir plots
    python read_scope.py fixtures\rohde_schwarz\rs_rtp_two_channel.bin --output-dir plots
    python read_scope.py fixtures\teledyne_lecroy\lecroy_waverunner_template_2_3.trc --output-dir plots
    python read_scope.py fixtures\rigol\rigol_ds1054z.wfm --output-dir plots

Inspect a file without plotting it:

    python read_scope.py fixtures\picoscope\representative_pulse.h5 --metadata-only

## PicoScope PSDATA conversion

If PicoScope 7 is installed, use the supplied PowerShell wrapper:

    .\scripts\convert_psdata.ps1 -InputPath .\fixtures\picoscope\pico_5444d_clock_capture.psdata -OutputDirectory .\converted

The wrapper finds a common PicoScope 7 installation or accepts the PicoScopeExecutable parameter. It copies only the selected input into a temporary directory because PicoScope's BatchConvert command operates on a directory.

The underlying PicoScope 7 command is:

    PicoScope.exe BatchConvert <source-directory> <destination-directory> .csv

After conversion, read the generated CSV files with read_scope.py.

PicoScope 6 has a different command-line interface:

    PicoScope /c <input.psdata> /d <destination-directory> /f csv /b all /q

Do not claim that SignalForge can read PSDATA natively. The file can contain waveform buffers, settings, maths channels, rulers, measurements, notes and labels. A CSV conversion does not necessarily preserve all of this session information.

## Reader output model

Every reader returns a list of WaveformRecord objects. Each record contains:

- A time array in seconds.
- One or more named channels.
- Channel values converted to base SI units where the source provides recognised units.
- The original display unit and applied scale.
- Source-format metadata.
- A frame index for multi-frame captures.

Invalid numeric CSV values are retained as NaN. They are not silently replaced. This behaviour is important for SignalForge's immutable raw-data and quality-mask design.

## Fixtures

| Fixture | Purpose | Expected result |
|---|---|---|
| analog_waveform.wfm | Official Tektronix single-frame analogue WFM | 50,000 samples and a 40 ps interval |
| fastframe_5mhz_100frames.wfm | Official Tektronix 5 Series FastFrame WFM | 100 frames, 2,500 samples per frame and a 160 ps interval |
| representative_pulse.isf | Deterministic Tektronix ISF binary-block example | 4,000 samples and two-byte signed big-endian data |
| pico_5444d_clock_capture.psdata | Real PicoScope 5444D native capture | Detection succeeds; direct read gives an actionable proprietary-format error |
| representative_pulse.csv | PicoScope-style two-channel CSV | 4,000 samples with microsecond, millivolt and ampere units |
| representative_pulse.h5 | Documented PicoScope-style channel and buffer HDF5 layout | Two channels and one buffer per channel |
| keysight_dsox1102g_single_channel.bin | Keysight/Agilent AG10 ordinary analogue record | One channel, 2,000 samples and a 500 ns interval |
| keysight_dsox1102g_two_channel.bin | Keysight/Agilent AG10 multi-waveform container | Two aligned channels, 4,000 samples and a 500 ps interval |
| keysight_synthetic_ag01.bin / ag03.bin | Deterministic AG01/AG03 layout branches | Eight exact float32 samples; synthetic evidence only |
| rs_rtp_two_channel.bin + rs_rtp_two_channel.Wfm.bin | R&S XML description and float32 payload pair | Two aligned channels, 4,000 samples and a 1.25 µs interval |
| rs_rtp_int8.bin + companion | Real R&S integer payload | One calibrated int8 channel and 4,000 samples |
| rs_rtp_explicit_time.bin + companion | Real R&S XYDOUBLEFLOAT payload | One channel and the complete stored float64 time axis |
| rs_synthetic_int16.bin + companion | Deterministic R&S integer layout | Exact int16 scaling branch; synthetic evidence only |
| lecroy_7200_template_1_0.trc | Older LeCroy template | `LECROY_1_0`, one channel and 5,002 samples |
| lecroy_waverunner_template_2_3.trc | Newer SCPI-prefixed LeCroy template | `LECROY_2_3`, one channel and 502 samples |
| lecroy_synthetic_be_word.trc | Big-endian `LECROY_2_3` word layout | Seven exact samples; synthetic evidence only |
| rigol_ds1204b.wfm | DS1000B family | Four channels, 8,192 samples and `wfm1000b` parser |
| rigol_ds1202ca.wfm | DS1000C family | Two channels, 5,120 samples and `wfm1000c` parser |
| rigol_ds1102d.wfm | Legacy two-channel Rigol family | 1,024 samples per channel and a 10 µs interval |
| rigol_ds1054z.wfm | Four-channel interleaved Rigol family | 278 samples per channel and a 4 ns interval |
| rigol_ds2072a.wfm | DS2000 family | One channel, 14,000 samples and `wfm2000` parser |
| rigol_ds4022.wfm | DS4000 family | Four channels, 7,000 samples and `wfm4000` parser |
| rigol_mso5000.bin | MSO5000 BIN family | Four channels, 1,000 samples and `bin5000` parser |
| rigol_dho824.wfm | Newer Rigol block/float family | One channel, 10,000 samples and a 400 ns interval |
| rigol_dho824.bin | DHO800 `RG03` BIN family | One channel, 10,000 samples and a 400 ns interval |

The representative pulse is synthetic. It contains a fast voltage step, a slower current rise, overshoot, damped ringing, pre-trigger noise and one deliberately invalid CSV sample. It is suitable for checking import fidelity and later pulse-processing work. It is not measured data.

See SOURCES_AND_LICENCES.md and fixtures/manifest.json for provenance, hashes and headline metadata. `fixtures/golden_results.json` contains the complete cross-language acceptance oracle for all 25 decoded primary fixtures.

See FORMAT_NOTES_ADDITIONAL_BRANDS.md for binary layouts, detection signatures and calibration equations. `TYPESCRIPT_PORT_MAP.md` maps each route to the included browser parser and Kaitai schema source.

## Acceptance criteria for the TypeScript port

1. The importer shall detect the file from its contents where a reliable signature exists. It shall not rely only on the extension.
2. The importer shall keep imported samples immutable.
3. The importer shall retain invalid, missing and non-finite samples as explicit quality information. It shall not forward-fill them.
4. The importer shall convert the horizontal axis to seconds and shall retain the original unit.
5. The importer shall retain each channel's name, original unit and SI scale.
6. The Tektronix ISF importer shall apply Y = (raw - YOFF) × YMULT + YZERO.
7. The Tektronix ISF importer shall apply X = XZERO + (index - PT_OFF) × XINCR.
8. The Tektronix WFM importer shall pass the supplied single-frame and 100-frame fixtures.
9. The PicoScope CSV importer shall recognise separate name and unit rows.
10. The application shall reject PSDATA with a concise explanation and conversion instructions. It shall not present the file as corrupt.
11. Parsing shall run outside the user-interface thread for large files.
12. Tests shall compare sample counts, time intervals, frame counts, units, invalid indices, selected values and statistics against `fixtures/golden_results.json` using its stated tolerances.
13. Keysight AGxx import shall validate every declared header and buffer length and preserve each channel's X origin and increment.
14. R&S import shall require the matching XML description and `.Wfm.bin` payload and validate their format code and hardware record length against one another.
15. LeCroy import shall find `WAVEDESC`, select the correct template and byte order, and use the declared logical-block lengths rather than a fixed data offset.
16. Rigol import shall dispatch by content to a family-specific parser. All nine supplied primary files shall pass independently.
17. Unsupported segmented/history, secondary-array, peak-detect, logic or bus variants shall produce an explicit unsupported-variant result rather than a partial or plausible-looking waveform.
18. The application wiki shall preserve the evidence levels in `support_matrix.json` and document both working variants and remaining limits.

## Important limitations

- Tektronix has several waveform families and WFM versions. The two fixtures do not prove support for every model or firmware version.
- ISF command abbreviations vary by instrument family. The reader includes the common full and abbreviated fields, but more real files are required.
- PicoScope CSV headings and units can vary with software version, locale, view type and enabled digital or maths channels.
- The HDF5 export appeared in recent PicoScope 7 releases. Obtain a real export from the work instrument before treating the adapter as complete.
- Binary import must be validated against files from each exact scope model and firmware family used at work.
- Keysight's high-level reference currently normalises ordinary analogue buffers. Its low-level parser exposes peak-detect, digital and segmented structures, but SignalForge needs a richer record model before enabling them.
- The R&S reference intentionally handles single-acquisition analogue NORMAL/AVERAGE captures. R&S's official reader supports substantially more signal and history types. Int16 has synthetic rather than real-hardware evidence.
- The LeCroy reference plots the primary array from one trace. Sequence/subarray timing and secondary arrays require further implementation.
- Rigol uses several unrelated WFM/BIN layouts. Nine primary fixtures prove nine parser paths, not every model or firmware revision.
- `third_party/rigolwfm_web_reference` is migration source, not a drop-in SignalForge dependency. Convert the required paths to strict TypeScript and add bounds/allocation limits.
