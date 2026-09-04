# Cursor task: implement multibrand oscilloscope import

Use this bundle as the reference and fixture set. Implement equivalent functionality in the existing SignalForge TypeScript application. Read `START_HERE.md`, then follow `SIGNALFORGE_IMPORT_SSOT.md` as the authoritative contract. Do not begin a separate research/design phase unless a real contradiction is found in the supplied evidence.

## Scope

Implement content-first adapters for:

1. Tektronix WFM single-frame and FastFrame.
2. Tektronix ISF binary blocks.
3. PicoScope two-row CSV.
4. PicoScope HDF5 behind an experimental label.
5. Explicit PicoScope PSDATA detection and a conversion-required message.
6. Keysight/Agilent AG01, AG03 and AG10 ordinary analogue `.bin` records.
7. Rohde & Schwarz RTP/RTO/RTE saved waveform pairs: XML `.bin` plus `.Wfm.bin` payload.
8. Teledyne LeCroy `LECROY_1_0` and `LECROY_2_3` `.trc`, both byte orders and optional SCPI prefixes.
9. Rigol WFM/BIN family dispatch. Mandatory fixture-proven paths are DS1000B, DS1000C, DS1000D/E, DS1000Z, DS2000, DS4000, MSO5000 BIN and DHO800 WFM/BIN. Keep DS6000 and MSO7000/8000 provisional until real fixtures exist.
10. A built-in wiki page describing exactly what is verified, layout-tested, experimental, conversion-required, provisional and unsupported.

Do not add a backend. Read locally in a Web Worker. Transfer typed-array buffers to the UI rather than copying large arrays repeatedly.

## Source material in this ZIP

- `FORMAT_NOTES_ADDITIONAL_BRANDS.md`: signatures, layouts, equations and limitations.
- `fixtures/manifest.json`: SHA-256 hashes and expected results.
- `fixtures/golden_results.json`: selected decoded axes/values, statistics, invalid indices and numeric tolerances for direct TypeScript comparison.
- `support_matrix.json`: authoritative evidence level and permitted wiki claim for every variant.
- `src/scope_examples`: working Python dispatch and normalisation.
- `third_party/rigolwfm_web_reference`: working browser JavaScript, generated Kaitai parsers and format-specific scaling. Migrate the required paths to strict TypeScript; do not embed the viewer wholesale.
- `TYPESCRIPT_PORT_MAP.md`: exact reference-function to TypeScript-module map.
- `BINARY_IMPORT_SECURITY.md`: checked-read, budget, worker and negative-test requirements.
- `WIKI_CONTENT_DRAFT.md`: ready-to-adapt built-in documentation.
- `SOURCES_AND_LICENCES.md`: provenance and licence obligations.

## Mandatory data rules

- Preserve imported samples and source bytes as immutable raw data.
- Retain NaN, missing and invalid samples in a quality mask. Never forward-fill during import.
- Convert time to seconds and recognised simple channel units to base SI units.
- Retain original units, channel labels, file names, model, firmware, parser/family and calibration metadata.
- Preserve every Tektronix FastFrame frame.
- Preserve per-channel time axes. Group channels only when their axes match.
- Validate all offsets, declared lengths and sample counts before allocating or reading.
- Enforce sensible limits for file size, decoded samples, channels and records.
- Reject unsupported variants explicitly. Never return a plausible partial waveform from a format you did not fully decode.

## Brand-specific requirements

### Keysight

- Detect `AG01`, `AG03` and `AG10` by content.
- Parse the version-specific file and buffer length fields.
- Decode ordinary analogue float32 buffers and use `time[i] = xOrigin + i * xIncrement`.
- Pass the two real AG10 files and the synthetic AG01/AG03 layout fixtures. Keep AG01/AG03 labelled `layout-tested` until real files are obtained.
- Initially reject segmented, logic and peak-detect/multi-buffer normalisation with an actionable unsupported-variant result.

### Rohde & Schwarz

- When files are dropped/selected, create a case-insensitive filename map and pair `<name>.bin` with `<name>.Wfm.bin`.
- Parse the XML metadata first; verify the payload's format code and hardware record length against it.
- Implement the four payload codes described in the format note. Float32, int8 and XYDOUBLEFLOAT have real fixtures; int16 has a synthetic layout fixture.
- Preserve every stored XYDOUBLEFLOAT time value rather than recreating a linear axis.
- Pass the supplied two-channel, int8, explicit-time and synthetic int16 pairs.
- Initially reject history/multi-acquisition and unsupported signal sources explicitly.

### Teledyne LeCroy

- Locate a plausible `WAVEDESC`; do not assume byte zero.
- Select template `LECROY_1_0` or `LECROY_2_3` and HIFIRST/LOFIRST from the descriptor.
- Use declared logical-block lengths to locate the primary sample array.
- Apply the template-specific vertical offset and horizontal-axis equations in the format note.
- Pass both supplied real template fixtures and the synthetic big-endian signed-word fixture. Keep the latter labelled `layout-tested`.
- Do not claim sequence/subarray or secondary-array support until those records have dedicated tests.

### Rigol

- Dispatch by signature/model to a family-specific parser; `.wfm` is not a format identifier by itself.
- Port the matching family calibration logic from the included browser reference.
- Pass all nine supplied Rigol primary fixtures independently.
- Keep untested families labelled as provisional even when a parser exists.

## PicoScope PSDATA behaviour

Do not attempt an undocumented parser. Identify PSDATA as a valid proprietary PicoScope session, request CSV/HDF5 export and show the PicoScope BatchConvert route. SignalForge is backend-free and cannot run installed vendor software from GitHub Pages.

## Completion gate

The work is complete only when:

- All 25 directly decoded primary fixtures pass against `fixtures/golden_results.json` within its stated tolerances, as well as the headline expectations and hashes in `fixtures/manifest.json`.
- The R&S description and payload must both be present and mismatched pairs fail.
- All four Keysight files, all three LeCroy files and all nine Rigol files pass.
- The 100-frame Tek WFM produces 100 records.
- The R&S XYDOUBLEFLOAT fixture retains the exact explicit time column.
- PicoScope CSV reports exactly one invalid Channel B sample.
- PSDATA produces the defined conversion-required state.
- Corrupt/truncated copies of every binary family fail cleanly without excessive allocation.
- Imported raw data remain unchanged after the default pipeline.
- Production build, existing tests and new browser tests pass.
- The built-in wiki reflects `support_matrix.json`, includes the evidence legend and does not promote synthetic/provisional paths to verified.

Report implemented adapters, a fixture-by-fixture result, unsupported variants, wiki location, new dependencies/licences and the commit hash. Do not perform unrelated refactoring.
