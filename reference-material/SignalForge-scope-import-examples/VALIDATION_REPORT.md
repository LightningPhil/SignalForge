# Validation report

Date: 2026-09-02

## Environment

- Python 3.12.13.
- Exact packages recorded in `requirements-lock.txt`.
- Normal supported ranges recorded in `requirements.txt` and `pyproject.toml`.
- Reference package version 3.0.0.

## Results

| Check | Result |
|---|---|
| Fixture manifest SHA-256 validation | Pass |
| Machine-readable support-matrix consistency | Pass |
| Golden result comparison | Pass |
| Full-array R&S vendor CSV comparisons | Pass |
| Positive and corrupt-file test suite | **91 passed** |
| `read_scope.py --all-fixtures --metadata-only` | Exit 0 |
| Directly decoded primary fixtures | 25 |
| Expected conversion-required fixture | 1 PicoScope PSDATA |
| Generated/visually spot-checked plots | 25 / pass |
| ZIP compressed-data integrity | Pass |
| Fresh virtual environment from extracted ZIP | Install pass; 91 tests pass; all-fixtures pass |

The clean-room run used only the extracted archive and a newly created virtual environment installed from `requirements-lock.txt`.

## Independent numeric evidence

The R&S float32 two-channel, int8 scaled and XYDOUBLEFLOAT explicit-time results are compared across their complete arrays with included vendor CSV exports. Time values in the XYDOUBLEFLOAT fixture are compared at `1e-18 s` absolute tolerance; channel values use `5e-6 V`.

Other cross-language expectations are in `fixtures/golden_results.json`. Those include record/frame counts, selected time/value samples, invalid indices, channel/unit information and per-record tolerances. They are intended to be consumed directly by the SignalForge TypeScript tests.

## Important interpretation

Passing this Python suite does not prove every scope model or firmware. The evidence boundary is `support_matrix.json`:

- real/vendor fixture paths may be labelled `verified` for the exact named variants;
- deterministic synthetic branches remain `layout-tested`;
- PicoScope HDF5 remains `experimental`;
- PSDATA remains `conversion-required`; and
- parser source without a real acceptance fixture remains `provisional`.

Cursor must update SignalForge's built-in wiki to match what its TypeScript implementation actually passes, without promoting these evidence levels.

