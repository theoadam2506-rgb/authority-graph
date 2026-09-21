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
  type ActionId,
  type AuthorityDecision,
  type CapabilityId,
  type DelegationId,
  type EventId,
  type Iso8601,
  type PrincipalId,
  type SequenceNumber,
} from "../domain/types.js";
import { evaluateConstraints } from "./evaluateConstraints.js";
import { validateChain, type DelegationEvent } from "./validateChain.js";
import type { CapabilityIssuedEvent, ValidatedGrant } from "./capacity.js";

export type ActionRequestedEvent = Extract<AuthorityEvent, { readonly event_type: "ACTION_REQUESTED" }>;

/**
 * The subset of rejection reasons that make sense BEFORE a CAPABILITY_ISSUED
 * event exists at all — i.e. the reasons `selectInvokedGrant` (the
 * command-oriented core, PR4B-2) can produce. `GrantRejectionReason`
 * (below) extends this with three more reasons that only make sense when
 * checking an already-asserted candidate's claims against this same
 * resolution (FINGERPRINT_MISMATCH, DECISION_SEQUENCE_NOT_IMMEDIATE,
 * GRANTED_CHAIN_MISMATCH) — see `validateAndSelectGrant`, which is now a
 * thin adapter built on top of `selectInvokedGrant`, kept only so PR4A's
 * already-committed tests keep passing unmodified.
 */
export type GrantSelectionRejectionReason =
  | "ACTION_NOT_FOUND"
  | "ACTION_REQUESTED_NOT_VISIBLE_AT_DECISION"
  | "INVOKED_DELEGATION_NOT_FOUND"
  | "INVOKED_DELEGATION_NOT_OWNED_BY_REQUESTER"
  | "NOT_AUTHORIZED";

export type GrantRejectionReason = GrantSelectionRejectionReason | "FINGERPRINT_MISMATCH" | "DECISION_SEQUENCE_NOT_IMMEDIATE" | "GRANTED_CHAIN_MISMATCH";

export type GrantValidationResult =
  | { readonly ok: true; readonly grant: ValidatedGrant }
  | { readonly ok: false; readonly reason: GrantRejectionReason; readonly decision?: AuthorityDecision };

/**
 * The GRANTED data `selectInvokedGrant` produces on success — deliberately
 * NOT a CAPABILITY_ISSUED event or payload of any kind. `capability_id`,
 * `enforcement_point_id`, and `expires_at` never appear here: they are not
 * resolution outputs, they are Authority-generated/policy/command inputs
 * decided elsewhere (see the design report, "AUTHORITY-CONTROLLED
 * OUTPUT"). `decisionSequence` is not repeated here either — it is exactly
 * the `snapshotSequence` the caller already passed in.
 */
export interface SelectedGrant {
  readonly requestingPrincipalId: PrincipalId;
  readonly actionFingerprint: ReturnType<typeof computeActionFingerprint>;
  readonly grantedChainRef: readonly ChainLink[];
}

export type GrantSelectionResult =
  | { readonly ok: true; readonly grant: SelectedGrant }
  | { readonly ok: false; readonly reason: GrantSelectionRejectionReason; readonly decision?: AuthorityDecision };

export function findActionRequested(actionId: ActionId, store: CanonicalStore): ActionRequestedEvent | undefined {
  for (const event of store) {
    if (event.event_type === "ACTION_REQUESTED" && event.payload.action_id === actionId) {
      return event;
    }
  }
  return undefined;
}

export function findDelegationById(delegationId: DelegationId, visibleAtDecision: CanonicalStore): DelegationEvent | undefined {
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
export function reconstructAuthorityTimeAt(store: CanonicalStore, atSequence: SequenceNumber): Iso8601 {
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
 * PR4B-2 — the command-oriented core: COMMAND -> DECISION, with no EVENT
 * involved at any point. Given only `actionId` (the command's own input)
 * and `snapshotSequence` (an Authority-computed instant — see the design
 * report: this is never caller input), resolves INVOKED and, if and only
 * if it is AUTHORIZED, returns the canonical GRANTED data a future
 * CAPABILITY_ISSUED would be built from. Constructs no event, no
 * `ValidatedGrant` — this function has no opinion about what happens
 * after a successful selection; that is the orchestration layer's job
 * (PR4B-2's command handler), not this pure function's.
 *
 * Every rejection reason corresponds to a specific, deliberate check — see
 * the module docstring for the two structural policies (INVOKED-only
 * selection, decision_sequence freshness — freshness does not apply here
 * in its original form, since there is no candidate-supplied
 * decision_sequence to check freshness against; `snapshotSequence` is
 * simply trusted, because by this function's contract it was already
 * computed by Authority, not supplied by an untrusted candidate).
 *
 * PR4B-5 — `authorityTime` is the caller-supplied trusted instant this
 * selection is evaluated at, passed straight through to `validateChain`.
 * It is a dimension deliberately independent from `snapshotSequence`:
 * the latter fixes WHICH events are visible (causality), the former fixes
 * WHEN, from a trust perspective, expiration/temporal constraints are
 * checked. This function no longer reconstructs an instant from the store
 * itself for this purpose — `reconstructAuthorityTimeAt` (below) remains
 * exported and legitimate for genuinely historical reconstruction (e.g.
 * `validateAndSelectGrant`'s re-check of an already-issued grant, anchored
 * to that grant's own recorded `authority_time`), but using it here, for a
 * PROSPECTIVE decision, was exactly the bug PR4B-5 fixes: time can pass
 * with no new event, and a delegation that expired hours ago must not look
 * valid forever for want of a subsequent event.
 */
export function selectInvokedGrant(
  store: CanonicalStore,
  actionId: ActionId,
  snapshotSequence: SequenceNumber,
  authorityTime: Iso8601,
): GrantSelectionResult {
  const request = findActionRequested(actionId, store);
  if (request === undefined) {
    return { ok: false, reason: "ACTION_NOT_FOUND" };
  }
  if (request.sequence > snapshotSequence) {
    // The request this selection claims to decide about did not exist yet
    // at the claimed snapshot — a causal impossibility (I19's own root
    // cause, applied here).
    return { ok: false, reason: "ACTION_REQUESTED_NOT_VISIBLE_AT_DECISION" };
  }

  const visibleAtSnapshot = store.filter((event) => event.sequence <= snapshotSequence);
  const invokedDelegation = findDelegationById(request.payload.delegation_id, visibleAtSnapshot);
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

  const validation = validateChain(invokedDelegation, request.payload.capability_requested, visibleAtSnapshot, undefined, authorityTime);

  let decision: AuthorityDecision;
  if (validation.kind === "valid") {
    decision = evaluateConstraints(validation.chain, request.payload.capability_requested, request.payload.parameters, visibleAtSnapshot, request.payload.requesting_principal_id);
  } else if (validation.kind === "denied") {
    decision = { outcome: "DENIED", reasonCode: validation.reasonCode };
  } else {
    decision = { outcome: "UNKNOWN", reasonCode: validation.reasonCode };
  }

  if (decision.outcome !== "AUTHORIZED") {
    return { ok: false, reason: "NOT_AUTHORIZED", decision };
  }

  const grantedChainRef: ChainLink[] = decision.chain.map((id): ChainLink => ({ kind: "delegation", delegation_id: id }));
  if (decision.approvalId !== undefined) {
    grantedChainRef.push({ kind: "approval", approval_id: decision.approvalId });
  }

  return {
    ok: true,
    grant: {
      requestingPrincipalId: request.payload.requesting_principal_id,
      actionFingerprint: computeActionFingerprint(request.payload.capability_requested, request.payload.parameters),
      grantedChainRef,
    },
  };
}

/**
 * The ASSERTED -> GRANTED boundary, EVENT-CANDIDATE-FIRST — kept as a thin
 * adapter over `selectInvokedGrant` purely so PR4A's already-committed
 * tests (tests/engine/grantValidation.test.ts) keep passing unmodified.
 * New code should prefer `selectInvokedGrant` directly (see the design
 * report: COMMAND -> DECISION -> EVENT, never EVENT CANDIDATE -> DECISION).
 * Given a CAPABILITY_ISSUED event (already assigned a `sequence`, as it
 * would be once ingested), decides whether ITS claims are demonstrably
 * true, and if so, returns the one and only `ValidatedGrant` this
 * codebase's production code is capable of constructing.
 */
export function validateAndSelectGrant(store: CanonicalStore, candidate: CapabilityIssuedEvent): GrantValidationResult {
  const request = findActionRequested(candidate.payload.action_id, store);
  if (request === undefined) {
    return { ok: false, reason: "ACTION_NOT_FOUND" };
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

  // PR4B-5 — `candidate.authority_time` is the ENVELOPE field, assigned by
  // Authority itself at ingestion (never source-supplied, unlike
  // `decision_sequence` above) — since the fix, it honestly carries the
  // real explicit authorityTime this candidate's original decision was
  // evaluated at. Re-checking it now against that same recorded instant is
  // the correct historical reconstruction: this call is re-validating an
  // ALREADY-DECIDED past grant, not making a new prospective one, so
  // reusing the event's own trustworthy authority_time here — rather than
  // reconstructing anything — is exactly right.
  const selection = selectInvokedGrant(store, candidate.payload.action_id, candidate.payload.decision_sequence, candidate.authority_time);
  if (!selection.ok) {
    return selection;
  }

  if (!chainsEqual(candidate.payload.granted_chain_ref, selection.grant.grantedChainRef)) {
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
