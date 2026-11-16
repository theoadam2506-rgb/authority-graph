# Authority V1: design documents

> **Status: experimental, partly implemented.** Nothing described in these
> documents is implemented unless it is explicitly marked **exists today** and
> points to the code or test that shows it. Everything else is **planned** and
> may change. **No independent review or audit of Authority, including
> Authority Proof, has been carried out** (the cryptographic review, D9, is
> prepared and not started), and no security guarantee is claimed for any of it.
> Not published to npm; not ready for production.

Authority V1 turns the existing deterministic engine into something an
application can call before a sensitive action. It has four components:

| Component | Role | State |
|---|---|---|
| **Authority Core** | Deterministic engine: delegations, revocations, restrictions, budgets, explainable decisions; capability issuance; single-use redemption (`CAPABILITY_REDEEMED`) in memory and on PostgreSQL | **exists today** (`src/engine`, `src/storage`); redemption merged in PRs 1 and 2 |
| **Authority Proof** | Canonical, signed attestations of issuances and redemptions; offline verification L0 to L3 (L3 replays a journal you supply); `authority proof verify` and `authority proof head` | **exists today** (`src/proof`, [`ATTESTATIONS.md`](./ATTESTATIONS.md)), merged in PRs 3 and 4; not independently reviewed; the `corroborate` command is deferred |
| **Authority SDK** | In-process TypeScript API to check authorization before an action | **planned, not started** |
| **Authority Conformance Lab** | Compares an external authorization system with the engine | **exists today** (V0, `src/conformance`, [`docs/CONFORMANCE.md`](../CONFORMANCE.md)) |

Reading order:

1. [`ARCHITECTURE.md`](./ARCHITECTURE.md): components, the authorize / redeem / report cycle, what each step does and does not guarantee.
2. [`ATTESTATIONS.md`](./ATTESTATIONS.md): the attestation format, signing input, journal hash, keys, verification levels and limits.
3. [`CRYPTO_REVIEW.md`](./CRYPTO_REVIEW.md) and [`D9_REVIEW_PACK.md`](./D9_REVIEW_PACK.md): the brief and the proposal for the independent cryptographic review (D9), prepared and **not started**.
4. [`VOCABULARY.md`](./VOCABULARY.md): the words we use, and the explicit line between what an attestation says and what nobody can prove.
5. [`THREATS.md`](./THREATS.md): V1 threats and mitigations, with residual risk stated.
6. [`DECISIONS.md`](./DECISIONS.md): decisions taken, and decisions still open.
7. [`ROADMAP.md`](./ROADMAP.md): the sequence of independent pull requests and their acceptance criteria.
8. [`EDITION.md`](./EDITION.md): what stays community (Apache-2.0) and what may be offered separately. Draft, pending legal review.

Constraints that bind every V1 change:

- The existing engine and event formats are not broken. Existing tests keep passing, unchanged.
- The licence stays Apache-2.0. Everything in this repository stays open source.
- No cloud service, dashboard, sidecar or Enterprise code in this repository.
- Decisions stay deterministic: no hidden clock, randomness or network input inside the engine.
- No security claim is made that is not demonstrated by a test in this repository.
