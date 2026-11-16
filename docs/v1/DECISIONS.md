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

## Still open

| # | Question | Recommendation |
|---|---|---|
| O1 | Packaging: one package with subpath exports, removal of `"private": true`, package name | One package; publication is a separate, explicit decision |
| O2 | Optional live-LLM mode for the demo (provider, user-supplied key, `fetch` without a dependency) | Optional, outside CI, sandbox tool only |
| O3 | Contribution policy: DCO or CLA; trademark policy | To be decided with legal review |
| O4 | Publication of [`EDITION.md`](./EDITION.md) | After legal review |
| O5 | Commercial validation (prospect conversations) before the Proof, SDK and demo work | At least two before PR 3 |
