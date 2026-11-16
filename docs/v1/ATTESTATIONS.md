# Attestations (`authority-attestation/v1`)

Status: **exists today** in `src/proof/` (PR 3): format, signing, journal hash
chain, offline verification levels L0 to L2, test vectors. **Not yet**: L3
(re-deriving the decision from a journal) and the `authority proof verify`
command (PR 4); an independent cryptographic review (D9) has not happened.
Nothing here is a security guarantee until that review is done.

## What this is, and is not

An attestation is a signed statement: *the holder of key K asserts that this
`CAPABILITY_ISSUED` (or `CAPABILITY_REDEEMED`) event is in the journal whose
chain head is H, and that Authority's own validator accepted it when the
attestation was built.*

It is **not** a proof that the decision was right, that the journal's events are
true or complete, that the signer is who you think, or that an effect happened.
Levels L0 to L2 never re-derive the decision; they say so in every result.

Three things are deliberately kept apart, and so must any report built on this:

| Question | Answered by | Not answered by |
|---|---|---|
| Was this document signed by a key I trust, unchanged? (cryptographic validity) | L1 | L0, L2, the journal |
| Does it say what I expected it to say? (context) | L2 | L1 |
| Is the journal authentic and complete? Is the decision correct? | nothing in L0 to L2 (L3 re-derives a decision from a journal **the verifier already trusts**; authenticity and completeness need a witness outside V1) | any signature |

## Format (frozen for v1)

Every object is **closed**: an unknown member at any level is an error.
`proof/attestation.schema.json` describes it and a test keeps it in step with the code.

```
{ "proof_version": "authority-attestation/v1",
  "kind": "ISSUANCE" | "REDEMPTION",
  "engine":  { "id": "authority-graph", "protocol_version": 1, "event_schema_version": 1 },
  "statement": {
    "event": { "sequence", "event_id", "authority_time" },
    "capability_id", "action_id", "action_fingerprint", "principal_id",
    "decision_sequence", "enforcement_point_id",
    // ISSUANCE only: "granted_chain_ref": [ {"kind":"delegation","delegation_id"} | {"kind":"approval","approval_id"} ], "expires_at"
  },
  "journal": { "scheme": "authority-journal-chain/v1", "head_sequence", "head_hash" },
  "signature": { "alg": "Ed25519", "key_id", "sig" } }
```

- `engine` is a fixed identifier plus the protocol and event-schema versions. It is not a hash of the specification and not a software version.
- `principal_id` is the event's envelope principal: an **assertion** by the caller (I17), not a verified identity.
- `enforcement_point_id` is present in both kinds. For a REDEMPTION, verifying at L2 **requires** the verifier to supply the expected one.
- Encodings are canonical: instants `YYYY-MM-DDTHH:mm:ss.sssZ` that round-trip through a date; fingerprints and hashes 64 lowercase hex; `key_id` 43 and `sig` 86 unpadded base64url characters that re-encode to themselves (a spelling with stray trailing bits is refused); identifiers 1 to 256 characters without control characters; integers are safe integers.

## Signing input (frozen)

```
bytes = utf8("authority-attestation/v1\n") || utf8( JCS( attestation with signature = { "alg", "key_id" } ) )
```

JCS is RFC 8785. Everything except `signature.sig` is signed, `alg` and `key_id`
included. The prefix is a domain separator. Signatures are Ed25519 through
`node:crypto` (deterministic: the same input gives the same bytes).

## Journal hash chain (frozen)

```
digest_i = SHA-256( "authority-journal-event/v1\n" || JCS(event_i) )
h_0      = SHA-256( "authority-journal-chain/v1" )
h_i      = SHA-256( h_{i-1} || digest_i )                 // 32 raw bytes each
head     = ( head_sequence = i, head_hash = hex(h_i) )
```

`event_i` is the **complete canonical event as exported**, `recorded_at`
included. Events must be sequence 1..n, contiguous and in order. The head says:
*this exact sequence of events hashes to this value*. It does not say the events
are true, that the journal is complete, or that no other journal exists with a
different history (see "Limits").

## Offline verification (L0 to L2; L3 below)

| Level | Checks | Result words |
|---|---|---|
| L0 form | strict JSON (no duplicate keys, only exact integers, no lone surrogates, bounded size and depth), closed schema, canonical encodings, the statement is consistent with itself (`head_sequence >= event.sequence`, `decision_sequence == event.sequence - 1`, `expires_at` after the event) | |
| L1 signature | fixed algorithm, `key_id` among **the verifier's** trusted keys, key window and revocation, Ed25519 over the signing input | `CONSISTENT_L1` |
| L2 context | the verifier's expected kind, capability, action, fingerprint, principal, enforcement point (required for REDEMPTION), journal head, and for an ISSUANCE an explicit instant at which it must not be expired. An empty expected context is refused, never passed vacuously. The expected context is itself validated as strictly as the attestation: unknown members (a typo would bind nothing), a non-canonical `at` (date-only, no milliseconds, an offset, lowercase, an impossible date, `24:00`, a number, `null`), a malformed hash, sequence or identifier are refused (`L2.EXPECTED_VALID`), never guessed. `at` applies to an ISSUANCE only and is refused for a REDEMPTION | `CONSISTENT_L2` |

A failure at a level leaves the following levels `NOT_CHECKED`. The overall
result is `REJECTED`, `CONSISTENT_L1` or `CONSISTENT_L2`; there is no plain
"valid". Every result carries `not_established`, the list of what it does not
establish. A deliberate test case, `validly-signed-lie`, shows that a statement
no journal supports passes L1 and L2: that is the point of the wording.

## L3: replay against a journal you supply (PR 4)

`authority proof verify <attestation> --keys <keys> --journal <journal> [--trusted-heads <heads>] [--scope full|prefix] [--json]`

L3 runs only after L1 (and L2 when an expected context is given) pass. A key
revoked `ALWAYS`, or outside its window, stays `REJECTED`: L3 is never run to
"rescue" it, however consistent the statement is with the journal. L3 then:

1. reads the journal strictly (same reader as attestations; bounded size and event count);
2. replays the **attested prefix** (events 1..`head_sequence`) with the engine's own validators and checks that its chain head equals the attested `journal_head`;
3. re-derives the statement from the event at `event.sequence` and requires it to equal the signed statement (`L3.EVENT`); a signed statement that no replay supports is refused (`L3.HEAD`, `L3.EVENT`);
4. re-validates the decision with the engine's validators over that prefix (`L3.DECISION`; for example a redemption of a capability whose authority was revoked before it is refused);
5. with `--scope full` (the default), also replays the **whole journal provided**; a defect in the suffix is reported and does not retroactively invalidate the attested prefix, which is checked separately.

Result word: `CONSISTENT_L3`. The report says which scope was validated
(`ATTESTED_PREFIX_ONLY` or `FULL_JOURNAL`), never both silently.

### Anchors

`--trusted-heads` is a file `authority-trusted-heads/v1` (a list of
`{head_sequence, head_hash, label?}`; closed, no dates, no source, no
signature). An anchor **you** supply that matches the journal at its sequence
and covers the attested head makes the report `anchored: true`.

What anchoring establishes: the journal you hold agrees, up to that sequence,
with a head you chose to trust. What it does **not** establish: that the anchor
is independent of the signer (the report states `independence:
NOT_ESTABLISHED`, `provenance: SUPPLIED_BY_VERIFIER`: a file on the same
machine proves nothing about its own independence), that events after the
anchor are complete or genuine, when the statement was signed, or who owns the
key. Events after the head that revoke the delegation are listed as
**information only** and never change the result.

### Corroboration analysis (the `corroborate` command is deferred)

A trusted-keys window is evaluated on the time the signer *claims*; a stolen
key can claim any time before its revocation. A journal anchored before the
compromise turns "when was this signed" into "is the statement true against a
history fixed before the compromise". That needs an anchor independent of the
signer, and still does not prove signing time, suffix completeness or
identity. `ALWAYS` revocations are never bypassed. The command is deferred
until the independent cryptographic review (D9) has covered PR 3.

### Replay cost and limits

Engine replay copies state per event, so cost grows faster than linearly
(roughly x4 per doubling once past a few thousand events). The limit is
`DEFAULT_MAX_REPLAY_EVENTS = 10_000` (override with `--max-events`); a larger
journal is refused, not truncated, with an explicit message.

Measured with `npm run proof:bench -- 1000 2000 5000 10000 20000 --budget 300`
(one run, Node 22, development container; each size in its own process, peak
RSS includes the synthetic journal; "L3 end-to-end" is the strict JSON read of
the journal plus `verifyAttestationL3`, what the CLI does):

| events | replay | L3 end-to-end | peak RSS |
|---:|---:|---:|---:|
| 1,000 | 97 ms | 156 ms | 99 MB |
| 2,000 | 335 ms | 339 ms | 119 MB |
| 5,000 | 1.5 s | 1.9 s | 191 MB |
| 10,000 | 6.1 s | 6.9 s | 277 MB |
| 20,000 | 27.5 s | 28.6 s | 389 MB |

Why 10,000: a verification at the ceiling takes about 7 s and under 300 MB on
a developer machine, which is acceptable for an offline, on-demand check. At
20,000 it takes about 29 s and the cost keeps quadrupling, which is not; so the
ceiling is not raised. Memory is not the binding constraint, time is. These
numbers are one machine and one synthetic journal shape (issuance events):
read the ratios, not the absolutes, and lower `--max-events` for a constrained
environment. The engine is deliberately not modified in this PR; a faster
replay (incremental state) needs its own arbitration. CI runs
`npm run proof:bench:smoke` (200 and 500 events, 60 s budget) only to prove the
script runs; it is not a performance gate.

### Limits that remain at L3

L3 does not establish that the journal is authentic or complete (an operator
can omit or fabricate events consistently), that an anchor is independent,
that a time claimed by the signer is true, or who a key belongs to. The report
carries `not_established` in every case. Report format:
`authority-proof-verify-report/v1`, schema `proof/verify-report.schema.json`.
Exit codes: 0 consistent, 1 rejected, 2 unreadable input, 64 usage.

## Keys

- Ed25519, JWK only (`{"kty":"OKP","crv":"Ed25519","x":...}`, and `d` for a private key). No PEM, no other curve.
- `key_id` = base64url(SHA-256(raw 32-byte public key)). It **names a key**. It is not the identity of a person, a service or an organization, and nothing in verification reads the optional free-text `label` of a trusted-keys file.
- Trust is decided by the verifier: a trusted-keys document (`authority-trusted-keys/v1`) maps keys to optional `not_before`, `not_after`, `revoked_from` (an instant or `"ALWAYS"`). An attestation's own claims never add a key.
- Custody is outside V1. The deployment supplies a `ProofSigner` (in-process key, KMS, HSM). `generateDevelopmentKeyPair` exists for tests and must not be used for anything real; the published vectors use RFC 8032's test key, whose private half is public knowledge.

### Compromised keys, and the limits of revocation windows

Key windows and `revoked_from` are evaluated on the attestation's **claimed**
time (`statement.event.authority_time`), which is the signer's own assertion.
Consequences, demonstrated by a test:

- A key holder, or an attacker holding a stolen key, can sign **today** a statement claiming an **earlier** time. An instant-based revocation therefore cannot distinguish it from a genuine pre-compromise attestation.
- `revoked_from: "ALWAYS"` rejects every attestation by the key and is the safe response to a suspected compromise. It also rejects the genuine past ones.
- Telling genuine past attestations from forged ones needs corroboration the attestation cannot give: re-deriving the decision against a journal copy the verifier held **before** the compromise (L3, PR 4) or an external witness (outside V1).
- Operational guidance: on suspected compromise, set `"ALWAYS"`, rotate, re-attest what matters under the new key from a trusted journal, and treat old attestations as unverified until corroborated.

## Trust boundaries

| Boundary | What is trusted | Consequence |
|---|---|---|
| Signer | its key and its builder code | it can sign anything; the builders refuse events the engine's validators reject (`validateAndSelectGrant`, `validateRedemptionEvent`), a compromised signer need not use them |
| Verifier's key list | entirely the verifier's choice | an unknown or revoked key is refused |
| Journal provider | not trusted | the head is a commitment to one history; it does not authenticate the events or prove completeness |
| Clock | injected, as everywhere in V1 | claimed times are assertions |
| Identity | asserted (I17) | `principal_id` is what the caller said |
| Effects | not covered | an attestation never says an effect happened |

## Limits (what nobody can establish from this)

- Authenticity of the journal's events (asserted, unauthenticated, I17) and the identity of any principal.
- Completeness of the journal: a truncated journal, a journal rolled back to an older state, or an omitted event (a revocation, say) is invisible without an external witness.
- Equivocation: a signer holding two incompatible journals can sign attestations against each; each is internally consistent. Detection needs a witness outside V1.
- The signer's clock, and whether the key was stolen.
- Non-repudiation, trusted timestamping, certification, conformance to JWS/COSE/WIMSE or any other standard: not claimed.
- That the effect happened or happened once; a lost redemption acknowledgement and its recovery are described in SPEC.

## Vectors and interoperability

`proof/vectors/` (generated by `npm run proof:vectors`, checked by the tests)
holds a fixed test key, a journal and its head after every prefix, genuine
attestations, the exact signing inputs, and negative cases with the expected
failing check. The signing inputs are verified by **OpenSSL**, and the journal
chain, the key id and the signing inputs are recomputed by **Python's standard
library**, both sharing no code with this repository. An independent verifier
implementing the sections above must reproduce `expected.json`.

## Versioning

`authority-attestation/v1`, `authority-journal-chain/v1` and
`authority-trusted-keys/v1` are frozen. Any change to a field, an encoding, the
signing input or the hash construction is a new version string; a verifier
refuses a version it does not know. There is no algorithm negotiation.
