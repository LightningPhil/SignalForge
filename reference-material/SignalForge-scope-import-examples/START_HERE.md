# Start here: SignalForge importer hand-off

This ZIP is an implementation package, not merely background research. Cursor should use the files in this order:

1. `SIGNALFORGE_IMPORT_SSOT.md` — authoritative implementation contract and completion gates.
2. `support_matrix.json` — machine-readable truth about verified, synthetic, provisional and unsupported variants.
3. `WIKI_CONTENT_DRAFT.md` — user-facing wiki copy to adapt after the tests establish what was actually implemented.
4. `TYPESCRIPT_PORT_MAP.md` — direct map from the supplied Python/JavaScript reference to proposed TypeScript modules.
5. `fixtures/manifest.json` — provenance, SHA-256 hashes and headline expectations.
6. `fixtures/golden_results.json` — selected decoded values, axes, units, invalid indices and tolerances for cross-language tests.
7. `tests/` and `src/scope_examples/` — executable Python behaviour.
8. `third_party/rigolwfm_kaitai_schemas/` — BSD-licensed Kaitai schema sources suitable for TypeScript generation.
9. `FORMAT_NOTES_ADDITIONAL_BRANDS.md` — detailed binary layouts and calibration equations.
10. `BINARY_IMPORT_SECURITY.md` — parser safety requirements for untrusted local files.
11. `REAL_SCOPE_FIXTURE_COLLECTION.md` — what to collect next from the actual work instruments.
12. `VALIDATION_REPORT.md` — clean-room installation, test and archive results.

## Non-negotiable interpretation rule

Passing a synthetic fixture proves only that a known byte-layout branch works. It does not prove compatibility with an instrument family or firmware. Cursor must preserve the support levels in `support_matrix.json` and must not turn “layout-tested” or “provisional” into “supported” in the built-in wiki.

## Reproduce the reference result

From this directory:

```text
python -m venv .venv
# Windows: .venv\Scripts\activate
# Linux/macOS: source .venv/bin/activate
python -m pip install -r requirements.txt
python read_scope.py --all-fixtures --output-dir plots
python -m pytest
```

The PSDATA file should report `CONVERSION REQUIRED`; that is a successful, intentional outcome. A standalone R&S `.Wfm.bin` is a companion payload and should not be treated as an independent waveform.

## Definition of a useful hand-off from Cursor

Cursor's final report should contain:

- The adapters and exact variants implemented.
- A fixture-by-fixture result against `golden_results.json`.
- The user-visible response for every unsupported or conversion-required case.
- The final support table copied from the application wiki.
- New dependencies and their licences.
- Worker/memory behaviour for large records.
- Any fixture or variant still needed from the real instruments.
