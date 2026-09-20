/**
 * Event schema for authority-graph V0 (EVENT_MODEL.md).
 *
 * This module defines the 8 event shapes documented in EVENT_MODEL.md plus
 * one additional, not-yet-documented shape (CAPABILITY_ISSUED — see its own
 * docstring below) and the canonical action-fingerprint function. It
 * contains no chain resolution, no ingestion/authorization decision logic —
 * that is the engine, deliberately not implemented here.
 */

import { createHash } from "node:crypto";
import type {
  ActionId,
  ActionParameters,
  ApprovalId,
  AssuranceLevel,
  Capability,
  CapabilityId,
  DelegationConstraints,
  DelegationId,
  EnforcementPointId,
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

/**
 * Records that Authority granted a precise execution right and froze the
 * authority provenance behind it — the GRANTED chain, as opposed to
 * AVAILABLE (what authority objectively existed), INVOKED
 * (`ACTION_REQUESTED.delegation_id`), and RECORDED
 * (`ACTION_EXECUTED.authority_chain_ref`, an after-the-fact assertion).
 *
 * This event does NOT mean: the action executed; a capability was redeemed;
 * an external result is known; the enforcement point dispatched anything.
 * It means only that this exact (action_id, action_fingerprint) pairing was,
 * at decision_sequence, backed by the chain named in `granted_chain_ref`.
 *
 * `granted_chain_ref` is the SAME KIND OF FIELD `authority_chain_ref` always
 * was: a value carried on a `DraftAuthorityEvent`, which any source can
 * populate, and which nothing in this module or in `ingest.ts` yet
 * revalidates against the canonical store. It is ASSERTED, not proven, for
 * exactly as long as no admissibility check re-derives and compares it
 * against the resolver's own chain-walking (mirrors `authority_chain_ref`'s
 * own status before I20's checks existed — see SPEC.md). Nothing about this
 * type should be read as a claim that a caller-supplied chain is trusted.
 * `decision_sequence` exists specifically so a future check can reconstruct
 * "what would the resolver itself have granted at this instant" and compare
 * it against `granted_chain_ref`, the same way `ActionExecutedPayload`'s own
 * `decision_sequence` already lets `explainAction` reconstruct historical
 * authority for an execution.
 *
 * `executed_by_principal_id`/`requesting_principal_id` are deliberately
 * absent here: the requester is already immutably fixed by `action_id`'s
 * own `ACTION_REQUESTED` and is meant to be looked up there, not re-asserted
 * as a second, independently-forgeable field (the same lesson I20 already
 * had to learn the hard way for `executed_by_principal_id`). An executor
 * identity, if ever needed, belongs to the later event that actually claims
 * one (mirroring `ACTION_REQUESTED` itself carrying no executor).
 *
 * `expires_at` is a plain, mandatory instant — never the optional
 * `no_expiry` variant `ExpiresAt` allows for delegations. A capability
 * without a bound lifetime would defeat the entire reason a bounded,
 * revocable reservation exists.
 *
 * On the envelope's own `principal_id` (`EventEnvelopeSource`/
 * `EventEnvelopeIngested`, shared structurally by every event type): for
 * the 4 existing event types with an ingestion-time check (I12/I13/I14),
 * this field is required to equal a specific payload field naming the
 * graph participant who performed the act — see EVENT_MODEL.md. Nothing
 * in `CapabilityIssuedPayload` plays that role: the act this event
 * records ("Authority resolved and granted this right") has no
 * delegation-graph participant behind it at all — not the HUMAN_ROOT, not
 * the requester, not the enforcement point named in
 * `enforcement_point_id`. `principal_id` on a `CAPABILITY_ISSUED` event is
 * therefore currently a structurally-required but semantically-unverified
 * field: it does not identify, prove, or even assert who or what issued
 * the capability. No admissibility check reads it today, and it must not
 * be read as naming a graph participant that "granted" anything.
 */
export interface CapabilityIssuedPayload {
  readonly capability_id: CapabilityId;
  readonly action_id: ActionId;
  readonly action_fingerprint: Fingerprint;
  readonly decision_sequence: SequenceNumber;
  readonly granted_chain_ref: readonly ChainLink[];
  readonly enforcement_point_id: EnforcementPointId;
  readonly expires_at: Iso8601;
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
  | Typed<"ACTION_EXECUTED", ActionExecutedPayload>
  | Typed<"CAPABILITY_ISSUED", CapabilityIssuedPayload>;

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

/**
 * Generic over its input's own narrowed `event_type` (PR4B-2 ergonomics
 * fix): calling `toDraft` on an already-narrowed `AuthorityEvent` (e.g. via
 * `isEventType`) now returns the correspondingly narrowed
 * `DraftAuthorityEvent` member, instead of unconditionally widening back to
 * the full union. Calling it on an unnarrowed `AuthorityEvent` still
 * returns the full `DraftAuthorityEvent` union exactly as before —
 * `E["event_type"]` is `AuthorityEventType` in that case, so
 * `Extract<DraftAuthorityEvent, {event_type: AuthorityEventType}>` is
 * `DraftAuthorityEvent` itself. Purely a typing precision improvement, not
 * a runtime behavior change (the function body is unchanged) and not a
 * security property of any kind.
 */
export function toDraft<E extends AuthorityEvent>(event: E): Extract<DraftAuthorityEvent, { readonly event_type: E["event_type"] }> {
  return {
    event_id: event.event_id,
    schema_version: event.schema_version,
    occurred_at: event.occurred_at,
    principal_id: event.principal_id,
    event_type: event.event_type,
    payload: event.payload,
  } as Extract<DraftAuthorityEvent, { readonly event_type: E["event_type"] }>;
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
