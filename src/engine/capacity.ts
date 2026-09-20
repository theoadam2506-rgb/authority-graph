/**
 * PR3 — pure semantics for the new authority_capacity accounting, sourced
 * from CAPABILITY_ISSUED grants instead of ACTION_EXECUTED. This module is
 * entirely separate from evaluateConstraints.ts on purpose: remainingBudget
 * (legacy, ACTION_EXECUTED-based, I20) is not modified, not reused, and not
 * reasoned about here — the two accounting worlds coexist without either
 * importing the other's logic.
 *
 * SECURITY BOUNDARY THIS MODULE DOES NOT YET ENFORCE (deliberately, per the
 * PR3 scope): a CAPABILITY_ISSUED event's `granted_chain_ref` is, as of this
 * PR, still ASSERTED — no ingestion-time admissibility check exists yet
 * that re-derives and compares it against the resolver's own chain-walking
 * at decision_sequence (see the docstring on `CapabilityIssuedPayload`,
 * src/domain/events.ts). Nothing in this module may be called with a raw
 * CAPABILITY_ISSUED event and treated as accounting truth — see
 * `ValidatedGrant` below.
 *
 * Pure: no I/O, no Date.now(), no mutation of its inputs.
 */
import type { AuthorityEvent, CanonicalStore, ChainLink } from "../domain/events.js";
import type { Branded, DelegationId, Iso8601, Money } from "../domain/types.js";

export type CapabilityIssuedEvent = Extract<AuthorityEvent, { readonly event_type: "CAPABILITY_ISSUED" }>;
type ActionRequestedEvent = Extract<AuthorityEvent, { readonly event_type: "ACTION_REQUESTED" }>;

/**
 * A CAPABILITY_ISSUED event that some validation step has demonstrated
 * corresponds to a chain Authority's own resolver would actually have
 * produced at `decision_sequence` for `action_id`/`action_fingerprint` —
 * the GRANTED promotion described in the CapabilityIssuedPayload docstring.
 *
 * DELIBERATELY, this module exports no constructor for this type. The only
 * legitimate way to obtain a `ValidatedGrant` is the future admissibility
 * check (Phase 4/4A) that actually performs that demonstration. A `grep`
 * across `src/` must never find a function that promotes an arbitrary
 * `CapabilityIssuedEvent` into a `ValidatedGrant` without validating it —
 * that would be a second, silent way to cross the exact boundary this type
 * exists to guard. Tests that need a `ValidatedGrant` before the real
 * validator exists construct one with a local, explicit `as ValidatedGrant`
 * cast, kept inside test files only (see tests/engine/capacity.test.ts) —
 * never through a reusable production-shaped factory.
 *
 * Branding here follows the exact same nominal-typing idiom
 * src/domain/types.ts already uses for opaque string/number identifiers
 * (`Branded<Value, BrandName>`), applied to an object instead of a
 * primitive. Like every other branded type in this codebase, this is a
 * compile-time discipline against ACCIDENTAL misuse (mirrors how
 * `CapabilityId`/`DelegationId` are `as X`-cast-constructible by anyone
 * determined to bypass their smart constructor) — not a cryptographic or
 * runtime guarantee. It does not, and cannot, stop a determined caller from
 * writing their own `as ValidatedGrant` cast; it only removes any
 * convenient, named, exported shortcut for doing so from production code.
 */
export type ValidatedGrant = Branded<{ readonly event: CapabilityIssuedEvent }, "ValidatedGrant">;

function findActionRequested(actionId: ActionRequestedEvent["payload"]["action_id"], visibleStore: CanonicalStore): ActionRequestedEvent | undefined {
  for (const event of visibleStore) {
    if (event.event_type === "ACTION_REQUESTED" && event.payload.action_id === actionId) {
      return event;
    }
  }
  return undefined;
}

function chainContainsDelegation(chain: readonly ChainLink[], delegationId: DelegationId): boolean {
  return chain.some((link) => link.kind === "delegation" && link.delegation_id === delegationId);
}

/**
 * The new-world counterpart to remainingBudget (evaluateConstraints.ts),
 * sourced from validated CAPABILITY_ISSUED grants instead of ACTION_EXECUTED.
 *
 * Unlike remainingBudget, this function does NOT walk from a claimed
 * terminal up through real ancestors (evaluateConstraints.ts's
 * `ancestorDelegationIds`) — that heuristic exists in the legacy path only
 * because `authority_chain_ref` is, and remains, an unvalidated after-the-
 * fact assertion, so the legacy code cannot trust that every delegation_id
 * it names truly belongs to the claimed chain. A `ValidatedGrant`'s
 * `granted_chain_ref` carries no such doubt BY CONTRACT — Phase 4's future
 * admissibility check is precisely what is supposed to guarantee that every
 * delegation_id appearing in it truly is the terminal or a real ancestor
 * before a raw event is ever promoted into a `ValidatedGrant` at all. Given
 * that contract, summing every grant whose chain names `delegationId`
 * directly is correct, not a shortcut — re-deriving the ancestor walk here
 * would duplicate a check that validation must already have performed.
 *
 * Mirrors EVENT_MODEL.md's total_budget semantics precisely: a grant debits
 * EVERY bounded ancestor level in its chain independently, by the full
 * amount, not just the immediately invoked delegation (see the D1->D2
 * worked example in the docstring on the test file).
 *
 * The amount debited is read from the immutable ACTION_REQUESTED for the
 * grant's `action_id` — CAPABILITY_ISSUED carries no amount of its own, by
 * design (see CapabilityIssuedPayload). A grant whose action_id cannot be
 * found, or whose request is non-monetary, contributes nothing.
 *
 * This function does NOT filter by expiry or by any redemption state —
 * CAPABILITY_REDEEMED does not exist yet (Phase 6), and pretending to
 * decide "is this grant still active" here, without that information,
 * would fabricate a resolved state this function cannot actually know. See
 * `isWithinReservationWindow` for the one, narrowly-scoped fact this PR CAN
 * honestly compute about expiry — deciding which grants to pass in remains
 * entirely the caller's responsibility, today and after Phase 6.
 *
 * Returning a NEGATIVE number when the sum of engaged grants exceeds
 * `capacity` is deliberate: this is a pure signal for a future admissibility
 * check to act on, not a decision. This function enforces no exclusion
 * between concurrent grants — see the module docstring: that atomicity is
 * Layer 2's job, not this pure function's.
 */
export function remainingCapacity(delegationId: DelegationId, capacity: Money, grants: readonly ValidatedGrant[], visibleStore: CanonicalStore): number {
  let engaged = 0;
  for (const grant of grants) {
    if (!chainContainsDelegation(grant.event.payload.granted_chain_ref, delegationId)) {
      continue;
    }
    const request = findActionRequested(grant.event.payload.action_id, visibleStore);
    if (request === undefined) {
      continue;
    }
    if (request.payload.parameters.kind === "monetary") {
      engaged += request.payload.parameters.amount.value;
    }
  }
  return capacity.value - engaged;
}

/**
 * Whether `grant`'s own reservation window is still open at `authorityTime`
 * — i.e. strictly before its `expires_at`.
 *
 * DELIBERATELY INCOMPLETE (see the module and CapabilityIssuedPayload
 * docstrings): `false` here means only "past its own expires_at", never
 * "this capacity may be released". Once CAPABILITY_REDEEMED exists (Phase
 * 6), a grant redeemed before expiry must stay engaged forever after — a
 * fact this function has no way to check today, since no redemption event
 * exists to check it against. A caller must NOT treat `false` as
 * authorization to drop a grant from `remainingCapacity`'s `grants` list
 * until that future redemption check exists alongside it. This function is
 * provided now only so that future combination is a matter of composing two
 * already-correct, separately-honest facts, not of retrofitting a
 * previously-overreaching one.
 */
export function isWithinReservationWindow(grant: ValidatedGrant, authorityTime: Iso8601): boolean {
  return Date.parse(authorityTime) < Date.parse(grant.event.payload.expires_at);
}
