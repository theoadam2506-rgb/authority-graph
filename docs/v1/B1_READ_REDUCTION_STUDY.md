# Reducing journal reads per call — study (no implementation)

Status: **study only.** Nothing described here is implemented, enabled or proposed for merge. No cache, no incremental mode, no change of the trust
model without the owner's decision. Everything marked *estimate* is arithmetic on measured numbers, not a measurement of an implementation.

## 1. What a call reads today (measured)

For a **new action**, `authorize()` materialises the whole journal **four times** (rows counted at the `pg` result level, journals of 10,000 and 30,000 events,
budgeted, `one-pass` mode, 6 calls each): 40,008 and 120,008 rows, i.e. 4 × n.

| # | where | lock | purpose |
|---|---|---|---|
| 1 | `ensureRequested` → `store.getEvents()` | none | is the request already there? |
| 2 | `store.append([request])` → `SELECT * … ORDER BY sequence` inside `appendWithin` | advisory lock | rebuild the ingestion state, validate, assign the sequence |
| 3 | `store.getEvents()` | none | read-only pre-check (`selectInvokedGrant`) — a refusal must never be recorded under the idempotency key |
| 4 | `issuance.issue()` transaction | advisory lock | the decision that counts |

(An action whose request already exists skips 2 and 3's re-read since O2-1: 2 reads.) The decision that grants anything is #4 only.

Cost structure at 100,000 events (p50, `docs/v1/B1_READ_STUDY_MEASURES.jsonl`, `B1_BENCHMARK_RAW.jsonl`): one `getEvents` ≈ 0.69 s, of which the SQL + `pg` row parsing alone is
0.48 s; B1's grant collection 0.20 s; the call 3.6 s. Delta reads are cheap: **10 rows 0.6 ms, 1,000 rows 6 ms, head row 0.5 ms, count/min/max 13 ms**.
A server-side digest of the table costs 0.43 s at 100k, i.e. as much as reading it: it is **not** a cheaper way to verify a prefix.

## 2. Candidate designs

* **D1 — one locked snapshot per call.** One transaction: advisory lock, one read, ensure the request (append it in the same transaction), decide, issue, commit. Reads: 4 → 1.
* **D2 — verified prefix + delta read.** The process keeps events 1..s (and the engine's prefix state); a call, under the advisory lock, reads only `sequence > s`.
  Variants of "verified": **V0** trust append-only (no verification); **V1** a hash chain stored per row by the writer, head compared with the cached one;
  **V2** the same chain **signed/sealed** (the architecture-C seal; out of scope: P1–P5 are not started).
* **D3 — drop the lock-free pre-check read** (reuse read #1 plus the own append). Reads: 4 → 3.

## 3. What must be proved, per design

Definitions. *Coherence*: the decision is computed from one state of the journal that actually existed. *Freshness*: that state includes every event committed before the
decision's serialization point. *Completeness*: nothing in 1..head is missing (contiguity) and nothing is invented. *Prefix immutability*: events already read have not changed.

### D1 — coherence, freshness, completeness
* **Coherence + freshness (provable from the code as it is).** Every protocol-following writer takes `pg_advisory_xact_lock(hashtext('authority_events'))` before reading and writing
  (`postgresEventStore.ts:136`, the issuance and redemption transactions). Locks are granted one at a time, a writer commits before releasing, so a snapshot taken **after** the lock was granted
  (the code uses the default READ COMMITTED; that is sufficient because the one journal read is a single statement issued after the lock — the "snapshot-after-lock" rule) sees every transaction committed before and none after. Hence the decision is taken from exactly the journal state at its serialization point.
* **Completeness.** Sequences are assigned under the same lock (max + 1) and there is a unique index on `sequence`; the journal read is contiguous 1..n or the existing code already rejects it
  (`journalHead` refuses a gap). A writer that bypasses the lock (the I32 comment names one) can only create a gap or a unique violation, never a state the snapshot misreads.
* **Equivalence with today.** Today = C1 (append request) ; P (lock-free pre-check) ; C2 (issue), with foreign commits allowed between them. D1 fuses C1;C2 in one critical section and removes P.
  Every D1 outcome is an outcome of today's protocol under the schedule "no foreign commit between C1 and C2", so **D1 cannot grant anything today's protocol could not grant** (safety direction holds).
  **It is not byte-identical**, and these differences would have to be decided, not hidden:
  1. if anything fails after the request was appended, today the `ACTION_REQUESTED` stays in the journal; in D1 the transaction rolls back (unless the request is committed first, which brings back a second critical section and a second read);
  2. P could refuse on a stale snapshot; D1 refuses only on the fresh one (an authorisation D1 gives and today would have refused for staleness; never the reverse);
  3. the number and order of statements change, so the fault-injection tests of O2-1 (reads/appends failing at the n-th call) would change meaning.
* **Not provable here:** that no non-compliant writer exists. It is the existing assumption; D1 does not add to it.

### D3 — freshness only
P is advisory (it grants nothing: the grant is #4). A stale snapshot can only produce a **false refusal** (e.g. a delegation or request that arrived out of order, A5) returned to the caller without being recorded. That is a
behaviour change in races, safety-neutral, but it contradicts "no silent change of result" unless the owner accepts it.

### D2 — the heavy one: this is where a new trust hypothesis appears
* **Coherence + freshness:** hold if the delta read happens under the advisory lock after acquiring it (same argument as D1) and the cached prefix equals the journal's prefix.
* **Completeness:** the delta must be exactly `s+1..m` contiguous; any hole, or `m < s`, invalidates the cache (full re-read). Checkable in O(delta).
* **Prefix immutability is the new assumption.** Today every decision re-reads the journal, so an `UPDATE`/`DELETE` by a privileged role or a restored backup is *seen* by the next decision. With a cached prefix it is **not seen until the cache is dropped**.
  * V0 rests entirely on database privileges (`roles.sql`, `append_only_check.sql`; there is no trigger): a trust assumption the engine does not currently make.
  * V1 (stored chain hash, unsigned) detects accidental corruption and non-recomputing edits, **not** an adversary able to rewrite rows and recompute the chain (such a writer can also forge the head).
  * V2 (sealed) is what would make the assumption checkable against a privileged adversary; it needs the key-management and external-anchor decisions that are explicitly out of scope.
  * A periodic full re-verification bounds the exposure window but does not remove it, and its cost is the current cost.
* **Engine side:** a cached journal is useless for the 0.20 s of grant collection unless the engine's prefix state (`PrefixState`) is kept and extended — i.e. an incremental evaluator, which the owner did not authorise. The
  guard (late activation) would also have to be maintained incrementally; a late activation inside the delta invalidates the cached state.

## 4. What it would buy (estimates — not implementations)

| design | full-journal reads / new action | estimate at 100,000 events, budgeted |
|---|---|---|
| today (B1 one-pass) | 4 | 3.6 s (measured) |
| D3 | 3 | ≈ 2.9 s (3 × 0.69 + 0.2 + other ≈ 0.6) |
| D1 | 1 | ≈ 1.0–1.3 s (0.69 read + 0.20 collection + ≈ 0.1–0.4 other O(n) steps): **borderline for 1 s, not reliably under** |
| D2 (+ incremental engine) | 0 full, delta only | ≪ 0.1 s plausible (delta 1–6 ms; the rest is decision on the delta) — **requires the incremental engine and the V0/V1/V2 trust choice** |

So: **D1 alone does not safely meet the < 1 s exploratory criterion at 100,000 events**; D2 does, at the price of a new assumption (prefix immutability) and an incremental evaluator.

## 5. Evidence required before any implementation (proposed, nothing done)
1. Controlled-interleaving tests on PostgreSQL (barriers in front of the lock, the pre-check and the issuance; foreign writers between C1 and C2, including a non-compliant writer) proving D1's outcomes are a subset of today's and listing exactly the differences of §3.
2. Fault-injection parity with the O2-1 suite, with the three differences of §3 decided one by one.
3. For D2: a written threat model for the cache (restore from backup, privileged `UPDATE`, replica lag, two processes, process restart), the choice V0/V1/V2, and a proof that a hole, a rewrite of the head or a late activation inside the delta always invalidates the cache.
4. Only then, measurements of an implementation, on the same profile as `B1_EQUIVALENCE.md` §9.

## 6. Decisions asked of the owner
* Is **D1** worth a Draft implementation study (reads 4 → 1, accepting the three differences or fixing them), knowing it is estimated to *approach* but not reliably reach 1 s?
* Is **D2** to be pursued at all, and under which trust choice (V0 / V1 / V2)? It is the only design estimated to reach well under 1 s; it changes the trust model.
* Is **D3** acceptable (false refusals on stale snapshots in races)?
