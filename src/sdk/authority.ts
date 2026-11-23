/**
 * Authority SDK: authorize -> redeem -> (effect) -> report, in process.
 *
 * It orchestrates the EXISTING engine, stores and transactions; it adds no
 * authority logic and changes no event format. What it adds is ordering and
 * failure handling:
 *
 *  - FAIL CLOSED. Only a successful redemption lets `guard` start the effect.
 *    A thrown error, an unavailable store, a bad clock or an unknown outcome
 *    all end with the effect NOT started.
 *  - ONE TICKET PER ACTION through this SDK. `authorize` always uses the same
 *    idempotency key for an action (`sdk-authorize.<actionId>`), so a retry
 *    returns the same ticket instead of issuing a second one. The engine
 *    itself does not forbid several tickets for one action (see the design
 *    notes in the pull request); this is why callers must not issue tickets
 *    around the SDK for the same action.
 *  - REFUSALS ARE NOT CACHED. The engine records a refused issuance under its
 *    idempotency key and replays it, even after an approval was granted. The
 *    SDK therefore evaluates the action first (read-only) and calls the
 *    issuance transaction only when the action is currently authorized.
 *
 * What this does NOT guarantee: that the external effect happens at most once
 * (only the target can, which is why `guard` passes `idempotencyKey` to the
 * effect); that identity is genuine (it is asserted by the caller); or that
 * the clock is honest (it is injected).
 */
import { randomUUID } from "node:crypto";
import { argumentsDigest } from "../domain/canonicalJson.js";
import { computeActionFingerprint, type CanonicalStore, type CapabilityIssuedPayload, type ChainLink, type DraftAuthorityEvent } from "../domain/events.js";
import {
  CURRENT_SCHEMA_VERSION,
  actionId as toActionId,
  capability as toCapability,
  capabilityId as toCapabilityId,
  clientIdempotencyKey,
  delegationId as toDelegationId,
  enforcementPointId as toEnforcementPointId,
  eventId,
  executionResultCode,
  iso8601,
  money,
  monetaryParameters,
  nonMonetaryParameters,
  principalId as toPrincipalId,
  recipientId,
  sequenceNumber,
  type ActionId,
  type ActionParameters,
  type AuthorityDecision,
  type Capability,
  type DelegationId,
  type Iso8601,
  type PrincipalId,
} from "../domain/types.js";
import { selectInvokedGrant } from "../engine/grantValidation.js";
import { validateRedemptionEvent } from "../engine/redeemCapability.js";
import { RedemptionSchemaError } from "../storage/postgresCapabilityRedemptionTransaction.js";
import type { Backend, BackendParts } from "./backend.js";
import { readClock, type TrustedClock } from "./clock.js";
import {
  AuthorityConfigError,
  AuthorityInputError,
  type AuthorizeResult,
  type EffectContext,
  type GuardResult,
  type RecordResult,
  type RedeemResult,
  type ReportResult,
  type Ticket,
  type ToolCall,
} from "./types.js";

export interface AuthorityConfig {
  readonly backend: Backend;
  /** Required. There is no default clock (D34). */
  readonly clock: TrustedClock;
  /** Names this enforcement point; a ticket can only be redeemed by the enforcement point it was issued for. */
  readonly enforcementPointId: string;
  /** Ticket lifetime. Default 10 minutes; between 1 second and 24 hours. */
  readonly capabilityTtlMs?: number;
  /** Source of ticket identifiers. Default: `cap-<random UUID>`. */
  readonly newId?: () => string;
}

export interface Authority {
  /** Records the call, evaluates it against the log and, if authorized, issues a single-use ticket. */
  authorize(call: ToolCall): Promise<AuthorizeResult>;
  /** Consumes the ticket immediately before the effect, re-checking authority at that instant. */
  redeem(ticket: Ticket, observed: ToolCall): Promise<RedeemResult>;
  /** Records the outcome (`ACTION_EXECUTED`) of a redeemed ticket. An assertion by the enforcement point, not proof. */
  report(ticket: Ticket, outcome: { readonly resultCode: string }): Promise<ReportResult>;
  /** authorize, redeem, run `effect` exactly when redemption succeeded, then report. Never retries the effect. */
  guard<T>(call: ToolCall, effect: (context: EffectContext) => Promise<T>): Promise<GuardResult<T>>;
  /** Appends events (delegations, approvals, revocations...) through the engine's ingestion rules. */
  record(drafts: readonly DraftAuthorityEvent[]): Promise<RecordResult>;
  /** Read-only view of the canonical journal. Throws if the store cannot be read. */
  events(): Promise<CanonicalStore>;
}

interface NormalizedCall {
  readonly actionId: ActionId;
  readonly agent: PrincipalId;
  readonly delegation: DelegationId;
  readonly capability: Capability;
  readonly parameters: ActionParameters;
}

const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 86_400_000;
const DEFAULT_TTL_MS = 600_000;

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AuthorityInputError(`${label} must be a non-empty string`);
  }
  return value;
}

function normalize(call: ToolCall): NormalizedCall {
  if (typeof call !== "object" || call === null) {
    throw new AuthorityInputError("The tool call must be an object");
  }
  const capability = typeof call.capability === "object" && call.capability !== null ? call.capability : undefined;
  if (capability === undefined) {
    throw new AuthorityInputError("capability must be { resource, action }");
  }
  try {
    const digest = argumentsDigest(call.args === undefined ? null : call.args);
    const recipient = call.recipient === undefined ? undefined : recipientId(requireText(call.recipient, "recipient"));
    const parameters =
      call.amount === undefined
        ? nonMonetaryParameters(recipient, digest)
        : monetaryParameters(money(call.amount.value, requireText(call.amount.currency, "amount.currency")), recipient, digest);
    return {
      actionId: toActionId(requireText(call.actionId, "actionId")),
      agent: toPrincipalId(requireText(call.agentId, "agentId")),
      delegation: toDelegationId(requireText(call.delegationId, "delegationId")),
      capability: toCapability(requireText(capability.resource, "capability.resource"), requireText(capability.action, "capability.action")),
      parameters,
    };
  } catch (cause) {
    if (cause instanceof AuthorityInputError) throw cause;
    throw new AuthorityInputError(cause instanceof Error ? cause.message : String(cause));
  }
}

function maxSequence(store: CanonicalStore): number {
  let max = 0;
  for (const event of store) {
    if (Number(event.sequence) > max) max = Number(event.sequence);
  }
  return max;
}

function findRequest(store: CanonicalStore, id: ActionId) {
  for (const event of store) {
    if (event.event_type === "ACTION_REQUESTED" && event.payload.action_id === id) return event;
  }
  return undefined;
}

/** Maps an engine refusal to a result. Anything unexpected is a denial: never an authorization. */
function refusal(reason: string, decision: AuthorityDecision | undefined): AuthorizeResult {
  if (decision !== undefined) {
    switch (decision.outcome) {
      case "REQUIRES_APPROVAL":
        return { status: "REQUIRES_APPROVAL", viaDelegation: decision.viaDelegation };
      case "DENIED":
        return { status: "DENIED", reason: decision.reasonCode };
      case "UNKNOWN":
        return { status: "UNKNOWN", reason: decision.reasonCode };
      default:
        return { status: "DENIED", reason: "UNEXPECTED_DECISION" };
    }
  }
  return { status: "DENIED", reason };
}

const RESULT_CODE = /^[A-Z0-9_]{1,64}$/;

const linkKey = (link: ChainLink): string => (link.kind === "delegation" ? `delegation:${link.delegation_id}` : `approval:${link.approval_id}`);

/** The first field of the caller's ticket that disagrees with the journal, if any. */
function firstMismatch(ticket: Ticket, issued: CapabilityIssuedPayload, requester: PrincipalId): string | undefined {
  if (ticket.actionId !== issued.action_id) return "actionId";
  if (ticket.agentId !== requester) return "agentId";
  if (ticket.fingerprint !== issued.action_fingerprint) return "fingerprint";
  if (ticket.decisionSequence !== Number(issued.decision_sequence)) return "decisionSequence";
  if (ticket.enforcementPointId !== issued.enforcement_point_id) return "enforcementPointId";
  const claimed = Array.isArray(ticket.grantedChain) ? ticket.grantedChain.map(linkKey) : undefined;
  const actual = issued.granted_chain_ref.map(linkKey);
  if (claimed === undefined || claimed.length !== actual.length || claimed.some((k, i) => k !== actual[i])) return "grantedChain";
  return undefined;
}

function validateTicket(ticket: Ticket): void {
  if (typeof ticket !== "object" || ticket === null) {
    throw new AuthorityInputError("The ticket must be the value returned by authorize()");
  }
  for (const key of ["capabilityId", "actionId", "agentId", "enforcementPointId", "fingerprint"] as const) {
    requireText(ticket[key], `ticket.${key}`);
  }
}

export function createAuthority(config: AuthorityConfig): Authority {
  if (typeof config !== "object" || config === null) throw new AuthorityConfigError("A configuration object is required");
  if (typeof config.backend?.build !== "function") throw new AuthorityConfigError("backend is required: memoryBackend() or postgresBackend(pool)");
  if (typeof config.clock?.now !== "function") throw new AuthorityConfigError("clock is required and has no default: pass { now } or systemClock explicitly");
  if (typeof config.enforcementPointId !== "string" || config.enforcementPointId.trim().length === 0) {
    throw new AuthorityConfigError("enforcementPointId must be a non-empty string");
  }
  const ttl = config.capabilityTtlMs ?? DEFAULT_TTL_MS;
  if (!Number.isInteger(ttl) || ttl < MIN_TTL_MS || ttl > MAX_TTL_MS) {
    throw new AuthorityConfigError(`capabilityTtlMs must be an integer between ${MIN_TTL_MS} and ${MAX_TTL_MS}`);
  }

  const clock = config.clock;
  const newId = config.newId ?? (() => `cap-${randomUUID()}`);
  const enforcementPoint = toEnforcementPointId(config.enforcementPointId);
  const parts: BackendParts = config.backend.build({ authorityTime: () => readClock(clock) });
  const { store, issuance, redemption } = parts;

  const dependencies = {
    nextCapabilityId: () => toCapabilityId(newId()),
    expiresAt: (at: Iso8601) => iso8601(new Date(Date.parse(at) + ttl).toISOString()),
  };

  /** Appends the ACTION_REQUESTED once; an identical retry (or a concurrent identical call) is accepted, a different call under the same actionId is refused. */
  async function ensureRequested(call: NormalizedCall, at: Iso8601): Promise<AuthorizeResult | undefined> {
    const matches = (existing: NonNullable<ReturnType<typeof findRequest>>): boolean =>
      existing.payload.requesting_principal_id === call.agent &&
      existing.payload.delegation_id === call.delegation &&
      computeActionFingerprint(existing.payload.capability_requested, existing.payload.parameters) === computeActionFingerprint(call.capability, call.parameters);

    const existing = findRequest(await store.getEvents(), call.actionId);
    if (existing !== undefined) {
      return matches(existing) ? undefined : { status: "DENIED", reason: "ACTION_ID_REUSED_WITH_DIFFERENT_CALL" };
    }
    const draft: DraftAuthorityEvent = {
      event_id: eventId(`sdk-request.${call.actionId}`),
      schema_version: CURRENT_SCHEMA_VERSION,
      occurred_at: at,
      principal_id: call.agent,
      event_type: "ACTION_REQUESTED",
      payload: {
        action_id: call.actionId,
        requesting_principal_id: call.agent,
        delegation_id: call.delegation,
        capability_requested: call.capability,
        parameters: call.parameters,
      },
    };
    const appended = await store.append([draft]);
    const outcome = appended.outcomes[0];
    if (outcome !== undefined && outcome.accepted) return undefined;
    const raced = findRequest(await store.getEvents(), call.actionId);
    if (raced !== undefined && matches(raced)) return undefined;
    return { status: "DENIED", reason: `ACTION_REQUEST_REJECTED:${outcome !== undefined && !outcome.accepted ? outcome.reasonCode : "NO_OUTCOME"}` };
  }

  async function authorize(call: ToolCall): Promise<AuthorizeResult> {
    const normalized = normalize(call);
    try {
      const requested = await ensureRequested(normalized, readClock(clock));
      if (requested !== undefined) return requested;

      // Read-only evaluation first: a refusal must never be recorded under the idempotency key.
      const at = readClock(clock);
      const snapshot = await store.getEvents();
      const grant = selectInvokedGrant(snapshot, normalized.actionId, sequenceNumber(maxSequence(snapshot)), at);
      if (!grant.ok) return refusal(grant.reason, grant.decision);

      const outcome = await issuance.issue(
        { principalId: normalized.agent },
        clientIdempotencyKey(`sdk-authorize.${normalized.actionId}`),
        { action_id: normalized.actionId, enforcement_point_id: enforcementPoint },
        dependencies,
        at,
      );
      if (outcome.outcome === "IDEMPOTENCY_CONFLICT") return { status: "DENIED", reason: "IDEMPOTENCY_CONFLICT" };
      const result = outcome.result;
      if (!result.ok) return refusal(result.reason, "decision" in result ? result.decision : undefined);
      const issued = result.capability;
      return {
        status: "AUTHORIZED",
        ticket: {
          capabilityId: issued.capability_id,
          actionId: issued.action_id,
          agentId: normalized.agent,
          enforcementPointId: issued.enforcement_point_id,
          expiresAt: issued.expires_at,
          fingerprint: issued.action_fingerprint,
          decisionSequence: Number(issued.decision_sequence),
          grantedChain: issued.granted_chain_ref,
        },
      };
    } catch (cause) {
      return { status: "UNAVAILABLE", cause };
    }
  }

  async function redeem(ticket: Ticket, observed: ToolCall): Promise<RedeemResult> {
    validateTicket(ticket);
    const normalized = normalize(observed);
    if (normalized.actionId !== ticket.actionId) return { status: "REFUSED", reason: "ACTION_ID_MISMATCH", ticketConsumed: false };
    let at: Iso8601;
    try {
      at = readClock(clock);
    } catch (cause) {
      return { status: "UNAVAILABLE", cause };
    }
    try {
      const result = await redemption.redeem(
        { principalId: normalized.agent },
        {
          capability_id: toCapabilityId(ticket.capabilityId),
          enforcement_point_id: enforcementPoint,
          observed_capability: normalized.capability,
          observed_parameters: normalized.parameters,
        },
        at,
      );
      if (result.ok) {
        return { status: "REDEEMED", capabilityId: result.redemption.capability_id, decisionSequence: Number(result.redemption.decision_sequence) };
      }
      return { status: "REFUSED", reason: result.reason, ticketConsumed: result.detail?.ticketConsumed === true };
    } catch (cause) {
      // The schema check runs before anything is written: nothing can have been consumed.
      if (cause instanceof RedemptionSchemaError) return { status: "UNAVAILABLE", cause };
      return { status: "UNKNOWN_OUTCOME", cause };
    }
  }

  /**
   * The ticket the caller hands in is a plain object and is never trusted: the
   * ACTION_EXECUTED is built from what the JOURNAL says about this capability
   * (the issued grant, the request, the redemption), and the caller's ticket
   * must agree with all of it. A forged or altered ticket records nothing.
   */
  async function report(ticket: Ticket, outcome: { readonly resultCode: string }): Promise<ReportResult> {
    validateTicket(ticket);
    const code = requireText(outcome?.resultCode, "resultCode");
    if (!RESULT_CODE.test(code)) {
      throw new AuthorityInputError("resultCode must match ^[A-Z0-9_]{1,64}$ (a short code, never free text or data)");
    }
    try {
      const snapshot = await store.getEvents();
      let issued: Extract<CanonicalStore[number], { readonly event_type: "CAPABILITY_ISSUED" }> | undefined;
      let redeemed: Extract<CanonicalStore[number], { readonly event_type: "CAPABILITY_REDEEMED" }> | undefined;
      for (const event of snapshot) {
        if (event.event_type === "CAPABILITY_ISSUED" && event.payload.capability_id === ticket.capabilityId) issued = event;
        if (event.event_type === "CAPABILITY_REDEEMED" && event.payload.capability_id === ticket.capabilityId && redeemed === undefined) redeemed = event;
      }
      if (issued === undefined) return { status: "REJECTED", reason: "UNKNOWN_TICKET" };
      if (redeemed === undefined) return { status: "REJECTED", reason: "TICKET_NOT_REDEEMED" };
      const request = findRequest(snapshot, issued.payload.action_id);
      if (request === undefined) return { status: "REJECTED", reason: "ACTION_NOT_FOUND" };

      const mismatch = firstMismatch(ticket, issued.payload, request.payload.requesting_principal_id);
      if (mismatch !== undefined) return { status: "REJECTED", reason: `TICKET_DOES_NOT_MATCH_JOURNAL:${mismatch}` };
      if (redeemed.payload.enforcement_point_id !== enforcementPoint) return { status: "REJECTED", reason: "WRONG_ENFORCEMENT_POINT" };
      const valid = validateRedemptionEvent(snapshot, redeemed);
      if (!valid.ok) return { status: "REJECTED", reason: `REDEMPTION_NOT_VALID:${valid.reason}` };

      const isReported = (events: CanonicalStore) => events.some((e) => e.event_type === "ACTION_EXECUTED" && e.payload.action_id === issued.payload.action_id);
      if (isReported(snapshot)) return { status: "ALREADY_REPORTED" };
      const draft: DraftAuthorityEvent = {
        event_id: eventId(`sdk-executed.${issued.payload.action_id}`),
        schema_version: CURRENT_SCHEMA_VERSION,
        occurred_at: readClock(clock),
        principal_id: request.payload.requesting_principal_id,
        event_type: "ACTION_EXECUTED",
        payload: {
          action_id: issued.payload.action_id,
          executed_by_principal_id: request.payload.requesting_principal_id,
          action_fingerprint: issued.payload.action_fingerprint,
          decision_sequence: issued.payload.decision_sequence,
          authority_chain_ref: issued.payload.granted_chain_ref,
          execution_result: executionResultCode(code),
        },
      };
      const appended = await store.append([draft]);
      const result = appended.outcomes[0];
      if (result !== undefined && result.accepted) return { status: "REPORTED", sequence: Number(result.sequence) };
      if (isReported(await store.getEvents())) return { status: "ALREADY_REPORTED" };
      return { status: "REJECTED", reason: result !== undefined && !result.accepted ? result.reasonCode : "NO_OUTCOME" };
    } catch (cause) {
      return { status: "UNAVAILABLE", cause };
    }
  }

  async function guard<T>(call: ToolCall, effect: (context: EffectContext) => Promise<T>): Promise<GuardResult<T>> {
    if (typeof effect !== "function") throw new AuthorityInputError("effect must be a function");
    const authorized = await authorize(call);
    if (authorized.status !== "AUTHORIZED") return { status: "BLOCKED", stage: "authorize", result: authorized };
    const ticket = authorized.ticket;
    const redeemed = await redeem(ticket, call);
    if (redeemed.status !== "REDEEMED") return { status: "BLOCKED", stage: "redeem", result: redeemed };

    // From here the ticket is consumed. The effect is started once and never retried.
    let value: T;
    try {
      value = await effect({ idempotencyKey: ticket.capabilityId, ticket });
    } catch (error) {
      return { status: "EFFECT_FAILED", error, ticketConsumed: true, report: await report(ticket, { resultCode: "EFFECT_FAILED" }) };
    }
    return { status: "EXECUTED", value, report: await report(ticket, { resultCode: "EXECUTED" }) };
  }

  async function record(drafts: readonly DraftAuthorityEvent[]): Promise<RecordResult> {
    try {
      const appended = await store.append(drafts);
      return {
        status: "RECORDED",
        outcomes: appended.outcomes.map((o) => (o.accepted ? { accepted: true, detail: `sequence:${Number(o.sequence)}` } : { accepted: false, detail: o.reasonCode })),
      };
    } catch (cause) {
      return { status: "UNAVAILABLE", cause };
    }
  }

  return { authorize, redeem, report, guard, record, events: () => store.getEvents() };
}
