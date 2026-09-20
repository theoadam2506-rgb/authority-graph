/**
 * PR4B-1 — the minimal command a caller submits to ask for a capability.
 * Pure types only; no command handler exists yet (that is PR4B-2/PR4B-3).
 *
 * Deliberately does NOT duplicate anything ACTION_REQUESTED already
 * carries: `requester`, `delegation_id` (INVOKED), the capability/parameters
 * being requested are all already immutably fixed by the ACTION_REQUESTED
 * that `action_id` points to — a future command handler looks them up
 * there, it never re-accepts them as fresh, independently-forgeable input
 * (the exact lesson already applied inside grantValidation.ts: never trust
 * a second, caller-supplied copy of a fact an immutable event already
 * carries).
 */
import type { ActionId, ClientIdempotencyKey, EnforcementPointId, PrincipalId } from "./types.js";

/**
 * The business command. Notably absent, on purpose (see the design report,
 * "AUTHORITY CONTROLLED FIELDS"): capability_id, decision_sequence,
 * granted_chain_ref, action_fingerprint, and expires_at. None of these are
 * ever caller input — Authority generates or derives every one of them.
 */
export interface IssueCapabilityCommand {
  readonly action_id: ActionId;
  readonly enforcement_point_id: EnforcementPointId;
}

/**
 * The one command kind PR4B-1 defines. A union, so a future second command
 * kind (e.g. a future redemption command) extends this type rather than
 * requiring every caller of ScopedIdempotencyKey to be rewritten.
 */
export type CommandOperation = "ISSUE_CAPABILITY";

/**
 * The idempotency scope Correction 3 requires: a raw client-supplied key
 * alone is never sufficient, because two different requesters could
 * present the same raw key and collide. The scope is the triple (WHO
 * authenticated, WHAT operation, the caller's own key) — not the key
 * alone. No hash/UUID/cryptographic format is chosen here; this is a
 * logical scope, not a wire format.
 *
 * The invariant this scope exists to make checkable later (PR4B-2):
 * same scope + same command payload => same logical result / same
 * capability, ever (an idempotent retry). Same scope + a DIFFERENT command
 * payload => an idempotency conflict, never a second capability and never
 * silently ignored.
 */
export interface ScopedIdempotencyKey {
  readonly authenticated_requester_id: PrincipalId;
  readonly operation: CommandOperation;
  readonly client_idempotency_key: ClientIdempotencyKey;
}

/**
 * What a future command handler actually receives: the business command,
 * plus the idempotency scope, plus (implicitly, not modeled as a field
 * here — it never becomes graph data) whatever authentication mechanism
 * established `authenticated_requester_id` in the first place.
 */
export interface IssueCapabilityCommandEnvelope {
  readonly command: IssueCapabilityCommand;
  readonly idempotency: ScopedIdempotencyKey;
}
