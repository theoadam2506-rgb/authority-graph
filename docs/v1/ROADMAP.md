# V1 roadmap: independent pull requests

Each pull request is independently reviewable, keeps every existing test
passing and unchanged, and merges only on the owner's approval. A later PR does
not start before the previous one is validated. The Status column was aligned with `main` after PR #30; the D9 independent review has not started. Estimates are ranges for one
engineer, not commitments.

| PR | Content | Acceptance criteria | Estimate | Status |
|---|---|---|---|---|
| prerequisite | PostgreSQL test isolation, one schema per file (issue #13) | Files pass in parallel on a fresh database, repeatedly; no test removed or skipped; nothing under `src/` changed | | merged (#22) |
| 0 | These design documents | No code change; no claim beyond what a test demonstrates | 1 to 2 days | merged (#23) |
| 1 | Core: `CAPABILITY_REDEEMED`, redemption kernel, in-memory transaction, invariants in `SPEC.md`, threats in `THREAT_MODEL.md` | All existing tests pass unchanged; double and concurrent redemption, expiry, wrong enforcement point, changed arguments, revocation between issue and redeem all tested; no existing decision changes | 5 to 8 days | merged (#24) |
| 2 | Core PostgreSQL: redemption transaction, additive uniqueness index, real concurrency tests (pools and OS processes) | N parallel redemptions on PostgreSQL 16: exactly one succeeds; idempotent migration | 4 to 6 days | merged (#25) |
| 3 | Proof: envelope, JCS + Ed25519, log head hash computed on export, JSON Schema, test vectors, L0 to L2 verification | Reproducible vectors; tamper tests (signature, field added or removed, key order, algorithm, unknown key); no negotiable algorithm | 5 to 7 days | merged (#26) |
| 4 | Proof: verification by replay (L3), journal verification, `authority proof verify` and `head` | Offline verification with an exported log and a public key; altered log detected | 3 to 4 days | merged (#27) |
| 5 | SDK: `authorize`, `redeem`, `report`, `guard`, `TrustedClock`, fail-closed, build and exports | Property test: the effect never runs without a successful redemption; `authorityAt` is not exposed as a guard | 5 to 8 days | **planned, not started** |
| 6 | Scripted agent demo with a sandbox tool | Over-limit request refused; revocation between authorize and redeem refused; replay refused; no external effect | 3 to 5 days | planned, not started |
| 7 | Conformance Lab consolidation: TOCTOU, replay and failure scenarios, SDK-guarded target | Deterministic reports; INCONCLUSIVE never conflated with FAIL | 4 to 6 days | planned, not started |
| 8 | Hardening: SECURITY.md, changelog, independent review of the cryptographic parts | Review documented before any security communication | 3 to 4 days | partly: `SECURITY.md` and the D9 review pack are merged (#28 to #30); the changelog and the independent review are **not done** |

Main uncertainties: exact redemption semantics under budgets, concurrency
behaviour of the PostgreSQL writer lock, performance of full-log resolution
(not measured), key handling by deployments, trusted time source, and whether
prospects want this shape at all (open question O5).
