# SignalForge native oscilloscope import SSOT

This document is the authoritative task specification for adding local oscilloscope-file import to SignalForge. Where another note differs, this document and `support_matrix.json` take precedence.

## Required outcome

Implement browser-side import of the fixture-proven Tektronix, PicoScope, Keysight/Agilent, Rohde & Schwarz, Teledyne LeCroy and Rigol variants in this ZIP. Preserve the existing backend-free GitHub Pages architecture. Run binary parsing in a Web Worker, return a vendor-neutral immutable result, expose actionable errors, and update the built-in wiki with evidence-qualified support and limitations.

Do not undertake unrelated numerical, UI or dependency refactoring as part of this task.

## Evidence vocabulary

SignalForge shall use these exact concepts internally and in its documentation:

| Level | Meaning |
|---|---|
| `verified` | The adapter passes a supplied vendor or real hardware-export fixture for this variant. |
| `layout-tested` | The adapter passes a deterministic synthetic fixture, but no real instrument file in this bundle proves it. |
| `experimental` | The route follows published structure, but representative real export evidence is missing. |
| `conversion-required` | The valid format is recognised but intentionally cannot be decoded locally. |
| `provisional` | Parser source exists without a supplied acceptance fixture. |
| `unsupported` | The variant is recognised and rejected explicitly. |

`support_matrix.json` is the source of truth. A parser existing in `third_party/` is not, by itself, support.

## Proposed import boundary

Names may be adapted to SignalForge's current structure, but keep these responsibilities separate:

```text
src/io/scope/
  types.ts                 vendor-neutral records and errors
  detect.ts                content-first format probes only
  groupFiles.ts            multi-file pairing, especially R&S
  registry.ts              probe/adapter registration and dispatch
  limits.ts                checked arithmetic and decode budgets
  workerProtocol.ts        typed worker request/result messages
  import.worker.ts         parsing execution and cancellation
  adapters/
    tekWfm.ts
    tekIsf.ts
    picoCsv.ts
    picoHdf5.ts
    picoPsdata.ts
    keysightAgxx.ts
    rohdeSchwarzRtx.ts
    lecroyTrc.ts
    rigol/
      dispatch.ts
      ...family-specific adapters
```

Format detection must not import the plotting/UI layer. Adapters must not write to global application state. The integration layer alone turns a successful import into SignalForge shots/channels.

## Vendor-neutral TypeScript contract

Use an equivalent of the following; align names with the existing data model without losing fields:

```ts
export type ImportSupportLevel =
  | 'verified'
  | 'layout-tested'
  | 'experimental'
  | 'conversion-required'
  | 'provisional'
  | 'unsupported';

export interface SourceFileRef {
  readonly name: string;
  readonly size: number;
  readonly lastModified: number;
  readonly role: 'primary' | 'companion';
}

export interface ImportedChannel {
  readonly name: string;
  readonly values: Float64Array;
  readonly invalidMask: Uint8Array;
  readonly unit: string;
  readonly sourceUnit: string;
  readonly sourceToSiScale: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ImportedWaveformRecord {
  readonly formatId: string;
  readonly supportLevel: ImportSupportLevel;
  readonly frameIndex: number;
  readonly timeSeconds: Float64Array;
  readonly channels: readonly ImportedChannel[];
  readonly sourceFiles: readonly SourceFileRef[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly warnings: readonly string[];
}

export type ScopeImportFailureCode =
  | 'unrecognised-format'
  | 'missing-companion'
  | 'ambiguous-companion'
  | 'conversion-required'
  | 'unsupported-variant'
  | 'truncated-file'
  | 'invalid-header'
  | 'length-mismatch'
  | 'decode-budget-exceeded'
  | 'cancelled';
```

Use a discriminated success/failure result. Do not infer error handling from message text. Include detected brand/family, source filenames and an actionable user message in failures.

## Immutable-data rules

- Never mutate a `File`, source `ArrayBuffer` or imported typed array after publishing a result.
- Never forward-fill, interpolate or replace an invalid source value during import.
- Keep an invalid/quality mask aligned with every channel.
- Retain original units and scaling metadata even when values are converted to base SI units.
- Retain each channel's real time axis. Group channels only when axes match.
- Preserve all Tektronix FastFrame frames.
- For R&S XYDOUBLEFLOAT, preserve every stored float64 time value; do not reconstruct the axis from the first interval.
- Do not silently decimate long records. If a record exceeds a budget, return a budget error or use a lossless chunked storage route.
- The default processing pipeline must not alter imported raw arrays.

## Content-first detection order

Probe cheap, strong signatures before invoking a full parser:

1. HDF5 eight-byte signature.
2. Tektronix WFM byte-order and `:WFM#00x` marker.
3. Tektronix ISF preamble plus `CURVE` binary block.
4. Keysight/Agilent `AG01`, `AG03` or `AG10` cookie.
5. R&S XML `Database`/`SaveItemType="Data"` description.
6. LeCroy plausible `WAVEDESC` descriptor and template.
7. Rigol family signatures and embedded model fields.
8. PicoScope PSDATA signature/extension.
9. Delimited text heuristics.

Extension may narrow an ambiguous probe but must not override contradictory content. `.wfm` and `.bin` are shared by unrelated manufacturers.

After a strong signature matches, a parse failure must be returned for that format. Do not fall through to another parser and accidentally produce a plausible waveform.

## Multi-file selection and R&S pairing

The file picker and drag-and-drop target must accept multiple files. Build a case-insensitive map without discarding original names. Pair a description `<stem>.bin` with exactly one `<stem>.Wfm.bin`.

- Missing companion: `missing-companion`, naming the required file.
- More than one case-equivalent candidate: `ambiguous-companion`; let the user choose.
- Standalone payload: explain that it is the sample payload and ask for the description.
- Validate payload format code, hardware record length and exact byte count against XML before allocation/decode.
- Retain both source-file references in the import result and project provenance.

## Adapter implementation order and gates

### Gate 1 — framework and existing CSV compatibility

- Add the types, registry, worker protocol, checked readers and error taxonomy.
- Keep the current CSV importer behaviour covered by regression tests.
- Add `multiple` file selection and R&S grouping without redesigning the rest of the application.
- Ensure cancel/retry works and stale worker results cannot overwrite a newer import.

### Gate 2 — small direct adapters

- Tektronix ISF.
- PicoScope CSV.
- PSDATA detection and conversion-required help.
- Keysight AGxx ordinary analogue.
- R&S pair decoder, including exact XYDOUBLEFLOAT time.

Gate passes only when corresponding `golden_results.json` entries pass and corrupt cases fail.

### Gate 3 — structured binary adapters

- Tektronix WFM single-frame and FastFrame.
- LeCroy TRC template/byte-order dispatch.
- Rigol family dispatch and only the fixture-proven family normalisers.
- PicoScope HDF5 behind an experimental label if a suitable locally bundled browser dependency is justified.

Gate passes only when every directly supported fixture passes, the 100-frame file returns 100 records, and no format is identified only by extension.

### Gate 4 — product integration and wiki

- Import into immutable raw session/shot/channel objects.
- Present format, model, firmware, source files, frames, channels, units and warnings in an import summary before processing.
- Show actionable unsupported/conversion-required states.
- Update the built-in wiki from `WIKI_CONTENT_DRAFT.md`, correcting it to match the actual test results.
- Add a visible “support evidence” legend and date.

## Cross-language acceptance procedure

For each entry in `fixtures/golden_results.json`:

1. Confirm content detection and source format.
2. Confirm record count, frame indices and sample counts exactly.
3. Confirm channel names, units, source units and invalid indices exactly.
4. Compare selected time/value samples and statistics with the supplied per-record/per-channel tolerance.
5. Confirm required metadata subset fields.

Do not compare only plots. A visually plausible trace can have the wrong sign, offset, unit, byte order or time origin.

Add separate negative tests for truncation, impossible lengths, unsupported enums, missing companions and mismatched pairs. `tests/test_corrupt_files.py` supplies Python examples.

## Dependency policy

- Reuse the format logic in `third_party/rigolwfm_web_reference` under its BSD-3-Clause terms, but port only required modules to strict TypeScript.
- Preserve the BSD copyright/licence notice in source distributions and About/licence documentation.
- Bundle dependencies through Vite; no runtime CDN.
- Do not ship the Python packages in the production web application.
- Record any HDF5/Kaitai dependency, version, licence and compressed bundle cost.
- Lazy-load large format modules after detection so ordinary CSV users do not pay the full parser cost.

## Completion gate

The task is complete only when all of the following are true:

- Production build, existing tests and new importer tests pass on `master`.
- Every claimed supported variant passes its fixture and golden values.
- The 100-frame Tektronix WFM produces 100 separate records.
- Pico CSV retains one invalid Channel B sample at index 2137.
- R&S explicit-time import retains the supplied float64 time column.
- Missing/mismatched R&S pairs fail with the correct typed error.
- Truncated/corrupt files for every binary family fail without hanging or excessive allocation.
- PSDATA produces `conversion-required`, not “corrupt”.
- Layout-tested, experimental and provisional variants remain labelled as such.
- Raw imported arrays remain unchanged after the default pipeline.
- The built-in wiki reports the implemented support and remaining limitations accurately.

Cursor's final response must provide fixture results, implemented variants, unsupported variants, wiki location, dependency/licence changes and the commit hash. Do not claim completion from compilation alone.

