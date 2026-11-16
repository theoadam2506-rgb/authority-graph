# Independent cryptographic review (decision D9): brief for the reviewer

Status: **not started**. No communication about security guarantees (website,
sales material, README claims, talks) may rely on Authority Proof until this
review is complete and its findings are resolved or published as known limits.

## Scope: the whole of PR 3

| Area | Files |
|---|---|
| Frozen formats and their normative text | `docs/v1/ATTESTATIONS.md`, `proof/attestation.schema.json` |
| Strict JSON reader | `src/proof/strictJson.ts` |
| Canonical encodings | `src/proof/encoding.ts` |
| Journal hash chain | `src/proof/journalHash.ts` (uses `src/domain/canonicalJson.ts`, RFC 8785 through `json-canonicalize`) |
| Keys, signer, trusted keys | `src/proof/keys.ts` |
| Attestation format, signing input, builders | `src/proof/attestation.ts` |
| Verification L0 to L2, expected context | `src/proof/verify.ts` |
| Vectors and generator | `proof/vectors/`, `scripts/generate-proof-vectors.ts` |
| Tests, including interoperability | `tests/proof/` (`interop.test.ts` uses OpenSSL and Python's standard library) |

Out of scope: the decision engine's semantics (SPEC.md I1 to I31; reviewed by
its own adversarial suite), PostgreSQL storage, key custody (the deployment's),
L3 replay and the command (PR 4), the SDK.

## What we ask the reviewer to try to break

1. **Signature binding.** Can two different documents (or two different meanings) have the same signing input? Is every semantically relevant byte covered (`alg`, `key_id`, `kind`, `engine`, `journal`, the statement)? Is the domain-separation prefix sufficient, including against cross-protocol and cross-version replay?
2. **Canonicalization.** Are there inputs for which JCS output differs between this implementation and a strictly conforming one (strings, escapes, number forms, key ordering of non-BMP characters, `__proto__`)? Does the strict reader refuse every ambiguity it claims to (duplicate keys after unescaping, inexact integers, lone surrogates, BOM, invalid UTF-8)? Can two parsers read two different documents from the same bytes?
3. **Encoding malleability.** Non-canonical base64url, hex case, instants, identifiers: is there any second text for the same value that verifies?
4. **Ed25519 usage.** Reliance on `node:crypto` (OpenSSL) for deterministic signing and for rejecting malleated signatures (S + L) and malformed keys, on Node 20 and 22. Small-order or non-canonical public keys in a trusted-keys file.
5. **Key model.** `key_id` derivation and collision considerations; the trusted-keys semantics (windows, `revoked_from`, `"ALWAYS"`) and the documented weakness that windows use the signer's claimed time. Is the documentation accurate and complete about compromise?
6. **Journal hash chain.** Domain separation, length-extension or splicing across prefixes, ambiguity between events, the empty journal, the effect of including `recorded_at`.
7. **Verification logic.** Order of checks, any path where a failure level still yields `CONSISTENT_*`, the expected-context validation (unknown members, instants), denial-of-service bounds.
8. **Honesty of the claims.** Does any text, error message, result word or test name overstate what L0 to L2 establish?

## Known weak points we already document (please confirm or sharpen)

- A validly signed statement no journal supports passes L1 and L2 (by design; test `validly-signed-lie`).
- Revocation instants cannot stop a stolen key from signing a backdated claim; only `ALWAYS` does.
- A journal head commits to one history: it does not prove authenticity, completeness or uniqueness (equivocation).
- No timestamping, no non-repudiation, no certification, no JWS/COSE/WIMSE claim.
- `principal_id` is asserted; the clock is injected.

## Reproduce

```bash
npm ci
npm test                                # includes the vectors and the OpenSSL / Python interoperability checks
npm run proof:vectors -- --check        # the published vectors are deterministic and unchanged
```

`proof/vectors/expected.json` states, for every document, the result and the
failing check an independent verifier must report.

## Deliverable we expect

A written report with: scope actually reviewed, method, each finding with
severity and a minimal reproduction, a statement of what was *not* examined, and
the reviewer's view of whether the stated limits are accurate. Reviewer
independence: not an author of this code, no commercial interest in the
outcome, and free to publish their findings. Findings are tracked as issues; the
frozen format strings change only by a new version (`.../v2`).
