/**
 * Typed event builders for the events a HUMAN or an operator authors:
 * delegations, sub-delegations, revocations and approval decisions. They turn
 * plain, readable input into the engine's `DraftAuthorityEvent`, so that an
 * outside developer does not have to learn the branded types and payload
 * shapes of the engine.
 *
 * What they are NOT: they add no authority. The engine still decides, at
 * ingestion, whether a draft is accepted (who may delegate, revoke or approve
 * is checked there, I-numbers unchanged). A builder only refuses input that is
 * malformed, ambiguous or looks like something it is not, BEFORE it reaches the
 * engine. It never builds the events Authority writes itself (action requests,
 * tickets, redemptions, execution reports): those come out of `authorize`,
 * `redeem` and `report`.
 *
 * STRICT INPUT. Each builder takes a plain object, accepts exactly its
 * documented keys and no others, reads own data properties only (no getter, no
 * prototype trick, no array where an object belongs), and throws
 * `AuthorityInputError` with a fixed message on the first problem. Nothing is
 * defaulted silently: expiry is explicit (`null` means "never"), and the time
 * comes from the clock you inject (D34, there is no default clock).
 */
import type { DraftAuthorityEvent } from "../../../src/domain/events.js";
import {
  CURRENT_SCHEMA_VERSION,
  approvalId,
  actionId,
  capability,
  delegationId,
  eventId,
  expiresAt,
  iso8601,
  money,
  noExpiry,
  principalId,
  reasonCode,
  thresholds,
  type Capability,
  type DelegationConstraints,
  type Money,
} from "../../../src/domain/types.js";
import { randomUUID } from "node:crypto";
import { readClock, type TrustedClock } from "./clock.js";
import { AuthorityInputError } from "./types.js";

// ---------------------------------------------------------------------------
// Input shapes (what the developer writes)
// ---------------------------------------------------------------------------

/** Whole units of a currency: a non-negative safe integer and a currency code. */
export interface MoneyInput {
  readonly value: number;
  readonly currency: string;
}

export interface CapabilityInput {
  readonly resource: string;
  readonly action: string;
}

/** The constraints shared by `delegation` and `subdelegation`. All monetary values must use ONE currency (I25). */
export interface ConstraintsInput {
  /** A canonical UTC instant (`2026-01-01T00:00:00.000Z`) or `null` for an explicit "no expiry". There is no default. */
  readonly expiresAt: string | null;
  readonly maxAmount?: MoneyInput;
  readonly totalBudget?: MoneyInput;
  /** Up to `automaticMax`, an action is authorized without a human; up to `approvalMax`, a human approval is required. */
  readonly thresholds?: { readonly automaticMax: MoneyInput; readonly approvalMax: MoneyInput };
}

export interface DelegationInput extends ConstraintsInput {
  readonly delegationId: string;
  /** The human root who grants. The event is authored by this principal. */
  readonly grantor: string;
  readonly grantee: string;
  /** Exact capabilities (no wildcard, no hierarchy: I9). */
  readonly capabilities: readonly CapabilityInput[];
  /** Whether the grantee may delegate further. Explicit: there is no default. */
  readonly canDelegate: boolean;
  readonly eventId?: string;
}

export interface SubdelegationInput extends ConstraintsInput {
  readonly delegationId: string;
  readonly parentDelegationId: string;
  /** The grantee of the parent. The event is authored by this principal. */
  readonly grantor: string;
  readonly grantee: string;
  readonly capabilities: readonly CapabilityInput[];
  readonly canDelegate: boolean;
  readonly eventId?: string;
}

export interface RevocationInput {
  readonly delegationId: string;
  /** The principal who revokes. The event is authored by this principal. */
  readonly revokedBy: string;
  /** A short code, `^[A-Z0-9_]{1,64}$`: never free text. */
  readonly reasonCode: string;
  readonly eventId?: string;
}

export interface ApprovalRequestInput {
  readonly approvalId: string;
  readonly actionId: string;
  /** The principal that asks (authors the event). */
  readonly requestedBy: string;
  /** The human who is asked. */
  readonly requestedFrom: string;
  readonly reasonCode: string;
  readonly eventId?: string;
}

export interface ApprovalGrantInput {
  readonly approvalId: string;
  readonly actionId: string;
  /** The approving human (authors the event). The engine accepts it only from the grantor of the action's delegation. */
  readonly approver: string;
  readonly eventId?: string;
}

export interface ApprovalDenialInput {
  readonly approvalId: string;
  readonly actionId: string;
  readonly denier: string;
  readonly reasonCode: string;
  readonly eventId?: string;
}

export interface EventBuilders {
  delegation(input: DelegationInput): DraftAuthorityEvent;
  subdelegation(input: SubdelegationInput): DraftAuthorityEvent;
  revocation(input: RevocationInput): DraftAuthorityEvent;
  approvalRequest(input: ApprovalRequestInput): DraftAuthorityEvent;
  approvalGranted(input: ApprovalGrantInput): DraftAuthorityEvent;
  approvalDenied(input: ApprovalDenialInput): DraftAuthorityEvent;
}

export interface EventBuildersConfig {
  /** Required, like for `createAuthority`: you choose and trust the time source. */
  readonly clock: TrustedClock;
  /** Source of event ids when an input does not carry `eventId`. Defaults to random UUIDs. */
  readonly newEventId?: () => string;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const MAX_TEXT = 256;
const MAX_CAPABILITIES = 64;
const REASON_CODE = /^[A-Z0-9_]{1,64}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const fail = (message: string): never => {
  throw new AuthorityInputError(message);
};

/** A plain object with exactly the allowed keys: own enumerable data properties, no accessor, no symbol, no unusual prototype. */
function exact(value: unknown, label: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length > 0) return fail(`${label} must not have symbol keys`);
  const allowed = new Set([...required, ...optional]);
  const out: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!allowed.has(key)) return fail(`${label} has an unknown key: ${JSON.stringify(key.slice(0, 40))}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) return fail(`${label}.${key} must be a plain data property`);
    out[key] = descriptor.value;
  }
  for (const key of required) {
    if (!(key in out) || out[key] === undefined) return fail(`${label}.${key} is required`);
  }
  return out;
}

/** An opaque identifier: 1 to 256 characters, no control character, no lone surrogate, no leading or trailing space. */
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) return fail(`${label} must be a non-empty string`);
  if (value.length > MAX_TEXT) return fail(`${label} must be at most ${MAX_TEXT} characters`);
  if (CONTROL_CHARACTERS.test(value) || LONE_SURROGATE.test(value)) return fail(`${label} must not contain control characters`);
  if (value !== value.trim()) return fail(`${label} must not start or end with whitespace`);
  return value;
}

function code(value: unknown, label: string): string {
  if (typeof value !== "string" || !REASON_CODE.test(value)) return fail(`${label} must match ^[A-Z0-9_]{1,64}$ (a short code, never free text)`);
  return value;
}

function instant(value: unknown, label: string): string {
  if (typeof value !== "string" || !CANONICAL_INSTANT.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    return fail(`${label} must be a canonical UTC instant such as 2026-01-01T00:00:00.000Z`);
  }
  return value;
}

function moneyOf(value: unknown, label: string): Money {
  const raw = exact(value, label, ["value", "currency"]);
  if (typeof raw.value !== "number" || !Number.isSafeInteger(raw.value) || raw.value < 0) return fail(`${label}.value must be a non-negative safe integer (whole units)`);
  return money(raw.value, text(raw.currency, `${label}.currency`));
}

function capabilitiesOf(value: unknown): readonly Capability[] {
  if (!Array.isArray(value) || value.length === 0) return fail("capabilities must be a non-empty array");
  if (value.length > MAX_CAPABILITIES) return fail(`capabilities must hold at most ${MAX_CAPABILITIES} entries`);
  const seen = new Set<string>();
  const out: Capability[] = [];
  value.forEach((entry: unknown, index) => {
    const raw = exact(entry, `capabilities[${index}]`, ["resource", "action"]);
    const resource = text(raw.resource, `capabilities[${index}].resource`);
    const action = text(raw.action, `capabilities[${index}].action`);
    // Capability matching is exact (I9). A lone "*" would read as a wildcard to a human and match nothing special: refuse the ambiguity.
    if (resource === "*" || action === "*") fail(`capabilities[${index}] must name an exact resource and action: "*" is not a wildcard here`);
    const key = JSON.stringify([resource, action]);
    if (seen.has(key)) fail(`capabilities[${index}] is a duplicate`);
    seen.add(key);
    out.push(capability(resource, action));
  });
  return out;
}

function constraintsOf(raw: Record<string, unknown>): DelegationConstraints {
  if (!("expiresAt" in raw)) return fail("expiresAt is required: an instant, or null for an explicit \"no expiry\"");
  const expiry = raw.expiresAt === null ? noExpiry : expiresAt(iso8601(instant(raw.expiresAt, "expiresAt")));
  const maxAmount = raw.maxAmount === undefined ? undefined : moneyOf(raw.maxAmount, "maxAmount");
  const totalBudget = raw.totalBudget === undefined ? undefined : moneyOf(raw.totalBudget, "totalBudget");
  let band: ReturnType<typeof thresholds> | undefined;
  if (raw.thresholds !== undefined) {
    const t = exact(raw.thresholds, "thresholds", ["automaticMax", "approvalMax"]);
    const automatic = moneyOf(t.automaticMax, "thresholds.automaticMax");
    const approval = moneyOf(t.approvalMax, "thresholds.approvalMax");
    if (automatic.value > approval.value) fail("thresholds.automaticMax must not exceed thresholds.approvalMax");
    band = thresholds(automatic, approval);
  }
  const currencies = new Set([maxAmount, totalBudget, band?.automatic_max_amount, band?.approval_max_amount].filter((m): m is Money => m !== undefined).map((m) => m.currency));
  if (currencies.size > 1) fail("All monetary constraints must use the same currency: Authority never converts between currencies (I25)");
  return {
    expires_at: expiry,
    ...(maxAmount === undefined ? {} : { max_amount: maxAmount }),
    ...(totalBudget === undefined ? {} : { total_budget: totalBudget }),
    ...(band === undefined ? {} : { thresholds: band }),
  };
}

const CONSTRAINT_KEYS = ["expiresAt", "maxAmount", "totalBudget", "thresholds"] as const;

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

/**
 * Builders bound to your clock. Every built event carries `occurred_at` read
 * from that clock (fail closed: a clock that throws or returns a non-canonical
 * instant stops the build with `ClockError`) and the current schema version.
 * The returned drafts are plain data; pass them to `authority.record([...])`.
 */
export function createEventBuilders(config: EventBuildersConfig): EventBuilders {
  if (typeof config !== "object" || config === null || typeof config.clock?.now !== "function") {
    throw new AuthorityInputError("createEventBuilders needs { clock }, an object with now(): you choose and trust the time source");
  }
  const clock = config.clock;
  const newEventId = config.newEventId ?? (() => `evt-${randomUUID()}`);

  const envelope = (author: string, supplied: unknown) => ({
    event_id: eventId(supplied === undefined ? text(newEventId(), "newEventId()") : text(supplied, "eventId")),
    schema_version: CURRENT_SCHEMA_VERSION,
    occurred_at: readClock(clock),
    principal_id: principalId(author),
  });

  return {
    delegation(input) {
      const raw = exact(input, "delegation input", ["delegationId", "grantor", "grantee", "capabilities", "canDelegate", ...CONSTRAINT_KEYS.slice(0, 1)], ["eventId", ...CONSTRAINT_KEYS.slice(1)]);
      if (typeof raw.canDelegate !== "boolean") fail("canDelegate must be true or false (there is no default)");
      const grantor = text(raw.grantor, "grantor");
      const grantee = text(raw.grantee, "grantee");
      if (grantor === grantee) fail("grantor and grantee must differ");
      return {
        ...envelope(grantor, raw.eventId),
        event_type: "DELEGATION_CREATED",
        payload: {
          ...constraintsOf(raw),
          delegation_id: delegationId(text(raw.delegationId, "delegationId")),
          grantor_principal_id: principalId(grantor),
          grantor_type: "HUMAN_ROOT",
          grantee_principal_id: principalId(grantee),
          capabilities: capabilitiesOf(raw.capabilities),
          can_delegate: raw.canDelegate as boolean,
          parent_delegation_id: null,
        },
      };
    },

    subdelegation(input) {
      const raw = exact(input, "subdelegation input", ["delegationId", "parentDelegationId", "grantor", "grantee", "capabilities", "canDelegate", "expiresAt"], ["eventId", ...CONSTRAINT_KEYS.slice(1)]);
      if (typeof raw.canDelegate !== "boolean") fail("canDelegate must be true or false (there is no default)");
      const grantor = text(raw.grantor, "grantor");
      const grantee = text(raw.grantee, "grantee");
      if (grantor === grantee) fail("grantor and grantee must differ");
      const id = text(raw.delegationId, "delegationId");
      const parent = text(raw.parentDelegationId, "parentDelegationId");
      if (id === parent) fail("a delegation cannot be its own parent");
      return {
        ...envelope(grantor, raw.eventId),
        event_type: "SUBDELEGATION_CREATED",
        payload: {
          ...constraintsOf(raw),
          delegation_id: delegationId(id),
          parent_delegation_id: delegationId(parent),
          grantor_principal_id: principalId(grantor),
          grantee_principal_id: principalId(grantee),
          capabilities: capabilitiesOf(raw.capabilities),
          can_delegate: raw.canDelegate as boolean,
        },
      };
    },

    revocation(input) {
      const raw = exact(input, "revocation input", ["delegationId", "revokedBy", "reasonCode"], ["eventId"]);
      const revokedBy = text(raw.revokedBy, "revokedBy");
      return {
        ...envelope(revokedBy, raw.eventId),
        event_type: "DELEGATION_REVOKED",
        payload: { delegation_id: delegationId(text(raw.delegationId, "delegationId")), revoked_by_principal_id: principalId(revokedBy), reason_code: reasonCode(code(raw.reasonCode, "reasonCode")) },
      };
    },

    approvalRequest(input) {
      const raw = exact(input, "approval request input", ["approvalId", "actionId", "requestedBy", "requestedFrom", "reasonCode"], ["eventId"]);
      return {
        ...envelope(text(raw.requestedBy, "requestedBy"), raw.eventId),
        event_type: "APPROVAL_REQUESTED",
        payload: {
          approval_id: approvalId(text(raw.approvalId, "approvalId")),
          action_id: actionId(text(raw.actionId, "actionId")),
          requested_from_principal_id: principalId(text(raw.requestedFrom, "requestedFrom")),
          policy_reason_code: reasonCode(code(raw.reasonCode, "reasonCode")),
        },
      };
    },

    approvalGranted(input) {
      const raw = exact(input, "approval grant input", ["approvalId", "actionId", "approver"], ["eventId"]);
      const approver = text(raw.approver, "approver");
      return {
        ...envelope(approver, raw.eventId),
        event_type: "APPROVAL_GRANTED",
        payload: { approval_id: approvalId(text(raw.approvalId, "approvalId")), action_id: actionId(text(raw.actionId, "actionId")), approving_principal_id: principalId(approver) },
      };
    },

    approvalDenied(input) {
      const raw = exact(input, "approval denial input", ["approvalId", "actionId", "denier", "reasonCode"], ["eventId"]);
      const denier = text(raw.denier, "denier");
      return {
        ...envelope(denier, raw.eventId),
        event_type: "APPROVAL_DENIED",
        payload: {
          approval_id: approvalId(text(raw.approvalId, "approvalId")),
          action_id: actionId(text(raw.actionId, "actionId")),
          denying_principal_id: principalId(denier),
          reason_code: reasonCode(code(raw.reasonCode, "reasonCode")),
        },
      };
    },
  };
}
