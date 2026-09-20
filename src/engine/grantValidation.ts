/**
 * PR4A — the ASSERTED CAPABILITY_ISSUED -> GRANTED CAPABILITY boundary,
 * as a pure, isolated function. This module contains the ONLY code in
 * `src/` that constructs a `ValidatedGrant` (src/engine/capacity.ts) —
 * and it does so only after actually performing the validation that
 * name promises. It does not touch ingest.ts, does not decide anything
 * about ACTION_EXECUTED/remainingBudget/I20, and performs no I/O.
 *
 * SELECTION POLICY (see the accompanying report for the full analysis):
 * GRANTED is the resolution of INVOKED — the delegation named by
 * ACTION_REQUESTED.delegation_id — and ONLY of INVOKED. This module never
 * substitutes a different, more permissive AVAILABLE chain the requester
 * happens to also hold, even when one would resolve more favorably. There
 * is therefore no multi-path tie-break to make here: exactly one candidate
 * (the invoked delegation) is ever resolved, so insertion order of any
 * other delegation the requester holds cannot affect the outcome.
 *
 * FRESHNESS INVARIANT (backdating) — READ THIS BEFORE TRUSTING
 * `candidate.payload.decision_sequence` FOR ANYTHING:
 *
 * `decision_sequence` sits inside `CapabilityIssuedPayload`, which is part
 * of `EventEnvelopeSource` — i.e., as of PR4A, it is source-authored data,
 * exactly as untrusted as `authority_chain_ref` ever was on ACTION_EXECUTED
 * before I20 existed. This function does NOT treat it as trustworthy
 * input. It treats it as an ASSERTION to check against one true, derived
 * quantity:
 *
 *   snapshotSequence = the last canonical sequence that was visible when
 *   Authority resolved this grant — i.e. `candidate.sequence - 1`, given
 *   that `sequence` is assigned contiguously, one at a time, by ingestion
 *   (never by a source).
 *
 * The only accepted `decision_sequence` is one that equals this
 * `snapshotSequence` EXACTLY. A caller gets no freedom to pick any other
 * value — not older (backdating), not equal to or later than its own
 * event (a causal impossibility, C25's own rule for ACTION_EXECUTED,
 * applied here too). This single equality subsumes every backdating
 * scenario, including one that tries to pick a pre-revocation instant:
 * if the only value ever accepted is "immediately before this event's own
 * sequence", there is no older, more convenient instant left to choose.
 *
 * WHAT THIS FUNCTION DOES NOT AND CANNOT GUARANTEE (left to PR4B): that
 * `candidate.sequence` itself was genuinely assigned by real ingestion in
 * the first place, rather than hand-set by whoever built the `AuthorityEvent`
 * object this function was called with. In PR4A there is no ingestion
 * pipeline wiring this function to real event admission yet — it is
 * exercised directly, in tests, against already-"sequenced" fixtures. The
 * freshness check above is a necessary, but on its own not sufficient,
 * condition: it is only as trustworthy as its caller's guarantee that
 * `candidate.sequence` is itself genuine. Making that guarantee real is
 * exactly PR4B's job (the transactional boundary that resolves, checks,
 * and assigns `sequence` atomically, so a caller never gets to supply
 * either `decision_sequence` or `sequence` as free-form input at all) —
 * see the accompanying design report. A related, deliberately unresolved
 * question for PR4B: whether `decision_sequence` should even remain a
 * source-authored payload field at all, or become an Authority-ASSIGNED
 * envelope-level fact (like `sequence`/`authority_time`/`recorded_at`
 * already are) — this module does not decide that; it only refuses to
 * treat the field as trusted in its current, still-source-authored shape.
 *
 * Pure: no I/O, no Date.now(), no mutation of its inputs.
 */
import { computeActionFingerprint, type AuthorityEvent, type CanonicalStore, type ChainLink } from "../domain/events.js";
import {
  iso8601,
  type AuthorityDecision,
  type CapabilityId,
  type DelegationId,
  type EventId,
  type Iso8601,
  type SequenceNumber,
} from "../domain/types.js";
import { evaluateConstraints } from "./evaluateConstraints.js";
import { validateChain, type DelegationEvent } from "./validateChain.js";
import type { CapabilityIssuedEvent, ValidatedGrant } from "./capacity.js";

type ActionRequestedEvent = Extract<AuthorityEvent, { readonly event_type: "ACTION_REQUESTED" }>;

export type GrantRejectionReason =
  | "ACTION_NOT_FOUND"
  | "ACTION_REQUESTED_NOT_VISIBLE_AT_DECISION"
  | "FINGERPRINT_MISMATCH"
  | "DECISION_SEQUENCE_NOT_IMMEDIATE"
  | "INVOKED_DELEGATION_NOT_FOUND"
  | "INVOKED_DELEGATION_NOT_OWNED_BY_REQUESTER"
  | "NOT_AUTHORIZED"
  | "GRANTED_CHAIN_MISMATCH";

export type GrantValidationResult =
  | { readonly ok: true; readonly grant: ValidatedGrant }
  | { readonly ok: false; readonly reason: GrantRejectionReason; readonly decision?: AuthorityDecision };

function findActionRequested(actionId: ActionRequestedEvent["payload"]["action_id"], store: CanonicalStore): ActionRequestedEvent | undefined {
  for (const event of store) {
    if (event.event_type === "ACTION_REQUESTED" && event.payload.action_id === actionId) {
      return event;
    }
  }
  return undefined;
}

function findDelegationById(delegationId: DelegationId, visibleAtDecision: CanonicalStore): DelegationEvent | undefined {
  for (const event of visibleAtDecision) {
    if ((event.event_type === "DELEGATION_CREATED" || event.event_type === "SUBDELEGATION_CREATED") && event.payload.delegation_id === delegationId) {
      return event;
    }
  }
  return undefined;
}

/**
 * Mirrors explainAction.ts's own private reconstructAuthorityTime exactly
 * (same rationale: legitimate only when looking back at a fixed past point,
 * never for "now" — see that file's docstring). Duplicated locally rather
 * than imported, since explainAction.ts does not export it — the same
 * small-local-helper convention evaluateConstraints.ts/ingest.ts already
 * each follow for their own private finders.
 */
function reconstructAuthorityTimeAt(store: CanonicalStore, atSequence: SequenceNumber): Iso8601 {
  let latest: { readonly ms: number; readonly iso: Iso8601 } | undefined;
  for (const event of store) {
    if (event.sequence <= atSequence) {
      const ms = Date.parse(event.authority_time);
      if (latest === undefined || ms > latest.ms) {
        latest = { ms, iso: event.authority_time };
      }
    }
  }
  return latest?.iso ?? iso8601("1970-01-01T00:00:00.000Z");
}

function chainLinksEqual(a: ChainLink, b: ChainLink): boolean {
  if (a.kind === "delegation" && b.kind === "delegation") {
    return a.delegation_id === b.delegation_id;
  }
  if (a.kind === "approval" && b.kind === "approval") {
    return a.approval_id === b.approval_id;
  }
  return false;
}

function chainsEqual(a: readonly ChainLink[], b: readonly ChainLink[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((link, index) => {
    const other = b[index];
    return other !== undefined && chainLinksEqual(link, other);
  });
}

/**
 * The ASSERTED -> GRANTED boundary. Given a CAPABILITY_ISSUED event
 * (already assigned a `sequence`, as it would be once ingested — this
 * function does not itself ingest anything), decides whether its claims
 * are demonstrably true against the canonical store, and if so, returns
 * the one and only `ValidatedGrant` this codebase's production code is
 * capable of constructing.
 *
 * Every rejection reason below corresponds to a specific, deliberate
 * check — see the module docstring for the two structural policies
 * (INVOKED-only selection, decision_sequence freshness) that shape several
 * of them at once.
 */
export function validateAndSelectGrant(store: CanonicalStore, candidate: CapabilityIssuedEvent): GrantValidationResult {
  const request = findActionRequested(candidate.payload.action_id, store);
  if (request === undefined) {
    return { ok: false, reason: "ACTION_NOT_FOUND" };
  }
  if (request.sequence > candidate.payload.decision_sequence) {
    // The request this capability claims to decide about did not exist
    // yet at the claimed decision point — a causal impossibility (I19's
    // own root cause, applied here).
    return { ok: false, reason: "ACTION_REQUESTED_NOT_VISIBLE_AT_DECISION" };
  }

  const canonicalFingerprint = computeActionFingerprint(request.payload.capability_requested, request.payload.parameters);
  if (candidate.payload.action_fingerprint !== canonicalFingerprint) {
    return { ok: false, reason: "FINGERPRINT_MISMATCH" };
  }

  // snapshotSequence = the last canonical sequence visible when Authority
  // would have resolved this grant. `decision_sequence` is only ever
  // accepted if it matches this DERIVED value exactly — see the module
  // docstring's FRESHNESS INVARIANT section for why this is a check
  // against an assertion, never trust placed in the assertion itself.
  const snapshotSequence = Number(candidate.sequence) - 1;
  if (Number(candidate.payload.decision_sequence) !== snapshotSequence) {
    return { ok: false, reason: "DECISION_SEQUENCE_NOT_IMMEDIATE" };
  }

  const visibleAtDecision = store.filter((event) => event.sequence <= candidate.payload.decision_sequence);
  const invokedDelegation = findDelegationById(request.payload.delegation_id, visibleAtDecision);
  if (invokedDelegation === undefined) {
    return { ok: false, reason: "INVOKED_DELEGATION_NOT_FOUND" };
  }
  if (invokedDelegation.payload.grantee_principal_id !== request.payload.requesting_principal_id) {
    // The invoked delegation_id is real, but it does not belong to the
    // requester who invoked it — validateChain has no way to catch this on
    // its own (see findCandidates, which pre-filters by grantee before
    // validateChain is ever called on the normal authorityAt path; this
    // function bypasses findCandidates on purpose — see the module
    // docstring — so it must re-establish that same guarantee itself).
    return { ok: false, reason: "INVOKED_DELEGATION_NOT_OWNED_BY_REQUESTER" };
  }

  const authorityTimeAtDecision = reconstructAuthorityTimeAt(store, candidate.payload.decision_sequence);
  const validation = validateChain(invokedDelegation, request.payload.capability_requested, visibleAtDecision, undefined, authorityTimeAtDecision);

  let decision: AuthorityDecision;
  if (validation.kind === "valid") {
    decision = evaluateConstraints(validation.chain, request.payload.capability_requested, request.payload.parameters, visibleAtDecision, request.payload.requesting_principal_id);
  } else if (validation.kind === "denied") {
    decision = { outcome: "DENIED", reasonCode: validation.reasonCode };
  } else {
    decision = { outcome: "UNKNOWN", reasonCode: validation.reasonCode };
  }

  if (decision.outcome !== "AUTHORIZED") {
    return { ok: false, reason: "NOT_AUTHORIZED", decision };
  }

  const canonicalChain: ChainLink[] = decision.chain.map((id): ChainLink => ({ kind: "delegation", delegation_id: id }));
  if (decision.approvalId !== undefined) {
    canonicalChain.push({ kind: "approval", approval_id: decision.approvalId });
  }

  if (!chainsEqual(candidate.payload.granted_chain_ref, canonicalChain)) {
    // The caller's asserted chain does not match what Authority's own
    // resolver actually produced for the invoked delegation. Rejected, not
    // silently replaced — see the module docstring: GRANTED is never a
    // caller-supplied value Authority merely rubber-stamps, but Authority
    // also never rewrites a source's own assertion (I3's spirit, applied
    // here: reject what is wrong, never quietly correct it).
    return { ok: false, reason: "GRANTED_CHAIN_MISMATCH" };
  }

  return { ok: true, grant: { event: candidate } as ValidatedGrant };
}

/**
 * The capability_id uniqueness SIGNAL described in the accompanying report:
 * returns the other CAPABILITY_ISSUED event already in `store` that claims
 * the same `capability_id`, if any — excluding `candidate`'s own event_id,
 * so an idempotent retry of the very same command (same event_id, same
 * payload, per I8's existing dedup rule in ingest.ts) is never reported as
 * a collision. This is a signal only: NOT wired into
 * `validateAndSelectGrant`, and NOT wired into ingest.ts. A future
 * ingestion-time admissibility check decides what to do with this signal.
 */
export function findCapabilityIdCollision(capabilityId: CapabilityId, candidateEventId: EventId, store: CanonicalStore): CapabilityIssuedEvent | undefined {
  for (const event of store) {
    if (event.event_type === "CAPABILITY_ISSUED" && event.payload.capability_id === capabilityId && event.event_id !== candidateEventId) {
      return event;
    }
  }
  return undefined;
}
