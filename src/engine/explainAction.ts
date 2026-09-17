/**
 * explainAction — the historical operation (SPEC.md, "question historique").
 * Resolves the immutable ACTION_REQUESTED for `actionId`, then reuses the
 * exact same shared resolution authorityAt performs (`resolveAuthority`) —
 * once at the query's own (atSequence, authorityTime) instant, once at any
 * recorded execution's decision_sequence. Not a second engine.
 *
 * explainAction never uses the current wall clock, and never derives a
 * decisional clock from occurred_at (PROMPT 3b): the query's own instant is
 * supplied explicitly by the caller (`current`), exactly like authorityAt;
 * the execution's decision-point instant is *reconstructed* from the
 * canonical store's own history — the trusted authority_time already
 * recorded on every visible-at-that-point event (assigned at ingestion from
 * the trusted clock dependency, never from occurred_at) — not read live.
 *
 * Pure: no I/O, no Date.now(), no global state, no mutation of its inputs.
 */
import { computeActionFingerprint } from "../domain/events.js";
import type { AuthorityEvent, AuthorityEventType, CanonicalStore, ChainLink } from "../domain/events.js";
import type {
  ActionExplanation,
  ActionExplanationQuery,
  ActionId,
  AmountThresholds,
  ApprovalId,
  AssuranceLevel,
  AuthorityDecision,
  AuthorityInstant,
  Capability,
  DelegationId,
  EventId,
  ExpiresAt,
  Iso8601,
  Money,
  PrincipalId,
  PrincipalType,
  ReasonCode,
  SequenceNumber,
} from "../domain/types.js";
import { CLOCK_DRIFT_THRESHOLD_MS } from "../domain/types.js";
import { resolveAuthority } from "./authorityAt.js";

type ActionRequestedEvent = Extract<AuthorityEvent, { readonly event_type: "ACTION_REQUESTED" }>;
type ActionExecutedEvent = Extract<AuthorityEvent, { readonly event_type: "ACTION_EXECUTED" }>;

function findActionRequested(actionId: ActionExplanationQuery["actionId"], events: CanonicalStore): ActionRequestedEvent | undefined {
  for (const event of events) {
    if (event.event_type === "ACTION_REQUESTED" && event.payload.action_id === actionId) {
      return event;
    }
  }
  return undefined;
}

function findActionExecuted(actionId: ActionExplanationQuery["actionId"], events: CanonicalStore): ActionExecutedEvent | undefined {
  for (const event of events) {
    if (event.event_type === "ACTION_EXECUTED" && event.payload.action_id === actionId) {
      return event;
    }
  }
  return undefined;
}

function findApprovalLink(chain: readonly ChainLink[]): ApprovalId | undefined {
  for (const link of chain) {
    if (link.kind === "approval") {
      return link.approval_id;
    }
  }
  return undefined;
}

function findDelegationGrantor(delegationId: ActionRequestedEvent["payload"]["delegation_id"], events: CanonicalStore): PrincipalId | undefined {
  for (const event of events) {
    if (event.event_type === "DELEGATION_CREATED" || event.event_type === "SUBDELEGATION_CREATED") {
      if (event.payload.delegation_id === delegationId) {
        return event.payload.grantor_principal_id;
      }
    }
  }
  return undefined;
}

/**
 * I14 + "Portée d'un refus": a refusal only ever concerns the specific
 * APPROVAL_REQUESTED it targets. It is never consulted by a fresh, unrelated
 * authorityAt query (see resolveAuthority) — but explainAction, which DOES
 * have this action in hand, must be able to report that this exact action's
 * own approval flow was validly refused by the delegation's own grantor.
 */
function hasOwnValidDenial(request: ActionRequestedEvent, events: CanonicalStore): boolean {
  const grantor = findDelegationGrantor(request.payload.delegation_id, events);
  if (grantor === undefined) {
    return false;
  }
  return events.some(
    (event) =>
      event.event_type === "APPROVAL_DENIED" &&
      event.payload.action_id === request.payload.action_id &&
      event.principal_id === grantor &&
      event.payload.denying_principal_id === grantor,
  );
}

/**
 * Reconstructs the trusted clock as it stood at `atSequence`, purely from
 * already-ingested history: the authority_time of the latest event visible
 * at that point (every such value was itself assigned by Authority's trusted
 * clock dependency at ingestion — never by the source's occurred_at). This
 * is legitimate here specifically because `atSequence` is a *fixed past
 * point* being looked back on, not "now": there is no passage-of-time-without
 * -an-event concern for a moment that has already fully happened and been
 * recorded (contrast authorityAt's own current instant, which the caller
 * must always supply explicitly for exactly that reason).
 */
function reconstructAuthorityTime(events: CanonicalStore, atSequence: SequenceNumber): Iso8601 {
  let latest: { readonly ms: number; readonly iso: Iso8601 } | undefined;
  for (const event of events) {
    if (event.sequence <= atSequence) {
      const ms = Date.parse(event.authority_time);
      if (latest === undefined || ms > latest.ms) {
        latest = { ms, iso: event.authority_time };
      }
    }
  }
  // Defensively unreachable in practice: decision_sequence always refers to
  // a point with prior history (at minimum, the delegation and request that
  // made the decision possible). No live clock is substituted.
  return latest?.iso ?? ("1970-01-01T00:00:00.000Z" as Iso8601);
}

function resolveActionAuthority(request: ActionRequestedEvent, events: CanonicalStore, atSequence: SequenceNumber, authorityTime: Iso8601): AuthorityDecision {
  const visible = events.filter((event) => event.sequence <= atSequence);
  const base = resolveAuthority(
    visible,
    request.payload.requesting_principal_id,
    request.payload.capability_requested,
    request.payload.parameters,
    undefined, // explainAction accepts whichever HUMAN_ROOT actually backs the chain
    authorityTime,
  );
  if (base.outcome === "REQUIRES_APPROVAL" && hasOwnValidDenial(request, visible)) {
    return { outcome: "DENIED", reasonCode: "C5_APPROVAL_DENIED_BY_GRANTOR" };
  }
  return base;
}

export function explainAction(events: CanonicalStore, query: ActionExplanationQuery, current: AuthorityInstant): ActionExplanation {
  const request = findActionRequested(query.actionId, events);
  if (request === undefined) {
    return {
      actionId: query.actionId,
      requestedAtSequence: current.atSequence,
      currentAuthority: { outcome: "UNKNOWN", reasonCode: "C24_NO_VALID_CHAIN" },
    };
  }

  const currentAuthority = resolveActionAuthority(request, events, current.atSequence, current.authorityTime);
  const execution = findActionExecuted(query.actionId, events);

  if (execution === undefined) {
    return { actionId: query.actionId, requestedAtSequence: request.sequence, currentAuthority };
  }

  const requestFingerprint = computeActionFingerprint(request.payload.capability_requested, request.payload.parameters);
  const authorityAtDecision: AuthorityDecision =
    execution.payload.decision_sequence >= execution.sequence
      ? // I18: decision_sequence is self-declared by the event's emitter, exactly
        // like occurred_at (I4), and nothing at ingestion constrains it against
        // causal order. An ACTION_EXECUTED cannot cite, as its own decision
        // point, a sequence that is later than or equal to itself — that event
        // did not exist yet (or was itself only just being assigned a sequence)
        // when this execution was recorded. This is a causal impossibility, not
        // a positive proof of missing authority, so it is UNKNOWN, never DENIED.
        { outcome: "UNKNOWN", reasonCode: "C25_FUTURE_DECISION_SEQUENCE" }
      : execution.payload.action_fingerprint === requestFingerprint
        ? resolveActionAuthority(
            request,
            events,
            execution.payload.decision_sequence,
            reconstructAuthorityTime(events, execution.payload.decision_sequence),
          )
        : { outcome: "DENIED", reasonCode: "C6_ACTION_FINGERPRINT_MISMATCH" };

  const consumedApprovalId = findApprovalLink(execution.payload.authority_chain_ref);

  return {
    actionId: query.actionId,
    requestedAtSequence: request.sequence,
    execution: {
      executedAtSequence: execution.sequence,
      decisionSequence: execution.payload.decision_sequence,
      authorityAtDecision,
      ...(consumedApprovalId !== undefined ? { consumedApprovalId } : {}),
    },
    currentAuthority,
  };
}

// ---------------------------------------------------------------------------
// explain() — formatted output (PROMPT 4, points 1/4/5). Everything below
// calls explainAction()/resolveAuthority indirectly through it and performs
// NO authority computation of its own: it only looks up and renders events
// that the decision already reached above points at (a chain's delegation
// ids, an action's approval ids). If reproducing a decision ever required
// re-deriving AUTHORIZED/DENIED/REQUIRES_APPROVAL/UNKNOWN here, that would be
// exactly the mistake PROMPT 4 point 4 warns against — stop and say so rather
// than doing it.
//
// I17 (assurance-level honesty) shapes every sentence a caller renders from
// this data: "the log contains an event asserting that X granted Y", never
// "X proved" or "X is authorized to" as a bare fact — V0 has no signatures
// and no verified identity.
// ---------------------------------------------------------------------------

export interface ChainLinkDetail {
  readonly delegationId: DelegationId;
  readonly grantorPrincipalId: PrincipalId;
  readonly grantorType?: PrincipalType; // only DELEGATION_CREATED (the root link) states this explicitly
  readonly granteePrincipalId: PrincipalId;
  readonly capabilities: readonly Capability[];
  readonly canDelegate: boolean;
  readonly expiresAt: ExpiresAt;
  readonly maxAmount?: Money;
  readonly totalBudget?: Money;
  readonly thresholds?: AmountThresholds;
  readonly grantedAtSequence: SequenceNumber;
  /** Every DELEGATION_REVOKED event the log contains against this delegation, whether or not it was itself authorized (I13) — that judgment already lives in the decision above, not here. */
  readonly revocations: readonly {
    readonly bySequence: SequenceNumber;
    readonly byPrincipalId: PrincipalId;
    readonly reasonCode: ReasonCode;
  }[];
}

export interface ApprovalDetail {
  readonly approvalId: ApprovalId;
  readonly requestedAtSequence: SequenceNumber;
  readonly requestedFromPrincipalId: PrincipalId;
  readonly decision?: {
    readonly outcome: "GRANTED" | "DENIED";
    readonly atSequence: SequenceNumber;
    readonly byPrincipalId: PrincipalId;
    readonly reasonCode?: ReasonCode; // APPROVAL_DENIED only
  };
}

export interface LateOrBackdatedObservation {
  readonly eventId: EventId;
  readonly eventType: AuthorityEventType;
  readonly occurredAt: Iso8601;
  readonly authorityTime: Iso8601;
  readonly driftMs: number;
}

export interface ExplanationReport extends ActionExplanation {
  readonly chain: readonly ChainLinkDetail[];
  readonly approvals: readonly ApprovalDetail[];
  readonly lateOrBackdatedEvents: readonly LateOrBackdatedObservation[];
  readonly assuranceLevel: AssuranceLevel;
}

function describeDelegation(delegationId: DelegationId, events: CanonicalStore): ChainLinkDetail | undefined {
  for (const event of events) {
    if (event.event_type !== "DELEGATION_CREATED" && event.event_type !== "SUBDELEGATION_CREATED") {
      continue;
    }
    if (event.payload.delegation_id !== delegationId) {
      continue;
    }
    const revocations = events
      .filter((e): e is Extract<AuthorityEvent, { readonly event_type: "DELEGATION_REVOKED" }> => e.event_type === "DELEGATION_REVOKED" && e.payload.delegation_id === delegationId)
      .map((e) => ({ bySequence: e.sequence, byPrincipalId: e.payload.revoked_by_principal_id, reasonCode: e.payload.reason_code }));
    return {
      delegationId,
      grantorPrincipalId: event.payload.grantor_principal_id,
      ...(event.event_type === "DELEGATION_CREATED" ? { grantorType: event.payload.grantor_type } : {}),
      granteePrincipalId: event.payload.grantee_principal_id,
      capabilities: event.payload.capabilities,
      canDelegate: event.payload.can_delegate,
      expiresAt: event.payload.expires_at,
      ...(event.payload.max_amount !== undefined ? { maxAmount: event.payload.max_amount } : {}),
      ...(event.payload.total_budget !== undefined ? { totalBudget: event.payload.total_budget } : {}),
      ...(event.payload.thresholds !== undefined ? { thresholds: event.payload.thresholds } : {}),
      grantedAtSequence: event.sequence,
      revocations,
    };
  }
  return undefined;
}

function describeApprovals(actionId: ActionId, events: CanonicalStore): readonly ApprovalDetail[] {
  const details: ApprovalDetail[] = [];
  for (const event of events) {
    if (event.event_type !== "APPROVAL_REQUESTED" || event.payload.action_id !== actionId) {
      continue;
    }
    const grant = events.find(
      (e): e is Extract<AuthorityEvent, { readonly event_type: "APPROVAL_GRANTED" }> =>
        e.event_type === "APPROVAL_GRANTED" && e.payload.approval_id === event.payload.approval_id,
    );
    const denial = events.find(
      (e): e is Extract<AuthorityEvent, { readonly event_type: "APPROVAL_DENIED" }> =>
        e.event_type === "APPROVAL_DENIED" && e.payload.approval_id === event.payload.approval_id,
    );
    const decision: ApprovalDetail["decision"] =
      grant !== undefined
        ? { outcome: "GRANTED", atSequence: grant.sequence, byPrincipalId: grant.payload.approving_principal_id }
        : denial !== undefined
          ? { outcome: "DENIED", atSequence: denial.sequence, byPrincipalId: denial.payload.denying_principal_id, reasonCode: denial.payload.reason_code }
          : undefined;
    details.push({
      approvalId: event.payload.approval_id,
      requestedAtSequence: event.sequence,
      requestedFromPrincipalId: event.payload.requested_from_principal_id,
      ...(decision !== undefined ? { decision } : {}),
    });
  }
  return details;
}

/**
 * SPEC.md / EVENT_MODEL.md, "LATE_OR_BACKDATED_EVENT_OBSERVED": a purely
 * diagnostic scan comparing each event's trusted `authority_time` against its
 * untrusted, source-declared `occurred_at`. Never consulted by
 * resolveAuthority, never affects AUTHORIZED/DENIED/REQUIRES_APPROVAL/UNKNOWN
 * — only `explain()`'s rendered output. `thresholdMs` defaults to the
 * exported `CLOCK_DRIFT_THRESHOLD_MS` but is accepted as a parameter (rather
 * than read as a closed-over constant) specifically so a caller — or a test
 * asserting this diagnostic can never move a decision — can vary it without
 * touching any decision path at all.
 */
export function findLateOrBackdatedEvents(
  events: CanonicalStore,
  thresholdMs: number = CLOCK_DRIFT_THRESHOLD_MS,
): readonly LateOrBackdatedObservation[] {
  const observations: LateOrBackdatedObservation[] = [];
  for (const event of events) {
    const driftMs = Math.abs(Date.parse(event.authority_time) - Date.parse(event.occurred_at));
    if (driftMs > thresholdMs) {
      observations.push({
        eventId: event.event_id,
        eventType: event.event_type,
        occurredAt: event.occurred_at,
        authorityTime: event.authority_time,
        driftMs,
      });
    }
  }
  return observations;
}

/**
 * The formatted, human/CLI-facing view of an action's history. Calls
 * `explainAction()` for every actual decision and only adds rendering: chain
 * details, approval history, revocations, clock-drift diagnostics, and the
 * assurance level. See the section docstring above for the "no authority
 * computation here" boundary.
 */
export function explain(
  events: CanonicalStore,
  query: ActionExplanationQuery,
  current: AuthorityInstant,
  options?: { readonly clockDriftThresholdMs?: number },
): ExplanationReport {
  const base = explainAction(events, query, current);
  const lateOrBackdatedEvents = findLateOrBackdatedEvents(events, options?.clockDriftThresholdMs);

  const request = findActionRequested(query.actionId, events);
  if (request === undefined) {
    return { ...base, chain: [], approvals: [], lateOrBackdatedEvents, assuranceLevel: "ASSERTED_UNVERIFIED" };
  }

  const decisionForChain = base.execution?.authorityAtDecision ?? base.currentAuthority;
  const chainIds = decisionForChain.outcome === "AUTHORIZED" ? decisionForChain.chain : [];
  const chain: ChainLinkDetail[] = [];
  for (const id of chainIds) {
    const detail = describeDelegation(id, events);
    if (detail !== undefined) {
      chain.push(detail);
    }
  }

  return {
    ...base,
    chain,
    approvals: describeApprovals(query.actionId, events),
    lateOrBackdatedEvents,
    assuranceLevel: request.assurance_level,
  };
}
