/**
 * PR4B-2 — the logical idempotency semantics Correction 3 (PR4B-1's
 * design report) required: a raw client key alone is never enough, since
 * two different authenticated requesters could present the same one.
 * `ScopedIdempotencyKey` (src/domain/capabilityCommand.ts) is the triple
 * this module actually keys on: (authenticated_requester_id, operation,
 * client_idempotency_key).
 *
 * PRE-COMMIT REVIEW CORRECTION: this module no longer accepts a caller-
 * supplied `ScopedIdempotencyKey` as an independent argument. Doing so
 * would let a caller assemble a scope whose `authenticated_requester_id`
 * disagrees with the `AuthenticatedPrincipal` actually used to call
 * `issueCapability` — two values that must always be the same identity,
 * carried as two independently-forgeable fields is exactly the kind of
 * duplication this codebase never accepts elsewhere (see
 * grantValidation.ts's own rationale for never re-accepting a fact an
 * immutable event already carries). Instead, this module is the ONLY
 * place a `ScopedIdempotencyKey` for the `ISSUE_CAPABILITY` operation is
 * ever constructed, and it is built exclusively from the
 * `AuthenticatedPrincipal` this function itself receives — never from
 * caller-supplied command data, never from an event.
 *
 * Pure, in-memory, no hashing/UUID scheme chosen for `event_id` derivation
 * (deliberately deferred — see the design report). `IdempotencyState` is
 * an immutable map, updated functionally (mirrors `IngestionState`'s own
 * `{nextState}` convention in ingest.ts) — nothing here mutates its input.
 */
import type { CanonicalStore } from "../domain/events.js";
import type { ClientIdempotencyKey, Iso8601 } from "../domain/types.js";
import type { IssueCapabilityCommand, ScopedIdempotencyKey } from "../domain/capabilityCommand.js";
import type { AuthenticatedPrincipal } from "../domain/authenticatedPrincipal.js";
import { issueCapability, type IssueCapabilityDependencies, type IssueCapabilityResult } from "./issueCapability.js";

function scopeKey(scope: ScopedIdempotencyKey): string {
  return `${scope.authenticated_requester_id}\u0000${scope.operation}\u0000${scope.client_idempotency_key}`;
}

/**
 * Exported (PR4B-3B): a Postgres-backed transaction persists this same
 * comparison rule against a command round-tripped through JSONB, rather
 * than an in-memory `IdempotencyRecord.command` — reusing this pure
 * function directly is exactly the "small, clean, safe extraction" this
 * codebase already prefers over any duplication (see
 * `replaceExecutedIdempotencyResult`'s own docstring on `scopeKey`,
 * PR4B-3A.5: unlike that key-representation export, this one exposes only
 * a business-level comparison, not internal storage shape — nothing about
 * this function's signature or behavior needed to change to be reused).
 */
export function commandsEqual(a: IssueCapabilityCommand, b: IssueCapabilityCommand): boolean {
  return a.action_id === b.action_id && a.enforcement_point_id === b.enforcement_point_id;
}

export interface IdempotencyRecord {
  readonly command: IssueCapabilityCommand;
  readonly result: IssueCapabilityResult;
}

export type IdempotencyState = ReadonlyMap<string, IdempotencyRecord>;

export const EMPTY_IDEMPOTENCY_STATE: IdempotencyState = new Map();

export type IssueCapabilityIdempotentResult =
  | { readonly outcome: "EXECUTED"; readonly result: IssueCapabilityResult; readonly nextState: IdempotencyState }
  | { readonly outcome: "REPLAYED"; readonly result: IssueCapabilityResult; readonly nextState: IdempotencyState }
  | { readonly outcome: "IDEMPOTENCY_CONFLICT"; readonly nextState: IdempotencyState };

/**
 * A. same scope + same command => the recorded result is REPLAYED —
 *    `issueCapability` is never called again, so no second reservation
 *    of capacity can ever happen for a retried command.
 * B. same scope + a different command => IDEMPOTENCY_CONFLICT. Neither
 *    the old nor a new result is returned as if it were fine — the
 *    caller must resolve the conflict, never silently pick one.
 * C. same `client_idempotency_key` but a different `authenticatedPrincipal`
 *    => a different scope entirely (the key includes the requester) => no
 *    collision, handled as a fresh command.
 *
 * `authenticatedPrincipal` is the ONLY source for the scope's
 * `authenticated_requester_id` — there is no second, independently-
 * suppliable copy of that identity for a caller to pass in disagreement
 * with it. `clientIdempotencyKey` is the caller's own raw key; `operation`
 * is not a parameter at all, since this function only ever handles
 * `"ISSUE_CAPABILITY"` — hard-coding it removes one more field a caller
 * could otherwise get wrong.
 *
 * PR4B-5 — `authorityTime` is used ONLY on the EXECUTED (cache-miss) path,
 * passed straight through to `issueCapability`. On a REPLAYED cache-hit
 * (case A above), it is deliberately never consulted: the first execution
 * under a given scope fixes the decision for that scope, permanently — a
 * retry that arrives at a later real instant must still see exactly the
 * result the first call produced, never a re-evaluation against the
 * retry's own later authorityTime. This is intentional, not an oversight:
 * a client retrying after a lost response is asking "what was the answer
 * to MY attempt", not "decide this again, now". A caller that genuinely
 * wants a fresh decision at a new instant must use a new
 * `clientIdempotencyKey` — `authorityTime` is deliberately NOT part of
 * `commandsEqual`/the scope key, precisely so that varying it alone can
 * never turn a retry into an `IDEMPOTENCY_CONFLICT`.
 */
export function issueCapabilityIdempotently(
  state: IdempotencyState,
  store: CanonicalStore,
  authenticatedPrincipal: AuthenticatedPrincipal,
  clientIdempotencyKey: ClientIdempotencyKey,
  command: IssueCapabilityCommand,
  dependencies: IssueCapabilityDependencies,
  authorityTime: Iso8601,
): IssueCapabilityIdempotentResult {
  const scope: ScopedIdempotencyKey = {
    authenticated_requester_id: authenticatedPrincipal.principalId,
    operation: "ISSUE_CAPABILITY",
    client_idempotency_key: clientIdempotencyKey,
  };
  const key = scopeKey(scope);
  const existing = state.get(key);
  if (existing !== undefined) {
    if (commandsEqual(existing.command, command)) {
      // REPLAYED: the persisted result from the ORIGINAL execution, as-is.
      // No re-evaluation at this call's own authorityTime — see docstring.
      return { outcome: "REPLAYED", result: existing.result, nextState: state };
    }
    return { outcome: "IDEMPOTENCY_CONFLICT", nextState: state };
  }

  const result = issueCapability(store, authenticatedPrincipal, command, dependencies, authorityTime);
  const nextState = new Map(state);
  nextState.set(key, { command, result });
  return { outcome: "EXECUTED", result, nextState };
}

/**
 * PR4B-3A.1 — the one correction case `issueCapabilityIdempotently` itself
 * cannot foresee: its own EXECUTED path just optimistically recorded an
 * `ok:true` result under this exact scope, but a LATER admission step
 * outside this module's knowledge (making the decision canonical — e.g.
 * the transactional layer ingesting the resulting event) rejected it. The
 * caller never needs, and must never reconstruct, this module's internal
 * key representation or `IdempotencyRecord` shape to fix that; it calls
 * this function instead — which owns both.
 *
 * Preconditions are CHECKED here, not trusted from the caller, and fail
 * closed (throw) rather than being modeled as a `Result`: this function's
 * only legitimate caller is the same logical turn that just produced the
 * record it corrects (see capabilityIssuanceTransaction.ts). Calling it
 * for a scope with no prior record, or with a `expectedCommand` that
 * disagrees with what was actually recorded, is a programming error in
 * that caller — not a business outcome — exactly the same category of
 * fault the smart constructors in domain/types.ts already throw on.
 *
 * Reuses `commandsEqual`/`scopeKey` as they already exist — nothing here
 * duplicates either rule.
 */
export function replaceExecutedIdempotencyResult(
  state: IdempotencyState,
  authenticatedPrincipal: AuthenticatedPrincipal,
  clientIdempotencyKey: ClientIdempotencyKey,
  expectedCommand: IssueCapabilityCommand,
  correctedResult: IssueCapabilityResult,
): IdempotencyState {
  const scope: ScopedIdempotencyKey = {
    authenticated_requester_id: authenticatedPrincipal.principalId,
    operation: "ISSUE_CAPABILITY",
    client_idempotency_key: clientIdempotencyKey,
  };
  const key = scopeKey(scope);
  const existing = state.get(key);
  if (existing === undefined) {
    throw new Error(
      "replaceExecutedIdempotencyResult: no existing record for this scope — this function only ever corrects a record issueCapabilityIdempotently already wrote in the same turn.",
    );
  }
  if (!commandsEqual(existing.command, expectedCommand)) {
    throw new Error(
      "replaceExecutedIdempotencyResult: expectedCommand does not match the recorded command for this scope — refusing to overwrite a record belonging to a different command.",
    );
  }
  const nextState = new Map(state);
  nextState.set(key, { command: existing.command, result: correctedResult });
  return nextState;
}
