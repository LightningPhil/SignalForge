# TypeScript port map

This map is intended to remove exploratory work from the implementation. The target paths are suggestions; preserve the responsibilities if SignalForge's existing naming differs.

## Shared layer

| Reference | Behaviour to port | Suggested TypeScript target |
|---|---|---|
| `src/scope_examples/models.py` | Immutable record/channel result, SI units and invalid mask | `src/io/scope/types.ts` |
| `src/scope_examples/detect.py` | Cheap content-first probes and dispatch identifiers | `src/io/scope/detect.ts` |
| `src/scope_examples/dispatch.py` | Registry/adapter dispatch and conversion-required state | `src/io/scope/registry.ts` |
| `src/scope_examples/units.py` | Unit cleaning and simple SI prefixes | reuse/extend SignalForge's unit module |
| `src/scope_examples/plotting.py` | Reference visualisation only | do not port; use existing SignalForge plotting |
| `fixtures/golden_results.json` | Cross-language result oracle | parameterised Vitest fixtures |
| `tests/test_corrupt_files.py` | Required defensive cases | Vitest worker tests |

## Tektronix

| Reference | Functions/data | Suggested target |
|---|---|---|
| `src/scope_examples/readers/tek_isf.py` | preamble aliases, IEEE 488.2 definite-length block, sample dtype/scaling | `adapters/tekIsf.ts` |
| `third_party/rigolwfm_web_reference/TektronixWfm001LeWfm.js` and `...Be...` | WFM#001 structures | `adapters/tekWfm/v1.ts` (provisional until fixture exists) |
| `third_party/rigolwfm_web_reference/TektronixWfm002LeWfm.js` and `...Be...` | WFM#002/#003 structures and version-dependent point-density layout | `adapters/tekWfm/v2v3.ts` |
| `app.js:parseTek` | endianness/version choice, calibration, FastFrame extraction | `adapters/tekWfm/index.ts` |
| `src/scope_examples/readers/tek_wfm.py:_validate_static_header` | reject partial files using static EOF/curve bounds | shared Tek WFM validation |

Do not reduce FastFrame to frame zero. Preserve all frames and their timing metadata.

## PicoScope

| Reference | Behaviour | Suggested target |
|---|---|---|
| `src/scope_examples/readers/delimited.py` | delimiter/header detection, two-row names/units, NaN retention | `adapters/picoCsv.ts` or shared delimited importer |
| `src/scope_examples/readers/pico_hdf5.py` | documented channel-group/buffer arrangement | `adapters/picoHdf5.ts` behind `experimental` |
| `scripts/convert_psdata.ps1` | supported conversion instructions | wiki/help only; browser cannot execute it |
| `src/scope_examples/dispatch.py` PSDATA branch | typed `conversion-required` result | `adapters/picoPsdata.ts` |

Do not add an undocumented PSDATA decoder. Keep the real PSDATA sample optional for public redistribution because its forum attachment has no explicit software licence.

## Keysight / Agilent

| Reference | Functions/data | Suggested target |
|---|---|---|
| `third_party/rigolwfm_web_reference/AgilentAgxxBin.js` | AG01/03/10 structure and version-sized lengths | `adapters/keysightAgxx/structure.ts` |
| `app.js:parseAgilentBin` | buffer iteration, labels and normalisation | `adapters/keysightAgxx/index.ts` |
| `src/scope_examples/readers/keysight.py` | strict ordinary-analogue policy, per-channel axes, NaN preservation | same adapter policy layer |

Implementation details:

- AG01/AG10 have 12-byte file and data headers with 32-bit sizes.
- AG03 has 16-byte file and data headers with 64-bit sizes; read with `DataView.getBigUint64` and reject values above `Number.MAX_SAFE_INTEGER` before conversion.
- Ordinary analogue values are little-endian float32 and already calibrated.
- Initially reject segmented, logic/digital, and peak-detect multi-buffer normalisation with `unsupported-variant`.

## Rohde & Schwarz

| Reference | Functions/data | Suggested target |
|---|---|---|
| `third_party/rigolwfm_web_reference/RohdeSchwarzRtpWfmBin.js` | eight-byte payload header | `adapters/rohdeSchwarzRtx/payload.ts` |
| `app.js:rohdeSchwarzParseMetadata` through `rohdeSchwarzDecodeSingleAcquisition` | XML flattening, active sources, scaling and four payload codes | `adapters/rohdeSchwarzRtx/decode.ts` |
| `app.js:parseRohdeSchwarzBin` | pairing and final model | `adapters/rohdeSchwarzRtx/index.ts` |
| `src/scope_examples/readers/rohde_schwarz.py` | stricter byte counts and exact XYDOUBLEFLOAT time array | use as normative behaviour |

Unlike the upstream convenience wrapper, the SignalForge adapter must keep the complete XYDOUBLEFLOAT time column. Pair filenames case-insensitively but retain original case for provenance.

## Teledyne LeCroy

| Reference | Functions/data | Suggested target |
|---|---|---|
| `Lecroy10LeTrc.js`, `Lecroy10BeTrc.js`, `Lecroy23LeTrc.js`, `Lecroy23BeTrc.js` | four template/byte-order structures | `adapters/lecroyTrc/structures/` |
| `app.js:parseLeCroy` | WAVEDESC search, selection, logical blocks and calibration | `adapters/lecroyTrc/index.ts` |
| `src/scope_examples/readers/lecroy.py` | vendor-neutral output expectation | result normaliser |

Select template and byte order from the descriptor before reading multi-byte fields. Use declared logical block lengths to locate `WAVE_ARRAY_1`; never assume samples begin immediately after a 320/346-byte descriptor.

## Rigol

| Fixture-proven parser | Browser structure | Browser normaliser | Suggested target/status |
|---|---|---|---|
| `wfm1000b` | `Rigol1000bWfm.js` | `parseB` | `rigol/ds1000b.ts` — verified |
| `wfm1000c` | `Rigol1000cWfm.js` | `parseC` | `rigol/ds1000c.ts` — verified |
| `wfm1000e` | `Rigol1000eWfm.js` | `parseE` | `rigol/ds1000e.ts` — verified |
| `wfm1000z` | `Rigol1000zWfm.js` | `parseZ` | `rigol/ds1000z.ts` — verified |
| `wfm2000` | `Rigol2000Wfm.js` | `parse2000` | `rigol/ds2000.ts` — verified |
| `wfm4000` | `Rigol4000Wfm.js` | `parse4000` | `rigol/ds4000.ts` — verified |
| `bin5000` | `RigolMso5000Bin.js` | `parseBin5000` | `rigol/mso5000.ts` — verified |
| `dho1000` WFM | `RigolDho8001000Wfm.js` | `parseDhoWfm` | `rigol/dhoWfm.ts` — verified |
| `dho1000` BIN | `RigolDho8001000Bin.js` | `parseDhoBin` | `rigol/dhoBin.ts` — verified |
| `wfm6000` | `Rigol6000Wfm.js` | `parse6000` | provisional; do not advertise |
| `bin7000_8000` | `Rigol70008000Bin.js` | `parseBin70008000` | provisional; do not advertise |

Keep family modules separate. The ADC sign/reference and layout vary; a generic Rigol `.wfm` formula is unsafe.

## Code-generation policy

The included JavaScript parser files were generated from Kaitai schemas. Cursor may either:

1. Regenerate TypeScript from the exact schemas and add a pinned Kaitai runtime; or
2. Port the bounded reads to hand-written strict TypeScript.

Whichever route is chosen must:

- preserve the BSD-3-Clause notice;
- add checked reads before every offset/length;
- avoid `any` at the public adapter boundary;
- lazy-load brand/family modules;
- be covered by the same golden and corrupt-file tests;
- use no public CDN at runtime.

Do not copy the viewer UI, Plotly setup or unrelated Siglent/Yokogawa parsers into SignalForge for this task.

