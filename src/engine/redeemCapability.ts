/**
 * V1 — the pure redemption decision kernel. Given a canonical snapshot, an
 * authenticated requester, a command and an explicit trusted instant, it
 * decides whether the ticket (`CAPABILITY_ISSUED`) may be redeemed now. It
 * persists nothing, reads no clock and generates nothing: like
 * `issueCapability`, it returns a DECISION; the transactional layer
 * (src/storage/capabilityRedemptionTransaction.ts) makes it canonical.
 *
 * Checks, in this fixed precedence (the first failing one is reported):
 *  1. CAPABILITY_NOT_FOUND         no CAPABILITY_ISSUED with that capability_id
 *  2. CAPABILITY_NOT_VALID         the ticket is not a valid grant (forged or incoherent)
 *  3. REQUESTER_MISMATCH           the authenticated requester is not the action's requester
 *  4. STALE_AUTHORITY_TIME         authorityTime older than an authority_time already in the log (I22 model)
 *  5. WRONG_ENFORCEMENT_POINT      not the enforcement point the ticket names
 *  6. ALREADY_REDEEMED             a CAPABILITY_REDEEMED for this capability_id already exists
 *  7. EXPIRED                      authorityTime >= expires_at (the boundary counts as expired)
 *  8. ARGUMENTS_MISMATCH           the observed capability/parameters have another fingerprint
 *  9. AUTHORITY_NO_LONGER_VALID    the invoked authority no longer yields AUTHORIZED at this
 *                                  instant and over the whole log (e.g. revoked since issuance)
 *
 * Redemption never releases or alters the capacity a ticket engages
 * (capacity.ts is untouched): a redeemed ticket stays engaged.
 *
 * Honest limits: this decides about AUTHORITY, not about the effect. It does
 * not make the external effect happen at most once (only the target can), it
 * does not verify identity (AuthenticatedPrincipal is an assertion), and it
 * cannot see a revocation that is not yet in the log.
 */
import type { AuthenticatedPrincipal } from "../domain/authenticatedPrincipal.js";
import type { RedeemCapabilityCommand } from "../domain/capabilityCommand.js";
import { computeActionFingerprint, type CanonicalStore } from "../domain/events.js";
import type { ActionId, AuthorityDecision, CapabilityId, EnforcementPointId, Fingerprint, Iso8601, SequenceNumber } from "../domain/types.js";
import { isWellFormedActionParameters, sequenceNumber } from "../domain/types.js";
import type { CapabilityIssuedEvent } from "./capacity.js";
import { findActionRequested, selectInvokedGrant, validateAndSelectGrant, type GrantRejectionReason } from "./grantValidation.js";

export type RedeemCapabilityRejectionReason =
  | "CAPABILITY_NOT_FOUND"
  | "CAPABILITY_NOT_VALID"
  | "REQUESTER_MISMATCH"
  | "STALE_AUTHORITY_TIME"
  | "WRONG_ENFORCEMENT_POINT"
  | "ALREADY_REDEEMED"
  | "EXPIRED"
  | "ARGUMENTS_MISMATCH"
  | "AUTHORITY_NO_LONGER_VALID"
  // Never returned by the pure kernel; produced only by the transactional layer.
  | "REDEMPTION_COLLISION"
  | "CONCURRENT_WRITE_DETECTED";

/** Exactly the fields a future canonical CAPABILITY_REDEEMED payload needs. */
export interface RedeemedCapabilityData {
  readonly capability_id: CapabilityId;
  readonly action_id: ActionId;
  readonly action_fingerprint: Fingerprint;
  readonly decision_sequence: SequenceNumber;
  readonly enforcement_point_id: EnforcementPointId;
}

export type RedeemCapabilityResult =
  | { readonly ok: true; readonly redemption: RedeemedCapabilityData }
  | {
      readonly ok: false;
      readonly reason: RedeemCapabilityRejectionReason;
      /** Present for CAPABILITY_NOT_VALID (why the grant failed validation) and AUTHORITY_NO_LONGER_VALID (the engine's decision). */
      readonly detail?: { readonly grantRejection?: GrantRejectionReason; readonly decision?: AuthorityDecision };
    };

function findIssued(store: CanonicalStore, capabilityId: CapabilityId): CapabilityIssuedEvent | undefined {
  for (const event of store) {
    if (event.event_type === "CAPABILITY_ISSUED" && event.payload.capability_id === capabilityId) {
      return event;
    }
  }
  return undefined;
}

function maxSequence(store: CanonicalStore): SequenceNumber {
  let max = 0;
  for (const event of store) {
    if (Number(event.sequence) > max) max = Number(event.sequence);
  }
  return sequenceNumber(max);
}

export function redeemCapability(
  store: CanonicalStore,
  authenticatedPrincipal: AuthenticatedPrincipal,
  command: RedeemCapabilityCommand,
  authorityTime: Iso8601,
): RedeemCapabilityResult {
  // 1
  const issued = findIssued(store, command.capability_id);
  if (issued === undefined) {
    return { ok: false, reason: "CAPABILITY_NOT_FOUND" };
  }

  // 2. A CAPABILITY_ISSUED written around the transaction is not authority:
  // it must still be a coherent grant of the canonical history.
  const grant = validateAndSelectGrant(store, issued);
  if (!grant.ok) {
    return { ok: false, reason: "CAPABILITY_NOT_VALID", detail: { grantRejection: grant.reason } };
  }

  // 3. The requester is read from the immutable ACTION_REQUESTED, never from the command.
  const request = findActionRequested(issued.payload.action_id, store);
  if (request === undefined || authenticatedPrincipal.principalId !== request.payload.requesting_principal_id) {
    return { ok: false, reason: "REQUESTER_MISMATCH" };
  }

  // 4. Same rule as issuance (I22): bound inclusive on the valid side.
  let maxAuthorityTimeMs: number | undefined;
  for (const event of store) {
    const ms = Date.parse(event.authority_time);
    if (maxAuthorityTimeMs === undefined || ms > maxAuthorityTimeMs) maxAuthorityTimeMs = ms;
  }
  if (maxAuthorityTimeMs !== undefined && Date.parse(authorityTime) < maxAuthorityTimeMs) {
    return { ok: false, reason: "STALE_AUTHORITY_TIME" };
  }

  // 5
  if (command.enforcement_point_id !== issued.payload.enforcement_point_id) {
    return { ok: false, reason: "WRONG_ENFORCEMENT_POINT" };
  }

  // 6
  for (const event of store) {
    if (event.event_type === "CAPABILITY_REDEEMED" && event.payload.capability_id === command.capability_id) {
      return { ok: false, reason: "ALREADY_REDEEMED" };
    }
  }

  // 7. SPEC expiration convention: authorityTime < expires_at is valid; the boundary itself is expired.
  if (!(Date.parse(authorityTime) < Date.parse(issued.payload.expires_at))) {
    return { ok: false, reason: "EXPIRED" };
  }

  // 8. Compared, never trusted: the ticket's fingerprint is what Authority issued.
  if (!isWellFormedActionParameters(command.observed_parameters)) {
    return { ok: false, reason: "ARGUMENTS_MISMATCH" };
  }
  const observedFingerprint = computeActionFingerprint(command.observed_capability, command.observed_parameters);
  if (observedFingerprint !== issued.payload.action_fingerprint) {
    return { ok: false, reason: "ARGUMENTS_MISMATCH" };
  }

  // 9. The TOCTOU re-check: the invoked authority, over the WHOLE current log, at THIS instant.
  const snapshotSequence = maxSequence(store);
  const reselection = selectInvokedGrant(store, issued.payload.action_id, snapshotSequence, authorityTime);
  if (!reselection.ok) {
    return {
      ok: false,
      reason: "AUTHORITY_NO_LONGER_VALID",
      detail: { ...(reselection.decision !== undefined ? { decision: reselection.decision } : {}), grantRejection: reselection.reason },
    };
  }

  return {
    ok: true,
    redemption: {
      capability_id: command.capability_id,
      action_id: issued.payload.action_id,
      action_fingerprint: issued.payload.action_fingerprint,
      decision_sequence: snapshotSequence,
      enforcement_point_id: issued.payload.enforcement_point_id,
    },
  };
}
