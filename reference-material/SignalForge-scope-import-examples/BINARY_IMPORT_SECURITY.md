# Defensive binary-import requirements

Oscilloscope files are untrusted local input. A static web application cannot rely on server-side scanning or process isolation, so parsers need explicit resource and bounds controls.

## Threats to handle

| Threat | Typical malformed field | Required response |
|---|---|---|
| Out-of-bounds read | data offset beyond `File.size` | typed `truncated-file` or `invalid-header`; no fallback parser |
| Excessive allocation | point/channel/frame count close to 2³²/2⁶⁴ | reject before multiplying or allocating |
| Integer precision loss | AG03 uint64 length above `Number.MAX_SAFE_INTEGER` | reject before conversion to `number` |
| Multiplication overflow | `points × channels × bytesPerPoint` | checked arithmetic against remaining bytes and decode budget |
| Partial plausible result | a library stops at EOF and returns fewer samples | compare against independent declared extents/counts and reject |
| Decompression bomb | compressed/block waveform declares enormous output | cap decompressed bytes and enforce progress/cancellation |
| Ambiguous pairing | two case-equivalent R&S payload names | ask the user to select; never choose arbitrarily |
| Format confusion | `.bin` or `.wfm` routed by extension | content-first probes; a strong match owns subsequent errors |
| UI denial of service | synchronous parsing of a long record | dedicated worker, cancellation and progress messages |
| XML abuse | huge R&S metadata or entity-heavy input | XML-size cap and parser without external-resource fetching |

The Python reference now independently checks the Tek WFM static EOF extent because `tm-data-types==0.5.0` can recover a truncated file as a shorter, visually plausible trace. SignalForge must be strict by default; data-recovery tooling is a separate mode and must never masquerade as a clean import.

## Checked-reader primitive

Centralise reads rather than repeating unchecked `DataView` calls:

```ts
class CheckedReader {
  constructor(
    readonly view: DataView,
    readonly byteLength: number,
    public offset = 0,
  ) {}

  require(bytes: number, context: string): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.offset > this.byteLength - bytes) {
      throw importError('truncated-file', `${context} exceeds the source bounds`);
    }
  }

  checkedProduct(a: number, b: number, context: string): number {
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0) {
      throw importError('invalid-header', `${context} is not a safe non-negative integer`);
    }
    const result = a * b;
    if (!Number.isSafeInteger(result)) {
      throw importError('invalid-header', `${context} overflows JavaScript integer precision`);
    }
    return result;
  }
}
```

Also validate absolute offsets with `offset <= fileSize - requiredBytes`; avoid `offset + requiredBytes <= fileSize`, which can hide overflow in other languages.

## Decode-budget design

Do not use one undocumented magic sample limit. Calculate expected resident memory before decode:

```text
time bytes        = samples × 8
channel bytes     = samples × 8 × analogue channels
quality bytes     = samples × 1 × analogue channels
temporary bytes   = parser-specific raw/decompression workspace
frame index bytes = frame count × metadata estimate
```

Recommended initial policy:

- 16 MiB maximum R&S XML description.
- 64 channels maximum unless a tested format genuinely requires more.
- 100,000 records/frames maximum.
- 512 MiB default total decoded-plus-temporary budget on desktop.
- 128 MiB default on devices reporting no more than 4 GiB device memory.
- Never allocate more than the actual remaining source bytes can justify.

Keep these named/configurable and show the predicted requirement in a `decode-budget-exceeded` error. These are product defaults, not format claims. For longer records, implement lossless chunked decoding/storage; do not silently downsample the immutable raw record.

## Worker protocol

- Assign a monotonically increasing request ID.
- Cancel old requests when a new import begins.
- Check cancellation between frames/blocks and during large copies.
- Ignore a result whose request ID is no longer current.
- Transfer ArrayBuffers exactly once where practical.
- Do not transfer the application's only mutable reference to raw data and then continue to use it.
- Convert unknown thrown values into a typed, sanitised import failure. Keep stack traces in development logs, not the user-facing wiki/error.

## Format-specific validation checklist

### Tektronix WFM

- Byte-order marker, WFM version and static header size.
- Declared minimum EOF extent and curve-buffer offset.
- Curve offsets in monotonic order and within the source.
- Bytes-per-point compatible with explicit data format.
- FastFrame metadata count agrees with available blocks.
- Full frame count present; never accept a shortened final frame.

### Tektronix ISF

- `CURVE` binary-block marker and digit count 1–9.
- Decimal payload length fits the file and is divisible by bytes per sample.
- `NR_PT` equals decoded sample count.
- Supported encoding, numeric format, byte order and horizontal unit.

### Keysight/Agilent AGxx

- Cookie and version-sized file length exactly match `File.size`.
- Waveform/data header sizes meet their minimum and fit.
- Every uint64 is safe before conversion.
- Buffer length equals `points × bytesPerPoint` for the normal analogue path.
- Reject repeated segment/channel records and multiple min/max buffers until modelled.

### Rohde & Schwarz RTx

- Exactly one named companion and a bounded XML description.
- Required XML properties exist and are finite/valid.
- `leading + recordLength <= hardwareRecordLength`.
- Payload header format/record length agree with XML.
- Payload has exactly the byte count implied by format, rows and channels.
- XYDOUBLEFLOAT rows retain explicit float64 X values.

### Teledyne LeCroy TRC

- A `WAVEDESC` occurrence is accepted only if template, COMM_ORDER, descriptor size and block sizes are plausible.
- Sum logical block sizes with checked arithmetic.
- `WAVE_ARRAY_1` byte count agrees with COMM_TYPE and point count.
- Reject subarrays/secondary arrays until their timing semantics are implemented.

### Rigol

- Family signature plus embedded model/version dispatch.
- Family-specific header, channel flags, record length and payload bounds.
- Exact de-interleave/block/decompression output length.
- Never reuse another family's sign, reference code or scale formula.

## Minimum negative test set

For every production binary adapter, test:

1. Empty and signature-only file.
2. Truncation at header midpoint, immediately before samples and within final samples.
3. Declared size one byte smaller and one byte larger than actual.
4. Maximum integer and a multiplication-overflow combination.
5. Unknown enum/sample type.
6. Unsupported but recognisable record class.
7. Non-finite calibration or time fields.
8. Cancellation during the largest fixture.
9. Repeated imports to detect stale-result and detached-buffer errors.

R&S additionally requires missing, duplicate, wrong-name and header/XML-mismatch pair tests. Tests must assert the failure code as well as “did not crash”.

