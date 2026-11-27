# V2 — authenticated prefixes, seals and an external anchor: design (no implementation)

Status: **design for study, nothing implemented.** Owner's target for sensitive production use. The requirement that drives it: integrity and freshness of the
journal must be **established at the moment the action is authorised**, not only by a later audit. Everything below is conditional on the assumptions of §2.
No SPEC change, no public API change, no key, no service, no schema change is made by this document.

## 1. Properties to guarantee at decision time

For every `AUTHORIZED` result (and every ticket redemption on a sensitive operation) there must exist an **anchored head** `H = (epoch, n, hash)` such that:

* **P-auth (authentic prefix)** — the journal used for the decision is exactly the prefix `1..n` whose hash chain (`journalHash.ts`: `h_i = SHA-256(h_{i-1} ‖ digest_i)`) ends in `H.hash`;
* **P-fresh (fresh)** — at the linearisation point of the check, no head with greater `(epoch, n)` had been anchored: nothing already acknowledged to anyone is missing;
* **P-complete** — sequences `1..n` are contiguous; the delta is exactly `s+1..n`;
* **P-mono (no rollback)** — heads only advance: `(epoch, n)` is lexicographically increasing, forks are impossible for an honest sealer.

## 2. Roles and assumptions (each one is a place the design can fail)

| component | does | assumption (A#) |
|---|---|---|
| **Writer / SDK** (PostgreSQL, advisory lock, D1-style single critical section) | appends events, computes the chain, asks for the seal | **A1** protocol-following writers take the lock; a non-compliant writer can only create gaps or unique violations that P-complete rejects |
| **Sealing service** (isolated; key in a non-exportable KMS/HSM key) | signs `Seal = Sign_K("authority-seal/v1" ‖ epoch ‖ n ‖ hash ‖ prev_hash ‖ counter)` | **A2** it keeps its own last sealed head and signs only a head that *extends* it: the writer sends `(prev_head, delta events)`, the service recomputes the chain over the delta itself; key never leaves the KMS; its audit log is append-only |
| **External anchor** (provider-independent interface, §5) | stores the latest sealed head | **A3** conditional write (compare-and-set on the previous version) and read-your-writes; durable; monotone by construction of the CAS; its credentials are not the sealing key |
| **Verifier** (in the SDK, and optionally at the enforcement point) | checks signatures, chain extension and anchor equality | **A4** the public key (or its epoch certificate chain) reaches the verifier by a path the database administrator does not control |
| hash function | SHA-256 | **A5** collision resistance |

What V2 does **not** protect against: a writer that is allowed to append false events (events are asserted, I17); compromise of the sealing key or of the KMS
policy; simultaneous compromise of database **and** anchor **and** verifier's key distribution; loss of availability (it increases availability coupling, §7).

## 3. Protocol

State: DB tables `authority_events` (unchanged) and `journal_seals(epoch, n, hash, prev_hash, counter, signature, created_at)` (append-only, new).
Anchor record: `A = (epoch, n, hash, seal, state ∈ {COMMITTED, PENDING})`, versioned by the provider.

**Write path (every transaction that appends, under the advisory lock):**
1. read the anchor `A₀` (a read through the interface); read the DB head; require `DB.head == A₀.head` *or* `DB.head == A₀.pending` (a crashed finaliser, §4), else **fail closed** (`UNAVAILABLE`, integrity alarm);
2. decide (D1: one read); append the events inside the transaction;
3. compute the new head `H₁`; send `(A₀.head, delta, H₁)` to the sealing service → `Seal₁` (service checks extension, bumps its counter);
4. **PREPARE** — CAS the anchor `A₀ → (H₁, Seal₁, PENDING)`; a failed CAS means another sealer advanced: roll back, fail closed;
5. `COMMIT` the DB transaction (events + `journal_seals` row);
6. **FINALISE** — CAS the anchor `PENDING → COMMITTED`; only now is the result released to the caller (**seal-before-release**: no ticket leaves the process before steps 3–6 succeeded).
Steps 3–4 and 6 add network round trips inside or next to the critical section; §7 gives the cost and the batching option.

**Read path (decision on an existing prefix, no write needed — e.g. redemption check, refusal):** under the lock, read the anchor and the DB head and apply the same equality test of step 1; the decision is released only if it holds.

**Prefix cache (the part that removes the full re-read):** the process keeps events `1..s`, the engine's prefix state and `h_s` **after** a full verification (§4, "load"). A call, under the lock:
reads `A₀`; reads rows `> s` (delta, contiguity checked); recomputes the chain over the delta from `h_s`; requires the result to equal `A₀.head` (or the pending head). The cached
prefix is authentic because it was verified once against a signed, anchored head; later edits to DB rows `≤ s` **cannot change a decision**, and are found by the next load or audit.
(Contrast with V0/V1 in `B1_READ_REDUCTION_STUDY.md`: here the prefix is bound to a signature and to an anchor, not to database privileges.)

## 4. Recovery and failure cases (what the system does at authorisation time)

| situation | detection | outcome |
|---|---|---|
| DB restored from an older backup | `DB.n < A.n` | refuse (`UNAVAILABLE`, integrity alarm) until the disaster-recovery procedure below |
| rows `≤ s` edited/deleted in the database | **without** the cache: the chain recomputed from a full read ≠ anchored hash → refuse. **With** the cache: not seen per call (the delta is chained from the cached `h_s`), decisions still use the authentic cached prefix; the edit is found at the next load, by the periodic re-verification, or by audit — a stated limit of the cache | refuse / decide on the authentic prefix + raise an alarm on re-verification |
| rows `> s` edited or a forged suffix | delta chained from `h_s` ≠ anchored head | refuse |
| replica lag / stale read | `DB.n < A.n` | refuse or retry; never decide on a stale prefix |
| crash after PREPARE, before COMMIT | anchor `PENDING(H₁)`, DB head `H₀` | next writer: **abort** (CAS `PENDING → COMMITTED(H₀)` with the previous seal) — the events never existed |
| crash after COMMIT, before FINALISE | anchor `PENDING(H₁)`, DB head `H₁` | next writer: **finalise** (CAS `PENDING → COMMITTED(H₁)`); the caller of the crashed call got `UNAVAILABLE`, the retry replays the ticket (idempotency row) |
| sealing service or anchor unreachable | timeout | `UNAVAILABLE` (never `DENIED`, never `AUTHORIZED`); nothing released |
| anchor rolled back by its operator | verifier keeps a local monotone high-water mark `(epoch, n)` and compares | refuse; with two independent anchors, a quorum read |
| fork (two sealers) | service refuses a head that does not extend its own | no seal; the second writer fails closed |

**Disaster recovery** (decided by the owner): the only way to adopt a DB state older than the anchor, or to re-root after a sealing-key loss, is a signed *epoch change*: a new monotone
`epoch` whose first head records `(old epoch, old head, new genesis reason)`, authorised by **two distinct, authenticated human approvers**, with an audit entry, executed by the sealing
service only (the service refuses an epoch change without both approvals). The old chain stays verifiable; decisions in a new epoch are never mixed with a lower epoch.

## 5. Interfaces (sketch, TypeScript, not code in the repository)

```ts
interface Anchor {                                   // provider-independent
  read(): Promise<{ record: AnchorRecord; version: string } | undefined>;
  compareAndSet(expectedVersion: string | undefined, next: AnchorRecord): Promise<{ ok: true; version: string } | { ok: false }>;
}
interface Sealer {                                   // the isolated service
  seal(request: { prevHead: Head; delta: readonly AuthorityEvent[]; epoch: number }): Promise<Seal>;
  verifyKey(epoch: number): Promise<PublicKeyCertificate>;
}
```
Required provider properties: conditional write on a version/etag, strongly consistent read of the latest version, durability, ideally object lock/versioning (audit of every value).
Implementations to evaluate later (none selected): object store with conditional put, a consensus store, a transparency-log service.

## 6. What to prove / test before any implementation
1. A paper proof that P-auth, P-fresh, P-complete, P-mono follow from A1–A5 for the protocol of §3, including each crash point (a table like `d1SingleSnapshot.test.ts` for the new statements).
2. A model check (TLA+/Alloy or an exhaustive interleaving harness) over: two writers, one sealer, one anchor, crash/restart at every step, anchor read staleness.
3. Fault-injection tests for every row of §4 on PostgreSQL with a fake anchor and fake sealer (adversarial modes: stale read, lost CAS ack, duplicate delivery, rollback).
4. A key-management and rotation plan (epoch certificates, verifier distribution, KMS audit, break-glass), reviewed by someone who did not write it.
5. Only then measurements.

## 7. Cost, estimated (not measured)
Per sensitive write: anchor read + seal + two CAS = 4 network round trips (≈ 5–40 ms each depending on the provider), **inside the serialisation window** if done as above: throughput of
one journal is bounded by `1 / (window)`; batching several pending requests under one seal (group commit) is the standard mitigation and needs its own design. Per read-only call: one anchor read.
With the verified prefix cache, **journal reads drop to the delta**, which is what makes sub-second authorisation at 100,000 events plausible; the engine-side incremental evaluator remains a separate, unauthorised piece of work.

## 8. Decisions needed from the owner before a next step
* policy classes: is `seal-before-release` mandatory for all operations or only for those marked sensitive (the others degrading to unanchored decisions)?
* the anchor provider class to study first, and whether two independent anchors (quorum) are required;
* acceptable added latency per sensitive authorisation (budget in ms) and acceptable single-journal throughput;
* who the two recovery approvers are and how they authenticate (this document assumes they exist).
