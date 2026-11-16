# Attestation test vectors (authority-attestation/v1)

Reproducible vectors for implementers of an independent verifier. **Test material only.**

- `test-key.json`: RFC 8032 section 7.1 TEST 1. Its private key is public knowledge: it protects nothing and must never be trusted for a real attestation.
- `trusted-keys.json`: the verifier's trusted-keys document ("authority-trusted-keys/v1").
- `journal.json` / `journal.head.json`: a 5-event journal and its hash chain ("authority-journal-chain/v1"), with the head after every prefix.
- `issuance.json`, `redemption.json`: genuine attestations over that journal.
- `*.signing-input.txt`: the exact bytes that were signed (UTF-8): `authority-attestation/v1\n` followed by the RFC 8785 (JCS) form of the attestation with `signature = { alg, key_id }`.
- `negative/`: documents a verifier must refuse (or, for `validly-signed-lie`, must accept at L2 and say nothing more about).
- `expected.json`: for every case, the expected result and failing check.

What these vectors establish: a verifier reads the format strictly, checks an Ed25519 signature over the frozen signing input, and compares an expected context. They say nothing about whether a decision was correct, whether the events are authentic or complete, or who the key belongs to.

Regenerate or check: `npx tsx scripts/generate-proof-vectors.ts [--check]` (deterministic; the test suite fails if these files drift).
