# authority-graph

An AI agent executes an action. Six months later, nobody can say exactly what
human authority covered it at that moment, or why. This engine answers that
question deterministically, from an append-only log of events — delegation,
approval, execution — nothing else.

## What it does

The engine exposes exactly two operations, never a third path:

- **`authorityAt(events, query, at)`** — prospective. *Would this be
  authorized right now, given everything logged so far?* It never requires
  the action to have already been requested — it answers a question about
  the current state of authority, not about one specific past event.
- **`explainAction(events, { actionId }, at)`** (and its formatted
  counterpart, `explain()`) — historical. *What happened to this specific
  action, and why?* It resolves authority both at the moment of any recorded
  execution and at the query's own instant. An action that was authorized
  when it ran stays authorized at that point forever — I3 (append-only)
  forbids rewriting that conclusion — even after the authority that backed
  it has since been revoked or expired.

They stay separate on purpose. A question about the current state of
authority must never be structurally dependent on some past action having
been requested, and a question about what actually happened to one action
needs that action's own history (its approvals, its denials) — history a
fresh, unrelated prospective query has no business consulting.

## Quickstart

```
npm install
npm run demo
```

One command, no database, no network, no API key. It plays a full scenario —
delegation, sub-delegation, a rejected forgery attempt, an approval-gated
escalation, single-use consumption, revocation, backdating, and a historical
`authority explain` on a now-defunct authority — entirely in memory, and
**asserts** the property each step claims to demonstrate. If any assumption
stops holding, the script throws and exits non-zero; it is a narrative
integration test, not a slideshow. Its actual output is reproduced byte for
byte below.

The CLI:

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
in `--json`. Reading a file is not re-running the ingestion-time checks
against it, and the CLI does not pretend otherwise.

## Demo output

```
$ npm run demo

> authority-graph@0.0.0 demo
> tsx demo/run.ts


==============================================================================
1. Root delegation — User → Agent A
==============================================================================
  ✓ Root delegation user -> A -> accepted at sequence 1
  ✓ A holds purchase_order.create directly from the user -> AUTHORIZED (chain: d-user-a)

==============================================================================
2. Valid sub-delegation — A → B, ≤ 2000
==============================================================================
  ✓ Sub-delegation A -> B (<=2000, bounded within user -> A per I5) -> accepted at sequence 2

==============================================================================
3. Laundering rejected — Mallory (never granted anything) attempts an invalid chain
==============================================================================
  ✓ Mallory's forged sub-delegation off user -> A -> rejected at ingestion (UNAUTHORIZED_SUBDELEGATION), no canonical sequence assigned
  ✓ Rejected draft appears in the security log (reasonCode: UNAUTHORIZED_SUBDELEGATION), event_id evt-subdelegation-3
  ✓ Canonical store still has 2 events — the rejected draft never entered it
  ✓ Mallory holds no authority whatsoever (her fabricated delegation never existed canonically) -> UNKNOWN (C24_NO_VALID_CHAIN)

==============================================================================
4. Normal action — B attempts 1800 → AUTHORIZED
==============================================================================
  ✓ B requests purchase_order.create for 1800 EUR -> accepted at sequence 3
  ✓ B executes the 1800 EUR action -> accepted at sequence 4
  ✓ B's 1800 EUR action is authorized, automatically, within its own band -> AUTHORIZED (chain: d-user-a -> d-a-b)

==============================================================================
5. Escalation — 4800 exceeds B, goes through A via the root delegation
==============================================================================
  ✓ B cannot reach 4800 EUR — its own delegation caps it at 2000 -> DENIED (C8_AMOUNT_EXCEEDS_APPROVAL_CEILING)
  ✓ A can reach 4800 EUR via the root delegation, but it falls in the approval band (2500 < 4800 <= 5000) -> REQUIRES_APPROVAL (via d-user-a)
  ✓ A requests purchase_order.create for 4800 EUR -> accepted at sequence 5

==============================================================================
6. Approval binding — User approves exactly the 4800 action
==============================================================================
  ✓ A requests the user's approval for the 4800 EUR action -> accepted at sequence 6
  ✓ The user grants approval appr-4800 -> accepted at sequence 7
  ✓ The exact approved action (4800 EUR, vendor-1) is now authorized -> AUTHORIZED (chain: d-user-a, approval: appr-4800)
  ✓ Changing the amount by 1 EUR makes the same approval unusable (I15 binds the exact fingerprint) -> REQUIRES_APPROVAL (via d-user-a)
  ✓ Changing the recipient makes the same approval unusable -> REQUIRES_APPROVAL (via d-user-a)

==============================================================================
7. Single use — valid execution, then a second consumption attempt → denied
==============================================================================
  ✓ A executes the 4800 EUR action, consuming appr-4800 -> accepted at sequence 8
  ✓ a-a-4800's execution was authorized at its own decision sequence -> AUTHORIZED (chain: d-user-a, approval: appr-4800)
  ✓ The exact same request, asked again, is now denied: the approval is spent -> DENIED (C7_APPROVAL_ALREADY_CONSUMED)
  ✓ A second, identical 4800 EUR request is recorded -> accepted at sequence 9
  ✓ The log accepts a second ACTION_EXECUTED reusing appr-4800 (I3: append-only never blocks a structurally valid record) -> accepted at sequence 10
  ✓ But resolution denies it: the log recording it does not grant it authority -> DENIED (C7_APPROVAL_ALREADY_CONSUMED)

==============================================================================
8. Revocation — User revokes d-user-a; descendants that depend on it exclusively fall too
==============================================================================
  ✓ The user revokes d-user-a -> accepted at sequence 11
  ✓ A's own authority is gone immediately -> DENIED (C12_DELEGATION_REVOKED)
  ✓ B's authority — which only ever existed through d-user-a — falls too, even though d-a-b itself was never touched -> DENIED (C12_DELEGATION_REVOKED)

==============================================================================
9. Backdating — an earlier occurred_at is injected; authority is not restored
==============================================================================
  ✓ Ingestion accepts the structurally valid request regardless of its occurred_at claim (I4: occurred_at is never decisional) -> accepted at sequence 12
  ✓ The backdated occurred_at does not resurrect a revoked delegation — sequence and authority_time are unmoved -> DENIED (C12_DELEGATION_REVOKED)
  ✓ explain() flags LATE_OR_BACKDATED_EVENT_OBSERVED for this event (drift: 157885200000ms) — diagnostic only, and it changed no decision above

==============================================================================
10. Historical explain — yesterday's authority, explained today
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
    - delegation d-user-a: user (HUMAN_ROOT) -> agent-a (granted at sequence 1)
        capabilities: purchase_order.create
        can_delegate: true
        expires_at: 2025-01-01T10:00:00.000Z
        thresholds: automatic<=2500, approval<=5000
        revocation: the log contains a DELEGATION_REVOKED event asserting that user revoked this delegation at sequence 11 (reason: POLICY_REVIEW)

  Approvals:
    - approval appr-4800 (requested at sequence 6 from user)
        the log contains an event asserting that user granted this approval at sequence 7

  Clock drift diagnostics:
    LATE_OR_BACKDATED_EVENT_OBSERVED: ACTION_REQUESTED (evt-action-request-13) — |authority_time - occurred_at| = 157885200000ms (authority_time: 2025-01-01T09:00:00.000Z, occurred_at: 2020-01-01T00:00:00.000Z)

  assurance_level: ASSERTED_UNVERIFIED — no cryptographic signature or verified identity backs any event in this log (I17); every claim above is "the log contains an event asserting", never a proof.

  ✓ CLI confirms: authorized at its own decision sequence -> AUTHORIZED (chain: d-user-a, approval: appr-4800)
  ✓ CLI confirms: not authorized today -> DENIED (C11_CAPABILITY_NOT_COVERED)
  ✓ The real `authority explain` CLI reproduces exactly the properties checked above, from a plain JSON export, with no database and no network

==============================================================================
All properties held. Demo complete.
==============================================================================
```

The last section is the point of the whole exercise: `d-user-a` is revoked
*and* expired — today, nothing authorizes A to spend 4800 EUR. And yet the
log still lets us reconstruct, precisely and mechanically, why that same
action was legitimate at sequence 8, back when it ran.

## What it doesn't do

- **No signatures, no verified identity.** V0 has no signature scheme.
  Every event, from every source, carries
  `assurance_level: "ASSERTED_UNVERIFIED"` — always. An "authorized"
  decision means *the log contains events asserting a chain of grants, none
  of them contradicted*, not that any of those grants were cryptographically
  proven. The CLI and `explain()`'s output phrase every claim accordingly
  ("the log contains an event asserting that X granted Y"), never "X
  proved" or "X is authorized to" as a bare fact.
- **Storage is correctness-first, not throughput-first.** PostgreSQL append
  serializes cooperative writers and reconstructs ingestion state from
  canonical history on each append. This is intentionally not designed for
  high-throughput production workloads. No "works up to N events" claim is
  made anywhere in this repo — that number has never been benchmarked, and a
  guessed one would be worse than none.
- **The `EventSource` API is append-only; the Postgres journal itself is
  not, against a privileged writer.** `pg_advisory_xact_lock` only protects
  writers that go through this API and cooperate with it — it is a mutex
  between well-behaved callers, not a database-level permission barrier.
  Nothing in `schema.sql` revokes `UPDATE`/`DELETE` grants or otherwise
  stops a writer with raw SQL access (or a different, non-cooperating
  client) from mutating rows directly. Append-only is a property of every
  code path this repository provides to write to the journal, not an
  intrinsic property of the Postgres table itself. Enforcing that at the
  database's own permission layer is future work, not something already in
  place.
- **Budget overspend from concurrent decisions (TOCTOU) is detected, not
  prevented.** Two individually `AUTHORIZED` decisions against the same
  `total_budget`, made before either is executed, can combine to exceed it —
  V0 has no reservation primitive. Once both executions are ingested, the
  remaining budget at any later sequence honestly reflects the overspend
  (negative if necessary), and `explain()` reports it rather than hiding it.
  V0 identifies the inconsistency after the fact; it does not prevent it
  beforehand.

## Further reading

- [`SPEC.md`](./SPEC.md) — the problem statement, the two operations, the
  four possible outcomes, and every numbered invariant (I1–I20) as a
  testable assertion, plus the exhaustive condition → outcome table.
- [`THREAT_MODEL.md`](./THREAT_MODEL.md) — the attack table: for each
  attack, which invariant is supposed to stop it, the defense mechanism, and
  the deterministic expected result.
- [`EVENT_MODEL.md`](./EVENT_MODEL.md) — the wire-level event schema (all 8
  event types) and the canonical/security-log ingestion split.

## Independent audit

The spec and its invariants were submitted to an independent adversarial
audit, which found four real gaps in the implementation (not in the spec's
intent). All four were fixed; the reproductions the audit wrote are kept
verbatim in [`tests/adversarial/independent-audit.test.ts`](./tests/adversarial/independent-audit.test.ts),
unmodified.

## License

Apache License 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## Development

```
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run demo        # the scenario above
```
