# D1 — one transaction, one lock, one journal read per `authorize()` (PROTOTYPE, Draft, not for merge)

Status: **study prototype, stacked on the explicit-isolation fix (PR #47).** Off by default: selected with `AUTHORITY_AUTHORIZE_SNAPSHOT=single`, PostgreSQL only, no public API change, no SPEC change, no new trust assumption,
no cache. The sequential protocol stays the default and is untouched in behaviour. Decision pending the owner.

## 1. What changes
A new action used to cost four journal reads and three transactions' worth of statements (15 statements, two lock sections):

| | sequential (today) | D1 |
|---|---|---|
| journal reads | 4 (lock-free, locked in `append`, lock-free pre-check, locked in `issue`) | **1**, after the lock |
| statements per call (new action, healthy) | 15 | **9** |
| advisory-lock sections | 2 | **1** |
| connections / transactions | 1 lock-free read + 2 transactions | 1 transaction |

Per path (statements counted on every connection, `pool.query` included; healthy runs, journal of a few events):

| path | journal reads: sequential → D1 | lock sections | statements |
|---|---|---|---|
| new action, authorised | 4 → **1** | 2 → **1** | 15 → **9** |
| same call again (ticket exists, replayed) | 1 → 1 | 1 → 1 | 6 → 6 |
| new action needing approval / denied | 3 → **1** | 1 → 1 | 7 → 5–6 |
| request already recorded, refusal | 1 → 1 | **0 → 1** | 1 → 5 |
| action id reused with another call | 1 → 1 | **0 → 1** | 1 → 5 |

The code is the same code: `PostgresEventStore.appendWithin` (the body of `append()`), `PostgresCapabilityIssuanceTransaction.issueWithin` (steps A–E of `issue()`), and the SDK's own
`selectInvokedGrant` pre-check, composed inside one transaction by `PostgresSingleSnapshotAuthorization`. `append()` and `issue()` call the same bodies, so their behaviour is unchanged
(existing suites green). The I32 schema check (`ensureSchema`) still runs before the transaction.

## 2. Coherence and freshness (argument, then evidence)
*Protocol:* `BEGIN` → `pg_advisory_xact_lock(hashtext('authority_events'))` → **one** `SELECT * FROM authority_events ORDER BY sequence` → the call's append, pre-check and issuance operate on that state
(advanced in memory by the call's own `processDraft`) → `COMMIT`.
* **Coherence.** Every protocol-following writer (`append`, `issue`, redemption) takes the same lock before reading and writing and commits before releasing it. The read happens after the lock was granted, so it sees
  every transaction committed before, and no protocol-following transaction can commit until this one ends. The decision is therefore taken on one state of the journal that actually existed, and the state the
  inserts are derived from (`sequence = max + 1`) is the state the decision used. No later statement re-reads the journal.
* **Freshness.** The state includes everything committed before the lock was granted. (The transactions use PostgreSQL's default READ COMMITTED; that is sufficient because the only journal read is the single statement
  that follows the lock. A writer that bypasses the lock can still commit mid-call; it cannot alter what this call decided on, and its conflicting insert fails on the unique `sequence` index → the transaction rolls back → `UNAVAILABLE`. Same as today.)
* **Not a new trust assumption.** Same lock domain, same fresh full read per decision; nothing is cached across calls, nothing is trusted that today is re-read.
* **Evidence** (`tests/sdk/d1SingleSnapshot.test.ts`, PostgreSQL 16): (a) a foreign transaction holding the lock makes the call wait; (b) a revocation committed before the call takes the lock is part of its snapshot (`DENIED`); (c) a foreign writer arriving mid-call is released only after the call committed.

## 3. I1–I32
Nothing in the engine, the event model or the schema changed. The invariants are enforced by the same code (ingestion rules inside `appendWithin`, `issueCapability`, the I32 unique index and `ACTION_ALREADY_TICKETED`).
Evidence: the **whole** repository suite (1,367 tests, which include the invariant suites, the O1/O2 differential suites, the PostgreSQL suites, the SDK suites) passes with `AUTHORITY_AUTHORIZE_SNAPSHOT=single` as in the default mode, on PostgreSQL 16;
the CI PostgreSQL job runs it that way. The suites that **pin the sequential protocol** (`o2Backends.test.ts`: number of reads, statement-level faults) force it themselves.
Scenario parity (`d1SingleSnapshot.test.ts`): 8 scenario sequences (plain, budget exhaustion, approval band, reused action id, unknown delegation, wrong capability, over the ceiling, `guard()` flow) give **identical results, journals and idempotency rows** in both protocols.

## 4. Crash at every persistence point (injected before and after every statement, then recovery by retry)
Method: a pool wrapper throws before or after the n-th SQL statement of one call (every connection counted), for every n, in both protocols; then a healthy retry of the same call.
15 statements → 30 cases sequential; 9 statements → 18 cases single.

| | sequential | D1 |
|---|---|---|
| nothing written by the failed call | 11 / 30 | 17 / 18 |
| **`ACTION_REQUESTED` left without a ticket** | **18 / 30** (any failure from the request's COMMIT up to the issuance's COMMIT) | **0 / 18** |
| committed but acknowledgement lost (`UNAVAILABLE` returned, effects durable) | 1 (ack lost on the issuance COMMIT) | 1 (ack lost on the one COMMIT) |
| after the healthy retry | `AUTHORIZED`, exactly 1 request, 1 ticket, 1 idempotency row — in every case | same, in every case |

Reading: D1 is **all-or-nothing** (the journal is either as before the call or holds the request and the decision together); the sequential protocol can leave a request without a ticket. After recovery both
converge to the same journal shapes. The "committed, acknowledgement lost" case is the existing one: the retry returns the same ticket from the idempotency row.

## 5. Behaviour differences (all of them, none hidden)
1. **A request can disappear after a failure.** If anything fails before the single `COMMIT`, the `ACTION_REQUESTED` appended by that call is rolled back too. Today it would stay in the journal with no ticket (18 of 30 crash points). Consequence: the journal no longer records *attempts* that failed on infrastructure; a retry re-creates the request. A business refusal (DENIED / REQUIRES_APPROVAL / UNKNOWN) still commits the request, as today. The same applies when the I32 index is missing: the sequential protocol appends the request and then fails in `issue()`; D1 checks the index first and writes nothing (both return `UNAVAILABLE`, same code; tested).
2. **The pre-check never uses a stale snapshot.** Today it is a lock-free read taken before the locked issuance; D1's pre-check runs on the locked state. It can only differ in a race, in the direction of a *fresher* answer (a false refusal on staleness disappears). D1 grants nothing the sequential protocol could not have granted under the schedule "no foreign commit between the request and the issuance".
3. **The critical section is longer for one call** (the CPU of the pre-check is now inside the lock) but there is one instead of two, and one read instead of two under the lock (§6).
4. **Fault injection at SDK-part level** (wrapping `store` / `issuance`) no longer reaches this path; use the pool-level wrapper of `d1SingleSnapshot.test.ts`.
5. `ACTION_REQUEST_REJECTED` security-log rows are written in the same transaction (rolled back with it on failure).
6. The in-memory backend is unchanged (no `singleSnapshot` part): D1 is PostgreSQL-only.

## 5b. Contention, waits and the lock (differences 7–9, measured and tested)
7. **Refusals now go through the lock.** A call whose answer needs no write — an action id reused with another call, a refusal on an already-recorded request — used to read the journal **without** the lock (1 statement,
   0 lock sections) and answer even while another writer held it. With D1 every `authorize()` takes the lock (5 statements, 1 lock section). Tested: with the lock held by a foreign transaction the sequential
   protocol answers within 400 ms, D1 only after the release. Measured under mixed load (one writer + 4 callers that are only refused, 20 s, one Node process, loopback PostgreSQL; `D1_CONTENTION_RAW.jsonl`):

   | journal | protocol | writer calls/s | writer p50 (ms) | refusal p50 / p95 (ms) | refusals served |
   |---|---|---|---|---|---|
   | 10,000 events | sequential | 0.70 | 1,477 | 242 / 331 | 279 |
   | 10,000 events | D1 | **3.1** | 325 | 307 / 396 | 242 |
   | 30,000 events | sequential | 0.10 | 8,949 | 653 / 799 | 116 |
   | 30,000 events | D1 | **1.1** | 958 | 945 / 1,049 | 84 |

   So refusals get slower (+27 % at 10,000 events, +45 % at 30,000) while the writer is 4–11 times faster: the four lock-free refusers no longer compete with it for the database and the process. A deployment dominated by
   read-only refusals and few writers loses throughput on those refusals; one dominated by writers gains.
8. **The injected clock runs under the lock.** Clock reads between the lock and the COMMIT for one new authorised action: sequential **1** (the ingestion clock, already inside `append()`), D1 **2** (that one and the
   decision time `at`). A clock that blocks or is slow holds the advisory lock, and the connection, for its duration. Tested (`d1SingleSnapshot.test.ts`).
9. **Waiting is unbounded unless the database bounds it, and a waiter holds a connection.** Neither protocol sets `lock_timeout`; D1 extends the set of calls that wait (see 7).
   - *Stuck holder:* a D1 call waits as long as the holder keeps the lock. With `lock_timeout=600` on the session it fails after about that time as `UNAVAILABLE`, writes nothing (not even the request), and the next call succeeds (tested).
   - *Pool exhaustion:* callers waiting for the lock keep their connection. With a pool of 2 and 4 waiting calls, a plain `events()` read on the same pool is starved until the lock is released; the four calls then all complete (tested).
   Recommendation (operational, no code change): set `lock_timeout` (and `statement_timeout`) on the role used by the SDK, size the pool above the number of concurrent callers expected to wait, keep the injected clock non-blocking.

## 6. Measurements (PostgreSQL 16, one machine, clone-populated journals, one in four events a grant; exploratory)
Raw data: `D1_BENCHMARK_RAW.jsonl`. p95 is given only for n ≥ 20. `callers` = concurrent `authorize()` calls on the same journal.

**Without a budget** (this branch alone; the grant collection is skipped, as in main):

| events | protocol | callers | n | `authorize()` p50 / p95 / max (ms) | throughput (calls/s) | advisory lock held per call (ms) | lock sections per call |
|---|---|---|---|---|---|---|---|
| 1,000 | sequential | 1 | 30 | 36 / 49 / 49 | 26.73 | 20 | 2 |
| 1,000 | single | 1 | 30 | 12 / 18 / 22 | 75.51 | 13 | 1 |
| 1,000 | sequential | 8 | 64 | 259 / 314 / 366 | 26.14 | 31 | 2 |
| 1,000 | single | 8 | 64 | 74 / 142 / 157 | 63.19 | 15 | 1 |
| 10,000 | sequential | 1 | 30 | 324 / 386 / 416 | 3.03 | 178 | 2 |
| 10,000 | single | 1 | 30 | 95 / 127 / 133 | 10.27 | 97 | 1 |
| 10,000 | sequential | 8 | 64 | 2214 / 2538 / 2676 | 3.19 | 248 | 2 |
| 10,000 | single | 8 | 64 | 390 / 698 / 809 | 11.43 | 87 | 1 |
| 30,000 | sequential | 1 | 30 | 835 / 943 / 947 | 1.18 | 459 | 2 |
| 30,000 | single | 1 | 30 | 256 / 284 / 309 | 3.86 | 258 | 1 |
| 30,000 | sequential | 8 | 64 | 6532 / 7526 / 7676 | 1.07 | 741 | 2 |
| 30,000 | single | 8 | 64 | 1210 / 2028 / 2225 | 3.91 | 256 | 1 |
| 100,000 | sequential | 1 | 12 | 2953 / – / 3157 | 0.34 | 1638 | 2 |
| 100,000 | single | 1 | 12 | 891 / – / 967 | 1.12 | 892 | 1 |
| 100,000 | sequential | 8 | 24 | 24298 / 28186 / 29351 | 0.29 | 2844 | 2 |
| 100,000 | single | 8 | 24 | 3948 / 7133 / 7602 | 1.11 | 899 | 1 |

**With a budget, B1 `one-pass` + D1** — a *throw-away local combination* of PR #45 and this branch, **not** a branch that exists; it only shows what the two could give together:

| events | protocol | callers | n | `authorize()` p50 / p95 / max (ms) | throughput (calls/s) | advisory lock held per call (ms) | lock sections per call |
|---|---|---|---|---|---|---|---|
| 1,000 | sequential | 1 | 30 | 45 / 54 / 55 | 21.95 | 26 | 2 |
| 1,000 | single | 1 | 30 | 15 / 28 / 31 | 62.62 | 15 | 1 |
| 1,000 | sequential | 8 | 64 | 268 / 422 / 467 | 23.99 | 34 | 2 |
| 1,000 | single | 8 | 64 | 66 / 125 / 178 | 64.38 | 15 | 1 |
| 10,000 | sequential | 1 | 30 | 315 / 389 / 395 | 3.07 | 182 | 2 |
| 10,000 | single | 1 | 30 | 110 / 153 / 179 | 8.62 | 115 | 1 |
| 10,000 | sequential | 8 | 64 | 2215 / 2584 / 2683 | 3.13 | 251 | 2 |
| 10,000 | single | 8 | 64 | 511 / 876 / 983 | 9.19 | 108 | 1 |
| 30,000 | sequential | 1 | 30 | 906 / 1016 / 1044 | 1.09 | 528 | 2 |
| 30,000 | single | 1 | 30 | 304 / 407 / 433 | 3.15 | 316 | 1 |
| 30,000 | sequential | 8 | 64 | 6866 / 8016 / 8314 | 1 | 812 | 2 |
| 30,000 | single | 8 | 64 | 1452 / 2558 / 2699 | 3.12 | 320 | 1 |
| 100,000 | sequential | 1 | 12 | 3256 / – / 3539 | 0.3 | 1909 | 2 |
| 100,000 | single | 1 | 12 | 1165 / – / 1275 | 0.84 | 1190 | 1 |

Reading:
* Single caller, 100,000 events: **sequential 2.95 s → D1 0.89 s** (no budget); with budget and B1's one-pass, **3.26 s → 1.17 s** (n = 12). So D1 alone reaches the exploratory 1 s only without a budget; with a budget it is **close but above** (1.17 s p50).
* Lock held per call roughly halves (100,000 events: 1.64 s → 0.89 s); the longest single section is about the same (0.97 s vs 0.97 s), so another writer never waits longer than before.
* With 8 concurrent callers the journal serialises: throughput is bounded by one lock section (≈ 0.9 s at 100,000 events), 1.1 calls/s against 0.29 before; latency under contention is queueing, not computation.
* The remaining time is the one journal read (≈ 0.7 s at 100,000) plus its processing; going lower needs not re-reading, which is the V2 / incremental question, **not** part of D1.

## 7. What is not done / limits
* Not a proof for non-protocol writers (same assumption as today). No model checking: the evidence is the argument above, the crash matrix and the interleaving tests.
* The matrix covers one scenario (a new, authorised action). Refusal paths, replayed tickets and `guard()` flows are covered by the parity and full-suite runs, not by their own crash matrix.
* The benchmark is single-machine, loopback PostgreSQL; the 100,000-event cells have n = 12 (single caller) and no concurrent-caller cell.
* Measures of "after the call" durability (fsync) were not varied.
