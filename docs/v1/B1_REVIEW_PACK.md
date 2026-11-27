# B1 — pack for the independent review (PR #45)

Scope of the change: `docs/v1/B1_EQUIVALENCE.md` (argument, limits, rollout, benchmarks). This page tells a reviewer **where to attack**,
what evidence exists for each point, and what is knowingly open. Nothing here is a claim of production readiness. `one-pass` is not the
default and the PR is not to be merged before the owner decides.

Reproduce everything: `npm ci && npx tsc --noEmit && npx vitest run` (and with `AUTHORITY_GRANT_EVALUATION=one-pass` / `=shadow`),
`scripts/b1-mutation-check.sh` (≈ 4.5 min), PostgreSQL 16 with `TEST_DATABASE_URL`.

## Code map
| file | role |
|---|---|
| `src/engine/onePassGrants.ts` | `onePassGuard`, `PrefixState`, `candidateIsValid`, `collectValidatedGrantsOnePass` |
| `src/engine/grantEvaluation.ts` | modes, stats, historical loop with limits, `compareGrantEvaluators`, dispatcher |
| `src/engine/evaluationContext.ts` | the two optional hook interfaces (prefix facts supplied by the one-pass state) |
| `src/engine/validateChain.ts`, `evaluateConstraints.ts` | behaviour-preserving: optional `context` parameter; no context = historical code |
| `src/engine/issueCapability.ts` | now imports `collectValidatedGrants`; O1-A lazy logic unchanged |
| `tests/oracle/engine/*` | frozen pre-B1 engine (SHA-pinned) used as the reference |

## 1. Exactness of the late-activation guard
*Claim:* if the guard accepts, every fact the historical evaluation reads for the charge of an execution (first request of its action, the
delegations on the ancestor walk from the invoked delegation) already exists, with its final value, at the position of that execution, and
what never resolves never resolves later. *Where to attack:* `onePassGuard` (walk stopping rules vs `ancestorDelegationIds`, `MAX_CHAIN_DEPTH`,
cycles, `parent_delegation_id` pointing forward — allowed by A5 —, first-wins vs last-wins). *Evidence:* exhaustive enumeration (≈ 1 M
journals) + 100,000 random/100,000 malformed differentials; guard bypassed ⇒ 32/2,800 late-activation journals diverge (so the guard is exercised);
mutants removing either late check are killed. *Open:* the argument is written, not machine-checked; the enumeration alphabets are small
(2 principals' worth of structure, depth ≤ 2 delegations).
*Reachability:* late activation is **reachable through real ingestion** (checked: `ingestAll` accepts `ACTION_EXECUTED` before its
`ACTION_REQUESTED` and before the delegation it cites — A5 out-of-order delivery), so it is not an academic case.

## 2. Equivalence of errors
Differential tests compare `observe()` of results **and thrown errors** (class and message) against the frozen oracle. Journals that
are not shape-sound or have non-strict sequences never reach the fast path, so whatever the historical loop throws on them it still throws
(≈ 11 % of the malformed journals make both throw; 0 divergence). *Attack:* a journal that is shape-sound, strictly increasing, guard-accepted,
and still makes the historical code throw (e.g. a field `isJournalShapeSound` does not read but a rule does). *Open:* equivalence of errors
holds only for what `isJournalShapeSound` covers; the O1 mutation suite pins its coverage.

## 3. Budget arithmetic and nested delegations
Charges are added per (delegation, currency) in journal order — identical floating-point sums —, once per (delegation, action), only for
executions demonstrably tied to their executor and for cited delegations on the terminal's ancestor walk. *Attack:* non-integer amounts,
very large/small values, mixed currencies, same action charged to parent and child, an execution citing a delegation outside its ancestry,
re-used action ids, sub-delegations whose parent appears later, revocation of an intermediate delegation, budget bound of child vs parent
(`totalBudgetBoundOk`). *Evidence:* targeted tests (currency per budget, untied executions, charged-once, nested budgets), mutants for each rule.
*Open:* no test with non-integer amounts at scale (random amounts are integers).

## 4. Pathological cost of the historical fallback
The guard refuses the **whole** journal when it finds one late activation, and the quadratic loop runs on it, under the advisory lock. **Reachable through the public `record()`** (raw drafts are accepted; an `ACTION_EXECUTED`
before its request is ingested): one hostile event moves a journal from linear to quadratic (0.72 s at 8,000 events; 443 s at 100,000 with a budget). Mitigation: the operational limit of §6, which prevents (`maxWork`) or
interrupts mid-loop (`deadlineMs`) the work, bounded by the deadline plus one validation (≈ 21 ms at 100,000 events) — see `B1_EQUIVALENCE.md` §6 for the evidence and for what it costs in availability.
*Not done:* a partial fast path (evaluate the prefix before the first late activation with the one-pass state, fall back only for the rest) — a possible improvement for the reviewer to judge.

## 5. Modes
`historical` default, identical to the pre-B1 code path (existing suites unchanged and green in all three modes). `shadow`: returns the
**historical** result in every branch (reviewer: check `collectValidatedGrants`, shadow branch); runs on ≤ 5,000 events only; a throwing
`onShadowMismatch` hook is swallowed. `one-pass`: guard accepted ⇒ fast path, else historical. *Attack:* any path where a one-pass value
reaches a decision in `shadow`; module-level mutable state shared across concurrent calls (config and stats are process-global, stats are
plain counters; config is read once per call); the environment variable being read at import time.

## 6. Security of the operational limit
Properties: off by default; only on the historical loop; `maxWork` is evaluated before the loop (grants × events); `deadlineMs` is checked
between two grants (the overshoot is at most one `validateAndSelectGrant`, O(n)); exceptions, never decisions; nothing written beyond the
request already being recorded; same call succeeds when the limit is lifted (`tests/sdk/b1BoundedFallback.test.ts`). The limit can be set
only by engine-level code or the process environment, not through the SDK or an event.
**Known weakness to decide:** the SDK reports any non-clock, non-schema exception as `UNAVAILABLE` with code **`BACKEND_ERROR`**, so the
limit is reported to the *caller* as a backend error; the precise cause (`GRANT_EVALUATION_WORK_LIMIT` / `…_DEADLINE`) is visible to the
operator through `onDiagnostic` only. Naming it publicly would need a new `UnavailableCode`, i.e. a public API change — not made. A hostile
journal can also make an honest actor's calls UNAVAILABLE by tripping the limit (availability, not safety: fail-closed).

## What the reviewer should receive
The PR diff, this page, `B1_EQUIVALENCE.md`, the CI run, and the commands above. The author's own suite is **not** independent: please add
journals of your own (a generator seeded differently, hand-made nested-budget cases) and try to make `compareGrantEvaluators` report `equal: false`
while the guard says `ACCEPTED`.
