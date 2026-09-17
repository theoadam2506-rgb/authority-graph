# authority-graph

A deterministic engine that reconstructs the human authority chain behind an
agent's action: given a log of events, it answers *what authority existed
exactly at instant T, and why* — prospectively (`authorityAt`) or
historically, after the fact (`explainAction` / `explain`).

See [`SPEC.md`](./SPEC.md), [`THREAT_MODEL.md`](./THREAT_MODEL.md) and
[`EVENT_MODEL.md`](./EVENT_MODEL.md) for the invariants, threat table, and
event schema this engine is built against.

## Run the demo

```
npm run demo
```

One command, no database, no network, no API key. It plays a full scenario —
delegation, sub-delegation, a rejected laundering attempt, an approval-gated
escalation, single-use consumption, revocation, backdating, and a historical
`authority explain` on a now-defunct authority — entirely in memory, and
**asserts** the property each step claims to demonstrate. If any assumption
stops holding, the script throws and exits non-zero; it is a narrative
integration test, not a slideshow.

### Actual output

```
$ npm run demo

> authority-graph@0.0.0 demo
> tsx demo/run.ts


==============================================================================
1. Délégation racine — Theo → Agent A
==============================================================================
  ✓ Root delegation Theo -> A -> accepted at sequence 1
  ✓ A holds purchase_order.create directly from Theo -> AUTHORIZED (chain: d-theo-a)

==============================================================================
2. Sous-délégation valide — A → B, ≤ 2000
==============================================================================
  ✓ Sub-delegation A -> B (<=2000, bounded within Theo -> A per I5) -> accepted at sequence 2

==============================================================================
3. Laundering refusé — Mallory (jamais habilitée) tente une chaîne invalide
==============================================================================
  ✓ Mallory's forged sub-delegation off Theo -> A -> rejected at ingestion (UNAUTHORIZED_SUBDELEGATION), no canonical sequence assigned
  ✓ Rejected draft appears in the security log (reasonCode: UNAUTHORIZED_SUBDELEGATION), event_id evt-subdelegation-3
  ✓ Canonical store still has 2 events — the rejected draft never entered it
  ✓ Mallory holds no authority whatsoever (her fabricated delegation never existed canonically) -> UNKNOWN (C24_NO_VALID_CHAIN)

==============================================================================
4. Action normale — B tente 1800 → AUTHORIZED
==============================================================================
  ✓ B requests purchase_order.create for 1800 EUR -> accepted at sequence 3
  ✓ B executes the 1800 EUR action -> accepted at sequence 4
  ✓ B's 1800 EUR action is authorized, automatically, within its own band -> AUTHORIZED (chain: d-theo-a -> d-a-b)

==============================================================================
5. Escalade — 4800 dépasse B, passe par A via la délégation racine
==============================================================================
  ✓ B cannot reach 4800 EUR — its own delegation caps it at 2000 -> DENIED (C8_AMOUNT_EXCEEDS_APPROVAL_CEILING)
  ✓ A can reach 4800 EUR via the root delegation, but it falls in the approval band (2500 < 4800 <= 5000) -> REQUIRES_APPROVAL (via d-theo-a)
  ✓ A requests purchase_order.create for 4800 EUR -> accepted at sequence 5

==============================================================================
6. Binding d'approbation — Theo approuve exactement l'action à 4800
==============================================================================
  ✓ A requests Theo's approval for the 4800 EUR action -> accepted at sequence 6
  ✓ Theo grants approval appr-4800 -> accepted at sequence 7
  ✓ The exact approved action (4800 EUR, vendor-1) is now authorized -> AUTHORIZED (chain: d-theo-a, approval: appr-4800)
  ✓ Changing the amount by 1 EUR makes the same approval unusable (I15 binds the exact fingerprint) -> REQUIRES_APPROVAL (via d-theo-a)
  ✓ Changing the recipient makes the same approval unusable -> REQUIRES_APPROVAL (via d-theo-a)

==============================================================================
7. Usage unique — exécution valide, puis seconde consommation → refus
==============================================================================
  ✓ A executes the 4800 EUR action, consuming appr-4800 -> accepted at sequence 8
  ✓ a-a-4800's execution was authorized at its own decision sequence -> AUTHORIZED (chain: d-theo-a, approval: appr-4800)
  ✓ The exact same request, asked again, is now denied: the approval is spent -> DENIED (C7_APPROVAL_ALREADY_CONSUMED)
  ✓ A second, identical 4800 EUR request is recorded -> accepted at sequence 9
  ✓ The log accepts a second ACTION_EXECUTED reusing appr-4800 (I3: append-only never blocks a structurally valid record) -> accepted at sequence 10
  ✓ But resolution denies it: the log recording it does not grant it authority -> DENIED (C7_APPROVAL_ALREADY_CONSUMED)

==============================================================================
8. Révocation — Theo révoque d-theo-a ; les descendants qui en dépendent exclusivement tombent
==============================================================================
  ✓ Theo revokes d-theo-a -> accepted at sequence 11
  ✓ A's own authority is gone immediately -> DENIED (C12_DELEGATION_REVOKED)
  ✓ B's authority — which only ever existed through d-theo-a — falls too, even though d-a-b itself was never touched -> DENIED (C12_DELEGATION_REVOKED)

==============================================================================
9. Backdating — occurred_at antérieur injecté ; l'autorité n'est pas restaurée
==============================================================================
  ✓ Ingestion accepts the structurally valid request regardless of its occurred_at claim (I4: occurred_at is never decisional) -> accepted at sequence 12
  ✓ The backdated occurred_at does not resurrect a revoked delegation — sequence and authority_time are unmoved -> DENIED (C12_DELEGATION_REVOKED)
  ✓ explain() flags LATE_OR_BACKDATED_EVENT_OBSERVED for this event (drift: 157885200000ms) — diagnostic only, and it changed no decision above

==============================================================================
10. explain historique — l'autorité d'hier, expliquée aujourd'hui
==============================================================================
  ✓ execution.authorityAtDecision is identical whether asked right after execution or 44 hours later
  ✓ ...while currentAuthority, asked today, reflects that this authority no longer exists -> DENIED (C11_CAPABILITY_NOT_COVERED)
  (the chain is both revoked — sequence 11 — and, independently, expired past 2025-01-01T10:00:00.000Z: either fact alone would deny it today)

  --- authority explain a-a-4800 (real CLI output) ---

  source: imported canonical event export
  ACTION_EXECUTED at sequence 8
  authority at decision sequence 7: AUTHORIZED
  approval consumed by execution 8
  current authority at sequence 12: DENIED
    reason: C11_CAPABILITY_NOT_COVERED — no valid delegation chain covers the requested capability

  Authority chain (root to leaf, as declared when each delegation was created):
    - delegation d-theo-a: theo (HUMAN_ROOT) -> agent-a (granted at sequence 1)
        capabilities: purchase_order.create
        can_delegate: true
        expires_at: 2025-01-01T10:00:00.000Z
        thresholds: automatic<=2500, approval<=5000
        revocation: the log contains a DELEGATION_REVOKED event asserting that theo revoked this delegation at sequence 11 (reason: POLICY_REVIEW)

  Approvals:
    - approval appr-4800 (requested at sequence 6 from theo)
        the log contains an event asserting that theo granted this approval at sequence 7

  Clock drift diagnostics:
    LATE_OR_BACKDATED_EVENT_OBSERVED: ACTION_REQUESTED (evt-action-request-13) — |authority_time - occurred_at| = 157885200000ms (authority_time: 2025-01-01T09:00:00.000Z, occurred_at: 2020-01-01T00:00:00.000Z)

  assurance_level: ASSERTED_UNVERIFIED — no cryptographic signature or verified identity backs any event in this log (I17); every claim above is "the log contains an event asserting", never a proof.

  ✓ CLI confirms: authorized at its own decision sequence -> AUTHORIZED (chain: d-theo-a, approval: appr-4800)
  ✓ CLI confirms: not authorized today -> DENIED (C11_CAPABILITY_NOT_COVERED)
  ✓ The real `authority explain` CLI reproduces exactly the properties checked above, from a plain JSON export, with no database and no network

==============================================================================
All properties held. Demo complete.
==============================================================================
```

The last section is the point of the whole exercise: `d-theo-a` is revoked
*and* expired — today, nothing authorizes A to spend 4800 EUR. And yet the
log still lets us reconstruct, precisely and mechanically, why that same
action was legitimate at sequence 8, back when it ran.

## The CLI

```
npm run authority -- explain <action_id> [--json] \
  [--events <path> | --db <connection-string>] \
  [--at-sequence <n>] [--authority-time <iso8601>] \
  [--clock-drift-threshold-ms <n>]
```

Two event sources, nothing else (no UI, no HTTP server, no auth, no
multi-tenant): a JSON export of an already-canonical log (`--events`), or a
live Postgres store (`--db`, or `DATABASE_URL`).

**On `--events`:** the CLI never implies that a local JSON file has been
validated by Authority. Every event keeps whatever `assurance_level` it was
ingested with (`ASSERTED_UNVERIFIED` in V0 — see below), and the CLI's own
output additionally labels where the data came from: `source: imported
canonical event export` in the text output, and a top-level `"source"` field
in `--json`. Reading a file is not re-running I12/I13/I14 against it, and the
CLI does not pretend otherwise.

## Storage

Two `EventSource` implementations behind one interface
(`src/storage/eventStore.ts`): `InMemoryEventStore` for tests and this demo,
and `PostgresEventStore` (`src/storage/postgresEventStore.ts`) for anything
persistent. Postgres is a journal, never a decision-maker — no authority
logic in SQL, no triggers, no view computing a permission
(`src/storage/schema.sql`).

**V0 correctness-first storage.** PostgreSQL append serializes cooperative
writers and reconstructs ingestion state from canonical history on each
append. This is intentionally not designed for high-throughput production
workloads. (No "works up to N events" claim is made here — that number has
never been benchmarked, and a guessed one would be worse than none.)

**The `EventSource` API is append-only; integrity against a privileged SQL
writer is not a V0 guarantee.** `pg_advisory_xact_lock` only protects writers
that go through this API and cooperate with it — it is a mutex between
well-behaved callers, not a database-level permission barrier. Nothing in
`schema.sql` revokes `UPDATE`/`DELETE` grants or otherwise stops a writer with
raw SQL access (or a different, non-cooperating client) from mutating rows
directly. The Postgres journal is *not* intrinsically append-only; it is
append-only because every path this codebase provides to write to it is, and
because no other path is provided. Enforcing that at the database's own
permission layer is future work, not something already in place.

**Assurance level.** V0 has no signature scheme and no verified identity.
Every event, from every source, carries `assurance_level: "ASSERTED_UNVERIFIED"`
— always. An "authorized" decision means *the log contains events asserting
a chain of grants, none of them contradicted*, not that any of those grants
were cryptographically proven. The CLI and `explain()`'s output phrase every
claim accordingly ("the log contains an event asserting that X granted Y"),
never "X proved" or "X is authorized to" as a bare fact.

### Required before production (not implemented here)

These need a real, running Postgres instance to mean anything — they are
integration tests against actual concurrent connections and transactions,
not something an in-memory fake can stand in for. Documented so they aren't
forgotten, not implemented in this repo:

1. **Two `PostgresEventStore` instances against the same database keep
   sequences unique and strictly increasing.** Construct two independent
   `PostgresEventStore`s (two pools, or two processes) pointed at the same
   schema; drive concurrent `append()` calls from both; assert the union of
   all accepted sequences has no duplicate and no gap-introducing race, i.e.
   `pg_advisory_xact_lock` actually serializes them end to end under real
   contention, not just in the single-writer case this repo's own tests
   exercise.
2. **A rejected append never consumes a sequence number.** Under the same
   two-writer setup, interleave batches that mix accepted and
   `ingestionAuthorityFailure`-rejected drafts; assert the accepted sequence
   numbers are exactly `1..k` with no reservation made, and released or
   otherwise skipped, for a rejected draft — a property this repo's
   in-memory tests already prove for one writer (`tests/storage/eventStore.test.ts`),
   but not for two writers racing through real Postgres transactions.

## Development

```
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run demo        # the scenario above
```
