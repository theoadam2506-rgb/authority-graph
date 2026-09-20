/**
 * PR4B-2 — the command-oriented orchestration: COMMAND -> DECISION -> EVENT
 * DATA, entirely in memory, entirely deterministic. This module does NOT
 * persist anything (no `EventSource.append`, no Postgres transaction — see
 * the design report for exactly what remains impossible here and belongs
 * to PR4B-3), and it does NOT authenticate anything (see
 * `authenticatedPrincipal.ts`: an already-authenticated identity is a
 * precondition, never something this module verifies itself).
 *
 * Pure: no I/O, no Date.now(), no Math.random(), no mutation of its
 * inputs. `capability_id` and `expires_at` come from injected
 * dependencies (see `IssueCapabilityDependencies`) precisely so tests can
 * supply deterministic values and the real deployment can supply whatever
 * generator/policy it wants, without either ever living inside this
 * kernel.
 */
import type { CanonicalStore, ChainLink } from "../domain/events.js";
import type {
  ActionId,
  AuthorityDecision,
  CapabilityId,
  DelegationId,
  EnforcementPointId,
  Fingerprint,
  Iso8601,
  Money,
  SequenceNumber,
} from "../domain/types.js";
import { sequenceNumber } from "../domain/types.js";
import type { AuthenticatedPrincipal } from "../domain/authenticatedPrincipal.js";
import { remainingCapacity, type ValidatedGrant } from "./capacity.js";
import {
  findActionRequested,
  findDelegationById,
  reconstructAuthorityTimeAt,
  selectInvokedGrant,
  validateAndSelectGrant,
  type GrantSelectionRejectionReason,
  type SelectedGrant,
} from "./grantValidation.js";
import type { IssueCapabilityCommand } from "../domain/capabilityCommand.js";

/**
 * `CAPABILITY_ID_COLLISION` is never returned by `issueCapability` itself —
 * this pure function has no visibility into ingestion (it never touches an
 * `EventSource`), so it cannot detect that a generated `capability_id`
 * already exists canonically. It exists in this union only so the
 * transactional layer (src/storage/capabilityIssuanceTransaction.ts, PR4B-3A)
 * can construct an `IssueCapabilityResult` carrying it after ingestion
 * itself rejects the draft — the exact same two-tier pattern
 * `GrantRejectionReason` already uses over `GrantSelectionRejectionReason`
 * (grantValidation.ts): a wider reason type for a value only a different
 * layer ever actually produces.
 */
export type IssueCapabilityRejectionReason = "REQUESTER_MISMATCH" | GrantSelectionRejectionReason | "CAPACITY_EXCEEDED" | "CAPABILITY_ID_COLLISION";

/**
 * Exactly the seven fields a future canonical CAPABILITY_ISSUED payload
 * needs (see CapabilityIssuedPayload, src/domain/events.ts) — but this is
 * NOT that type, deliberately: this module never constructs an event or an
 * envelope. Turning this into an actual canonical event, with a real
 * sequence/authority_time assigned atomically, is PR4B-3's job.
 */
export interface IssuedCapabilityData {
  readonly capability_id: CapabilityId;
  readonly action_id: ActionId;
  readonly action_fingerprint: Fingerprint;
  readonly decision_sequence: SequenceNumber;
  readonly granted_chain_ref: readonly ChainLink[];
  readonly enforcement_point_id: EnforcementPointId;
  readonly expires_at: Iso8601;
}

/**
 * `CAPABILITY_ID_COLLISION` gets its own branch, carrying the specific
 * `capability_id` that was proposed and refused — needed for audit (a
 * caller/operator must be able to tell WHICH id a broken/forced generator
 * collided on) without ever letting that id be mistaken for a canonical
 * success: it is a DIFFERENT field (`capability_id`, not `capability`),
 * on a branch whose own `ok` is `false`. `decision` is deliberately absent
 * here too — this rejection has nothing to do with an authorization
 * decision (see `AuthorityDecision`), so giving it one would be
 * meaningless. This field is intentionally NOT added to the other
 * rejection reasons: none of them have a refused business identifier to
 * report, and adding an unused optional field to branches that never
 * populate it would only invite confusion about what it means.
 */
export type IssueCapabilityResult =
  | { readonly ok: true; readonly capability: IssuedCapabilityData }
  | { readonly ok: false; readonly reason: "CAPABILITY_ID_COLLISION"; readonly capability_id: CapabilityId }
  | { readonly ok: false; readonly reason: Exclude<IssueCapabilityRejectionReason, "CAPABILITY_ID_COLLISION">; readonly decision?: AuthorityDecision };

/**
 * Injected dependencies (mirrors the existing `IngestionClock` idiom in
 * ingest.ts: a named-function dependency object, never a closed-over
 * global). `nextCapabilityId` and `expiresAt` are the ONLY two places this
 * module reaches outside of pure computation on its arguments — and both
 * are deterministic from the caller's point of view (a test supplies a
 * fixed sequence/counter; a real deployment supplies its own generator/
 * policy). Neither is ever `Math.random`/`Date.now()` inside this kernel.
 */
export interface IssueCapabilityDependencies {
  readonly nextCapabilityId: () => CapabilityId;
  /** `snapshotAuthorityTime` is the reconstructed trusted instant at `snapshotSequence` — never a live clock read. */
  readonly expiresAt: (snapshotAuthorityTime: Iso8601) => Iso8601;
}

function computeSnapshotSequence(store: CanonicalStore): SequenceNumber {
  let max = 0;
  for (const event of store) {
    if (Number(event.sequence) > max) {
      max = Number(event.sequence);
    }
  }
  return sequenceNumber(max);
}

/**
 * Re-derives every ALREADY-ISSUED, still-valid grant from the canonical
 * store, by re-running `validateAndSelectGrant` (PR4A) against every
 * CAPABILITY_ISSUED event already present. This is the only legitimate
 * way to obtain a `ValidatedGrant[]` in this codebase (see
 * capacity.ts's own docstring: no factory exists to skip validation) —
 * and it is deliberately expensive (O(n) re-validation per issuance, over
 * however many CAPABILITY_ISSUED events already exist) rather than
 * trusting persisted events at face value. That cost is a direct
 * consequence of NOT yet having a real write boundary (PR4B-3): once
 * CAPABILITY_ISSUED events can only ever be produced by an already-
 * validated, atomic Authority transaction, re-validating them again on
 * every read is redundant and should be dropped. Until then, re-checking
 * is the honest choice over silently trusting persisted data this
 * codebase cannot yet prove was never hand-crafted.
 */
function collectValidatedGrants(store: CanonicalStore): readonly ValidatedGrant[] {
  const grants: ValidatedGrant[] = [];
  for (const event of store) {
    if (event.event_type !== "CAPABILITY_ISSUED") {
      continue;
    }
    const result = validateAndSelectGrant(store, event);
    if (result.ok) {
      grants.push(result.grant);
    }
  }
  return grants;
}

/**
 * The orchestration itself. See the module docstring for what it does NOT
 * do (persist, authenticate). Step numbering below matches the design
 * report's own numbered list, for traceability.
 *
 * `authenticatedPrincipal` is received, never derived: this function does
 * not authenticate anything (see authenticatedPrincipal.ts — no JWT/mTLS/
 * API key/signature check lives here or anywhere in this module). Taking
 * `AuthenticatedPrincipal` instead of a raw `PrincipalId` is a typing
 * discipline, not a security boundary (TYPE SAFETY != SECURITY BOUNDARY —
 * a determined caller can still write `{ principalId: x } as
 * AuthenticatedPrincipal` and this function has no way to tell): its only
 * purpose is to make "an identity the caller merely extracted from
 * somewhere" and "an identity the deployment's auth layer has already
 * verified" different types at this specific boundary, so a future adapter
 * cannot pass one where the other was intended without at least writing an
 * explicit, greppable cast to do so.
 */
export function issueCapability(
  store: CanonicalStore,
  authenticatedPrincipal: AuthenticatedPrincipal,
  command: IssueCapabilityCommand,
  dependencies: IssueCapabilityDependencies,
): IssueCapabilityResult {
  const authenticatedRequesterId = authenticatedPrincipal.principalId;

  // 1. find ACTION_REQUESTED by action_id.
  const request = findActionRequested(command.action_id, store);
  if (request === undefined) {
    return { ok: false, reason: "ACTION_NOT_FOUND" };
  }

  // 2. authenticated_requester_id === ACTION_REQUESTED.requesting_principal_id.
  // The cryptographic proof behind `authenticatedPrincipal` is not this
  // module's concern (see authenticatedPrincipal.ts) — only the equality
  // check is: without it, a different, unrelated authenticated caller
  // could reserve capacity against a victim's own action_id (the H2
  // vector, moved earlier — see the design report).
  if (authenticatedRequesterId !== request.payload.requesting_principal_id) {
    return { ok: false, reason: "REQUESTER_MISMATCH" };
  }

  // 3. snapshotSequence = the last canonical sequence visible right now.
  const snapshotSequence = computeSnapshotSequence(store);

  // 4-5. resolve INVOKED only, produce the canonical GRANTED chain.
  const selection = selectInvokedGrant(store, command.action_id, snapshotSequence);
  if (!selection.ok) {
    return selection;
  }
  const grant: SelectedGrant = selection.grant;

  // 6. the amount engaged, read from the immutable, canonical ACTION_REQUESTED.
  const requestedAmount = request.payload.parameters.kind === "monetary" ? request.payload.parameters.amount.value : 0;

  // 7-8. remainingCapacity(D) - requestedAmount >= 0 for EVERY bounded
  // delegation in the GRANTED chain — a single insufficient ancestor
  // rejects the WHOLE emission; nothing partial is ever issued.
  const existingGrants = collectValidatedGrants(store);
  for (const link of grant.grantedChainRef) {
    if (link.kind !== "delegation") {
      continue;
    }
    const delegationEvent = findDelegationById(link.delegation_id as DelegationId, store);
    if (delegationEvent === undefined) {
      continue; // selectInvokedGrant already proved every link resolves; unreachable in practice.
    }
    const totalBudget: Money | undefined = delegationEvent.payload.total_budget;
    if (totalBudget === undefined) {
      continue; // H: unbounded delegation — never an artificial cap.
    }
    const remaining = remainingCapacity(link.delegation_id, totalBudget, existingGrants, store);
    if (remaining - requestedAmount < 0) {
      return { ok: false, reason: "CAPACITY_EXCEEDED" };
    }
  }

  // 9. expires_at from an injected POLICY, anchored to the reconstructed
  // snapshot instant — never the caller, never a live clock.
  const snapshotAuthorityTime = reconstructAuthorityTimeAt(store, snapshotSequence);
  const expiresAt = dependencies.expiresAt(snapshotAuthorityTime);

  // 10. capability_id from an injected, deterministic generator.
  const capabilityId = dependencies.nextCapabilityId();

  // 11-12. construct the canonical data and return it. Nothing here is
  // persisted — see the module docstring.
  return {
    ok: true,
    capability: {
      capability_id: capabilityId,
      action_id: command.action_id,
      action_fingerprint: grant.actionFingerprint,
      decision_sequence: snapshotSequence,
      granted_chain_ref: grant.grantedChainRef,
      // REQUESTED, not verified: no enforcement-point habilitation registry
      // exists yet (a distinct future PR, before any real API) — this
      // value is copied through as-is if the rest of the command
      // succeeds, never checked against anything.
      enforcement_point_id: command.enforcement_point_id,
      expires_at: expiresAt,
    },
  };
}
