# Vocabulary

## Words

| Term | Meaning in this project |
|---|---|
| **Decision** | The engine's answer to "may this agent do this now?": `AUTHORIZED`, `DENIED`, `REQUIRES_APPROVAL` or `UNKNOWN`, with a reason code. **exists today** |
| **Prospective question** | `authorityAt`: would compatible authority exist right now? It is **not** permission to execute a particular action instance. **exists today** (README, "Execution decisions are instance-bound") |
| **Ticket** | A `CAPABILITY_ISSUED` event: a decision made durable for one exact action (`action_id`, fingerprint), one enforcement point, with an expiry. **exists today** |
| **Redemption** | Planned. The atomic, single-use consumption of a ticket immediately before the effect, re-checking that authority still holds at that instant. |
| **Enforcement point** | The component that actually performs, or refuses, the effect. Authority never executes anything. |
| **Attestation** | **exists today for issuances and redemptions** (PR 3, `src/proof`, [`ATTESTATIONS.md`](./ATTESTATIONS.md)). A canonical JSON document (RFC 8785) signed with Ed25519 by a key the deployment supplies, stating that an event is in a journal with a given chain head. It is not a statement that the decision was right. |
| **Verification by replay** | Planned (PR 4, "L3"). Recomputing the decision from an exported event log and comparing it with the attestation. Possible because the engine is deterministic. |
| **Authority Proof** | The name of the component. Its artifacts are called *attestations*; we avoid "proof" for them because it suggests more than they establish. |

## What an attestation says, and what nobody can prove

An attestation, **if the signing key was not compromised**, says: *this Authority
instance, holding key K, evaluated action fingerprint F against an event log
whose head hash was H, at trusted time T, and returned outcome O with
chain C; and the document has not been altered since signing.*

Anyone holding the exported log can additionally check, by replay, that O
follows from the log, and that H matches it.

An attestation does **not** and **cannot** establish:

| Not established | Why |
|---|---|
| That the events in the log are true | Events are asserted and unauthenticated (`ASSERTED_UNVERIFIED`, invariant I17). A stolen or wrong identity upstream produces a perfectly consistent log. |
| That the log is complete | An omitted revocation, a truncated log or a log rolled back to an older state is not detectable without an external witness. V1 has none. |
| That the signer's clock was right | Time is supplied by the deployment (`TrustedClock`); Authority trusts it. |
| That the signing key was not stolen | Key custody is outside V1. |
| That the effect happened, or happened once | The execution report is an assertion by the enforcement point; redemption bounds authorizations, not external side effects. |
| That nothing bypasses the guard | A caller that never asks Authority is outside Authority's reach. |
| That a human intended the action, or that a `HUMAN_ROOT` holds real-world authority | Out of scope. |

Wording rules for all documentation, code comments and demos:

- Say "the log contains an event asserting that X did Y", never "X proved".
- Never write "tamper-proof", "non-repudiation", "certified", "compliant with" (any standard) or "secure" without a cited test or primary source.
- A `PASS` from the Conformance Lab means agreement with the engine on the probed inputs only.
