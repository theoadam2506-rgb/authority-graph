/**
 * Thin draft builders for demo/run.ts — the demo's own equivalent of
 * tests/fixtures/builders.ts, but producing `DraftAuthorityEvent`s (no
 * sequence/authority_time/recorded_at: those are Authority's to assign at
 * ingestion, via the real `InMemoryEventStore`, not the demo's).
 */
import {
  actionId,
  approvalId,
  CURRENT_SCHEMA_VERSION,
  delegationId,
  eventId,
  executionResultCode,
  iso8601,
  reasonCode,
  sequenceNumber,
  type ActionParameters,
  type Capability,
  type DelegationConstraints,
  type Fingerprint,
  type PrincipalId,
  type PrincipalType,
} from "../src/domain/types.js";
import type {
  ActionExecutedPayload,
  ActionRequestedPayload,
  ApprovalDeniedPayload,
  ApprovalGrantedPayload,
  ApprovalRequestedPayload,
  ChainLink,
  DelegationCreatedPayload,
  DelegationRevokedPayload,
  DraftAuthorityEvent,
  SubdelegationCreatedPayload,
} from "../src/domain/events.js";

type Draft<T extends DraftAuthorityEvent["event_type"]> = Extract<DraftAuthorityEvent, { readonly event_type: T }>;

let autoId = 0;
function nextEventId(label: string) {
  autoId += 1;
  return eventId(`evt-${label}-${autoId}`);
}

function envelope(label: string, principal: PrincipalId, occurredAt: string) {
  return {
    event_id: nextEventId(label),
    schema_version: CURRENT_SCHEMA_VERSION,
    occurred_at: iso8601(occurredAt),
    principal_id: principal,
  };
}

export interface RootDelegationInput {
  readonly id: string;
  readonly grantor: PrincipalId;
  readonly grantorType: PrincipalType;
  readonly grantee: PrincipalId;
  readonly capabilities: readonly Capability[];
  readonly canDelegate: boolean;
  readonly constraints: DelegationConstraints;
  readonly occurredAt: string;
}

export function rootDelegationDraft(o: RootDelegationInput): Draft<"DELEGATION_CREATED"> {
  const payload: DelegationCreatedPayload = {
    ...o.constraints,
    delegation_id: delegationId(o.id),
    grantor_principal_id: o.grantor,
    grantor_type: o.grantorType,
    grantee_principal_id: o.grantee,
    capabilities: o.capabilities,
    can_delegate: o.canDelegate,
    parent_delegation_id: null,
  };
  return { ...envelope("delegation", o.grantor, o.occurredAt), event_type: "DELEGATION_CREATED", payload };
}

export interface SubDelegationInput {
  readonly id: string;
  readonly parentId: string;
  readonly grantor: PrincipalId;
  readonly grantee: PrincipalId;
  readonly capabilities: readonly Capability[];
  readonly canDelegate: boolean;
  readonly constraints: DelegationConstraints;
  readonly occurredAt: string;
}

export function subDelegationDraft(o: SubDelegationInput): Draft<"SUBDELEGATION_CREATED"> {
  const payload: SubdelegationCreatedPayload = {
    ...o.constraints,
    delegation_id: delegationId(o.id),
    parent_delegation_id: delegationId(o.parentId),
    grantor_principal_id: o.grantor,
    grantee_principal_id: o.grantee,
    capabilities: o.capabilities,
    can_delegate: o.canDelegate,
  };
  return { ...envelope("subdelegation", o.grantor, o.occurredAt), event_type: "SUBDELEGATION_CREATED", payload };
}

export interface RevokeInput {
  readonly targetId: string;
  readonly issuedBy: PrincipalId;
  readonly reason: string;
  readonly occurredAt: string;
}

export function revokeDelegationDraft(o: RevokeInput): Draft<"DELEGATION_REVOKED"> {
  const payload: DelegationRevokedPayload = {
    delegation_id: delegationId(o.targetId),
    revoked_by_principal_id: o.issuedBy,
    reason_code: reasonCode(o.reason),
  };
  return { ...envelope("revoke", o.issuedBy, o.occurredAt), event_type: "DELEGATION_REVOKED", payload };
}

export interface ActionRequestInput {
  readonly id: string;
  readonly requester: PrincipalId;
  readonly delegationId: string;
  readonly capability: Capability;
  readonly parameters: ActionParameters;
  readonly occurredAt: string;
}

export function actionRequestDraft(o: ActionRequestInput): Draft<"ACTION_REQUESTED"> {
  const payload: ActionRequestedPayload = {
    action_id: actionId(o.id),
    requesting_principal_id: o.requester,
    delegation_id: delegationId(o.delegationId),
    capability_requested: o.capability,
    parameters: o.parameters,
  };
  return { ...envelope("action-request", o.requester, o.occurredAt), event_type: "ACTION_REQUESTED", payload };
}

export interface ApprovalRequestInput {
  readonly id: string;
  readonly actionId: string;
  readonly requestedFrom: PrincipalId;
  readonly requester: PrincipalId;
  readonly occurredAt: string;
}

export function approvalRequestDraft(o: ApprovalRequestInput): Draft<"APPROVAL_REQUESTED"> {
  const payload: ApprovalRequestedPayload = {
    approval_id: approvalId(o.id),
    action_id: actionId(o.actionId),
    requested_from_principal_id: o.requestedFrom,
    policy_reason_code: reasonCode("AMOUNT_BAND_APPROVAL"),
  };
  return { ...envelope("approval-request", o.requester, o.occurredAt), event_type: "APPROVAL_REQUESTED", payload };
}

export interface ApprovalGrantInput {
  readonly id: string;
  readonly actionId: string;
  readonly approver: PrincipalId;
  readonly occurredAt: string;
}

export function approvalGrantDraft(o: ApprovalGrantInput): Draft<"APPROVAL_GRANTED"> {
  const payload: ApprovalGrantedPayload = { approval_id: approvalId(o.id), action_id: actionId(o.actionId), approving_principal_id: o.approver };
  return { ...envelope("approval-grant", o.approver, o.occurredAt), event_type: "APPROVAL_GRANTED", payload };
}

export interface ApprovalDenyInput {
  readonly id: string;
  readonly actionId: string;
  readonly denier: PrincipalId;
  readonly reason: string;
  readonly occurredAt: string;
}

export function approvalDenyDraft(o: ApprovalDenyInput): Draft<"APPROVAL_DENIED"> {
  const payload: ApprovalDeniedPayload = {
    approval_id: approvalId(o.id),
    action_id: actionId(o.actionId),
    denying_principal_id: o.denier,
    reason_code: reasonCode(o.reason),
  };
  return { ...envelope("approval-deny", o.denier, o.occurredAt), event_type: "APPROVAL_DENIED", payload };
}

export interface ActionExecutionInput {
  readonly actionId: string;
  readonly executor: PrincipalId;
  readonly decisionSequence: number;
  readonly chain: readonly ChainLink[];
  readonly fingerprint: Fingerprint;
  readonly occurredAt: string;
}

export function actionExecutionDraft(o: ActionExecutionInput): Draft<"ACTION_EXECUTED"> {
  const payload: ActionExecutedPayload = {
    action_id: actionId(o.actionId),
    executed_by_principal_id: o.executor,
    action_fingerprint: o.fingerprint,
    decision_sequence: sequenceNumber(o.decisionSequence),
    authority_chain_ref: o.chain,
    execution_result: executionResultCode("EXECUTED"),
  };
  return { ...envelope("action-execution", o.executor, o.occurredAt), event_type: "ACTION_EXECUTED", payload };
}

export function delegationLink(id: string): ChainLink {
  return { kind: "delegation", delegation_id: delegationId(id) };
}

export function approvalLink(id: string): ChainLink {
  return { kind: "approval", approval_id: approvalId(id) };
}
