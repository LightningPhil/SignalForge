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
npm run test:lab
npm run build
npm run verify:dist:artifact
npm run test:e2e
npm audit --audit-level=high
```

`npm run check` covers strict TypeScript, ESLint, Prettier and Vitest.
Locally, Playwright builds and serves `dist` before testing the production
application, lazy chunks, `/SignalForge/` base path and service worker. CI runs
`npm run build` explicitly first, then previews that artifact with
`PLAYWRIGHT_SKIP_BUILD=1`.

The normal synthetic gate includes deterministic seeded scenarios and a
100,000-sample structural run. `npm run test:bench:1m` exercises a
one-million-sample record without a flaky wall-clock assertion.
`npm run bench:performance -- --million` records informational timings and
process memory; the scheduled workflow uploads that report but correctness
gates remain numerical and structural.

## GitHub Pages

The workflow in `.github/workflows/quality-and-pages.yml` runs on `dev` and
`master`; pull requests also receive a dependency-diff review, and deployment
occurs only for a successful push to `master`.

The repository currently retains the existing `master:/docs` branch deployment
as a production fallback. When this development work is merged, switch
Settings → Pages → Source to **GitHub Actions** before relying on artifact
deployment. The compiled `dist/` output (hashed assets, workers, service worker,
`.nojekyll` and `THIRD_PARTY_NOTICES.txt`) is intentionally tracked and must be
rebuilt from the verified source before a release so the committed bundle is the
exact tested build; stale hashed assets are removed by the build's `emptyOutDir`.
`npm run verify:dist:artifact` checks references, the service-worker stamp,
`.nojekyll` and notices before staging. For a release, run `git add -A dist`
after the clean build and then `npm run verify:dist`; strict mode compares the
filesystem to the Git index and therefore intentionally fails on a correct but
unstaged rebuild. CI checks the already committed index. The browser suite also
serves two deployments on one origin and proves that the newer worker evicts
the older runtime cache.

## Protected releases

Remote `master` is protected so changes arrive through pull requests, the
quality and dependency-review checks must pass, conversations must be resolved,
history is linear, and force pushes and branch deletion are disabled. The rule
also applies to administrators. It requires zero outside approvals so the
repository remains operable by a solo maintainer; `dev` remains the integration
branch.
GitHub's automatic release-note categories are configured in
`.github/release.yml`; summarize user-visible changes in `CHANGELOG.md` before
cutting a release.

## Native adapter policy

An adapter remains fixture-required until files from the exact instrument model
and firmware family reproduce trusted vendor exports for timing, scaling,
segmentation, metadata and malformed cases. Shared extensions do not establish
compatibility.

## Roadmap

`ProjectPlan.md` is the implementation SSOT. The next priorities are collecting
real instrument fixtures, independent numerical validation against trusted
offline tools, broad real-session usability trials, calibrated uncertainty
models and performance tuning informed by the scheduled benchmark artifacts.
