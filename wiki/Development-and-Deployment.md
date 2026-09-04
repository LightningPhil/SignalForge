# Development and Deployment

## Branch policy

- `dev` is the integration branch.
- `master` is production.
- Merge `dev` only after type, lint, format, unit, production build and browser
  workflow gates pass.

## Local quality gates

```bash
npm ci
npm run check
npm run test:e2e
npm audit --audit-level=high
```

`npm run check` covers strict TypeScript, ESLint, Prettier and Vitest.
Locally, Playwright builds and serves `dist` before testing the production
application, lazy chunks, `/SignalForge/` base path and service worker. CI runs
`npm run build` explicitly first, then previews that artifact with
`PLAYWRIGHT_SKIP_BUILD=1`.

## GitHub Pages

The workflow in `.github/workflows/quality-and-pages.yml` runs on `dev` and
`master`; deployment occurs only for a successful push to `master`.

The repository currently retains the existing `master:/docs` branch deployment
as a production fallback. When this development work is merged, switch
Settings → Pages → Source to **GitHub Actions** before relying on artifact
deployment. Generated `dist` bundles are ignored and are not committed.

## Native adapter policy

An adapter remains fixture-required until files from the exact instrument model
and firmware family reproduce trusted vendor exports for timing, scaling,
segmentation, metadata and malformed cases. Shared extensions do not establish
compatibility.

## Roadmap

`ProjectPlan.md` is the implementation SSOT. The next priorities are collecting
real instrument fixtures, independent numerical validation against trusted
offline tools, broad real-session usability trials, and measured performance
work for large multi-shot projects.
