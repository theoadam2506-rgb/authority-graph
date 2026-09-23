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
  InvokedRecordedAlignment,
  InvokedValidation,
  Iso8601,
  Money,
  PrincipalId,
  PrincipalType,
  ReasonCode,
  RecordedChainIntegrity,
  RecordedValidation,
  SequenceNumber,
} from "../domain/types.js";
import { CLOCK_DRIFT_THRESHOLD_MS } from "../domain/types.js";
import { resolveAuthority } from "./authorityAt.js";
import { isNotCausallyAfter } from "./causality.js";
import { evaluateConstraints } from "./evaluateConstraints.js";
import {
  canonicalAncestryIds,
  findDelegation,
  invokedRecordedAlignment as computeInvokedRecordedAlignment,
  recordedChainIntegrity as computeRecordedChainIntegrity,
  recordedTerminalId,
} from "./provenance.js";
import { validateChain } from "./validateChain.js";

type ActionRequestedEvent = Extract<AuthorityEvent, { readonly event_type: "ACTION_REQUESTED" }>;
type ActionExecutedEvent = Extract<AuthorityEvent, { readonly event_type: "ACTION_EXECUTED" }>;
type ApprovalRequestedEvent = Extract<AuthorityEvent, { readonly event_type: "APPROVAL_REQUESTED" }>;

function findActionRequested(actionId: ActionExplanationQuery["actionId"], events: CanonicalStore): ActionRequestedEvent | undefined {
  for (const event of events) {
    if (event.event_type === "ACTION_REQUESTED" && event.payload.action_id === actionId) {
      return event;
    }
  }
  return undefined;
}

function findApprovalRequested(approvalId: ApprovalId, events: CanonicalStore): ApprovalRequestedEvent | undefined {
  for (const event of events) {
    if (event.event_type === "APPROVAL_REQUESTED" && event.payload.approval_id === approvalId) {
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
  for (const event of events) {
    if (event.event_type !== "APPROVAL_DENIED") {
      continue;
    }
    if (event.payload.action_id !== request.payload.action_id) {
      continue;
    }
    if (event.principal_id !== grantor || event.payload.denying_principal_id !== grantor) {
      continue;
    }
    // I19: action_id must reference this request causally before the denial;
    // approval_id must reference a causally-prior APPROVAL_REQUESTED. A
    // forged direct APPROVAL_DENIED that skips one of these is ignored,
    // exactly as if it had never been emitted (mirrors the APPROVAL_GRANTED
    // fix in evaluateConstraints.ts's findGrantOutcome, PROMPT 6b finding #1).
    if (!isNotCausallyAfter(request, event.sequence)) {
      continue;
    }
    const approvalRequest = findApprovalRequested(event.payload.approval_id, events);
    if (approvalRequest === undefined || !isNotCausallyAfter(approvalRequest, event.sequence)) {
      continue;
    }
    return true;
  }
  return false;
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

/**
 * RECORDED VALIDATION (debates/provenance/QUESTION.md): would the delegation
 * actually claimed by the recorded authority_chain_ref (recordedTerminalId,
 * provenance.ts — RECORDED's own terminal, independent of what was invoked)
 * have authorized the exact, immutable requested action at the historical
 * decision point? Independent of recordedChainIntegrity/invokedRecordedAlignment:
 * a structurally EXACT, perfectly ALIGNED recorded chain can still be DENIED
 * (e.g. revoked); a MISMATCH/DIVERGENT one can still resolve to a canonical
 * ancestry that was itself AUTHORIZED.
 *
 * Anchored to `execution.payload.decision_sequence` exactly like
 * resolveActionAuthority above: `events` is filtered to what was visible at
 * that point *before* any of recordedTerminalId/validateChain/evaluateConstraints
 * run, so a revocation or a later ACTION_EXECUTED that only arrives afterward
 * can never leak backward into this historical answer. Never re-invoked with
 * the caller's own `current` instant — that would silently turn a historical
 * question into a live one.
 */
/**
 * INVOKED VALIDATION (debates/invoked-authority/QUESTION.md): would the
 * delegation specifically named by ACTION_REQUESTED.delegation_id, alone —
 * INVOKED, never RECORDED's own citation, never the root-agnostic AVAILABLE
 * search — have authorized the exact requested action at (atSequence,
 * authorityTime)? A third axis, independent of both:
 * - authorityAtDecision/currentAuthority (AVAILABLE): searches every chain
 *   the agent holds, root-agnostic, ignoring which delegation was invoked;
 * - recordedValidation (RECORDED): anchored to the execution's own claimed
 *   terminal (recordedTerminalId), which can diverge from INVOKED whenever
 *   invokedRecordedAlignment is DIVERGENT.
 *
 * Uses `request.payload.requesting_principal_id` as the evaluated agent
 * (not an executor identity) so this is meaningful even before any
 * ACTION_EXECUTED exists — see invokedAuthorityNow below. Filters `events`
 * to `atSequence` before any resolution runs, exactly like
 * resolveActionAuthority/recordedValidation, so a later event can never
 * leak backward into an answer anchored to an earlier instant.
 */
function invokedAuthority(request: ActionRequestedEvent, events: CanonicalStore, atSequence: SequenceNumber, authorityTime: Iso8601): InvokedValidation {
  const visible = events.filter((event) => event.sequence <= atSequence);
  const terminal = findDelegation(request.payload.delegation_id, visible);
  if (terminal === undefined) {
    return "UNRESOLVABLE";
  }
  // M9 (fixed): the invoked delegation existing and being structurally valid
  // is not enough — it must actually be held by the requester. Without this
  // check, a delegation granted to some other principal B would still
  // validate INVOKED authority for a request made by A, since validateChain
  // below never compares the terminal's own grantee against `agentId`
  // (that comparison is evaluateConstraints's job, downstream, and only for
  // grant-matching, not for the chain's own base holder). Same fail-closed
  // answer the prospective API gives when the agent holds no chain at all —
  // no new reason code.
  if (terminal.payload.grantee_principal_id !== request.payload.requesting_principal_id) {
    return { outcome: "UNKNOWN", reasonCode: "C24_NO_VALID_CHAIN" };
  }
  const validation = validateChain(terminal, request.payload.capability_requested, visible, undefined, authorityTime);
  if (validation.kind === "valid") {
    return evaluateConstraints(validation.chain, request.payload.capability_requested, request.payload.parameters, visible, request.payload.requesting_principal_id);
  }
  return validation.kind === "denied"
    ? { outcome: "DENIED", reasonCode: validation.reasonCode }
    : { outcome: "UNKNOWN", reasonCode: validation.reasonCode };
}

function recordedValidation(request: ActionRequestedEvent, execution: ActionExecutedEvent, events: CanonicalStore): RecordedValidation {
  const visible = events.filter((event) => event.sequence <= execution.payload.decision_sequence);
  const terminalId = recordedTerminalId(execution, visible);
  const terminal = terminalId === undefined ? undefined : findDelegation(terminalId, visible);
  if (terminal === undefined) {
    return "UNRESOLVABLE";
  }
  const authorityTime = reconstructAuthorityTime(visible, execution.payload.decision_sequence);
  const validation = validateChain(terminal, request.payload.capability_requested, visible, undefined, authorityTime);
  if (validation.kind === "valid") {
    return evaluateConstraints(validation.chain, request.payload.capability_requested, request.payload.parameters, visible, execution.payload.executed_by_principal_id);
  }
  return validation.kind === "denied"
    ? { outcome: "DENIED", reasonCode: validation.reasonCode }
    : { outcome: "UNKNOWN", reasonCode: validation.reasonCode };
}

export function explainAction(events: CanonicalStore, query: ActionExplanationQuery, current: AuthorityInstant): ActionExplanation {
  const request = findActionRequested(query.actionId, events);
  if (request === undefined) {
    return {
      actionId: query.actionId,
      requestedAtSequence: current.atSequence,
      currentAuthority: { outcome: "UNKNOWN", reasonCode: "C24_NO_VALID_CHAIN" },
      invokedAuthorityNow: "UNRESOLVABLE",
    };
  }

  const currentAuthority = resolveActionAuthority(request, events, current.atSequence, current.authorityTime);
  const invokedAuthorityNow = invokedAuthority(request, events, current.atSequence, current.authorityTime);
  const execution = findActionExecuted(query.actionId, events);

  if (execution === undefined) {
    return { actionId: query.actionId, requestedAtSequence: request.sequence, currentAuthority, invokedAuthorityNow };
  }

  const requestFingerprint = computeActionFingerprint(request.payload.capability_requested, request.payload.parameters);
  // I18: decision_sequence is self-declared by the event's emitter, exactly
  // like occurred_at (I4), and nothing at ingestion constrains it against
  // causal order. An ACTION_EXECUTED cannot cite, as its own decision point,
  // a sequence that is later than or equal to itself — that event did not
  // exist yet (or was itself only just being assigned a sequence) when this
  // execution was recorded. This is a causal impossibility, not a positive
  // proof of missing authority, so it is UNKNOWN, never DENIED.
  const hasFutureDecisionSequence = execution.payload.decision_sequence >= execution.sequence;
  const decisionAuthorityTime = hasFutureDecisionSequence ? undefined : reconstructAuthorityTime(events, execution.payload.decision_sequence);

  const authorityAtDecision: AuthorityDecision = hasFutureDecisionSequence
    ? { outcome: "UNKNOWN", reasonCode: "C25_FUTURE_DECISION_SEQUENCE" }
    : execution.payload.action_fingerprint === requestFingerprint
      ? resolveActionAuthority(request, events, execution.payload.decision_sequence, decisionAuthorityTime!)
      : { outcome: "DENIED", reasonCode: "C6_ACTION_FINGERPRINT_MISMATCH" };

  // Deliberately NOT gated on action_fingerprint matching (unlike
  // authorityAtDecision's C6 case above): INVOKED validation asks whether
  // the delegation the REQUEST itself named would have authorized the
  // REQUEST's own, immutable parameters — independent of whatever the
  // execution later claims to have run, which is exactly the question
  // recordedValidation/invokedRecordedAlignment already cover separately.
  const invokedAuthorityAtDecision: InvokedValidation = hasFutureDecisionSequence
    ? { outcome: "UNKNOWN", reasonCode: "C25_FUTURE_DECISION_SEQUENCE" }
    : invokedAuthority(request, events, execution.payload.decision_sequence, decisionAuthorityTime!);

  const consumedApprovalId = findApprovalLink(execution.payload.authority_chain_ref);

  return {
    actionId: query.actionId,
    requestedAtSequence: request.sequence,
    execution: {
      executedAtSequence: execution.sequence,
      decisionSequence: execution.payload.decision_sequence,
      authorityAtDecision,
      invokedAuthorityAtDecision,
      recordedChainIntegrity: computeRecordedChainIntegrity(execution, events),
      invokedRecordedAlignment: computeInvokedRecordedAlignment(request, execution, events),
      recordedValidation: recordedValidation(request, execution, events),
      ...(consumedApprovalId !== undefined ? { consumedApprovalId } : {}),
    },
    currentAuthority,
    invokedAuthorityNow,
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

/**
 * A structural reconstruction of a delegation's canonical root-to-terminal
 * ancestry, resolved to full link detail — independent of any
 * AUTHORIZED/DENIED/REQUIRES_APPROVAL/UNKNOWN verdict (design correction
 * made before implementation: a verdict's own `chain` field only exists on
 * the AUTHORIZED variant, so a rendering that only worked for AUTHORIZED
 * would silently show nothing for every other outcome). "unresolvable" when
 * the ancestry cannot be reconstructed at all (missing node, cycle, depth
 * exceeded) or when any link along it has no resolvable detail.
 */
export type InvokedCanonicalChain =
  | { readonly kind: "resolved"; readonly chain: readonly ChainLinkDetail[] }
  | { readonly kind: "unresolvable" };

/**
 * The AVAILABLE chain (currentAuthority's own chain, when AUTHORIZED),
 * resolved to full link detail. Three variants, not two (design correction
 * made before implementation): "none" when the current decision itself does
 * not select any chain at all (DENIED/REQUIRES_APPROVAL/UNKNOWN) — carries
 * the full decision, never a lossy synthesized string, since
 * REQUIRES_APPROVAL has no reasonCode; "unresolvable" when the decision IS
 * AUTHORIZED but a cited delegation's detail cannot be resolved from the
 * visible events — never silently dropped into a shorter, partial chain.
 */
export type AvailableAuthorityChain =
  | { readonly kind: "resolved"; readonly chain: readonly ChainLinkDetail[] }
  | { readonly kind: "none"; readonly decision: Exclude<AuthorityDecision, { readonly outcome: "AUTHORIZED" }> }
  | { readonly kind: "unresolvable"; readonly decision: Extract<AuthorityDecision, { readonly outcome: "AUTHORIZED" }> };

/** A single raw citation from a recorded execution's authority_chain_ref, in array order, duplicates preserved — independent of recordedChainIntegrity's structural judgment. */
export interface RecordedDelegationReference {
  readonly delegationId: DelegationId;
  readonly detail?: ChainLinkDetail;
}

export interface ExplanationReport extends ActionExplanation {
  readonly execution?: NonNullable<ActionExplanation["execution"]> & {
    /** Structural reconstruction of the INVOKED delegation's canonical ancestry, at decisionSequence — filtered to events visible at that instant (see M7). */
    readonly invokedCanonicalChainAtDecision: InvokedCanonicalChain;
  };
  /** AVAILABLE chain: at decisionSequence when executed, AVAILABLE now otherwise. Unchanged for compatibility — a plain array, silently shorter when a link's detail cannot be resolved. See availableChainNow for the explicit, non-lossy equivalent. */
  readonly chain: readonly ChainLinkDetail[];
  /** Structural reconstruction of the INVOKED delegation's canonical ancestry, now — filtered to events visible at current.atSequence (see M7). */
  readonly invokedCanonicalChainNow: InvokedCanonicalChain;
  /** AVAILABLE chain, now, resolved in full detail from currentAuthority and events visible at current.atSequence — never a silently empty array when currentAuthority is not AUTHORIZED (see M6/M7). */
  readonly availableChainNow: AvailableAuthorityChain;
  /** Raw authority_chain_ref citations of the executed action, only when executed. */
  readonly recordedDelegationReferences?: readonly RecordedDelegationReference[];
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
 * Structural reconstruction of `delegationId`'s canonical root-to-terminal
 * ancestry, resolved to full link detail, filtered to events visible at
 * `atSequence` BEFORE any resolution runs — same temporal discipline as
 * recordedValidation/resolveActionAuthority, and the fix for the design flaw
 * caught before implementation: an earlier draft resolved link detail
 * (specifically each link's `revocations` list) against the full,
 * unfiltered store, letting a later revocation leak backward into an
 * "at decision" view. Never depends on any AUTHORIZED/DENIED/REQUIRES_APPROVAL/UNKNOWN verdict.
 */
function buildInvokedCanonicalChain(delegationId: DelegationId, events: CanonicalStore, atSequence: SequenceNumber): InvokedCanonicalChain {
  const visible = events.filter((event) => event.sequence <= atSequence);
  const ancestry = canonicalAncestryIds(delegationId, visible);
  if (ancestry === undefined) {
    return { kind: "unresolvable" };
  }
  const details: ChainLinkDetail[] = [];
  for (const id of ancestry) {
    const detail = describeDelegation(id, visible);
    if (detail === undefined) {
      return { kind: "unresolvable" };
    }
    details.push(detail);
  }
  return { kind: "resolved", chain: details };
}

/**
 * The AVAILABLE chain, now, resolved from `currentAuthority` and events
 * visible at `atSequence` — never a bare empty array (design flaw caught
 * before implementation: an earlier draft silently filtered out any link
 * whose detail failed to resolve, indistinguishable from "not AUTHORIZED").
 */
function buildAvailableChainNow(currentAuthority: AuthorityDecision, events: CanonicalStore, atSequence: SequenceNumber): AvailableAuthorityChain {
  if (currentAuthority.outcome !== "AUTHORIZED") {
    return { kind: "none", decision: currentAuthority };
  }
  const visible = events.filter((event) => event.sequence <= atSequence);
  const details: ChainLinkDetail[] = [];
  for (const id of currentAuthority.chain) {
    const detail = describeDelegation(id, visible);
    if (detail === undefined) {
      return { kind: "unresolvable", decision: currentAuthority };
    }
    details.push(detail);
  }
  return { kind: "resolved", chain: details };
}

/**
 * "Available chain at decision"/"Available chain now" (pre-execution) render
 * from the legacy `chain` field (unchanged, for compatibility — see
 * ExplanationReport) paired with the decision that produced it, synthesized
 * at render/report-build time only: never a stored field, never changing
 * `chain`'s own type or values.
 */
export function asAvailableChainResult(decision: AuthorityDecision, resolvedChain: readonly ChainLinkDetail[]): AvailableAuthorityChain {
  if (decision.outcome !== "AUTHORIZED") {
    return { kind: "none", decision };
  }
  // `chain` (legacy, unfiltered-by-design here — see its own field doc) can
  // silently drop a link whose detail failed to resolve, shrinking the
  // array without signaling it. A mismatch against decision.chain's own
  // length is exactly that silent drop happening — never pass it off as a
  // complete "resolved" result.
  if (resolvedChain.length !== decision.chain.length) {
    return { kind: "unresolvable", decision };
  }
  return { kind: "resolved", chain: resolvedChain };
}

/**
 * M8 (extended): resolves each citation's detail against events visible at
 * `execution.sequence` — the instant the record itself was made, not
 * decision_sequence (RECORDED's own citations are read as-recorded, not
 * "at decision") and not the full store. A revocation strictly after
 * execution.sequence must not leak into a citation's detail here, same
 * discipline as the legacy `chain` field's own fix.
 */
function buildRecordedDelegationReferences(execution: ActionExecutedEvent, events: CanonicalStore): readonly RecordedDelegationReference[] {
  const visible = events.filter((event) => event.sequence <= execution.sequence);
  const refs: RecordedDelegationReference[] = [];
  for (const link of execution.payload.authority_chain_ref) {
    if (link.kind !== "delegation") {
      continue;
    }
    const detail = describeDelegation(link.delegation_id, visible);
    refs.push({ delegationId: link.delegation_id, ...(detail !== undefined ? { detail } : {}) });
  }
  return refs;
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
    // No ACTION_REQUESTED exists yet: explainAction() never returns an
    // `execution` in this branch either, so it is left out here too —
    // destructured away rather than spread, so its narrower declared shape
    // (missing invokedCanonicalChainAtDecision) can never be mistaken by the
    // type checker for a real, present ExplanationReport.execution.
    const { execution: _noExecution, ...baseWithoutExecution } = base;
    return {
      ...baseWithoutExecution,
      chain: [],
      invokedCanonicalChainNow: { kind: "unresolvable" },
      availableChainNow: buildAvailableChainNow(base.currentAuthority, events, current.atSequence),
      approvals: [],
      lateOrBackdatedEvents,
      assuranceLevel: "ASSERTED_UNVERIFIED",
    };
  }

  const decisionForChain = base.execution?.authorityAtDecision ?? base.currentAuthority;
  const chainIds = decisionForChain.outcome === "AUTHORIZED" ? decisionForChain.chain : [];
  // M8 (fixed): `chain`'s own instant is decisionSequence post-execution,
  // current.atSequence pre-execution — exactly the instant `decisionForChain`
  // above was itself resolved at. Link detail (in particular each link's
  // `revocations` list) must be filtered to that same instant, not read off
  // the full, unfiltered store: an earlier version let a revocation strictly
  // after decisionSequence leak into the "at decision" view. The only
  // permitted effect of this filtering is dropping temporally-posterior
  // detail (e.g. a later revocation) from an otherwise-identical link — the
  // delegation itself is always visible by this instant, since it was
  // already part of an AUTHORIZED decision resolved at it.
  const chainAtSequence = base.execution !== undefined ? base.execution.decisionSequence : current.atSequence;
  const visibleForChain = events.filter((event) => event.sequence <= chainAtSequence);
  const chain: ChainLinkDetail[] = [];
  for (const id of chainIds) {
    const detail = describeDelegation(id, visibleForChain);
    if (detail !== undefined) {
      chain.push(detail);
    }
  }

  const invokedCanonicalChainNow = buildInvokedCanonicalChain(request.payload.delegation_id, events, current.atSequence);
  const availableChainNow = buildAvailableChainNow(base.currentAuthority, events, current.atSequence);

  const executedEvent = findActionExecuted(query.actionId, events);
  const executionWithChain =
    base.execution === undefined || executedEvent === undefined
      ? undefined
      : {
          ...base.execution,
          invokedCanonicalChainAtDecision: buildInvokedCanonicalChain(request.payload.delegation_id, events, base.execution.decisionSequence),
        };
  const recordedDelegationReferences = executedEvent === undefined ? undefined : buildRecordedDelegationReferences(executedEvent, events);

  const { execution: _baseExecution, ...baseWithoutExecution } = base;
  return {
    ...baseWithoutExecution,
    ...(executionWithChain !== undefined ? { execution: executionWithChain } : {}),
    chain,
    invokedCanonicalChainNow,
    availableChainNow,
    ...(recordedDelegationReferences !== undefined ? { recordedDelegationReferences } : {}),
    approvals: describeApprovals(query.actionId, events),
    lateOrBackdatedEvents,
    assuranceLevel: request.assurance_level,
  };
}
