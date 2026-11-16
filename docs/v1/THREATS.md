# V1 threats

Status: design. This table lists what V1 intends to address and what stays
open. A row becomes a claim only when a test in this repository demonstrates
it. The existing attacks A1 to A32 in [`THREAT_MODEL.md`](../../THREAT_MODEL.md) still apply.

| Threat | Planned mitigation | Residual risk, stated |
|---|---|---|
| **TOCTOU** between decision and effect (the authority changes after `authorize`) | `redeem` re-checks the chain at the instant of redemption, atomically | Window between redemption and the external effect; only the target can deduplicate or re-check |
| **Replay** of a ticket or of an attestation | Single-use redemption; ticket bound to action, agent, enforcement point and arguments digest; expiry; verifier imposes the expected context | An attestation of a past decision stays valid as a statement about the past; verifiers must check the context |
| **Forged or altered attestation** | Canonical JCS serialization, Ed25519, a fixed algorithm (no negotiable `alg`) | Stolen signing key; key custody is the deployment's |
| **Argument substitution** | Digest of canonical arguments compared with what is observed at redemption; non-canonicalizable arguments are rejected | Anything the application does that is not in the digested arguments |
| **Concurrent revocation** | Total order by event sequence; redemption evaluated against the log at its own sequence | A revocation not yet written to the log cannot be honoured |
| **Concurrent double redemption** | Atomic redemption (in memory first, then PostgreSQL under the existing writer lock) | Planned: tested in memory in PR 1; PostgreSQL behaviour only once PR 2 lands. Not demonstrated today |
| **Dependency failure** (store, clock, signer) | Fail-closed; `UNAVAILABLE` is distinct from `DENIED` and never allowed | Availability: a failing dependency blocks actions |
| **Log rollback, truncation, omission** | Log head hash inside the attestation; replay detects a changed log | Not detectable without an external witness; out of V1 |
| **Bypassing the guard** | Documentation, one enforcement point recommended | Out of Authority's reach |
| **Ticket theft** | Ticket bound to agent, enforcement point and arguments | A bearer inside the same process |
| **Clock manipulation** | Injected clock; refusal of instants older than what the log already contains (I22) | Trust in the clock's source |
| **Algorithm downgrade, canonicalization ambiguity** | Fixed algorithm; RFC 8785 with strict input validation (existing `canonicalizeToolArguments`) | Review pending |
| **Lost COMMIT acknowledgement (PostgreSQL)** | The call throws, a retry reads the truth, the effect never runs without an observed `ok` | The holder cannot be told apart from another caller: a legitimate effect may be lost; Authority never produces a second success |
| **Stale or manipulated clock** | Injected clock; instants older than the log's latest are refused | A stale clock redeems within the recorded window; a far-future value blocks later sane-clock calls (availability) |
| **Attestation: forgery, field tampering, algorithm or version confusion** (PR 3) | Closed schema, fixed algorithm, Ed25519 over a domain-separated, JCS-canonical input that includes `alg` and `key_id`; every leaf mutation and every signature bit is detected by tests | A stolen key signs anything; revocation instants rely on the claimed time (see `ATTESTATIONS.md`) |
| **Attestation: ambiguous serialization** (PR 3) | Strict reader: duplicate keys, inexact numbers, lone surrogates, non-canonical base64url and oversized input are refused | An independent verifier must be as strict; the vectors define the behaviour |
| **Attestation: a validly signed lie** (PR 3) | L0 to L2 say they do not validate the decision; L3 (PR 4) re-derives it from a journal the verifier supplies; the journal's authenticity and completeness, and an anchor's independence, remain NOT established | Authenticity and completeness of the journal are not established; equivocation needs an outside witness |
| **Prompt injection steering an agent** | Not a model defence. The enforcement point refuses actions outside the delegated authority regardless of what the model asks | The model may still misuse authority it legitimately holds |
| **Ticket consumed by a concurrent write** (`CONCURRENT_WRITE_DETECTED`) | Redemption fails closed: nothing is authorized, the event is recognisable (I31), the caller authorizes again | Availability trade-off accepted for V1: the consumed ticket keeps its capacity engaged, so re-authorizing under a `total_budget` may be refused (`CAPACITY_EXCEEDED`). Capacity accounting is unchanged in V1; no claim is made about the external effect |

Review gate: the cryptographic components (envelope, signing, verification)
get an independent review before any security communication about them.
