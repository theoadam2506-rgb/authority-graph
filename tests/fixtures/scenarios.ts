/**
 * Composed scenarios shared across adversarial test files. Each helper
 * returns plain `AuthorityEvent[]` (already "ingested" — sequence/authority_time
 * are test-author-assigned, since there is no ingestion pipeline in this
 * prompt) plus whatever handles the calling test needs (ids, an AuthorityQuery).
 */

import {
  capability,
  executionResultCode,
  monetaryParameters,
  money,
  noExpiry,
  nonMonetaryParameters,
  reasonCode,
  sequenceNumber,
  thresholds,
  type ActionParameters,
  type AmountThresholds,
  type AuthorityQuery,
  type Capability,
  type ExpiresAt,
  type Fingerprint,
  type Money,
  type PrincipalId,
  type PrincipalType,
} from "../../src/domain/types.js";
import {
  computeActionFingerprint,
  type ActionExecutedPayload,
  type ActionRequestedPayload,
  type ApprovalDeniedPayload,
  type ApprovalGrantedPayload,
  type ApprovalRequestedPayload,
  type AuthorityEvent,
  type ChainLink,
  type DelegationCreatedPayload,
  type DelegationRevokedPayload,
  type SubdelegationCreatedPayload,
} from "../../src/domain/events.js";
import {
  actionExecutedEvent,
  actionRequestedEvent,
  approvalDeniedEvent,
  approvalGrantedEvent,
  approvalRequestedEvent,
  delegationCreatedEvent,
  delegationRevokedEvent,
  instant,
  sequentialClock,
  subdelegationCreatedEvent,
  timeAt,
  type EnvelopeTiming,
} from "./builders.js";

export { instant, sequentialClock, timeAt };
import { action, approval, delegation, principal, recipient } from "./ids.js";

// ---------------------------------------------------------------------------
// Common cast of principals
// ---------------------------------------------------------------------------

export const THEO = principal("theo"); // HUMAN_ROOT
export const AGENT_A = principal("agent-a");
export const AGENT_B = principal("agent-b");
export const AGENT_C = principal("agent-c");
export const MALLORY = principal("mallory"); // never granted anything
export const VENDOR = recipient("vendor-1");

export const PURCHASE_ORDER_CREATE: Capability = capability("purchase_order", "create");

export const EUR = (value: number): Money => money(value, "EUR");

export function delegationLink(id: string): ChainLink {
  return { kind: "delegation", delegation_id: delegation(id) };
}

export function approvalLink(id: string): ChainLink {
  return { kind: "approval", approval_id: approval(id) };
}

// ---------------------------------------------------------------------------
// Event builders (thin, opinionated wrappers over tests/fixtures/builders.ts)
// ---------------------------------------------------------------------------

export interface RootDelegationOptions {
  readonly sequence: number;
  readonly id: string;
  readonly grantor: PrincipalId;
  readonly grantorType: PrincipalType;
  readonly grantee: PrincipalId;
  readonly capabilities: readonly Capability[];
  readonly canDelegate: boolean;
  readonly emitter?: PrincipalId; // envelope principal_id; defaults to grantor
  readonly expires?: ExpiresAt;
  readonly maxAmount?: Money;
  readonly totalBudget?: Money;
  readonly amountThresholds?: AmountThresholds;
  readonly timing?: EnvelopeTiming;
}

export function rootDelegation(o: RootDelegationOptions): AuthorityEvent {
  const payload: DelegationCreatedPayload = {
    delegation_id: delegation(o.id),
    grantor_principal_id: o.grantor,
    grantor_type: o.grantorType,
    grantee_principal_id: o.grantee,
    capabilities: o.capabilities,
    can_delegate: o.canDelegate,
    expires_at: o.expires ?? noExpiry,
    ...(o.maxAmount !== undefined ? { max_amount: o.maxAmount } : {}),
    ...(o.totalBudget !== undefined ? { total_budget: o.totalBudget } : {}),
    ...(o.amountThresholds !== undefined ? { thresholds: o.amountThresholds } : {}),
    parent_delegation_id: null,
  };
  return delegationCreatedEvent(o.sequence, o.emitter ?? o.grantor, payload, o.timing);
}

export interface SubDelegationOptions {
  readonly sequence: number;
  readonly id: string;
  readonly parentId: string;
  readonly grantor: PrincipalId;
  readonly grantee: PrincipalId;
  readonly capabilities: readonly Capability[];
  readonly canDelegate: boolean;
  readonly emitter?: PrincipalId; // defaults to grantor; set to a different principal to test I12
  readonly expires?: ExpiresAt;
  readonly maxAmount?: Money;
  readonly totalBudget?: Money;
  readonly amountThresholds?: AmountThresholds;
  readonly timing?: EnvelopeTiming;
}

export function subDelegation(o: SubDelegationOptions): AuthorityEvent {
  const payload: SubdelegationCreatedPayload = {
    delegation_id: delegation(o.id),
    parent_delegation_id: delegation(o.parentId),
    grantor_principal_id: o.grantor,
    grantee_principal_id: o.grantee,
    capabilities: o.capabilities,
    can_delegate: o.canDelegate,
    expires_at: o.expires ?? noExpiry,
    ...(o.maxAmount !== undefined ? { max_amount: o.maxAmount } : {}),
    ...(o.totalBudget !== undefined ? { total_budget: o.totalBudget } : {}),
    ...(o.amountThresholds !== undefined ? { thresholds: o.amountThresholds } : {}),
  };
  return subdelegationCreatedEvent(o.sequence, o.emitter ?? o.grantor, payload, o.timing);
}

export interface RevocationOptions {
  readonly sequence: number;
  readonly targetId: string;
  readonly issuedBy: PrincipalId; // envelope principal_id AND revoked_by_principal_id
  readonly reason?: string;
  readonly timing?: EnvelopeTiming;
}

export function revokeDelegation(o: RevocationOptions): AuthorityEvent {
  const payload: DelegationRevokedPayload = {
    delegation_id: delegation(o.targetId),
    revoked_by_principal_id: o.issuedBy,
    reason_code: reasonCode(o.reason ?? "REVOKED_FOR_TEST"),
  };
  return delegationRevokedEvent(o.sequence, o.issuedBy, payload, o.timing);
}

export interface ActionRequestOptions {
  readonly sequence: number;
  readonly id: string;
  readonly requester: PrincipalId;
  readonly delegationId: string;
  readonly capability?: Capability;
  readonly parameters?: ActionParameters;
  readonly timing?: EnvelopeTiming;
}

export function actionRequest(o: ActionRequestOptions): AuthorityEvent {
  const payload: ActionRequestedPayload = {
    action_id: action(o.id),
    requesting_principal_id: o.requester,
    delegation_id: delegation(o.delegationId),
    capability_requested: o.capability ?? PURCHASE_ORDER_CREATE,
    parameters: o.parameters ?? nonMonetaryParameters(),
  };
  return actionRequestedEvent(o.sequence, o.requester, payload, o.timing);
}

export interface ApprovalRequestOptions {
  readonly sequence: number;
  readonly id: string;
  readonly actionId: string;
  readonly requestedFrom: PrincipalId;
  readonly requester: PrincipalId; // envelope emitter, usually the resolver/agent itself
  readonly timing?: EnvelopeTiming;
}

export function approvalRequest(o: ApprovalRequestOptions): AuthorityEvent {
  const payload: ApprovalRequestedPayload = {
    approval_id: approval(o.id),
    action_id: action(o.actionId),
    requested_from_principal_id: o.requestedFrom,
    policy_reason_code: reasonCode("AMOUNT_BAND_APPROVAL"),
  };
  return approvalRequestedEvent(o.sequence, o.requester, payload, o.timing);
}

export interface ApprovalGrantOptions {
  readonly sequence: number;
  readonly id: string;
  readonly actionId: string;
  readonly approver: PrincipalId; // envelope emitter AND approving_principal_id
  readonly timing?: EnvelopeTiming;
}

export function approvalGrant(o: ApprovalGrantOptions): AuthorityEvent {
  const payload: ApprovalGrantedPayload = {
    approval_id: approval(o.id),
    action_id: action(o.actionId),
    approving_principal_id: o.approver,
  };
  return approvalGrantedEvent(o.sequence, o.approver, payload, o.timing);
}

export interface ApprovalDenyOptions {
  readonly sequence: number;
  readonly id: string;
  readonly actionId: string;
  readonly denier: PrincipalId;
  readonly timing?: EnvelopeTiming;
}

export function approvalDeny(o: ApprovalDenyOptions): AuthorityEvent {
  const payload: ApprovalDeniedPayload = {
    approval_id: approval(o.id),
    action_id: action(o.actionId),
    denying_principal_id: o.denier,
    reason_code: reasonCode("DENIED_FOR_TEST"),
  };
  return approvalDeniedEvent(o.sequence, o.denier, payload, o.timing);
}

export interface ActionExecutionOptions {
  readonly sequence: number;
  readonly actionId: string;
  readonly executor: PrincipalId;
  readonly decisionSequence: number;
  readonly chain: readonly ChainLink[];
  readonly capability?: Capability;
  readonly parameters?: ActionParameters; // the *actually executed* parameters
  readonly fingerprintOverride?: string; // to deliberately forge a mismatch (A17/I15)
  readonly timing?: EnvelopeTiming;
}

export function actionExecution(o: ActionExecutionOptions): AuthorityEvent {
  const cap = o.capability ?? PURCHASE_ORDER_CREATE;
  const params = o.parameters ?? nonMonetaryParameters();
  const fingerprint: Fingerprint =
    o.fingerprintOverride !== undefined
      ? (o.fingerprintOverride as Fingerprint)
      : computeActionFingerprint(cap, params);
  const payload: ActionExecutedPayload = {
    action_id: action(o.actionId),
    executed_by_principal_id: o.executor,
    action_fingerprint: fingerprint,
    decision_sequence: sequenceNumber(o.decisionSequence),
    authority_chain_ref: o.chain,
    execution_result: executionResultCode("EXECUTED_FOR_TEST"),
  };
  return actionExecutedEvent(o.sequence, o.executor, payload, o.timing);
}

// ---------------------------------------------------------------------------
// Named scenarios
// ---------------------------------------------------------------------------

/**
 * A single HUMAN_ROOT -> AGENT_A delegation, no money involved. Baseline for
 * C1. Deliberately carries no ACTION_REQUESTED event: authorityAt's
 * prospective query needs none (see the mandatory "does not require
 * ACTION_REQUESTED" test).
 */
export function simpleAuthorizedChain(): {
  readonly store: readonly AuthorityEvent[];
  readonly query: AuthorityQuery;
} {
  const store = [
    rootDelegation({
      sequence: 1,
      id: "d-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
    }),
  ];
  const query: AuthorityQuery = {
    agentId: AGENT_A,
    principalId: THEO,
    capability: PURCHASE_ORDER_CREATE,
    parameters: nonMonetaryParameters(),
  };
  return { store, query };
}

/**
 * The mandatory I12 laundering scenario:
 * Theo -> A (purchase_order.create <= 5000, can_delegate: false)
 *      -> A creates B (<= 1000)
 *           -> B creates C (<= 500)
 * Every link is more restrictive than its parent (I5 holds everywhere), but
 * the chain is illegitimate from A -> B onward because A never had the right
 * to sub-delegate. C must never be AUTHORIZED.
 */
export function launderingChain(): {
  readonly store: readonly AuthorityEvent[];
  readonly query: AuthorityQuery;
} {
  const store = [
    rootDelegation({
      sequence: 1,
      id: "d-theo-a",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false, // <-- A is never granted the right to sub-delegate
      maxAmount: EUR(5000),
      amountThresholds: thresholds(5000, 5000),
    }),
    // A sub-delegates anyway (I12 violation), more restrictive than its own grant (I5 satisfied).
    subDelegation({
      sequence: 2,
      id: "d-a-b",
      parentId: "d-theo-a",
      grantor: AGENT_A,
      grantee: AGENT_B,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: true,
      maxAmount: EUR(1000),
      amountThresholds: thresholds(1000, 1000),
    }),
    // B, believing its grant from A is legitimate, sub-delegates further to C.
    subDelegation({
      sequence: 3,
      id: "d-b-c",
      parentId: "d-a-b",
      grantor: AGENT_B,
      grantee: AGENT_C,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      maxAmount: EUR(500),
      amountThresholds: thresholds(500, 500),
    }),
    // Kept as a historical record (useful for explainAction-focused tests),
    // even though authorityAt's own prospective query below does not need it.
    actionRequest({
      sequence: 4,
      id: "a-c-1",
      requester: AGENT_C,
      delegationId: "d-b-c",
      parameters: monetaryParameters(EUR(100)),
    }),
  ];
  const query: AuthorityQuery = {
    agentId: AGENT_C,
    principalId: THEO,
    capability: PURCHASE_ORDER_CREATE,
    parameters: monetaryParameters(EUR(100)),
  };
  return { store, query };
}

/** Sibling sub-delegations sharing a bounded parent total_budget. */
export function siblingsSharingBudget(parentBudget: number, childBudget: number): AuthorityEvent[] {
  return [
    rootDelegation({
      sequence: 1,
      id: "d-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: true,
      totalBudget: EUR(parentBudget),
      amountThresholds: thresholds(parentBudget, parentBudget),
    }),
    subDelegation({
      sequence: 2,
      id: "d-sibling-1",
      parentId: "d-root",
      grantor: AGENT_A,
      grantee: AGENT_B,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      totalBudget: EUR(childBudget),
      amountThresholds: thresholds(childBudget, childBudget),
    }),
    subDelegation({
      sequence: 3,
      id: "d-sibling-2",
      parentId: "d-root",
      grantor: AGENT_A,
      grantee: AGENT_C,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      totalBudget: EUR(childBudget),
      amountThresholds: thresholds(childBudget, childBudget),
    }),
  ];
}
