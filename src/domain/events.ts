/**
 * Event schema for authority-graph V0 (EVENT_MODEL.md).
 *
 * This module defines the 8 event shapes and the canonical action-fingerprint
 * function. It contains no chain resolution, no ingestion/authorization
 * decision logic — that is the engine, deliberately not implemented here.
 */

import { createHash } from "node:crypto";
import type {
  ActionId,
  ActionParameters,
  ApprovalId,
  AssuranceLevel,
  Capability,
  DelegationConstraints,
  DelegationId,
  EventId,
  ExecutionResultCode,
  Fingerprint,
  Iso8601,
  PrincipalId,
  PrincipalType,
  ReasonCode,
  SchemaVersion,
  SequenceNumber,
} from "./types.js";

// ---------------------------------------------------------------------------
// Envelope
//
// A source may only ever author `EventEnvelopeSource`. `sequence`,
// `authority_time`, `recorded_at` and `assurance_level` are attributed by
// Authority at ingestion (I4) — keeping them in a separate, stricter shape
// (`EventEnvelopeIngested`) makes "a source forging its own sequence" a type
// error rather than a runtime check to remember.
// ---------------------------------------------------------------------------

export interface EventEnvelopeSource {
  readonly event_id: EventId;
  readonly schema_version: SchemaVersion;
  readonly occurred_at: Iso8601;
  readonly principal_id: PrincipalId;
}

export interface EventEnvelopeIngested extends EventEnvelopeSource {
  readonly sequence: SequenceNumber;
  readonly authority_time: Iso8601;
  readonly recorded_at: Iso8601;
  readonly assurance_level: AssuranceLevel;
}

// ---------------------------------------------------------------------------
// Payloads — one interface per event type, field names mirror EVENT_MODEL.md.
// ---------------------------------------------------------------------------

export type DelegationCreatedPayload = DelegationConstraints & {
  readonly delegation_id: DelegationId;
  readonly grantor_principal_id: PrincipalId;
  readonly grantor_type: PrincipalType;
  readonly grantee_principal_id: PrincipalId;
  readonly capabilities: readonly Capability[];
  readonly can_delegate: boolean;
  readonly parent_delegation_id: null;
};

export type SubdelegationCreatedPayload = DelegationConstraints & {
  readonly delegation_id: DelegationId;
  readonly parent_delegation_id: DelegationId;
  readonly grantor_principal_id: PrincipalId;
  readonly grantee_principal_id: PrincipalId;
  readonly capabilities: readonly Capability[];
  readonly can_delegate: boolean;
};

export interface DelegationRevokedPayload {
  readonly delegation_id: DelegationId;
  readonly revoked_by_principal_id: PrincipalId;
  readonly reason_code: ReasonCode;
}

export interface ActionRequestedPayload {
  readonly action_id: ActionId;
  readonly requesting_principal_id: PrincipalId;
  readonly delegation_id: DelegationId;
  readonly capability_requested: Capability;
  readonly parameters: ActionParameters;
}

export interface ApprovalRequestedPayload {
  readonly approval_id: ApprovalId;
  readonly action_id: ActionId;
  readonly requested_from_principal_id: PrincipalId;
  readonly policy_reason_code: ReasonCode;
}

export interface ApprovalGrantedPayload {
  readonly approval_id: ApprovalId;
  readonly action_id: ActionId;
  readonly approving_principal_id: PrincipalId;
}

export interface ApprovalDeniedPayload {
  readonly approval_id: ApprovalId;
  readonly action_id: ActionId;
  readonly denying_principal_id: PrincipalId;
  readonly reason_code: ReasonCode;
}

/** authority_chain_ref elements: an ordered mix of delegation and approval links. */
export type ChainLink =
  | { readonly kind: "delegation"; readonly delegation_id: DelegationId }
  | { readonly kind: "approval"; readonly approval_id: ApprovalId };

export interface ActionExecutedPayload {
  readonly action_id: ActionId;
  readonly executed_by_principal_id: PrincipalId;
  readonly action_fingerprint: Fingerprint;
  readonly decision_sequence: SequenceNumber;
  readonly authority_chain_ref: readonly ChainLink[];
  readonly execution_result: ExecutionResultCode;
}

// ---------------------------------------------------------------------------
// Discriminated union over event_type, parameterized by envelope shape so
// that "as authored" and "as accepted into the canonical store" share one
// payload definition.
// ---------------------------------------------------------------------------

type Typed<Type extends string, Payload> = { readonly event_type: Type; readonly payload: Payload };

type EventBodyUnion =
  | Typed<"DELEGATION_CREATED", DelegationCreatedPayload>
  | Typed<"DELEGATION_REVOKED", DelegationRevokedPayload>
  | Typed<"SUBDELEGATION_CREATED", SubdelegationCreatedPayload>
  | Typed<"ACTION_REQUESTED", ActionRequestedPayload>
  | Typed<"APPROVAL_REQUESTED", ApprovalRequestedPayload>
  | Typed<"APPROVAL_GRANTED", ApprovalGrantedPayload>
  | Typed<"APPROVAL_DENIED", ApprovalDeniedPayload>
  | Typed<"ACTION_EXECUTED", ActionExecutedPayload>;

/** As authored by a source, before Authority assigns sequence/authority_time. */
export type DraftAuthorityEvent = EventEnvelopeSource & EventBodyUnion;

/** As accepted into the canonical store — the only shape `authorityAt()` ever reads. */
export type AuthorityEvent = EventEnvelopeIngested & EventBodyUnion;

export type AuthorityEventType = EventBodyUnion["event_type"];

export type CanonicalStore = readonly AuthorityEvent[];

export function isEventType<T extends AuthorityEventType>(
  event: AuthorityEvent,
  type: T,
): event is Extract<AuthorityEvent, { readonly event_type: T }> {
  return event.event_type === type;
}

export function toDraft(event: AuthorityEvent): DraftAuthorityEvent {
  return {
    event_id: event.event_id,
    schema_version: event.schema_version,
    occurred_at: event.occurred_at,
    principal_id: event.principal_id,
    event_type: event.event_type,
    payload: event.payload,
  } as DraftAuthorityEvent;
}

// ---------------------------------------------------------------------------
// Canonical action fingerprint (I15) — pure, deterministic (I2), no engine
// logic: this is a serialization rule belonging to the event schema, not a
// resolution decision.
// ---------------------------------------------------------------------------

const FIELD_SEPARATOR = ""; // unit separator, per EVENT_MODEL.md
const ABSENT = "∅"; // ∅, per EVENT_MODEL.md

export function computeActionFingerprint(
  capabilityRequested: Capability,
  parameters: ActionParameters,
): Fingerprint {
  const amountSegment = parameters.kind === "monetary" ? String(parameters.amount.value) : ABSENT;
  const recipientSegment = parameters.recipient !== undefined ? String(parameters.recipient) : ABSENT;
  const canonical = [
    `resource=${capabilityRequested.resource}`,
    `action=${capabilityRequested.action}`,
    `amount=${amountSegment}`,
    `recipient=${recipientSegment}`,
  ].join(FIELD_SEPARATOR);
  return createHash("sha256").update(canonical, "utf8").digest("hex") as Fingerprint;
}
