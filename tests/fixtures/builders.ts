/**
 * Low-level event builders: one thin wrapper per event type around a shared
 * envelope helper. Payload objects are constructed by callers (usually
 * tests/fixtures/scenarios.ts) using the domain helpers in src/domain/types.ts
 * — these builders only attach the envelope (I4: sequence/authority_time are
 * always test-author-assigned here, since there is no ingestion pipeline yet
 * to assign them).
 */

import {
  CURRENT_SCHEMA_VERSION,
  iso8601,
  sequenceNumber,
  schemaVersion,
  type AuthorityInstant,
  type PrincipalId,
  type SchemaVersion,
} from "../../src/domain/types.js";
import type {
  ActionExecutedPayload,
  ActionRequestedPayload,
  ApprovalDeniedPayload,
  ApprovalGrantedPayload,
  ApprovalRequestedPayload,
  AuthorityEvent,
  DelegationCreatedPayload,
  DelegationRevokedPayload,
  EventEnvelopeIngested,
  SubdelegationCreatedPayload,
} from "../../src/domain/events.js";
import type { IngestionClock } from "../../src/engine/authority.js";
import { evt } from "./ids.js";

// Fixed epoch, no wall-clock reads anywhere in this file (forbidden: Date.now()).
const EPOCH_MS = Date.parse("2025-01-01T00:00:00.000Z");

/** Deterministic instant derived purely from an integer offset, never from Date.now(). */
export function timeAt(offsetSeconds: number): string {
  return new Date(EPOCH_MS + offsetSeconds * 1000).toISOString();
}

/**
 * A ready-to-use (atSequence, authorityTime) pair for authorityAt/
 * explainAction, for tests that don't care about a specific trusted-time
 * value — authorityTime simply advances in lockstep with the given sequence
 * number by default (override via the second parameter for tests that need
 * authorityTime and atSequence to move independently, e.g. the "time passes
 * with no new event" expiration tests).
 */
export function instant(sequence: number, authorityTimeOffsetSeconds?: number): AuthorityInstant {
  return {
    atSequence: sequenceNumber(sequence),
    authorityTime: iso8601(timeAt(authorityTimeOffsetSeconds ?? sequence)),
  };
}

/**
 * A minimal ingestAll clock for tests that don't care about specific trusted
 * times: authorityTime simply advances with the batch index.
 */
export const sequentialClock: IngestionClock = {
  authorityTime: (_draft, index) => iso8601(timeAt(index)),
};

export interface EnvelopeTiming {
  readonly eventId?: string;
  readonly occurredAt?: string;
  readonly authorityTime?: string;
  readonly recordedAt?: string;
  readonly schemaVersion?: number;
}

function envelope(sequence: number, principal: PrincipalId, timing?: EnvelopeTiming): EventEnvelopeIngested {
  const seq = sequenceNumber(sequence);
  const fallback = timeAt(sequence);
  const version: SchemaVersion =
    timing?.schemaVersion === undefined ? CURRENT_SCHEMA_VERSION : schemaVersion(timing.schemaVersion);
  return {
    event_id: evt(timing?.eventId ?? `evt-${sequence}`),
    schema_version: version,
    occurred_at: iso8601(timing?.occurredAt ?? fallback),
    principal_id: principal,
    sequence: seq,
    authority_time: iso8601(timing?.authorityTime ?? fallback),
    recorded_at: iso8601(timing?.recordedAt ?? fallback),
    assurance_level: "ASSERTED_UNVERIFIED",
  };
}

export function delegationCreatedEvent(
  sequence: number,
  principal: PrincipalId,
  payload: DelegationCreatedPayload,
  timing?: EnvelopeTiming,
): AuthorityEvent {
  return { ...envelope(sequence, principal, timing), event_type: "DELEGATION_CREATED", payload };
}

export function subdelegationCreatedEvent(
  sequence: number,
  principal: PrincipalId,
  payload: SubdelegationCreatedPayload,
  timing?: EnvelopeTiming,
): AuthorityEvent {
  return { ...envelope(sequence, principal, timing), event_type: "SUBDELEGATION_CREATED", payload };
}

export function delegationRevokedEvent(
  sequence: number,
  principal: PrincipalId,
  payload: DelegationRevokedPayload,
  timing?: EnvelopeTiming,
): AuthorityEvent {
  return { ...envelope(sequence, principal, timing), event_type: "DELEGATION_REVOKED", payload };
}

export function actionRequestedEvent(
  sequence: number,
  principal: PrincipalId,
  payload: ActionRequestedPayload,
  timing?: EnvelopeTiming,
): AuthorityEvent {
  return { ...envelope(sequence, principal, timing), event_type: "ACTION_REQUESTED", payload };
}

export function approvalRequestedEvent(
  sequence: number,
  principal: PrincipalId,
  payload: ApprovalRequestedPayload,
  timing?: EnvelopeTiming,
): AuthorityEvent {
  return { ...envelope(sequence, principal, timing), event_type: "APPROVAL_REQUESTED", payload };
}

export function approvalGrantedEvent(
  sequence: number,
  principal: PrincipalId,
  payload: ApprovalGrantedPayload,
  timing?: EnvelopeTiming,
): AuthorityEvent {
  return { ...envelope(sequence, principal, timing), event_type: "APPROVAL_GRANTED", payload };
}

export function approvalDeniedEvent(
  sequence: number,
  principal: PrincipalId,
  payload: ApprovalDeniedPayload,
  timing?: EnvelopeTiming,
): AuthorityEvent {
  return { ...envelope(sequence, principal, timing), event_type: "APPROVAL_DENIED", payload };
}

export function actionExecutedEvent(
  sequence: number,
  principal: PrincipalId,
  payload: ActionExecutedPayload,
  timing?: EnvelopeTiming,
): AuthorityEvent {
  return { ...envelope(sequence, principal, timing), event_type: "ACTION_EXECUTED", payload };
}
