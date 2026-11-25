/**
 * Public types of the SDK. Decisions are RESULTS, never exceptions: a caller
 * that forgets to handle a case cannot accidentally treat a refusal as a
 * success, because every non-success status is a distinct member of a union.
 * Exceptions are reserved for programmer errors (malformed configuration or
 * input), which stop the call before any effect can run.
 *
 * NO PUBLIC RESULT CONTAINS A RAW ERROR. A result is plain, JSON-safe data made
 * of statuses, fixed codes and ids that Authority itself chose, so it can be
 * logged, serialised or handed to an agent as it is. The raw error (which can
 * carry a host name, a user, a connection URL, a path) goes only to the
 * operator, through `AuthorityConfig.onDiagnostic`, correlated by `diagnosticId`.
 */
import type { ChainLink } from "../../../src/domain/events.js";
import type { RedeemCapabilityRejectionReason } from "../../../src/engine/redeemCapability.js";

/** One tool call an agent wants to perform. Identity fields are ASSERTED by the caller: Authority does not verify identity. */
export interface ToolCall {
  /** Unique per action. Reusing it with a different call is refused. */
  readonly actionId: string;
  /** The (already authenticated, by you) principal that makes the call. */
  readonly agentId: string;
  /** The delegation the agent invokes. */
  readonly delegationId: string;
  readonly capability: { readonly resource: string; readonly action: string };
  /** Whole units of the currency (a non-negative safe integer). Omit for a non-monetary action. */
  readonly amount?: { readonly value: number; readonly currency: string };
  readonly recipient?: string;
  /** The tool arguments. Canonicalised (RFC 8785) and digested: any change makes redemption fail. Must be plain JSON data. */
  readonly args?: unknown;
}

/** What `authorize` returns on success and `redeem` consumes. A plain value: keep it where the enforcement point can reach it. */
export interface Ticket {
  readonly capabilityId: string;
  readonly actionId: string;
  readonly agentId: string;
  readonly enforcementPointId: string;
  readonly expiresAt: string;
  readonly fingerprint: string;
  readonly decisionSequence: number;
  readonly grantedChain: readonly ChainLink[];
}

/** Why a dependency was unavailable. Chosen by Authority from the error's type and code, never copied from its message. */
export type UnavailableCode =
  | "CLOCK_INVALID" // the injected clock threw or returned a non-canonical instant
  | "BACKEND_UNREACHABLE" // the store could not be reached (connection refused, timeout, DNS, server shutdown)
  | "BACKEND_ERROR" // the store or a transaction failed for another reason
  | "SCHEMA_NOT_READY" // the PostgreSQL schema check failed: nothing was written
  | "INTERNAL_ERROR"; // the failure could not even be classified

/** Why an outcome is uncertain. The redemption call failed in a way that does not say whether it was written. */
export type UncertainCode = "OUTCOME_UNCERTAIN";

/**
 * What the OPERATOR receives (and only the operator): the full diagnostic for a
 * failure whose public result carries only `diagnosticId` and a fixed code.
 * `cause` is the raw error, by reference. It is defined as NON-ENUMERABLE so
 * that a careless `JSON.stringify(diagnostic)` or object spread still leaves it
 * out; read it explicitly. Never forward a Diagnostic to an agent or a client.
 */
export interface Diagnostic {
  readonly id: string;
  readonly operation: "authorize" | "redeem" | "report" | "record" | "guard.effect";
  readonly code: UnavailableCode | UncertainCode | "EFFECT_THREW";
  readonly actionId?: string;
  /** The raw error or thrown value. Operator-only; non-enumerable. */
  readonly cause: unknown;
}

export type AuthorizeResult =
  | { readonly status: "AUTHORIZED"; readonly ticket: Ticket }
  | { readonly status: "REQUIRES_APPROVAL"; readonly viaDelegation: string }
  | { readonly status: "DENIED"; readonly reason: string }
  /** The engine could not decide (for example a missing link in the chain). Treated as not allowed. */
  | { readonly status: "UNKNOWN"; readonly reason: string }
  /** Storage, clock or another dependency failed. Never treated as allowed. Retrying `authorize` is safe. */
  | { readonly status: "UNAVAILABLE"; readonly code: UnavailableCode; readonly diagnosticId: string };

export type RedeemResult =
  | { readonly status: "REDEEMED"; readonly capabilityId: string; readonly decisionSequence: number }
  | {
      readonly status: "REFUSED";
      readonly reason: RedeemCapabilityRejectionReason | "ACTION_ID_MISMATCH";
      /**
       * Describes THIS call: true only when this call consumed the ticket even though nothing is authorized
       * (CONCURRENT_WRITE_DETECTED). An earlier consumption does not set it: ALREADY_REDEEMED carries false.
       * To know whether a ticket is consumed, look for CAPABILITY_REDEEMED in the journal.
       */
      readonly ticketConsumed: boolean;
    }
  /**
   * The call failed in a way that does not tell whether the redemption was
   * written (for example a lost COMMIT acknowledgement). The effect must NOT
   * run: the ticket may or may not be consumed, and a retry will report
   * ALREADY_REDEEMED either way. Inspect the journal (`events()`).
   */
  | { readonly status: "UNKNOWN_OUTCOME"; readonly code: UncertainCode; readonly diagnosticId: string }
  /** A dependency failed before anything could have been written. Never treated as allowed. */
  | { readonly status: "UNAVAILABLE"; readonly code: UnavailableCode; readonly diagnosticId: string };

export type ReportResult =
  | { readonly status: "REPORTED"; readonly sequence: number }
  | { readonly status: "ALREADY_REPORTED" }
  | { readonly status: "REJECTED"; readonly reason: string }
  | { readonly status: "UNAVAILABLE"; readonly code: UnavailableCode; readonly diagnosticId: string };

export type RecordResult =
  | { readonly status: "RECORDED"; readonly outcomes: readonly { readonly accepted: boolean; readonly detail: string }[] }
  | { readonly status: "UNAVAILABLE"; readonly code: UnavailableCode; readonly diagnosticId: string };

/** What the guarded effect receives. Pass `idempotencyKey` to the target system so that it can deduplicate: Authority cannot. */
export interface EffectContext {
  readonly idempotencyKey: string;
  readonly ticket: Ticket;
}

export type GuardResult<T> =
  /** The effect ran and returned. `report` says whether the outcome was recorded (a failure to record never hides the effect). */
  | { readonly status: "EXECUTED"; readonly value: T; readonly report: ReportResult }
  /** The effect was not started. */
  | { readonly status: "BLOCKED"; readonly stage: "authorize"; readonly result: Exclude<AuthorizeResult, { status: "AUTHORIZED" }> }
  | { readonly status: "BLOCKED"; readonly stage: "redeem"; readonly result: Exclude<RedeemResult, { status: "REDEEMED" }> }
  /**
   * The effect was started and threw. The ticket is consumed and is never reused; the effect is never retried.
   * The thrown value is NOT in the result (a tool error can carry URLs or tokens): it goes to `onDiagnostic`.
   * To handle it in your own code, catch inside the effect (but an error you catch and return as a value is
   * reported as EXECUTED, not as a failure).
   * It does NOT say whether the external effect happened: a refusal by the target and a timeout look the same.
   * The first report of an action wins; it cannot be corrected afterwards.
   */
  | { readonly status: "EFFECT_FAILED"; readonly code: "EFFECT_THREW"; readonly diagnosticId: string; readonly ticketConsumed: true; readonly report: ReportResult };

export class AuthorityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorityConfigError";
  }
}

export class AuthorityInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorityInputError";
  }
}
