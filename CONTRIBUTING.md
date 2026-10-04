# Contributing

Authority is a deterministic engine: the same canonical history, the same
instant and the same query always give the same answer. Contributions are
judged on whether they keep that property and whether their claims are
backed by a reproducible test.

No contribution is guaranteed to be accepted.

## Security first

An exploitable, unfixed vulnerability is never reported in a public issue,
pull request or discussion. Follow [`SECURITY.md`](./SECURITY.md).

## Reporting a bug

Open an issue with the commit SHA you tested, the commands you ran, the
expected result and the observed result. A failing test is the best bug
report.

## Proposing an adversarial scenario or a counterexample

An adversarial scenario tries to make Authority give a wrong answer. A
counterexample claims that a documented rule (an invariant in
[`SPEC.md`](./SPEC.md), an attack in [`THREAT_MODEL.md`](./THREAT_MODEL.md))
does not hold. Both need, at minimum:

1. **The minimal ordered sequence of events**, with only the fields that
   matter for the scenario.
2. **The query** (`authorityAt` or `explainAction`, and the instant).
3. **The expected result** and why, citing the invariant concerned (I1 to
   I25) or the threat-model entry.
4. **The observed result.**
5. **The commit SHA tested.**
6. If you can, **a test** that fails before the fix and passes after it.
   The test fixtures in [`tests/fixtures`](./tests/fixtures) build events
   for you; [`tests/adversarial`](./tests/adversarial) has many examples.

If the scenario is theoretical or does not describe an exploitable flaw, an
issue is fine. Otherwise, use [`SECURITY.md`](./SECURITY.md).

## Correcting the documentation

Small fixes (typos, broken links, wrong commands) can go straight to a pull
request. A change to what the documentation *claims* about Authority's
behavior must point to the code or test that shows the new claim is true.

## Changing the code

- **Stay in scope.** Authority resolves authority from a canonical event
  history, deterministically. Changes that add wall-clock reads, randomness,
  network calls or other hidden inputs to a decision will not be accepted.
- **Behavior changes come with tests.** A fix comes with a test that fails
  without it. A change to an invariant updates `SPEC.md` in the same pull
  request.
- **No claims about external protocols without a primary source.** A pull
  request must not present an Authority result as a statement about OAuth,
  an IETF document, a vendor's product or any other external system unless
  it cites the primary source (the specification or official documentation
  itself) that supports the statement.
- **Keep the provenance of tests honest.** The audit block of
  [`tests/adversarial/independent-audit.test.ts`](./tests/adversarial/independent-audit.test.ts)
  records what the independent audit found. New tests go in their own files.

## Before opening a pull request

These must pass. CI runs all of them on every push and pull request:

```
npm ci
npm run typecheck
npm test
npm run demo
npm run quickstart
node scripts/check-readme-demo-excerpt.mjs
```

Without a reachable database, `npm test` skips the 17 PostgreSQL tests.
Skipped is not passed: CI runs them against PostgreSQL 16, and the
[Development section of the README](./README.md#development) shows how to
run them locally.

## Declaring AI assistance

If an AI tool produced a substantial part of your contribution (code, tests
or text, beyond autocomplete), say so in the pull request description. You
remain responsible for every line and every claim in it.

## License

By contributing, you agree that your contribution is licensed under the
[Apache License 2.0](./LICENSE), like the rest of the project.
