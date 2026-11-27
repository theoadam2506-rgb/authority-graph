/**
 * B1 — what an evaluator may answer INSTEAD of scanning the visible store.
 *
 * `validateChain` and `evaluateConstraints` take an optional context. Without it they behave exactly as before (they scan the
 * `visibleStore` they are given). With it, the few operations that scan the whole store are answered by the caller from state
 * it has maintained incrementally over the same prefix (see onePassGrants.ts and docs/v1/B1_EQUIVALENCE.md). The contexts add
 * no rule: every rule still lives in `validateChain` / `evaluateConstraints`, once.
 */
import type { Money, DelegationId, PrincipalId, Capability, ActionParameters, ActionId, ApprovalId } from "../domain/types.js";
import type { DelegationEvent } from "./validateChain.js";

export interface ChainEvaluationContext {
  /** The delegation index `buildDelegationIndex(visibleStore)` would build (the last delegation event per id wins). */
  delegationIndex(): ReadonlyMap<DelegationId, DelegationEvent>;
  /** What `isRevoked(node, visibleStore, index)` returns. */
  isRevoked(node: DelegationEvent, index: ReadonlyMap<DelegationId, DelegationEvent>): boolean;
  /** What `remainingBudget(id, budget, visibleStore)` returns. */
  remainingBudget(delegationId: DelegationId, budget: Money): number;
}

export interface ConstraintEvaluationContext {
  /** What `remainingBudget(id, budget, visibleStore)` returns. */
  remainingBudget(delegationId: DelegationId, budget: Money): number;
  /** What `findGrantOutcome(terminal, agentId, capability, parameters, visibleStore, queriedActionId)` returns. */
  grantOutcome(
    terminal: DelegationEvent,
    agentId: PrincipalId,
    capability: Capability,
    parameters: ActionParameters,
    queriedActionId: ActionId | undefined,
  ): { readonly anyValidGrant: boolean; readonly unconsumedApprovalId: ApprovalId | undefined };
}
