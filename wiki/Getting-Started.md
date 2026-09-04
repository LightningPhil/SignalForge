# Getting Started

## Run locally

SignalForge requires Node.js 24 LTS.

```bash
npm install
npm run dev
```

The production-quality gate is:

```bash
npm run check
npm run test:e2e
```

`test:e2e` builds and serves the production bundle before running Chromium
workflow tests.

## Load one capture

1. Select **Load**.
2. Choose a CSV, TSV or text waveform.
3. Select the row containing channel headers.
4. Select a channel tab above the graph.
5. Keep the raw overlay visible while evaluating any processing pipeline.

Time units in headers such as `Time (ms)` are normalized to seconds for
analysis while source bytes remain preserved.

## Build a multi-shot session

1. Select **Multi Import**.
2. Use a typed filename profile and review the generated example, or disable
   filename conventions to accept any supported name as a separate shot.
3. Preview extracted SI metadata and importer warnings before import.
4. Open **Sessions** to review shots, place authoritative markers, compare
   event-aligned waveforms, and run batch pulse calculations.

See [Importing Files and Building Sessions](Importing-and-Sessions) for profile
grammar, conflict handling, limits, persistence, and project archives.

## Work safely

- The default pipeline is pass-through.
- Missing, invalid, clipped and saturated values are flagged rather than
  silently replaced.
- Use Grid repair controls to interpolate or forward-fill explicitly.
- Undo and redo apply to recorded data repairs.
- Export the full CSV form when an audit trail is required; it contains
  original, working, quality and filtered columns.
