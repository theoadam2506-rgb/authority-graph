/**
 * Given a structurally valid chain (root..terminal, already passed through
 * validateChain), decides AUTHORIZED / REQUIRES_APPROVAL / DENIED / UNKNOWN
 * from the terminal's amount thresholds, total_budget across every bounded
 * ancestor in the chain, and a fingerprint-matched, unconsumed approval grant
 * when the amount falls in the approval band.
 *
 * Pure: no I/O, no Date.now(), no mutation of its inputs.
 */
import { computeActionFingerprint } from "../domain/events.js";
import type { AuthorityEvent, CanonicalStore } from "../domain/events.js";
import type { ActionParameters, ApprovalId, AuthorityDecision, Capability, DelegationId, Money, PrincipalId } from "../domain/types.js";
import { isNotCausallyAfter } from "./causality.js";
import type { DelegationEvent } from "./validateChain.js";

type ActionRequestedEvent = Extract<AuthorityEvent, { readonly event_type: "ACTION_REQUESTED" }>;
type ApprovalRequestedEvent = Extract<AuthorityEvent, { readonly event_type: "APPROVAL_REQUESTED" }>;

function findActionRequested(actionId: ActionRequestedEvent["payload"]["action_id"], visibleStore: CanonicalStore): ActionRequestedEvent | undefined {
  for (const event of visibleStore) {
    if (event.event_type === "ACTION_REQUESTED" && event.payload.action_id === actionId) {
      return event;
    }
  }
  return undefined;
}

function findApprovalRequested(approvalId: ApprovalId, visibleStore: CanonicalStore): ApprovalRequestedEvent | undefined {
  for (const event of visibleStore) {
    if (event.event_type === "APPROVAL_REQUESTED" && event.payload.approval_id === approvalId) {
      return event;
    }
  }
  return undefined;
}

/**
 * I-budget: at any sequence, the remaining capacity of a total_budget-bounded
 * delegation is its declared value minus the sum of every ACTION_EXECUTED
 * (visible at this sequence) whose authority_chain_ref passes through it —
 * directly or via any descendant (SPEC.md, "Sémantique de total_budget").
 * ACTION_EXECUTED itself carries only a fingerprint, never raw parameters
 * (EVENT_MODEL.md): the spent amount can only be read from the immutable
 * ACTION_REQUESTED of the same action_id.
 */
export function remainingBudget(delegationId: DelegationId, totalBudget: Money, visibleStore: CanonicalStore): number {
  let spent = 0;
  for (const event of visibleStore) {
    if (event.event_type !== "ACTION_EXECUTED") {
      continue;
    }
    const passesThroughDelegation = event.payload.authority_chain_ref.some(
      (link) => link.kind === "delegation" && link.delegation_id === delegationId,
    );
    if (!passesThroughDelegation) {
      continue;
    }
    const request = findActionRequested(event.payload.action_id, visibleStore);
    if (request === undefined) {
      continue;
    }
    if (request.payload.parameters.kind === "monetary") {
      spent += request.payload.parameters.amount.value;
    }
  }
  return totalBudget.value - spent;
}

function budgetExceeded(chain: readonly DelegationEvent[], amount: number, visibleStore: CanonicalStore): boolean {
  return chain.some((node) => {
    const budget = node.payload.total_budget;
    if (budget === undefined) {
      return false;
    }
    return amount > remainingBudget(node.payload.delegation_id, budget, visibleStore);
  });
}

function isApprovalConsumed(approvalId: ApprovalId, visibleStore: CanonicalStore): boolean {
  return visibleStore.some(
    (event) =>
      event.event_type === "ACTION_EXECUTED" &&
      event.payload.authority_chain_ref.some((link) => link.kind === "approval" && link.approval_id === approvalId),
  );
}

/**
 * I14 + I15 + I16: search the whole visible store (not just this chain) for a
 * valid grant matching this exact fingerprint. A raw APPROVAL_DENIED is never
 * consulted here — a refusal is inherently about one past, specific request
 * (SPEC.md, "Portée d'un refus") and has no power over a fresh, unrelated
 * prospective question for the same fingerprint.
 */
function findGrantOutcome(
  terminal: DelegationEvent,
  agentId: PrincipalId,
  capability: Capability,
  parameters: ActionParameters,
  visibleStore: CanonicalStore,
): { readonly anyValidGrant: boolean; readonly unconsumedApprovalId: ApprovalId | undefined } {
  const targetFingerprint = computeActionFingerprint(capability, parameters);
  const habilitatedGrantor = terminal.payload.grantor_principal_id;
  const terminalDelegationId = terminal.payload.delegation_id;

  let anyValidGrant = false;
  for (const event of visibleStore) {
    if (event.event_type !== "APPROVAL_GRANTED") {
      continue;
    }
    if (event.principal_id !== habilitatedGrantor || event.payload.approving_principal_id !== habilitatedGrantor) {
      continue; // I14: not the delegation's own grantor — ignored for decision
    }
    // I19: an approval_id with no causally-prior APPROVAL_REQUESTED behind it
    // is not a legitimate grant — ignored for decision, exactly as if this
    // APPROVAL_GRANTED had never been emitted (PROMPT 6b, finding #1).
    const approvalRequest = findApprovalRequested(event.payload.approval_id, visibleStore);
    if (approvalRequest === undefined || !isNotCausallyAfter(approvalRequest, event.sequence)) {
      continue;
    }
    const request = findActionRequested(event.payload.action_id, visibleStore);
    if (request === undefined || !isNotCausallyAfter(request, event.sequence)) {
      continue; // I19: action_id must also exist causally before this grant
    }
    if (request.payload.requesting_principal_id !== agentId || request.payload.delegation_id !== terminalDelegationId) {
      continue;
    }
    const requestFingerprint = computeActionFingerprint(request.payload.capability_requested, request.payload.parameters);
    if (requestFingerprint !== targetFingerprint) {
      continue;
    }
    anyValidGrant = true;
    if (!isApprovalConsumed(event.payload.approval_id, visibleStore)) {
      return { anyValidGrant: true, unconsumedApprovalId: event.payload.approval_id };
    }
  }
  return { anyValidGrant, unconsumedApprovalId: undefined };
}

export function evaluateConstraints(
  chain: readonly DelegationEvent[],
  capability: Capability,
  parameters: ActionParameters,
  visibleStore: CanonicalStore,
  agentId: PrincipalId,
): AuthorityDecision {
  const terminal = chain[chain.length - 1];
  if (terminal === undefined) {
    return { outcome: "UNKNOWN", reasonCode: "C24_NO_VALID_CHAIN" };
  }
  const chainIds = chain.map((node) => node.payload.delegation_id);

  if (parameters.kind === "non_monetary") {
    return { outcome: "AUTHORIZED", chain: chainIds };
  }

  const amount = parameters.amount.value;

  if (budgetExceeded(chain, amount, visibleStore)) {
    return { outcome: "DENIED", reasonCode: "C9_TOTAL_BUDGET_EXCEEDED" };
  }

  const thresholds = terminal.payload.thresholds;
  if (thresholds === undefined) {
    // A monetary action against a delegation with no declared thresholds is
    // not resolvable — fail-closed, not a permissive "no ceiling" default.
    return { outcome: "UNKNOWN", reasonCode: "C22_UNKNOWN_CONSTRAINT_TYPE" };
  }
  const ceiling = terminal.payload.max_amount !== undefined ? terminal.payload.max_amount.value : Number.POSITIVE_INFINITY;
  const wellFormed = thresholds.automatic_max_amount <= thresholds.approval_max_amount && thresholds.approval_max_amount <= ceiling;
  if (!wellFormed) {
    return { outcome: "UNKNOWN", reasonCode: "C22_UNKNOWN_CONSTRAINT_TYPE" };
  }

  if (amount <= thresholds.automatic_max_amount) {
    return { outcome: "AUTHORIZED", chain: chainIds };
  }
  if (amount > thresholds.approval_max_amount) {
    return { outcome: "DENIED", reasonCode: "C8_AMOUNT_EXCEEDS_APPROVAL_CEILING" };
  }

  const { anyValidGrant, unconsumedApprovalId } = findGrantOutcome(terminal, agentId, capability, parameters, visibleStore);
  if (unconsumedApprovalId !== undefined) {
    return { outcome: "AUTHORIZED", chain: chainIds, approvalId: unconsumedApprovalId };
  }
  if (anyValidGrant) {
    return { outcome: "DENIED", reasonCode: "C7_APPROVAL_ALREADY_CONSUMED" };
  }
  return { outcome: "REQUIRES_APPROVAL", viaDelegation: terminal.payload.delegation_id };
}
