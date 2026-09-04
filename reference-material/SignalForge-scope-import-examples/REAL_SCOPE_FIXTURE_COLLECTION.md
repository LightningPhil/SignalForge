# Collecting real scope fixtures

The next confidence gain will come from files produced by the exact oscilloscopes and firmware used at work. Shared extensions do not guarantee shared layouts.

## Minimum capture set per scope/model/firmware

Create these captures without changing software/firmware between the native and CSV saves:

| ID | Capture | Why it matters |
|---|---|---|
| A | One enabled analogue channel, 1 kHz sine or calibrator square wave | basic sign, gain, offset, timing and units |
| B | Two or four analogue channels with deliberately different volts/div and offsets | channel order, de-interleaving and per-channel calibration |
| C | Single pulse with pre-trigger data and a non-zero time position | trigger origin and pulse fidelity |
| D | Long-memory record, at least one million samples | length fields, browser memory and worker performance |
| E | Segmented/FastFrame/sequence capture if the scope supports it | multi-record timing and unsupported-variant behaviour |
| F | Peak-detect/min-max or envelope acquisition | exposes dual-buffer layouts |
| G | One disabled channel between enabled channels | channel-slot mapping |
| H | Digital/MSO capture if relevant | explicit rejection now; future fixture for logic support |

For each capture, save:

- the native file;
- the vendor CSV/text export of the same acquisition;
- a screenshot showing scales, offsets, trigger position and enabled channels; and
- if available, the instrument's setup/configuration file.

For R&S, retain both `.bin` and `.Wfm.bin`. For LeCroy sequence data, retain any segment/trigger-time context. For PicoScope, keep the original PSDATA even when exporting CSV/HDF5.

## Sidecar metadata template

Store a UTF-8 JSON file beside every capture:

```json
{
  "fixture_id": "keysight-dsox1102g-fw-01.20-capture-b",
  "brand": "Keysight",
  "model": "DSO-X 1102G",
  "serial_redacted": true,
  "firmware": "exact version from About/System",
  "acquisition_software": "name and exact version, if used",
  "saved_on": "YYYY-MM-DD",
  "save_route": "front panel or menu/command used",
  "acquisition_mode": "sample | average | peak detect | segmented | other",
  "record_length": 0,
  "sample_rate_hz": 0,
  "trigger_time_expected_s": 0,
  "channels": [
    {
      "name": "CH1",
      "signal": "1 kHz calibrator square wave",
      "unit": "V",
      "scale_per_div": 1,
      "offset": 0,
      "probe_factor": 10,
      "coupling": "DC"
    }
  ],
  "native_file": "capture.bin",
  "reference_export": "capture.csv",
  "sharing_permission": "private-test-only | redistributable",
  "notes": ""
}
```

Never guess unknown fields; use `null` and explain in `notes`.

## Validation before adding a fixture

1. Hash every source with SHA-256 before any sanitisation.
2. Open both native and CSV in vendor software and confirm they belong to the same acquisition.
3. Record sample count, first/last time, interval, channel units and min/max.
4. Compare native-reader output with the reference export sample by sample where rounding permits.
5. Explain any mismatch such as CSV display-only decimation or decimal rounding.
6. Add the native hash/provenance and expected values to `fixtures/manifest.json`.
7. Regenerate `fixtures/golden_results.json`.
8. Add model/firmware to `support_matrix.json`; upgrade status only for the exact proven variant.
9. Run all positive and corrupt-file tests.

## Privacy and redistribution

- Scope files can contain operator names, paths, notes, labels, serial numbers and timestamps.
- Inspect metadata before publishing.
- Prefer capturing new, non-sensitive calibration signals expressly for redistribution.
- If redaction changes file bytes, keep the original privately and record exactly what was changed.
- Do not strip or patch binary metadata merely to make a public fixture unless the modified file is also reopened in vendor software and clearly labelled sanitised.
- A publicly reachable forum attachment is not automatically under a software/data licence. Replace the supplied PicoScope forum PSDATA with your own redistributable capture before public release if possible.

## Recommended filename

Use a stable, descriptive pattern:

```text
<brand>_<model>_fw-<version>_<capture-id>_<variant>.<extension>
```

Keep original vendor-generated filenames in sidecar metadata if files are renamed for the test corpus.

