# Decisions

## Taken

| # | Decision |
|---|---|
| D1 | Redemption is atomic and single-use. Budget reservation is not part of V1. |
| D2 | The existing Core and event formats are preserved; V1 is additive. |
| D3 | Attestations are canonical JSON (RFC 8785) signed with Ed25519 through `node:crypto`. Their limits are stated explicitly ([`VOCABULARY.md`](./VOCABULARY.md)). No claim of conformance to JWS, COSE or any other standard. |
| D4 | Keys and the clock are injected (`ProofSigner`, `TrustedClock`). V1 includes no key management. |
| D5 | The SDK is an in-process TypeScript library. No HTTP service or sidecar. |
| D6 | The licence stays Apache-2.0; community components stay open source. |
| D7 | No cloud, dashboard, sidecar or Enterprise code in this repository. |
| D8 | The agent demonstration uses a scripted agent and a sandbox tool. No payment, no production action. |
| D9 | The cryptographic components get an independent review before any security communication. |
| D10 | A new event type is added additively; the SQL schema is compatible (`event_type` is unconstrained `TEXT`, payload is `JSONB`). Whether `schema_version` changes is settled in the redemption PR, with a stated rationale. |
| D11 | PostgreSQL test isolation (issue #13) is fixed with one schema per test file before any storage work. |
| D12 | Capacity accounting is unchanged in V1. The capacity cost of a ticket consumed by `CONCURRENT_WRITE_DETECTED` is accepted as an availability trade-off, documented, and never presented as a guarantee about external effects. |
| D13 | PostgreSQL redemption (PR 2) uses one atomic SQL transaction, a fresh read of the log, a uniqueness constraint on redemptions and an explicit check that the current transaction inserted the event. It reuses the backend-agnostic contract suite and completes the planned PostgreSQL tests. No npm package is published and Authority Proof is not started before this lands. |
| D14 | PR 3 attests ISSUANCE and REDEMPTION only; DECISION attestations and attested refusals are deferred. |
| D15 | The journal hash covers the complete canonical event, `recorded_at` included; the format is frozen (`docs/v1/ATTESTATIONS.md`). |
| D16 | Keys are Ed25519 JWK only in V1. |
| D17 | Unknown members are refused at every level of the envelope. |
| D18 | `enforcement_point_id` is mandatory for a REDEMPTION; L2 verifies the expected context and L0 to L2 never claim to validate the decision. |
| D19 | The engine is identified by a fixed id plus protocol and event-schema versions, not by a hash of `SPEC.md`. |
| D20 | PR 3 is signing, L0 to L2 verification, the hash chain and vectors; PR 4 is L3 replay and the command. |
| D21 | An independent cryptographic review follows PR 3, before any communication about security guarantees. |
| D22 | Two prospect interviews run in parallel and do not block the work. |
| D23 | L3 result is `CONSISTENT_L3` plus an `anchored` flag; anchoring never asserts independence of the anchor. |
| D24 | The `corroborate` command is deferred until after the D9 crypto review. |
| D25 | Trusted anchors use the strict, closed format `authority-trusted-heads/v1`. |
| D26 | Replay is limited to 10,000 events without modifying the engine. Measured: 10,000 events verify end to end in about 7 s and 277 MB; 20,000 in about 29 s (`proof:bench`, `docs/v1/ATTESTATIONS.md`). The ceiling stays at 10,000. |
| D27 | Revocations after the attested head are reported as information only. |
| D28 | Report format `authority-proof-verify-report/v1`; the CLI is routed as `authority proof ...` in the existing entry point. D9 review runs in two passes: PR 3 crypto, then L3 replay. |
| D29 | D9 review budget: two scenarios prepared (0 to 500 EUR; 1,500 to 3,000 EUR), no spend committed. See `D9_REVIEW_PACK.md`. |
| D30 | Volet B (L3) may be prepared in parallel with volet A but is not concluded before Critical and High findings of volet A that affect L3 are fixed. |
| D31 | Coordinated disclosure with an indicative 90-day delay, adaptable to severity; no fix date is promised (`SECURITY.md`). |
| D32 | Authority is never presented as audited before D9 is complete; internal and AI-assisted reviews are called internal verification. |
| D33 | SDK: `authorize` triggers no external effect; `redeem` consumes a capability without running the effect; `guard` orders redemption before the effect and never promises exactly-once for external effects. |
| D34 | SDK: `TrustedClock` must be injected explicitly (no implicit default clock); `report` is an optional verification function, never an implicit authorization. |
| D35 | `@authority-graph/core` is a working name, not reserved; no npm package is published without a separate decision. |
| D36 | I32: at most one `CAPABILITY_ISSUED` per action, definitively (variant A). An expired, redeemed or burned ticket does not free the action; a new action is required. Enforced in the kernel, in ingestion, in the issuance transactions and by a PostgreSQL unique index. Moving approval consumption to redemption is deferred. See "D36 in detail" below. |

## Still open

| # | Question | Recommendation |
|---|---|---|
| O1 | Packaging: one package with subpath exports, removal of `"private": true`, package name | One package; publication is a separate, explicit decision |
| O2 | Optional live-LLM mode for the demo (provider, user-supplied key, `fetch` without a dependency) | Optional, outside CI, sandbox tool only |
| O3 | Contribution policy: DCO or CLA; trademark policy | To be decided with legal review |
| O4 | Publication of [`EDITION.md`](./EDITION.md) | After legal review |
| O5 | Commercial validation (prospect conversations) before the Proof, SDK and demo work | At least two before PR 3 |

## D36 in detail: one ticket per action (I32)

**Status:** decided by the project owner; implemented in a separate pull request from the SDK (PR 5a), which it does not require.

**Context.** A ticket (`CAPABILITY_ISSUED`) is the right to run one action, and an approval is bound to one action (I6). The engine did not limit the tickets per action: with different idempotency keys, one approved action obtained two tickets and both were redeemed, because the approval is consumed only by a later `ACTION_EXECUTED`, not by issuance or redemption. Found while building the SDK; reproduced on `main` at `397ba8c`. The SDK worked around it (one fixed idempotency key per action) but a caller issuing tickets directly was not protected.

**Decision.** Invariant I32 (see `SPEC.md`): at most one `CAPABILITY_ISSUED` per `action_id`, definitively.

- An **expired**, **redeemed** or **burned** (`CONCURRENT_WRITE_DETECTED`) ticket does not free the action. A new action (a new `ACTION_REQUESTED`, and a new approval where one is needed) is required. This follows from approval binding: an approval belongs to one action, so a replacement ticket for the same action would be a replacement effect under the same approval.
- Four independent layers, mirroring I28: the kernel (`ACTION_ALREADY_TICKETED`), ingestion (business id `ticketed_action_id`, which also makes replay refuse a journal that tickets an action twice), the issuance transactions, and a PostgreSQL partial unique index checked by `IssuanceSchemaError`.
- Idempotency is unchanged.

**Alternatives considered.**

- *Variant B, re-issue after expiry if nothing was redeemed.* More flexible, but it has no database-level backstop (an index cannot express "all earlier tickets expired"), more states, and an unclear approval semantics (is a stale approval still good?). Rejected for V1; revisit only on a demonstrated need.
- *Consume the approval at redemption* (instead of at `ACTION_EXECUTED`). More faithful to the intent and it would make a second effect impossible by construction, but it changes the approval accounting (I15, I18) and the redemption contract. **Deferred by the project owner**; it is not part of I32.
- *Document the possibility only.* Rejected: a documented hole is still a hole.

**Consequences.**

- Existing tests that issued several tickets for one action were changed: the redemption harnesses (memory and PostgreSQL) and the contract now give each extra ticket its own action; `tests/proof/fixture.ts` gives its second ticket its own action; the "known cost" test in `tests/redemption/redemptionReview.test.ts` now asserts both the I32 refusal and the capacity cost on a new action. The published proof vectors were regenerated (`npm run proof:vectors`; the fixture journal gains one `ACTION_REQUESTED`) and the proof tests that hard-code the journal layout were shifted by one event. A fragile test that depended on a signature containing a `-` was fixed.
- Recovery after a consumed ticket (`CONCURRENT_WRITE_DETECTED`, an unknown outcome that proved to be `ALREADY_REDEEMED`) now means opening a new action, not re-authorizing the same one. The capacity cost of D12 is unchanged.
- **Migration and compatibility.** An installation written before I32 may hold several tickets for one action. `schema.sql` refuses once, listing the offending action ids, and rewrites nothing (the journal is append-only). **Do not delete the extra ticket**: that breaks the hash chain and every attestation over the journal. The options (archive the legacy journal and start a fresh one; stay on the pre-I32 schema read-only), the read-only verification procedures, the backup procedure and the rollback are in [`COMPATIBILITY_I32.md`](./COMPATIBILITY_I32.md). The previously published proof vectors are replaced by regenerated ones (they held two tickets for one action). No real installation is known: that is not a statement about databases or exports this repository cannot see.
- A journal with two tickets for one action no longer replays, so an attestation over such a journal no longer verifies at L3. Same remark: no released journal is known to contain one.
- The SDK (`src/sdk`, PR 5a) is compatible: its fixed idempotency key per action keeps its behaviour, and it maps the new refusal to `DENIED` (`ACTION_ALREADY_TICKETED`).
- **Replay cost.** A ticket now adds two business ids to the ingestion state. Measured on the same machine with the benchmark (`npm run proof:bench -- 5000 10000`, a worst case where every event is a ticket): 10,000 events replay in about 9.5 s instead of 8.0 s on `main` (5,000 events: 2.2 s instead of 2.0 s). The 10,000-event ceiling (D26) is kept.
