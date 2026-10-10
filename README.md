# authority-graph

[![CI](https://github.com/theoadam2506-rgb/authority-graph/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/theoadam2506-rgb/authority-graph/actions/workflows/ci.yml)

An AI agent executes an action. Six months later, nobody can say exactly what
human authority covered it at that moment, or why. This engine answers that
question deterministically, from an append-only log of events: delegation,
approval, execution, nothing else.

**In:** an append-only log of events (who delegated what to whom, under what
limits, plus whatever approvals and executions actually happened) and a
question (*could/did this agent do this?*, at a specific point in causal time
and a specific trusted instant). **Out:** one of exactly four outcomes:
`AUTHORIZED`, `DENIED`, `REQUIRES_APPROVAL`, `UNKNOWN`, each with a
machine-checkable reason, never a bare yes/no.

## 30-second example

```ts
import { authorityAt, ingestAll } from "./src/engine/authority.js";
import {
  actionId, capability, delegationId, eventId, monetaryParameters, money, noExpiry,
  principalId, sequenceNumber, thresholds, CURRENT_SCHEMA_VERSION, iso8601,
} from "./src/domain/types.js";

const OWNER = principalId("human-owner");
const AGENT_A = principalId("agent-a");
const PURCHASE_ORDER_CREATE = capability("purchase_order", "create");
const NOW = iso8601("2024-01-01T00:00:00.000Z"); // authority_time is always an explicit input, never Date.now()

const { canonicalStore } = ingestAll(
  [{
    event_id: eventId("evt-delegation-1"), schema_version: CURRENT_SCHEMA_VERSION,
    occurred_at: NOW, principal_id: OWNER, event_type: "DELEGATION_CREATED",
    payload: {
      delegation_id: delegationId("d-owner-agentA"), grantor_principal_id: OWNER,
      grantor_type: "HUMAN_ROOT", grantee_principal_id: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE], can_delegate: false, expires_at: noExpiry,
      thresholds: thresholds(money(2000, "EUR"), money(2000, "EUR")), parent_delegation_id: null,
    },
  }, {
    // Used later by the capability-issuance example below (harmless here):
    // authorityAt() never reads ACTION_REQUESTED, so it doesn't change the
    // two outcomes shown right after this block.
    event_id: eventId("evt-action-request-1"), schema_version: CURRENT_SCHEMA_VERSION,
    occurred_at: NOW, principal_id: AGENT_A, event_type: "ACTION_REQUESTED",
    payload: {
      action_id: actionId("act-1"), requesting_principal_id: AGENT_A,
      delegation_id: delegationId("d-owner-agentA"), capability_requested: PURCHASE_ORDER_CREATE,
      parameters: monetaryParameters(money(1800, "EUR")),
    },
  }],
  { authorityTime: () => NOW },
);

const query = { agentId: AGENT_A, principalId: OWNER, capability: PURCHASE_ORDER_CREATE };
const at = { atSequence: sequenceNumber(1), authorityTime: NOW };

authorityAt(canonicalStore, { ...query, parameters: monetaryParameters(money(1800, "EUR")) }, at);
// -> { outcome: "AUTHORIZED", chain: ["d-owner-agentA"] }

authorityAt(canonicalStore, { ...query, parameters: monetaryParameters(money(4800, "EUR")) }, at);
// -> { outcome: "DENIED", reasonCode: "C8_AMOUNT_EXCEEDS_APPROVAL_CEILING" }
```

Every function and type above is real, public production API. Nothing here
is a test-only shortcut. The full runnable version, including a historical
`explainAction()` call, is [`examples/quickstart.ts`](./examples/quickstart.ts):

```
npm run quickstart
```

## Run it

```
git clone <this repository>
npm install
npm run demo        # the full scripted scenario below
npm run quickstart   # the short story above, runnable and self-checking
```

This repository is not published to npm. `npm install` here installs this
repo's own development dependencies from a local clone. It does not install
a package named `authority-graph` from any registry (see
[Status](#status) below). No database, no network, and no API key are needed
for either command above.

## What Authority answers

The engine exposes exactly two operations, never a third path:

- **`authorityAt(events, query, at)`**: prospective. *Would this be
  authorized right now, given everything logged so far?* It never requires
  the action to have already been requested; it answers a question about
  the current state of authority, not about one specific past event.
- **`explainAction(events, { actionId }, at)`** (and its formatted
  counterpart, `explain()`): historical. *What happened to this specific
  action, and why?* It resolves authority both at the moment of any recorded
  execution and at the query's own instant. An action that was authorized
  when it ran stays authorized at that point forever: I3 (append-only)
  forbids rewriting that conclusion, even after the authority that backed
  it has since been revoked or expired.

They stay separate on purpose. A question about the current state of
authority must never be structurally dependent on some past action having
been requested, and a question about what actually happened to one action
needs that action's own history (its approvals, its denials): history a
fresh, unrelated prospective query has no business consulting.

### Execution decisions are instance-bound

`authorityAt` answers a fingerprint-scoped discovery question. Its
`AUTHORIZED` result means that compatible authority currently exists for the
given agent, capability, and parameters; it is **not** proof that a particular
action instance may be executed. In particular, a compatible approval may have
been granted for another action with the same fingerprint, or another
delegation held by the same agent may cover the capability.

Before an external effect, evaluate the exact `ACTION_REQUESTED` and the
delegation it invokes through `explainAction(...).invokedAuthorityNow`, or use
transactional capability issuance. Those paths bind the decision to the exact
`action_id` and invoked delegation. An instance-bound decision is not a
reservation and does not consume an approval: durable capability issuance and
recorded execution have their own transactional and event semantics.

## Capability issuance

Alongside the two read-side operations above, the engine also exposes a
separate **write-side capability**: capability issuance. This does not add a
third way to *ask* about authority. `authorityAt`/`explainAction` remain
the only two query operations. Capability issuance is a distinct kind of
call that, on success, *writes* a new `CAPABILITY_ISSUED` event recording a
decision already made, but two layers are involved, and only one of them
ever touches storage:

- **`issueCapability`**: the pure **capability decision kernel**. It
  resolves the same INVOKED delegation chain and the same capacity
  accounting a prospective question would, and returns an
  `IssueCapabilityResult`, nothing more. Calling it directly persists
  **nothing**: no event is written, no store is touched, and it does not
  even take an idempotency key as a parameter.
- **Transactional capability issuance**: `CapabilityIssuanceTransaction`
  (in-memory) or `PostgresCapabilityIssuanceTransaction` (PostgreSQL, see
  [PostgreSQL deployment](#postgresql-deployment) below), is what actually
  calls the kernel, decides whether the result becomes canonical, and, on
  success, writes `CAPABILITY_ISSUED` under an idempotency key so that a
  retry never produces a second one. This transactional boundary is the
  only supported way to make a capability-issuance decision durable.

The example below continues the [30-second example](#30-second-example)
above, reusing its `AGENT_A` and `canonicalStore`, including the
`ACTION_REQUESTED` (`act-1`, 1800 EUR) that example's own store now carries
for exactly this purpose. It calls `issueCapability` directly to show the
decision kernel's own shape: this call by itself persists nothing; see
[PostgreSQL deployment](#postgresql-deployment) below for the transactional
call that actually writes the event.

```ts
import { issueCapability, type IssueCapabilityDependencies } from "./src/engine/issueCapability.js";
import type { AuthenticatedPrincipal } from "./src/domain/authenticatedPrincipal.js";
import { actionId, capabilityId, enforcementPointId, iso8601 } from "./src/domain/types.js";
import type { IssueCapabilityCommand } from "./src/domain/capabilityCommand.js";

// AuthenticatedPrincipal is a caller-supplied ASSERTION, not something this
// call verifies: authentication (JWT/mTLS/API key, whatever the deployment
// uses) is assumed to have already happened at the deployment boundary,
// before this identity is constructed. AGENT_A is the same principal
// declared in the 30-second example above.
const authenticatedPrincipal: AuthenticatedPrincipal = { principalId: AGENT_A };

const command: IssueCapabilityCommand = {
  action_id: actionId("act-1"),
  enforcement_point_id: enforcementPointId("ep-gateway-1"),
};

// expiresAt is injected by the caller, not a constant of the engine itself.
// 5 minutes here is only this example's own deployment policy.
const dependencies: IssueCapabilityDependencies = {
  nextCapabilityId: () => capabilityId("cap-1"),
  expiresAt: (authorityTime) => iso8601(new Date(Date.parse(authorityTime) + 5 * 60_000).toISOString()),
};

// authorityTime is explicit and caller-supplied, never Date.now(), never
// reconstructed from the log's own last event.
const authorityTime = iso8601("2025-01-01T00:20:00.000Z");

// canonicalStore is the same store produced by ingestAll(...) in the
// 30-second example above.
const result = issueCapability(canonicalStore, authenticatedPrincipal, command, dependencies, authorityTime);
// -> { ok: true, capability: { capability_id: "cap-1", action_id: "act-1",
//      expires_at: "2025-01-01T00:25:00.000Z", ... } }. This is the actual
//    result of running this exact call; it is still only a DECISION, not a
//    written event: nothing has been persisted by this call alone (see
//    below). A mismatched requester, an over-capacity or expired
//    delegation, or a stale `authorityTime` would instead return
//    `{ ok: false, reason: ... }`: see `SPEC.md` I21 through I24 for the exact
//    reasons.
```

To actually record this decision as a canonical `CAPABILITY_ISSUED` event,
call `issue(...)` on `InMemoryCapabilityIssuanceTransaction` or
`PostgresCapabilityIssuanceTransaction` instead of calling `issueCapability`
directly. See [PostgreSQL deployment](#postgresql-deployment) below.

Idempotence goes through `issueCapabilityIdempotently`, keyed on
`(authenticated requester, operation, a caller-supplied `ClientIdempotencyKey`)`:
the first call under a given key fixes the outcome (including a refusal)
permanently for that key. A retry under the same key later `REPLAYS` the
exact original result, without re-evaluating anything (a new `authorityTime`
on the retry changes nothing); a different command under the same key is
`IDEMPOTENCY_CONFLICT`, never silently resolved one way or the other. A
caller wanting a genuinely new decision must use a new key. A retry never
produces a second `CAPABILITY_ISSUED` event, and a refused attempt (for any
reason, including a stale `authorityTime`) never produces one at all;
see [`SPEC.md`](./SPEC.md) for the exact invariants and
[`EVENT_MODEL.md`](./EVENT_MODEL.md) for the event's field-by-field
definition.

`enforcement_point_id` is REQUESTED by the caller, not verified: no
enforcement-point habilitation registry exists yet, so this value is copied
through as-is on success and never checked against anything.

### PostgreSQL deployment

Getting the full transactional guarantee (exactly one canonical
`CAPABILITY_ISSUED` per idempotency key, the event and its idempotency
record always becoming visible together) requires going through
`PostgresCapabilityIssuanceTransaction`, not calling the pure
`issueCapability` function directly against your own storage. It runs one
real ACID transaction per call (`BEGIN`/`COMMIT`/`ROLLBACK` on one
connection) and acquires the *same* Postgres advisory lock that
`PostgresEventStore.append()` already uses for ordinary event ingestion.
The two writers are serialized against each other by construction, never
by convention.

This is **not** a claim that the underlying Postgres journal is
cryptographically append-only: the advisory lock is a cooperative mutex
between writers that go through this API, not a database-level permission
barrier (see [What it doesn't do](#what-it-doesnt-do) above, the same
caveat that already applies to `PostgresEventStore`).

The in-memory equivalent, `InMemoryCapabilityIssuanceTransaction`, gives the
same *observable* sequencing guarantees but only within one process and one
instance: it is a promise-chain mutex, not a crash-atomic transaction; see
`SPEC.md` for exactly which guarantees are, and are not, backend-independent.

## Using the CLI

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
ingested with (`ASSERTED_UNVERIFIED` in V0, see below), and the CLI's own
output additionally labels where the data came from: `source: imported
canonical event export` in the text output, and a top-level `"source"` field
in `--json`. Reading a file is not re-running the ingestion-time checks
against it, and the CLI does not pretend otherwise.

## Demo output

One command, no database, no network, no API key. It plays a full scenario:
delegation, sub-delegation, a rejected forgery attempt, an approval-gated
escalation, single-use consumption, revocation, backdating, and a historical
`authority explain` on a now-defunct authority, entirely in memory, and
**asserts** the property each step claims to demonstrate. If any assumption
stops holding, the script throws and exits non-zero; it is a narrative
integration test, not a slideshow.

The excerpt below is illustrative, not the full output: it shows the outcome
lines of the last step, a historical `authority explain` of the 4800 EUR
action `a-a-4800`, printed by the real CLI from a JSON export of the demo's
log. Run `npm run demo` for the complete, current output. CI checks that
every line of this excerpt still appears, in this order, in the real output
(`node scripts/check-readme-demo-excerpt.mjs`); the rest of the output may
change.

<!-- demo-excerpt:start -->
```
  --- authority explain a-a-4800 (real CLI output) ---
  source: imported canonical event export
  ACTION_EXECUTED at sequence 8
  authority at decision sequence 7: AUTHORIZED
  invoked delegation authority at decision sequence 7: AUTHORIZED
  recorded chain validation at decision sequence 7: AUTHORIZED
  approval consumed by execution 8
  current authority at sequence 12: DENIED
    reason: C11_CAPABILITY_NOT_COVERED: no valid delegation chain covers the requested capability
  invoked delegation authority at sequence 12: DENIED
    reason: C11_CAPABILITY_NOT_COVERED: no valid delegation chain covers the requested capability
  ✓ CLI confirms: authorized at its own decision sequence -> AUTHORIZED (chain: d-user-a, approval: appr-4800)
  ✓ CLI confirms: not authorized today -> DENIED (C11_CAPABILITY_NOT_COVERED)
All properties held. Demo complete.
```
<!-- demo-excerpt:end -->

The last section is the point of the whole exercise: `d-user-a` is revoked
*and* expired. Today, nothing authorizes A to spend 4800 EUR. And yet the
log still lets us reconstruct, precisely and mechanically, why that same
action was legitimate at sequence 8, back when it ran.

## What it doesn't do

- **No signatures, no verified identity.** V0 has no signature scheme.
  Every event, from every source, carries
  `assurance_level: "ASSERTED_UNVERIFIED"`, always. An "authorized"
  decision means *the log contains events asserting a chain of grants, none
  of them contradicted*, not that any of those grants were cryptographically
  proven. The CLI and `explain()`'s output phrase every claim accordingly
  ("the log contains an event asserting that X granted Y"), never "X
  proved" or "X is authorized to" as a bare fact.
- **Storage is correctness-first, not throughput-first.** PostgreSQL append
  serializes cooperative writers and reconstructs ingestion state from
  canonical history on each append. This is intentionally not designed for
  high-throughput production workloads. No "works up to N events" claim is
  made anywhere in this repo: that number has never been benchmarked, and a
  guessed one would be worse than none.
- **The `EventSource` API is append-only; the Postgres journal itself is
  not, against a privileged writer.** `pg_advisory_xact_lock` only protects
  writers that go through this API and cooperate with it. It is a mutex
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
  `total_budget`, made before either is executed, can combine to exceed it:
  V0 has no reservation primitive. Once both executions are ingested, the
  remaining budget at any later sequence honestly reflects the overspend
  (negative if necessary), and `explain()` reports it rather than hiding it.
  V0 identifies the inconsistency after the fact; it does not prevent it
  beforehand.

## Further reading

- [`SPEC.md`](./SPEC.md): the problem statement, the two operations, the
  four possible outcomes, and every numbered invariant (I1 through I25) as a
  testable assertion, plus the exhaustive condition → outcome table.
- [`THREAT_MODEL.md`](./THREAT_MODEL.md): the attack table: for each
  attack, which invariant is supposed to stop it, the defense mechanism, and
  the deterministic expected result.
- [`EVENT_MODEL.md`](./EVENT_MODEL.md): the wire-level event schema (all 9
  event types, including `CAPABILITY_ISSUED`) and the canonical/security-log
  ingestion split.

## Independent audit

The spec and its invariants were submitted to an independent adversarial
audit, which found four real gaps in the implementation (not in the spec's
intent). All four were fixed. The four reproductions the audit wrote are
kept in the "Independent adversarial audit" block of
[`tests/adversarial/independent-audit.test.ts`](./tests/adversarial/independent-audit.test.ts):
their scenarios and assertions are unchanged since they were committed
(`62369a1`), and their only later edit is a mechanical rewrite of threshold
literals as currency-bound amounts (`f73e962`). The same file also holds,
in a separately labeled block, one post-audit regression test that the
audit did not write (I6 action-instance binding, added by pull request #9).

## Approvals are bound to action instances (I6)

An approval covers exactly the action instance it was granted for. If two
distinct actions share the same fingerprint, the same requester and the same
invoked delegation, and approval P1 is granted (and not yet consumed) for the
first one only, the first is `AUTHORIZED` with P1 and the second remains
`REQUIRES_APPROVAL`: an approval is never reused across two `action_id`
values. See
[`SPEC.md`, I6 — action-instance approval binding](./SPEC.md#i6--action-instance-approval-binding)
for the exact scenario, its scope and its reference test.

## License

Apache License 2.0: see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## Status

V0. Not published to npm, and `package.json` is marked `private`: the
supported way to use this project today is `git clone` plus the commands in
[Run it](#run-it) above, not a package manager install. The in-memory engine
and the Postgres backend are both covered by the test suite described below,
including tests against a real PostgreSQL 16 instance, which CI runs on every
push and pull request; neither has been benchmarked or run at production
scale.

**Breaking change, unit binding (I25).** A monetary quantity is the atomic
pair `(value, currency)`; Authority compares `currency` by exact equality and
never converts it. Two consequences for anything written against the earlier
V0: `thresholds(automatic, approval)` now takes two `Money` values (for
example `thresholds(money(100, "EUR"), money(1000, "EUR"))`), and
`action_fingerprint` changed format and now covers the currency (byte-for-byte
definition and reference vectors in [`EVENT_MODEL.md`](./EVENT_MODEL.md)). V0
defines no dual-accept: fingerprints computed under the earlier format, and
delegations whose thresholds are bare numbers, are not recognized.

## Development

```
npm run typecheck    # tsc --noEmit
npm test             # vitest run
npm run demo         # the full scripted scenario
npm run quickstart    # the short story from the top of this README
node scripts/check-readme-demo-excerpt.mjs   # the README demo excerpt still matches the demo
```

Without a reachable database, `npm test` skips the 17 PostgreSQL tests and
still exits 0. To run them, point `TEST_DATABASE_URL` at an isolated
PostgreSQL 16 database (the tests truncate its tables) and run the two files
one after the other, then check the report:

```
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/authority_graph_test \
  npx vitest run \
  tests/storage/postgresEventStore.test.ts \
  tests/storage/postgresCapabilityIssuanceTransaction.test.ts \
  --no-file-parallelism \
  --reporter=default --reporter=json --outputFile.json=vitest-postgres.json
node scripts/check-postgres-report.mjs vitest-postgres.json
```

The second command fails unless every PostgreSQL test ran and passed (none
skipped, failed or todo, at least 17 passed). CI
([`.github/workflows/ci.yml`](./.github/workflows/ci.yml)) runs all of the
above: the first block on Node 20 and 22, the PostgreSQL block on Node 20
against a `postgres:16` service.
