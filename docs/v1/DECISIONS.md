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

## Still open

| # | Question | Recommendation |
|---|---|---|
| O1 | Packaging: one package with subpath exports, removal of `"private": true`, package name | One package; publication is a separate, explicit decision |
| O2 | Optional live-LLM mode for the demo (provider, user-supplied key, `fetch` without a dependency) | Optional, outside CI, sandbox tool only |
| O3 | Contribution policy: DCO or CLA; trademark policy | To be decided with legal review |
| O4 | Publication of [`EDITION.md`](./EDITION.md) | After legal review |
| O5 | Commercial validation (prospect conversations) before the Proof, SDK and demo work | At least two before PR 3 |
