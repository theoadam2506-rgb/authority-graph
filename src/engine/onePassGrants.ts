/**
 * B1 — one-pass evaluation of the historical grants (no cross-call state, no cache).
 *
 * What it computes. For every CAPABILITY_ISSUED event `C` of a journal, in journal order, exactly what the historical loop
 * (`collectValidatedGrants`) computes: `validateAndSelectGrant(store, C).ok`, and when it is ok the `{ event: C }` grant.
 * The historical loop re-derives the world visible at `C` (every event with a smaller sequence) from scratch for each grant,
 * which costs O(journal) per grant; this module walks the journal ONCE, keeps the state of the prefix up to the current event
 * in indexes, and evaluates `C` against that state. The rules themselves are NOT re-implemented here: `validateChain` and
 * `evaluateConstraints` are called with a context (evaluationContext.ts) that answers the few operations which used to scan
 * the visible store. See docs/v1/B1_EQUIVALENCE.md for the argument and its limits.
 *
 * When it applies. Only when `onePassGuard` accepts the journal; otherwise the caller runs the historical loop, unchanged.
 * The guard is exact for what the fast path assumes (and conservative for the rest):
 *   1. the journal is shape-sound (every property the evaluation reads exists with the right type: nothing can throw);
 *   2. sequences strictly increase in array order (so "visible at C" = "earlier in the array");
 *   3. NO LATE ACTIVATION: for every ACTION_EXECUTED `X`, its action's request, the delegation that request invokes and every
 *      delegation reached while walking up from it, if they exist in the journal at all, appear BEFORE `X`. Only then is
 *      the debit an execution contributes to a delegation's total budget final at the moment `X` is read (a reference that
 *      never resolves never activates, and is harmless).
 *
 * Pure: no I/O, no clock, no mutation of its input.
 */
import { computeActionFingerprint, type AuthorityEvent, type CanonicalStore, type ChainLink } from "../domain/events.js";
import { MAX_CHAIN_DEPTH, type ActionId, type ActionParameters, type ApprovalId, type Capability, type DelegationId, type Money, type PrincipalId } from "../domain/types.js";
import type { CapabilityIssuedEvent, ValidatedGrant } from "./capacity.js";
import type { ChainEvaluationContext, ConstraintEvaluationContext } from "./evaluationContext.js";
import { ancestorDelegationIds, evaluateConstraints, findGrantOutcome, isDemonstrablyTiedToItsExecutor, terminalDelegationOf } from "./evaluateConstraints.js";
import { chainsEqual, type ActionRequestedEvent } from "./grantValidation.js";
import type { JournalLookup } from "./journalIndex.js";
import { isJournalShapeSound } from "./journalShape.js";
import { findRoot, validateChain, type DelegationEvent } from "./validateChain.js";

export type OnePassRefusal = "NOT_SHAPE_SOUND" | "SEQUENCE_NOT_STRICTLY_INCREASING" | "LATE_ACTIVATION";
export type OnePassGuardResult =
  | { readonly ok: true; readonly firstRequest: ReadonlyMap<string, ActionRequestedEvent> }
  | { readonly ok: false; readonly reason: OnePassRefusal; readonly at?: number };

const EMPTY_STORE: CanonicalStore = Object.freeze([]) as unknown as CanonicalStore;
type ExecutedEvent = Extract<AuthorityEvent, { readonly event_type: "ACTION_EXECUTED" }>;
type IssuedEvent = CapabilityIssuedEvent;

/** The exact applicability test. O(journal), allocation-light, no decision. */
export function onePassGuard(store: CanonicalStore): OnePassGuardResult {
  if (!isJournalShapeSound(store)) {
    return { ok: false, reason: "NOT_SHAPE_SOUND" };
  }
  let previous = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < store.length; i += 1) {
    const sequence = Number((store[i] as AuthorityEvent).sequence);
    if (!(sequence > previous)) {
      return { ok: false, reason: "SEQUENCE_NOT_STRICTLY_INCREASING", at: i };
    }
    previous = sequence;
  }
  const firstRequest = new Map<string, ActionRequestedEvent>();
  const firstDelegation = new Map<string, DelegationEvent>();
  for (const event of store) {
    if (event.event_type === "ACTION_REQUESTED") {
      if (!firstRequest.has(event.payload.action_id)) firstRequest.set(event.payload.action_id, event);
    } else if (event.event_type === "DELEGATION_CREATED" || event.event_type === "SUBDELEGATION_CREATED") {
      if (!firstDelegation.has(event.payload.delegation_id)) firstDelegation.set(event.payload.delegation_id, event);
    }
  }
  for (let i = 0; i < store.length; i += 1) {
    const event = store[i] as AuthorityEvent;
    if (event.event_type !== "ACTION_EXECUTED") continue;
    const request = firstRequest.get(event.payload.action_id);
    if (request === undefined) continue; // never activates
    if (request.sequence > event.sequence) return { ok: false, reason: "LATE_ACTIVATION", at: i };
    // the walk `ancestorDelegationIds` performs from the invoked delegation, with the same stopping rules
    const visited = new Set<string>();
    let current: string | undefined = request.payload.delegation_id;
    let steps = 0;
    while (current !== undefined && !visited.has(current)) {
      visited.add(current);
      const node: DelegationEvent | undefined = firstDelegation.get(current);
      if (node === undefined) break; // unresolved for ever: harmless
      if (node.sequence > event.sequence) return { ok: false, reason: "LATE_ACTIVATION", at: i };
      if (node.event_type === "DELEGATION_CREATED") break;
      current = node.payload.parent_delegation_id;
      steps += 1;
      if (steps > MAX_CHAIN_DEPTH) break;
    }
  }
  return { ok: true, firstRequest };
}

/** The state of the prefix: everything the evaluation of the next grant may ask, maintained as events are read. */
class PrefixState {
  /** `buildDelegationIndex` semantics: the LAST delegation event per id wins. */
  readonly delegationIndex = new Map<DelegationId, DelegationEvent>();
  /** `findDelegation` semantics: the FIRST delegation event per id. */
  readonly firstDelegation = new Map<string, DelegationEvent>();
  readonly delegationEvents: DelegationEvent[] = [];
  /** delegation id -> principals that signed a DELEGATION_REVOKED for it. */
  readonly revokers = new Map<string, Set<string>>();
  readonly firstRequest = new Map<string, ActionRequestedEvent>();
  readonly approvalRequestsById = new Map<string, AuthorityEvent[]>();
  readonly grantsByAction = new Map<string, AuthorityEvent[]>();
  readonly executionsByAction = new Map<string, ExecutedEvent[]>();
  /** delegation id -> currency -> sum of the debits charged to it (every addition happens in journal order, like the historical loop). */
  readonly spent = new Map<string, Map<string, number>>();
  /** "delegation id \0 action id": this action was already charged to this delegation. */
  readonly charged = new Set<string>();
  /** The two lookups `terminalDelegationOf` / `ancestorDelegationIds` / `isDemonstrablyTiedToItsExecutor` make, answered from the indexes. */
  readonly lookup = {
    delegation: (id: string) => this.firstDelegation.get(id),
    actionRequested: (id: string) => this.firstRequest.get(id),
  } as unknown as JournalLookup;

  apply(event: AuthorityEvent): void {
    switch (event.event_type) {
      case "DELEGATION_CREATED":
      case "SUBDELEGATION_CREATED": {
        this.delegationIndex.set(event.payload.delegation_id, event);
        if (!this.firstDelegation.has(event.payload.delegation_id)) this.firstDelegation.set(event.payload.delegation_id, event);
        this.delegationEvents.push(event);
        return;
      }
      case "DELEGATION_REVOKED": {
        const set = this.revokers.get(event.payload.delegation_id) ?? new Set<string>();
        set.add(event.principal_id);
        this.revokers.set(event.payload.delegation_id, set);
        return;
      }
      case "ACTION_REQUESTED": {
        if (!this.firstRequest.has(event.payload.action_id)) this.firstRequest.set(event.payload.action_id, event);
        return;
      }
      case "APPROVAL_REQUESTED": {
        push(this.approvalRequestsById, event.payload.approval_id, event);
        return;
      }
      case "APPROVAL_GRANTED": {
        push(this.grantsByAction, event.payload.action_id, event);
        return;
      }
      case "ACTION_EXECUTED": {
        this.account(event);
        push(this.executionsByAction, event.payload.action_id, event);
        return;
      }
      default:
        return;
    }
  }

  /**
   * The contribution of one execution to the budgets it cites, decided with the facts visible when it is read. The guard guarantees
   * those facts cannot change later, so this is also what any later snapshot would have computed. The checks are those of
   * `remainingBudget`, in the same order, through the same functions.
   */
  private account(execution: ExecutedEvent): void {
    const cited = new Set<string>();
    for (const link of execution.payload.authority_chain_ref) if (link.kind === "delegation") cited.add(link.delegation_id);
    if (cited.size === 0) return;
    const request = this.firstRequest.get(execution.payload.action_id);
    if (request === undefined) return;
    const parameters = request.payload.parameters;
    const terminal = terminalDelegationOf(execution.payload.authority_chain_ref, request.payload.delegation_id, execution.payload.executed_by_principal_id, EMPTY_STORE, this.lookup);
    if (terminal === undefined) return;
    const ancestry = ancestorDelegationIds(terminal, EMPTY_STORE, this.lookup);
    const tied = isDemonstrablyTiedToItsExecutor(execution, request, EMPTY_STORE, this.lookup);
    for (const delegationId of cited) {
      if (!ancestry.has(delegationId as DelegationId)) continue;
      const key = `${delegationId}\u0000${request.payload.action_id}`;
      if (this.charged.has(key)) continue; // an action is debited once per delegation
      if (!tied) continue;
      if (parameters.kind === "monetary") {
        const byCurrency = this.spent.get(delegationId) ?? new Map<string, number>();
        byCurrency.set(parameters.amount.currency, (byCurrency.get(parameters.amount.currency) ?? 0) + parameters.amount.value);
        this.spent.set(delegationId, byCurrency);
        this.charged.add(key);
      }
    }
  }

  readonly chainContext: ChainEvaluationContext = {
    delegationIndex: () => this.delegationIndex,
    isRevoked: (node, index) => {
      const directGrantor = node.payload.grantor_principal_id;
      const root = findRoot(node.payload.delegation_id, index);
      const rootGrantor = root !== undefined ? root.payload.grantor_principal_id : undefined;
      const signers = this.revokers.get(node.payload.delegation_id);
      return signers !== undefined && (signers.has(directGrantor) || (rootGrantor !== undefined && signers.has(rootGrantor)));
    },
    remainingBudget: (delegationId: DelegationId, budget: Money) => budget.value - (this.spent.get(delegationId)?.get(budget.currency) ?? 0),
  };

  readonly constraintContext: ConstraintEvaluationContext = {
    remainingBudget: (delegationId: DelegationId, budget: Money) => budget.value - (this.spent.get(delegationId)?.get(budget.currency) ?? 0),
    grantOutcome: (terminal: DelegationEvent, agentId: PrincipalId, capability: Capability, parameters: ActionParameters, queriedActionId: ActionId | undefined) => {
      const noGrant = { anyValidGrant: false, unconsumedApprovalId: undefined as ApprovalId | undefined };
      if (queriedActionId === undefined) return noGrant; // not reachable from the grant path (the action id is always supplied)
      const grants = this.grantsByAction.get(queriedActionId);
      if (grants === undefined) return noGrant;
      // `findGrantOutcome` reads only: the APPROVAL_GRANTED of the queried action, the APPROVAL_REQUESTED of their ids, the first
      // request of the action, the executions of the action, and the delegations. Hand it exactly those, in journal order per kind.
      const reduced: AuthorityEvent[] = [...this.delegationEvents];
      const seen = new Set<string>();
      for (const grant of grants) {
        reduced.push(grant);
        if (grant.event_type !== "APPROVAL_GRANTED" || seen.has(grant.payload.approval_id)) continue;
        seen.add(grant.payload.approval_id);
        const requests = this.approvalRequestsById.get(grant.payload.approval_id);
        if (requests !== undefined) reduced.push(...requests);
      }
      const request = this.firstRequest.get(queriedActionId);
      if (request !== undefined) reduced.push(request);
      const executions = this.executionsByAction.get(queriedActionId);
      if (executions !== undefined) reduced.push(...executions);
      return findGrantOutcome(terminal, agentId, capability, parameters, reduced, queriedActionId);
    },
  };
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/** `validateAndSelectGrant(store, candidate).ok`, evaluated against the prefix state that precedes `candidate`. */
function candidateIsValid(candidate: IssuedEvent, state: PrefixState, firstRequest: ReadonlyMap<string, ActionRequestedEvent>): boolean {
  const request = firstRequest.get(candidate.payload.action_id); // the first request of the WHOLE journal, as `findActionRequested(…, store)`
  if (request === undefined) return false;
  if (candidate.payload.action_fingerprint !== computeActionFingerprint(request.payload.capability_requested, request.payload.parameters)) return false;
  const snapshot = Number(candidate.sequence) - 1;
  if (Number(candidate.payload.decision_sequence) !== snapshot) return false;
  if (request.sequence > snapshot) return false;
  const invoked = state.firstDelegation.get(request.payload.delegation_id);
  if (invoked === undefined) return false;
  if (invoked.payload.grantee_principal_id !== request.payload.requesting_principal_id) return false;
  const validation = validateChain(invoked, request.payload.capability_requested, EMPTY_STORE, undefined, candidate.authority_time, state.chainContext);
  if (validation.kind !== "valid") return false;
  const decision = evaluateConstraints(validation.chain, request.payload.capability_requested, request.payload.parameters, EMPTY_STORE, request.payload.requesting_principal_id, request.payload.action_id, state.constraintContext);
  if (decision.outcome !== "AUTHORIZED") return false;
  const granted: ChainLink[] = decision.chain.map((id): ChainLink => ({ kind: "delegation", delegation_id: id }));
  if (decision.approvalId !== undefined) granted.push({ kind: "approval", approval_id: decision.approvalId });
  return chainsEqual(candidate.payload.granted_chain_ref, granted);
}

/**
 * The validated grants of a journal, in journal order, or `undefined` when the guard refuses it (the caller then runs the
 * historical loop). The list is element-for-element the one the historical loop returns.
 */
export function collectValidatedGrantsOnePass(store: CanonicalStore, checked?: OnePassGuardResult): readonly ValidatedGrant[] | undefined {
  const guard = checked ?? onePassGuard(store);
  if (!guard.ok) return undefined;
  const state = new PrefixState();
  const grants: ValidatedGrant[] = [];
  for (const event of store) {
    if (event.event_type === "CAPABILITY_ISSUED" && candidateIsValid(event, state, guard.firstRequest)) {
      grants.push({ event } as ValidatedGrant);
    }
    state.apply(event);
  }
  return grants;
}
