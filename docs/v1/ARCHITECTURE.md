# Architecture

Status: experimental. **exists today** and **planned** are marked. Authority Core (including single-use redemption in memory and on PostgreSQL), Authority Proof (attestations, verification L0 to L3 and the `authority proof` commands, see [`ATTESTATIONS.md`](./ATTESTATIONS.md)) and the Conformance Lab exist today. The SDK is planned and not started. Nothing has been independently reviewed.

```
 AI agent / tool gateway
        | guard(request, effect)
        v
 +-----------------------------------------------------------------+
 | Authority SDK  (5a exists in src/sdk; see SDK.md)                |
 |   authorize / redeem / report / guard                           |
 |   injected: TrustedClock, authenticate, ProofSigner?, id source |
 |   failure policy: fail-closed (the only option in V1)           |
 +---------+----------------------------------+--------------------+
           | decisions, events                | attestations
           v                                  v
 +---------------------------+     +-----------------------------+
 | Authority Core            |     | Authority Proof (exists)    |
 | src/engine, src/storage   |---->| JCS + Ed25519 envelope      |
 | exists today              |     | log head hash (computed on  |
 | + CAPABILITY_REDEEMED     |     | export), verify, replay     |
 +-------------+-------------+     +-----------------------------+
               ^
 +-------------+-------------+
 | Conformance Lab           |  targets: simulated, OPA (exist); SDK-guarded service (planned)
 | exists today (V0)         |
 +---------------------------+
```

Everything lives in this repository, in one npm package with subpath exports
(`authority-graph`, `/sdk`, `/proof`, `/conformance`). No new runtime
dependency: Ed25519 and SHA-256 come from `node:crypto`; canonical JSON uses
`json-canonicalize`, already a dependency.

## Core, today and planned

**Exists today:** `authorityAt` (prospective), `explainAction` (historical),
`issueCapability` (pure decision kernel), transactional idempotent issuance
(in memory and PostgreSQL) writing `CAPABILITY_ISSUED`, append-only PostgreSQL
journal, argument binding through an RFC 8785 digest in the action fingerprint.

**V1, in memory (exists today, PR 1) and on PostgreSQL (PR 2):** one new event type, `CAPABILITY_REDEEMED`, and the
redemption decision. Existing events, schemas and decisions are unchanged.
The SQL schema needs no change for it: `authority_events.event_type` is
`TEXT` with no `CHECK` constraint and the payload is opaque `JSONB`
(`src/storage/schema.sql`). The PostgreSQL transaction adds an additive, idempotent partial unique index on
redeemed `capability_id` in `schema.sql` (the migration).

## The cycle of a sensitive action (the transactions and the SDK 5a that orchestrates them exist)

1. **authorize.** The application asks for a decision bound to this exact
   call: tool name, canonical arguments digest, amount, recipient. If the
   decision is `AUTHORIZED`, a ticket (`CAPABILITY_ISSUED`) with a short
   lifetime is returned. At most one ticket exists per action, definitively (I32, D36): an expired or redeemed ticket does not free the action, a new action is required.
2. **redeem.** Immediately before the effect, one atomic step checks that the
   ticket exists, has not expired, has not been redeemed, names this
   enforcement point, matches the arguments actually observed, and that the
   authority chain is **still valid at the instant of redemption** (a
   revocation written after `authorize` is honoured). On success it writes
   `CAPABILITY_REDEEMED`. A second attempt, concurrent or later, is refused.
3. **effect.** Performed by the application, outside Authority.
4. **report.** The existing `ACTION_EXECUTED` records the outcome. It is an
   assertion by the enforcement point.

What this guarantees: a ticket is redeemed at most once, and authority is
re-checked at the last moment Authority controls. What it does **not**
guarantee: that the effect happens at most once. Between step 2 and the
effect only the target system can deduplicate (for example with an idempotency
key). That residual window is documented, not hidden.

## Time, identity, keys, failures

- **Time.** The engine never reads a clock. The SDK receives a `TrustedClock`
  and is the only place a system clock may be wired in; that is a trust
  assumption of the deployment, stated in the documentation.
- **Identity.** `AuthenticatedPrincipal` stays a typed assertion made by the
  caller after its own authentication. Authority does not verify identity.
- **Keys.** Signing goes through a `ProofSigner` interface the deployment
  implements. V1 contains no key management.
- **Failures.** A store, clock or signer that fails, throws or is unavailable
  yields `UNAVAILABLE`, which is never treated as allowed. `guard` does not run
  the effect in that case. There is no fail-open option in V1.

## Out of scope for V1

HTTP service or sidecar, hosted or multi-tenant ledger, dashboard, external
anchoring or timestamping, identity verification, key management, performance
or high-availability claims, any Enterprise feature.
