# Dependency audit status (npm audit)

> Status: informational, measured on `main` at `ba37c32` on 2026-11-23. Nothing
> here was fixed by this note: no dependency, lockfile or code was changed.
> `npm audit` output moves daily; re-run it before relying on this page.

## What was measured

| Scope | Command | Result |
|---|---|---|
| This repository, runtime dependencies only | `npm audit --omit=dev` | **0 vulnerabilities** |
| This repository, including development tooling | `npm audit` | **11** (6 moderate, 2 high, 3 critical) |
| A clean consumer project that installs the SDK tarball (`npm run sdk:package`), 13 packages | `npm audit --omit=dev` | **0 vulnerabilities** |

The 11 findings are all in **development tooling** (the test runner and its
transitive tools). None is part of the SDK package, whose runtime dependencies are
`json-canonicalize` and the types-only `@types/pg` (with `pg` an optional peer).

## The 11 findings (development only)

| Package | Severity | Via | Fix offered by npm |
|---|---|---|---|
| `vitest` (direct) | critical | Vitest UI server: arbitrary file read and execution when the UI server is listening (GHSA-5xrq-8626-4rwp) | `vitest@5.1.1`, **major** |
| `@vitest/coverage-v8` (direct) | critical | `test-exclude` | `@vitest/coverage-v8@5.1.1`, **major** |
| `tinypool` | critical | Prototype pollution gadget in worker options (GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr) | `vitest@5.1.1`, **major** |
| `source-map-js` | high | Event-loop denial of service through source-map section offsets (GHSA-68fv-2mgg-jv7q) | `npm audit fix`, non-breaking |
| `vite` | high | Path traversal in optimized-deps `.map` handling (GHSA-4w7w-66w2-5vf9); `launch-editor` NTLMv2 hash disclosure on Windows (GHSA-v6wh-96g9-6wx3) | `vitest@5.1.1`, **major** |
| `@vitest/mocker` | moderate | Path traversal / code injection through mock registration (GHSA-82fw-gwwq-j7x9, GHSA-qxg6-89mg-rqv8) | `vitest@5.1.1`, **major** |
| `esbuild` | moderate | A website can send requests to the dev server and read the response (GHSA-67mh-4wv8-2f99) | `vitest@5.1.1`, **major** |
| `glob`, `minimatch`, `test-exclude` | moderate | AbortSignal cancellation bypass; globparts denial of service | `@vitest/coverage-v8@5.1.1`, **major** |
| `vite-node` | moderate | `vite` | `vitest@5.1.1`, **major** |

How they relate to the project's use: the tests run with `vitest run` in CI and
locally; the Vitest UI server, the Vite dev server and the coverage reporter are
not started in CI. These are reasons the exposure is low, **not** reasons to ignore
them: a developer machine that runs `vitest --ui` or a dev server is exposed.
Upgrading is a major version change of the test runner and deserves its own pull
request with a full test run; it is not part of this note.

## Rule before any publication

Before any future publication of the package, require, in a **clean consumer
project** that installs the packed tarball:

```
npm audit --omit=dev
```

to report no vulnerability that the maintainer has not explicitly reviewed and
accepted in writing. `npm run sdk:package:check` does not run `npm audit`
(advisories change daily and would make CI flaky); run it by hand at release time
and keep the output with the release decision.

## Worth knowing

- `@types/pg` (a dependency of the SDK package, types only) pulls `@types/node`
  26.x into a consumer project. It adds no runtime code, but it is what a
  consumer's type-checker will see if they have no `@types/node` of their own.
- `pg` is not installed by the SDK. A user of `postgresBackend` installs it and
  audits it under their own policy.
