/**
 * Domain types for authority-graph V0.
 *
 * This module defines DATA SHAPES and pure smart constructors only — no chain
 * resolution, no ingestion logic, no decision-making. See SPEC.md for the
 * invariants these shapes are designed to make unrepresentable, and
 * EVENT_MODEL.md for the wire-level field definitions they mirror.
 */

// ---------------------------------------------------------------------------
// Branding — opaque identifiers (I11: principals and business IDs are opaque
// and must never be interchangeable at the type level, even though they are
// all strings underneath).
// ---------------------------------------------------------------------------

declare const brandTag: unique symbol;
export type Branded<Value, BrandName extends string> = Value & {
  readonly [brandTag]: BrandName;
};

function requireNonEmpty(value: string, label: string): string {
  if (value.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  return value;
}

export type PrincipalId = Branded<string, "PrincipalId">;
export const principalId = (value: string): PrincipalId =>
  requireNonEmpty(value, "PrincipalId") as PrincipalId;

export type DelegationId = Branded<string, "DelegationId">;
export const delegationId = (value: string): DelegationId =>
  requireNonEmpty(value, "DelegationId") as DelegationId;

export type ActionId = Branded<string, "ActionId">;
export const actionId = (value: string): ActionId => requireNonEmpty(value, "ActionId") as ActionId;

export type ApprovalId = Branded<string, "ApprovalId">;
export const approvalId = (value: string): ApprovalId =>
  requireNonEmpty(value, "ApprovalId") as ApprovalId;

export type EventId = Branded<string, "EventId">;
export const eventId = (value: string): EventId => requireNonEmpty(value, "EventId") as EventId;

export type RecipientId = Branded<string, "RecipientId">;
export const recipientId = (value: string): RecipientId =>
  requireNonEmpty(value, "RecipientId") as RecipientId;

/**
 * Identifies an execution capability artifact — a future engine concept, not
 * yet backed by any event type or resolution logic. Introduced now, ahead of
 * that logic, purely so nothing downstream is tempted to represent it as a
 * bare string or as a `DelegationId`: a capability is not a delegation and
 * must never be interchangeable with one at the type level (I11's existing
 * rule for opaque identifiers, applied here in advance of the concept it
 * will eventually identify). Always assigned by Authority itself, never
 * supplied by a caller — mirrors every other identifier in this module that
 * the resolver, not the source, is the sole issuer of.
 */
export type CapabilityId = Branded<string, "CapabilityId">;
export const capabilityId = (value: string): CapabilityId =>
  requireNonEmpty(value, "CapabilityId") as CapabilityId;

/**
 * Identifies an enforcement point — the actor that would present/redeem a
 * future execution capability — as a concept distinct from `PrincipalId`.
 * An enforcement point (a gateway, an orchestrator, an MCP server) is not
 * simply another kind of principal: conflating the two at the type level is
 * exactly the confusion that let an unrelated actor's claimed identity stand
 * in for an agent's own in earlier authority_chain_ref-based accounting.
 * Not yet referenced by any event payload or resolution function.
 */
export type EnforcementPointId = Branded<string, "EnforcementPointId">;
export const enforcementPointId = (value: string): EnforcementPointId =>
  requireNonEmpty(value, "EnforcementPointId") as EnforcementPointId;

/**
 * A caller-supplied retry key, kept distinct from `CapabilityId` on purpose:
 * the former is chosen by whoever calls a future issuance operation (so a
 * retry after a lost response can find the same result instead of producing
 * a second artifact); the latter is assigned by Authority alone. Merging
 * the two would let a caller-controlled value stand in for an
 * Authority-issued identity — the same category of mistake this module
 * already refuses to allow between any two of its other branded IDs.
 */
export type ClientIdempotencyKey = Branded<string, "ClientIdempotencyKey">;
export const clientIdempotencyKey = (value: string): ClientIdempotencyKey =>
  requireNonEmpty(value, "ClientIdempotencyKey") as ClientIdempotencyKey;

export type ReasonCode = Branded<string, "ReasonCode">;
export const reasonCode = (value: string): ReasonCode => requireNonEmpty(value, "ReasonCode") as ReasonCode;

export type ExecutionResultCode = Branded<string, "ExecutionResultCode">;
export const executionResultCode = (value: string): ExecutionResultCode =>
  requireNonEmpty(value, "ExecutionResultCode") as ExecutionResultCode;

/** Output of computeActionFingerprint (events.ts) only — never authored by a source. */
export type Fingerprint = Branded<string, "Fingerprint">;

export type Iso8601 = Branded<string, "Iso8601">;
export const iso8601 = (value: string): Iso8601 => {
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`Not a valid ISO 8601 timestamp: ${value}`);
  }
  return value as Iso8601;
};

export type SequenceNumber = Branded<number, "SequenceNumber">;
export const sequenceNumber = (value: number): SequenceNumber => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`SequenceNumber must be a non-negative integer, got ${value}`);
  }
  return value as SequenceNumber;
};

export type SchemaVersion = Branded<number, "SchemaVersion">;
export const schemaVersion = (value: number): SchemaVersion => value as SchemaVersion;

/**
 * V0 speaks exactly one wire schema. This is not specified in EVENT_MODEL.md
 * (see PROMPT 2 hesitations) but is required to give "schema_version inconnue"
 * a concrete meaning: any value other than this one is UNKNOWN territory for
 * the resolver, fail-closed (I1), rather than silently best-effort parsed.
 */
export const CURRENT_SCHEMA_VERSION: SchemaVersion = schemaVersion(1);

/**
 * I10 — maximum delegation chain depth, counted in delegation EDGES traversed
 * while walking from the queried agent back up to a HUMAN_ROOT, not in nodes
 * or distinct principals. A chain agentId <-d3- B <-d2- A <-d1- HUMAN_ROOT has
 * depth 3 (three edges: d1, d2, d3), regardless of how many distinct
 * principals appear along the way. See SPEC.md I10 for the worked example and
 * PROMPT 2b for why edges (not nodes) is the counted unit: it is the number
 * of SUBDELEGATION_CREATED/DELEGATION_CREATED links the resolver must walk
 * and re-validate (I5/I12) that determines resolution cost, not the number of
 * distinct identities involved.
 */
export const MAX_CHAIN_DEPTH = 32;

/**
 * EVENT_MODEL.md / SPEC.md name this constant but do not pin a value — an
 * explicit choice disclosed to the user rather than silently picked (see the
 * "under-specified" list handed back after PROMPT 4). Purely diagnostic: it
 * never enters any AUTHORIZED/DENIED/REQUIRES_APPROVAL/UNKNOWN decision, only
 * `explain()`'s LATE_OR_BACKDATED_EVENT_OBSERVED signal (src/engine/explainAction.ts).
 */
export const CLOCK_DRIFT_THRESHOLD_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Trust anchor (Blocker 1) and assurance level (I17)
// ---------------------------------------------------------------------------

export type PrincipalType = "HUMAN_ROOT" | "AGENT";

/** V0 has no signatures and no verified identity (I17). Every event asserts this. */
export type AssuranceLevel = "ASSERTED_UNVERIFIED";

// ---------------------------------------------------------------------------
// Capabilities (I9 — exact match only, no wildcard, no hierarchy)
// ---------------------------------------------------------------------------

export interface Capability {
  readonly resource: string;
  readonly action: string;
}

export function capability(resource: string, action: string): Capability {
  return { resource, action };
}

export function sameCapability(a: Capability, b: Capability): boolean {
  return a.resource === b.resource && a.action === b.action;
}

// ---------------------------------------------------------------------------
// Money and typed delegation constraints (Blocker 3 — exactly three
// constraint types, no generic Record<string, unknown>).
// ---------------------------------------------------------------------------

export interface Money {
  readonly value: number; // non-negative integer, smallest currency unit
  readonly currency: string;
}

export function money(value: number, currency: string): Money {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Money.value must be a non-negative integer, got ${value}`);
  }
  requireNonEmpty(currency, "Money.currency");
  return { value, currency };
}

/**
 * expires_at is either a concrete instant or an explicit statement of no
 * expiry. There is no third, implicit state — I1 forbids a null default.
 */
export type ExpiresAt = { readonly kind: "at"; readonly value: Iso8601 } | { readonly kind: "no_expiry" };

export function expiresAt(value: Iso8601): ExpiresAt {
  return { kind: "at", value };
}

export const noExpiry: ExpiresAt = { kind: "no_expiry" };

/**
 * The two approval thresholds (Blocker 3) are mandatory together or absent
 * together: representing "automatic_max_amount without approval_max_amount"
 * is not possible at the type level, only as a single nested optional field.
 */
export interface AmountThresholds {
  readonly automatic_max_amount: number;
  readonly approval_max_amount: number;
}

export function thresholds(automaticMaxAmount: number, approvalMaxAmount: number): AmountThresholds {
  return { automatic_max_amount: automaticMaxAmount, approval_max_amount: approvalMaxAmount };
}

/**
 * The three V0 constraint types (max_amount, total_budget, expires_at), plus
 * the paired approval thresholds. Adding a fourth constraint type means
 * editing this interface, not smuggling a new key into an open-ended map —
 * an unrecognized constraint therefore cannot be constructed at all through
 * this module (see C22 in the adversarial tests for how the resolver must
 * still treat an unrecognized constraint arriving from outside this type
 * system as UNKNOWN, not as a compile-time impossibility).
 */
export interface DelegationConstraints {
  readonly expires_at: ExpiresAt;
  readonly max_amount?: Money;
  readonly total_budget?: Money;
  readonly thresholds?: AmountThresholds;
}

// ---------------------------------------------------------------------------
// Action parameters (I15 fingerprint inputs)
// ---------------------------------------------------------------------------

/**
 * A monetary action can never appear without its amount's currency, and a
 * fingerprint can always be computed without guessing which fields are
 * "meant together" — hence a discriminated union rather than three
 * independent optional fields.
 */
export type ActionParameters =
  | { readonly kind: "monetary"; readonly amount: Money; readonly recipient?: RecipientId }
  | { readonly kind: "non_monetary"; readonly recipient?: RecipientId };

export function monetaryParameters(amount: Money, recipient?: RecipientId): ActionParameters {
  return recipient === undefined ? { kind: "monetary", amount } : { kind: "monetary", amount, recipient };
}

export function nonMonetaryParameters(recipient?: RecipientId): ActionParameters {
  return recipient === undefined ? { kind: "non_monetary" } : { kind: "non_monetary", recipient };
}

// ---------------------------------------------------------------------------
// The 4 engine outputs (SPEC.md, "Les 4 sorties du moteur") and the TWO
// operations that produce them (SPEC.md, "Les deux opérations du moteur").
//
// authorityAt is PROSPECTIVE: "would this be authorized in this state?". It
// never requires a pre-existing ACTION_REQUESTED — the engine must not be
// structurally dependent on a historical event to answer a question about
// the current state of authority.
//
// explainAction is HISTORICAL: "what happened for this action, and why?". It
// looks up the immutable ACTION_REQUESTED for a given actionId and evaluates
// authority from its fingerprint, both at the moment of any recorded
// execution and at the query's own sequence — it is a thin, additional layer
// on top of the same resolution authorityAt performs, not a separate engine.
// ---------------------------------------------------------------------------

export type AuthorityOutcome = "AUTHORIZED" | "DENIED" | "REQUIRES_APPROVAL" | "UNKNOWN";

/** Reason codes trace back to the exhaustive condition table in SPEC.md. */
export type DenialReasonCode =
  | "C5_APPROVAL_DENIED_BY_GRANTOR"
  | "C6_ACTION_FINGERPRINT_MISMATCH"
  | "C7_APPROVAL_ALREADY_CONSUMED"
  | "C8_AMOUNT_EXCEEDS_APPROVAL_CEILING"
  | "C9_TOTAL_BUDGET_EXCEEDED"
  | "C11_CAPABILITY_NOT_COVERED"
  | "C12_DELEGATION_REVOKED";

export type UnknownReasonCode =
  | "C10_INCOMPLETE_CHAIN"
  | "C15_MISSING_CAN_DELEGATE"
  | "C17_AGENT_ROOT_NO_HUMAN_ANCHOR"
  | "C18_CYCLE_DETECTED"
  | "MAX_CHAIN_DEPTH_EXCEEDED"
  | "C20_EVENT_ID_CONFLICT"
  | "C21_BUSINESS_ID_COLLISION"
  | "C22_UNKNOWN_CONSTRAINT_TYPE"
  | "C24_NO_VALID_CHAIN"
  | "C25_FUTURE_DECISION_SEQUENCE"
  | "UNKNOWN_SCHEMA_VERSION";

/**
 * The shared decision shape. Deliberately carries no reference back to any
 * specific ACTION_REQUESTED/actionId: it is the answer to "is (agentId,
 * capability, parameters) authorized at this sequence", full stop — a
 * question that makes sense whether or not any action was ever requested.
 */
export type AuthorityDecision =
  | { readonly outcome: "AUTHORIZED"; readonly chain: readonly DelegationId[]; readonly approvalId?: ApprovalId }
  | { readonly outcome: "DENIED"; readonly reasonCode: DenialReasonCode }
  | { readonly outcome: "REQUIRES_APPROVAL"; readonly viaDelegation: DelegationId }
  | { readonly outcome: "UNKNOWN"; readonly reasonCode: UnknownReasonCode };

/**
 * authorityAt's input (SPEC.md, "authorityAt — question prospective").
 *
 * - `agentId`: the principal that would hold/exercise the delegation and
 *   attempt to execute the capability — what earlier drafts of this module
 *   called `principalId`.
 * - `principalId`: the HUMAN_ROOT the caller expects to be accountable for
 *   this authority. authorityAt does not just answer "is agentId authorized
 *   by *some* human" — it answers "is agentId authorized, specifically under
 *   principalId's authority". A chain that is otherwise fully valid but
 *   rooted at a *different* HUMAN_ROOT than the one asserted here is DENIED
 *   for this query (positive proof this pairing lacks authority), not
 *   silently accepted under the wrong human and not UNKNOWN either.
 *
 * Neither field requires an ACTION_REQUESTED to exist anywhere in `events`.
 */
export interface AuthorityQuery {
  readonly agentId: PrincipalId;
  readonly principalId: PrincipalId;
  readonly capability: Capability;
  readonly parameters: ActionParameters;
}

/** explainAction's input: a pointer to one immutable, already-recorded action. */
export interface ActionExplanationQuery {
  readonly actionId: ActionId;
}

/**
 * The (causal order, trusted clock) pair an evaluation is anchored to
 * (PROMPT 3b). Both fields are supplied explicitly by the caller:
 *
 * - `atSequence` answers "which events are visible" (I4 causal order).
 * - `authorityTime` answers "is a given expires_at in the past" (I4 clock).
 *
 * Neither is ever derived from `occurred_at` (source-declared, untrustworthy
 * by construction — deriving a decisional clock from it would reintroduce
 * exactly the backdating risk I4 exists to prevent) and neither is ever read
 * from a live clock (Date.now() is forbidden throughout this pure engine).
 * `max(authority_time of visible events)` is also not a substitute for
 * `authorityTime`: time can pass with no new event at all, and a delegation
 * that has since expired must not appear valid merely because nothing has
 * been logged since before its expiry. In production the admission layer
 * supplies both fields; in tests, fixed values are injected explicitly.
 */
export interface AuthorityInstant {
  readonly atSequence: SequenceNumber;
  readonly authorityTime: Iso8601;
}

/**
 * explainAction's output (SPEC.md, "explainAction — question historique").
 * Composite by design: it can report both "was this authorized when it ran"
 * and "is it still authorized now" as two independently true facts, e.g. a
 * legitimately executed action whose single-use grant has since been
 * consumed remains AUTHORIZED at its own decision_sequence forever, even
 * though currentAuthority may read DENIED for the exact same fingerprint at
 * a later sequence.
 */
export interface ActionExplanation {
  readonly actionId: ActionId;
  readonly requestedAtSequence: SequenceNumber;
  readonly execution?: {
    readonly executedAtSequence: SequenceNumber;
    readonly decisionSequence: SequenceNumber;
    /** Authority for this action's immutable, as-requested fingerprint, resolved AT decisionSequence. */
    readonly authorityAtDecision: AuthorityDecision;
    readonly consumedApprovalId?: ApprovalId;
  };
  /** Authority for this action's immutable, as-requested fingerprint, resolved at the query's own sequence. */
  readonly currentAuthority: AuthorityDecision;
}

// ---------------------------------------------------------------------------
// Ingestion outcomes (I3 / I8 — canonical store vs. security log)
// ---------------------------------------------------------------------------

export type IngestRejectionCode =
  | "EVENT_ID_CONFLICT"
  | "BUSINESS_ID_COLLISION"
  | "UNAUTHORIZED_REVOCATION"
  | "UNAUTHORIZED_SUBDELEGATION"
  | "UNAUTHORIZED_APPROVAL_DECISION"
  | "UNKNOWN_SCHEMA_VERSION"
  // PR4B-5A — never produced by `processDraft`/ingest.ts (legacy ingestion
  // is entirely untouched): `InMemoryEventStore.append()` alone returns
  // this, strictly scoped to the one draft carrying the `explicitAuthorityTime`
  // bypass reserved for capability issuance, when that instant would
  // otherwise be silently clamped upward by the store's own hidden
  // monotonic high-water mark. See eventStore.ts.
  | "STALE_AUTHORITY_TIME";

export type IngestOutcome =
  | { readonly accepted: true; readonly sequence: SequenceNumber }
  | { readonly accepted: false; readonly reasonCode: IngestRejectionCode };

export interface SecurityLogEntry {
  readonly eventId: EventId;
  readonly payloadHash: string;
  readonly reasonCode: IngestRejectionCode;
  readonly recordedAt: Iso8601;
}
