# B1 — one-pass evaluation of historical grants: equivalence argument, limits, rollout

Status: **proposal under review (Draft PR). Not merged, not enabled by default.** No change to `SPEC.md`, to the event model, to
the public SDK API or to any error code. The historical evaluation stays in the code base, is the default, and is the fallback.

## 1. What is being optimised

`issueCapability` needs the list of grants already issued on a delegation (`collectValidatedGrants(store)`). The historical
implementation re-validates **every** `CAPABILITY_ISSUED` event with `validateAndSelectGrant(store, grant)`, which itself
re-resolves the chain, the revocations and (for `total_budget`) re-sums the executions visible at the grant's decision snapshot.
With *g* grants and *n* events the cost is O(g·(n+e)), quadratic on a journal where most events are grants. B1 computes the same
list in one forward pass over the journal.

## 2. Definitions

* `J = e1 … en` is the journal. `sequence(e_i)` is strictly increasing (checked by the guard).
* A candidate `c = e_k` of type `CAPABILITY_ISSUED` is accepted by the historical loop iff `validateAndSelectGrant(J, c).ok`.
  Its decision snapshot is `{ e : sequence(e) ≤ decision_sequence(c) }`. The validation rejects `c` unless
  `decision_sequence(c) = sequence(c) − 1` (the decision is *immediately* before the grant), so the snapshot is exactly the
  **prefix** `P_{k−1} = e1 … e_{k−1}` when sequences are strictly increasing.
* Everything `validateAndSelectGrant` reads is either (a) a fact about the **prefix** `P_{k−1}`, or (b) the **first
  `ACTION_REQUESTED` of the action in the whole journal** (`findActionRequested(id, store)`), a fact that is fixed once it exists.

## 3. Why one pass can be exact (prefix proof)

The validation of `c` is, in this order (the one-pass evaluator keeps it, see `candidateIsValid`):

1. first request of `c.action_id` exists (whole journal); fingerprint of its capability and parameters equals `c.action_fingerprint`;
2. `decision_sequence = sequence − 1` and the request is not after the snapshot;
3. the invoked delegation exists in the prefix (first-wins) and its grantee is the requesting principal;
4. `validateChain` on the prefix: root, expirations at `c.authority_time`, **revocations** by the grantor or the root grantor,
   parent/child inclusion (capabilities, expiry, money, thresholds), **`total_budget` bounds** (`remainingBudget` of the parent);
5. `evaluateConstraints` on the prefix: capability coverage, thresholds, **`total_budget` of every delegation of the chain**,
   approvals (`findGrantOutcome`);
6. `c.granted_chain_ref` equals the chain the decision derives (plus the approval, if any).

The same functions are used on both paths (`validateChain`, `evaluateConstraints`, `findGrantOutcome`, `chainsEqual`,
`computeActionFingerprint`); the one-pass path only supplies, through optional `ChainEvaluationContext` /
`ConstraintEvaluationContext` hooks, the three prefix facts they would otherwise recompute by scanning: the delegation index,
the revocation test, and the spent amount per delegation and currency. With no context the code is the historical code
(identical bytes of behaviour, checked by the unchanged existing suites in the three modes).

The prefix state is maintained as events are read:

| fact | maintained as | semantics kept |
|---|---|---|
| delegation index of `validateChain` | `Map` overwritten at each delegation event | **last wins** |
| `findDelegation` (grantee, ancestry, ties) | `Map` set once | **first wins** |
| revocations | `Map<delegation, Set<principal>>` | revoker must be the direct grantor or the root grantor (tested at query time with the *current* index, as `isRevoked` does) |
| first request per action | `Map` set once | first wins |
| spent per delegation & currency | accumulated at each `ACTION_EXECUTED` | added in **journal order** (same floating-point sums); charged **once per (delegation, action)**; only if the execution is demonstrably tied to its executor and the cited delegation is on the ancestor walk of the terminal delegation |
| approvals | reduced array (delegations, `APPROVAL_GRANTED` of the queried action, their `APPROVAL_REQUESTED`, first request, executions of the action) handed to the original `findGrantOutcome` | the I19 checks inside make approvals insensitive to late events |

## 4. Temporal dependencies and the guard (late activation)

An execution `x` is *charged* using facts that the historical evaluation reads **at the snapshot of each later grant**:
the first request of its action and the delegations on the ancestor walk from the invoked delegation. In the historical loop a
grant evaluated *after* those facts appear charges `x`, even if `x` itself came *before* them in the journal ("late activation").
A one-pass evaluator decides `x`'s contribution when it reads `x` and cannot see the future: it would not charge `x`.

`onePassGuard` (O(n), no decision) therefore refuses the journal when:

* the journal is not shape-sound (`isJournalShapeSound`), or the sequences are not strictly increasing, or
* an `ACTION_EXECUTED` precedes the **first request** of its action, or precedes any delegation on the walk from the request's
  delegation to its root, *when that request / delegation exists somewhere in the journal*.

A reference that never resolves (no such delegation or request anywhere) cannot change later and is harmless. The refused
journals use the historical loop, unchanged (the fallback). The guard is **sufficient** (proved above) and **its exactness is
demonstrated experimentally** (§6): with the guard bypassed, 32 of the 2,800 late-activation journals of the enumeration give a
different grant list than the oracle, so the guard is not decorative.

## 5. Modes and rollout

| mode | decision taken from | notes |
|---|---|---|
| `historical` (**default**) | the historical loop | nothing changes unless a mode is chosen |
| `shadow` | **the historical loop, always** | the one-pass result is computed next to it on journals ≤ `shadowMaxEvents` (5,000), compared, mismatches counted and reported to `onShadowMismatch`; the new result is never returned, so no decision comes from an unvalidated result |
| `one-pass` | one-pass if the guard accepts, else the historical loop | |

Set with the environment variable `AUTHORITY_GRANT_EVALUATION` or the engine-level `configureGrantEvaluation` (not exported by
the SDK). Proposed rollout: ship with `historical`; run `shadow` where journals are small enough, collect `shadowMismatches` (must
stay 0); select `one-pass` only after a decision of the owner. Offline comparison of large journals: `compareGrantEvaluators`.

## 6. Quadratic fallback, who can trigger it, and the operational limit (off by default)

**The risk.** The historical loop is quadratic, and the guard sends a journal to it as soon as it finds one late activation (an execution that precedes its request
or a delegation of its chain). That is **reachable by any caller of the public `record()`**: it accepts raw drafts, and the engine's ingestion accepts an `ACTION_EXECUTED`
before its `ACTION_REQUESTED` (out-of-order delivery, A5). Checked (`tests/sdk/b1BoundedFallback.test.ts`): after two `record()` calls the guard answers `LATE_ACTIVATION`. So **one hostile
event moves a journal from linear to quadratic** — measured: 8,000 events 0.72 s, and 443 s at 100,000 events with a budget. The work runs inside the issuance transaction, **under the advisory lock**, so
it delays every writer, not only the caller. This is the cost the historical path always had; B1 does not make it worse, but `one-pass` does not remove it either.

**The limit.** `limits.maxWork` (grants × events, known before the loop) and `limits.deadlineMs` (checked before every validation) stop the historical loop with `GrantEvaluationLimitExceeded`
(`GRANT_EVALUATION_WORK_LIMIT` / `GRANT_EVALUATION_DEADLINE`). What is verified, by test, and not just a check after the work:

| property | evidence |
|---|---|
| `maxWork` **prevents** the work: refusal before any validation started | `validationsRun === 0` (`b1Targeted`, `b1BoundedFallback`: late activation injected through `record()` + `one-pass` + `maxWork`) |
| `deadlineMs` **interrupts mid-loop**: the work done is a function of the deadline, not of the journal size | 300 / 600 / 1,200 / 2,400-event journals all stop after the same 3 validations (deadline 25 ms, injected clock) |
| it is a real-time bound | journal whose full evaluation takes 257 ms, deadline 12.8 ms: stopped at 13.3 ms |
| overshoot is at most one validation | one `validateAndSelectGrant` at 100,000 events: p50 2.5 ms, max 20.9 ms (n = 20 samples) |
| the result is `UNAVAILABLE`, never a business refusal | SDK tests for both limits; nothing issued or refused by the interrupted call; the same call succeeds once the limit is lifted |
| decision rules untouched | no rule file is modified by the limit; with no limit the loop is the historical loop (one counter, `validationsRun`, was added) |

**Contention.** The lock is held for at most `deadlineMs` + one validation (≈ 21 ms measured at 100,000 events) + the O(n) preparatory work (shape check, guard, candidate count), instead of the unbounded
quadratic time. The price is availability: a legitimate journal that needs the historical path for longer than the deadline is answered `UNAVAILABLE` until the operator raises the limit or the journal is repaired.
**Recommendation:** enable limits whenever `one-pass` is selected (the guard refusals then show how often the fallback is taken: `guardRefusals.LATE_ACTIVATION`), starting from a deadline around the p99 of the
one-pass call on the target journal sizes (a few hundred ms) and tuning from the counters.

**What the caller sees today.** The SDK maps any exception to `UNAVAILABLE`; this one is reported as `BACKEND_ERROR`, the precise cause is operator-only (`onDiagnostic`). A specific public code is a proposal awaiting
the owner's decision (`PROPOSAL_GRANT_LIMIT_UNAVAILABLE_CODE.md`); the public API is unchanged.

## 7. Verification

| check | file | scale |
|---|---|---|
| exhaustive enumeration vs the **frozen oracle** (`tests/oracle/engine`, SHA-pinned copy of the pre-B1 engine) | `tests/engine/b1Enumeration.test.ts` | every journal of length ≤ 5 over a 10-event alphabet (111,110), ≤ 6 over two 6-event alphabets (2 × 55,986), ≤ 4 over the whole 29-event alphabet (732,540) |
| guard necessity | same | 2,800 late-activation journals, 32 diverge without the guard |
| differential, results **and errors** | `tests/engine/b1Differential.test.ts` | 100,000 random well-formed + 100,000 malformed (structural damage) + 2,000 SDK-generated journals |
| targeted: budgets, sub-delegations, expirations, revocations, late activations, forged references, approvals, currencies | `tests/engine/b1Targeted.test.ts` | 28 tests with explicit expectations, also checked against the oracle |
| modes, shadow, environment variable, linearity of reads, limits | same + `tests/sdk/b1BoundedFallback.test.ts` | |
| PostgreSQL 16 parity and concurrency, `one-pass` and `shadow` | `tests/engine/b1Backends.test.ts` | |
| mutation | `scripts/b1-mutation-check.sh` | 23 mutants of the evaluator and the dispatcher; every one must be killed |
| reproducibility of the test generators | `tests/engine/b1Reproducibility.test.ts` | 20,000 seeds of generator + `mutate`, twice: identical journals (the shared, mutable `JUNK` objects made 1,191 of them differ before the fix) |
| whole suite in each mode | CI | `npm test` default, `AUTHORITY_GRANT_EVALUATION=one-pass`, `=shadow` |

## 8. Limits of the equivalence (what this does **not** establish)

* The equivalence is **argued and tested, not machine-checked**. The enumeration is bounded (alphabets and lengths above); the
  random journals sample a much larger space but not all of it.
* It is stated for the grant list `collectValidatedGrants` returns, and hence for `issueCapability`'s decisions. Other engine
  functions (`authorityAt`, `explainAction`, `redeemCapability`, `remainingCapacity`) are **not** modified in behaviour; they
  keep their historical code.
* Journals refused by the guard run the historical path and keep its cost (quadratic) and its behaviour, errors included.
  On malformed journals the guard almost always refuses (≈ 94 % in the malformed differential), so one-pass is exercised
  mainly on well-formed ones; that is by design (shape-soundness is the precondition of the fast path).
* The guard compares **sequences, not authority times**. It relies on the I3 append-only journal and on ingestion keeping
  sequences increasing; a journal tampered with at the storage layer is outside the guarantee, as for the historical engine.
* A party able to append events can choose to make the guard refuse (late activation) and so force the historical path:
  that is a **denial-of-service** risk on large journals, which §6 bounds if (and only if) the operator enables it.
* The shadow mode cannot compare large journals in-process (the historical loop it needs is quadratic): above
  `shadowMaxEvents` it is plain `historical`.
* Residual cost: grants whose decision involves approvals pay O(delegations) to build the reduced array.

## 9. Performance (PostgreSQL 16, one machine, journals populated by bulk insert of real SDK events)

Journals of N events in which one event in four is a grant (the worst case for the historical loop); `authorize()` end to end through
the SDK and `postgresBackend`, new action (two full journal reads) and retry of an existing request (one read); engine-only =
`collectValidatedGrants` on the journal already in memory. **Small samples are reported as such:** p95/p99 are not given below n = 20;
the historical 100,000-event budgeted cell is a **single** run (it took 7.9 minutes); the `shadow` cells exist only up to 10,000 events (above
that it is plain `historical`). Raw results: `B1_BENCHMARK_RAW.jsonl`. Exploratory, not a performance guarantee.

| budget | events | mode | `authorize()` new action p50 / max (ms) | n | retry p50 (ms) | engine-only grant collection p50 (ms) | journal read p50 (ms) |
|---|---|---|---|---|---|---|---|
| no | 1,000 | historical | 43.2 / 54.9 | 7 | 9.9 | 8.1 (n=7) | 7.3 |
| no | 1,000 | one-pass | 46.7 / 95.7 | 30 | 11.7 | 2.0 (n=30) | 8.1 |
| no | 1,000 | shadow | 36.9 / 55.4 | 7 | 9.1 | 10.3 (n=7) | 6.9 |
| no | 10,000 | historical | 316 / 410 | 7 | 72.8 | 584 (n=7) | 68.6 |
| no | 10,000 | one-pass | 337 / 455 | 30 | 70.3 | 12.6 (n=30) | 63.9 |
| no | 10,000 | shadow | 300 / 351 | 7 | 65.2 | 578 (n=7) | 77.1 |
| no | 30,000 | historical | 912 / 1,261 | 7 | 209 | 7,961 (n=7) | 204 |
| no | 30,000 | one-pass | 997 / 1,110 | 30 | 216 | 65.3 (n=30) | 224 |
| no | 100,000 | historical | 3,511 / 3,553 | 3 | 724 | 100,379 (n=3) | 684 |
| no | 100,000 | one-pass | 3,410 / 4,713 | 30 | 728 | 197 (n=30) | 693 |
| yes | 1,000 | historical | 80.1 / 91.9 | 7 | 11.8 | 30.4 (n=7) | 7.4 |
| yes | 1,000 | one-pass | 39.9 / 124 | 30 | 9.8 | 1.1 (n=30) | 7.2 |
| yes | 1,000 | shadow | 67.2 / 92.9 | 7 | 9.2 | 21.9 (n=7) | 7.0 |
| yes | 10,000 | historical | 2,683 / 3,110 | 7 | 70.1 | 2,290 (n=7) | 64.5 |
| yes | 10,000 | one-pass | 326 / 383 | 30 | 69.2 | 12.8 (n=30) | 64.5 |
| yes | 10,000 | shadow | 2,610 / 2,837 | 7 | 74.7 | 2,269 (n=7) | 69.1 |
| yes | 30,000 | historical | 28,916 / 32,323 | 7 | 217 | 26,091 (n=7) | 185 |
| yes | 30,000 | one-pass | 1,062 / 1,325 | 30 | 239 | 56.1 (n=30) | 237 |
| yes | 100,000 | historical | 473,085 / 473,085 | 1 | 901 | 442,920 (n=1) | 769 |
| yes | 100,000 | one-pass | 3,576 / 4,305 | 30 | 736 | 203 (n=30) | 677 |

Reading of the table:

* The quadratic term is gone: with a budget at 10,000 / 30,000 / 100,000 events, grant collection goes from 2.3 s / 26 s / 443 s
  (historical, n = 7 / 7 / 1) to 13 ms / 56 ms / 203 ms (one-pass, n = 30), and `authorize()` of a new action from 2.7 s / 28.9 s / 473 s
  to 0.33 s / 1.06 s / 3.6 s.
* **The exploratory criterion `authorize()` < 1 s at 100,000 events with a budget is NOT met** (p50 3.6 s). It is not met either by the
  unbudgeted historical path (3.5 s), so it is not caused by B1: the remaining time is the journal read and its deserialisation (a new
  action reads the whole journal twice, ≈ 0.7 s each at 100,000 events; a CPU profile of the whole benchmark process at 30,000 events — which includes its own journal reads, so it overstates reading and is indicative only —
  attributes ≈ 75 % of busy time to `rowToEvent` / date parsing / `pg` row parsing / garbage collection, ≈ 3 % to `onePassGrants.ts`, ≈ 4 % to the ingestion rebuild).
  Getting below 1 s would require **not re-reading the journal on each call** (incremental reading, a cached prefix, or a different
  read path), which is the unverified cache / new trust hypothesis that has to be decided by the owner and is **not** part of B1.
