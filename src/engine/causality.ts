/**
 * I19 — causal legitimacy of point-in-time ID references (PROMPT 6b).
 * Several event payloads cite another event by a business ID (`approval_id`,
 * `action_id`, ...) as evidence for a claim about a specific moment — "I am
 * responding, now, to this already-deposited approval request"
 * (`APPROVAL_GRANTED`/`APPROVAL_DENIED`). Finding #4 (PROMPT 6a, I18) showed
 * one instance of this general pattern for `decision_sequence`; finding #1
 * (PROMPT 6b) showed another for `APPROVAL_GRANTED.approval_id`. Both share
 * one root cause: a citing event's reference is only legitimate once the
 * referenced event actually exists in the canonical store AND its own
 * `sequence` is never strictly later than the citing event's `sequence`.
 *
 * NOT every ID reference in the schema gets this treatment — see SPEC.md
 * I19, "Distinction avec la livraison hors-ordre": `parent_delegation_id` on
 * `SUBDELEGATION_CREATED` is a structural graph pointer resolved as a
 * snapshot at `atSequence`, not a point-in-time claim, and A5 deliberately
 * allows a parent to carry a *higher* sequence than the child citing it.
 * Applying this check there breaks A5 — do not.
 *
 * This module also decides nothing about "not found at all" — that is the
 * pre-existing, legitimate out-of-order-delivery case (A5, THREAT_MODEL.md).
 * `isNotCausallyAfter` is only ever meant to be called once a candidate has
 * already been found by business-ID match.
 *
 * Equality is tolerated, not rejected: the real ingestion path
 * (`src/engine/ingest.ts`) assigns a unique, strictly increasing `sequence`
 * to each accepted event one at a time, so two *distinct* events can never
 * actually share a `sequence` through real ingestion — tolerating a tie
 * here opens no real gap. Some hand-built test fixtures (predating I19)
 * assign two related events the same `sequence` by convention; only a
 * *strictly later* `sequence` — an event that demonstrably did not exist
 * yet — is treated as a violation.
 */
import type { SequenceNumber } from "../domain/types.js";

export function isNotCausallyAfter(candidate: { readonly sequence: SequenceNumber }, citingSequence: SequenceNumber): boolean {
  return candidate.sequence <= citingSequence;
}
