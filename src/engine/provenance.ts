/**
 * Shared, read-only provenance primitives (historical provenance
 * investigation — see debates/provenance/QUESTION.md in the private research
 * lab). Used by explainAction.ts (recordedChainIntegrity,
 * invokedRecordedAlignment, recordedValidation) and by
 * evaluateConstraints.ts (approval-consumption chain-coherence). Kept in its
 * own module, imported by both, specifically to avoid the circular
 * dependency a shared helper would otherwise create between engine files —
 * validateChain.ts already documents the identical reasoning for why it does
 * not import back from evaluateConstraints.ts.
 *
 * Nothing here participates in any AUTHORIZED/DENIED/REQUIRES_APPROVAL/UNKNOWN
 * decision, and nothing here reads or writes total_budget or approval
 * consumption state — these are diagnostic, historical, read-only
 * computations over the canonical store alone. I20's own budget attribution
 * (evaluateConstraints.ts's terminalDelegationOf/ancestorDelegationIds)
 * deliberately does NOT use recordedTerminalId below: I20 anchors on the
 * INVOKED delegation and tolerates an otherwise-noisy authority_chain_ref by
 * design, while the provenance diagnostics here anchor on RECORDED's own
 * claimed terminal and are deliberately strict. See QUESTION.md for why
 * these must not be collapsed into one notion of "the terminal".
 *
 * Pure: no I/O, no Date.now(), no mutation of its inputs.
 */
import { MAX_CHAIN_DEPTH, type DelegationId, type InvokedRecordedAlignment, type RecordedChainIntegrity } from "../domain/types.js";
import type { AuthorityEvent, CanonicalStore, ChainLink } from "../domain/events.js";

type DelegationEvent = Extract<AuthorityEvent, { readonly event_type: "DELEGATION_CREATED" | "SUBDELEGATION_CREATED" }>;
type ActionRequestedEvent = Extract<AuthorityEvent, { readonly event_type: "ACTION_REQUESTED" }>;
type ActionExecutedEvent = Extract<AuthorityEvent, { readonly event_type: "ACTION_EXECUTED" }>;

export function findDelegation(delegationId: DelegationId, events: CanonicalStore): DelegationEvent | undefined {
  for (const event of events) {
    if (
      (event.event_type === "DELEGATION_CREATED" || event.event_type === "SUBDELEGATION_CREATED") &&
      event.payload.delegation_id === delegationId
    ) {
      return event;
    }
  }
  return undefined;
}

/**
 * Root-to-terminal canonical ancestry of `terminalId`, reconstructed purely
 * from parent_delegation_id — cycle/depth-bounded exactly like I10
 * (validateChain.ts's walkUpChain), but deliberately not that function: this
 * one performs no schema_version/can_delegate/I1 checks, because it answers
 * a purely structural question ("what is this graph shaped like"), never an
 * authorization question. Returns undefined if any node along the path is
 * missing, the walk cycles, or the depth bound is exceeded.
 */
export function canonicalAncestryIds(terminalId: DelegationId, events: CanonicalStore): readonly DelegationId[] | undefined {
  const reversed: DelegationId[] = [];
  const visited = new Set<DelegationId>();
  let currentId: DelegationId | undefined = terminalId;
  let steps = 0;
  while (currentId !== undefined && !visited.has(currentId)) {
    visited.add(currentId);
    const delegation = findDelegation(currentId, events);
    if (delegation === undefined) {
      return undefined;
    }
    reversed.push(currentId);
    if (delegation.event_type === "DELEGATION_CREATED") {
      return reversed.reverse();
    }
    currentId = delegation.payload.parent_delegation_id;
    steps += 1;
    if (steps > MAX_CHAIN_DEPTH) {
      return undefined;
    }
  }
  return undefined; // cycle, or the walk never reached a DELEGATION_CREATED root
}

function recordedDelegationIds(chain: readonly ChainLink[]): readonly DelegationId[] {
  const ids: DelegationId[] = [];
  for (const link of chain) {
    if (link.kind === "delegation") {
      ids.push(link.delegation_id);
    }
  }
  return ids;
}

/**
 * The structural leaf of the delegation subgraph cited by `execution`'s own
 * `authority_chain_ref` — RECORDED's own terminal — independent of what was
 * invoked (see invokedRecordedAlignment for that separate comparison).
 *
 * A cited delegation qualifies as the leaf iff (a) it is not the
 * parent_delegation_id of any OTHER cited delegation, and (b) its own
 * grantee is the execution's executed_by_principal_id. Exactly one such leaf
 * must exist, or the terminal is UNRESOLVABLE (undefined):
 * - zero candidates means no cited delegation is demonstrably the one the
 *   executor held;
 * - more than one means the cited set does not describe a single,
 *   unambiguous chain (two unrelated, independent, both-executor-held
 *   delegations cited together — a foreign chain injected alongside a real
 *   one naturally produces this, without needing a dedicated case for it).
 *
 * Anchored on graph position ("parent of another cited node"), never on
 * array order or array position: two delegations sharing the same grantee in
 * a row (root -> leaf, both granted to the same executor) must still resolve
 * leaf as the unique terminal, which a "unique delegation cited whose
 * grantee is the executor" rule cannot do (it would see both as candidates).
 *
 * Any dangling reference among the cited delegation IDs makes the whole
 * cited subgraph untrustworthy for this computation — fail closed
 * (undefined), rather than silently computing leaves over a partially
 * resolved graph.
 */
export function recordedTerminalId(execution: ActionExecutedEvent, events: CanonicalStore): DelegationId | undefined {
  const citedIds = [...new Set(recordedDelegationIds(execution.payload.authority_chain_ref))];
  if (citedIds.length === 0) {
    return undefined;
  }

  const resolved = new Map<DelegationId, DelegationEvent>();
  for (const id of citedIds) {
    const node = findDelegation(id, events);
    if (node === undefined) {
      return undefined;
    }
    resolved.set(id, node);
  }

  const citedSet = new Set(citedIds);
  const parentIds = new Set<DelegationId>();
  for (const id of citedIds) {
    const node = resolved.get(id);
    if (
      node !== undefined &&
      node.event_type === "SUBDELEGATION_CREATED" &&
      node.payload.parent_delegation_id !== id &&
      citedSet.has(node.payload.parent_delegation_id)
    ) {
      parentIds.add(node.payload.parent_delegation_id);
    }
  }

  const leaves = citedIds.filter((id) => !parentIds.has(id));
  const candidates = leaves.filter((id) => resolved.get(id)?.payload.grantee_principal_id === execution.payload.executed_by_principal_id);

  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Structural self-consistency: does the recorded delegation-id sequence
 * (authority_chain_ref, delegation-kind links only, in array order) equal
 * the canonical root-to-terminal ancestry of RECORDED's own terminal (see
 * recordedTerminalId)? Says nothing about whether that terminal is what was
 * invoked (see invokedRecordedAlignment) or whether it would have authorized
 * the action (see recordedValidation in explainAction.ts). Read-only: never
 * consulted by total_budget attribution (I20) or approval-grant eligibility
 * (I14/I16) — only by approval-consumption chain-coherence, which is itself
 * a fail-closed, non-authorizing check (see evaluateConstraints.ts).
 */
export function recordedChainIntegrity(execution: ActionExecutedEvent, events: CanonicalStore): RecordedChainIntegrity {
  const terminalId = recordedTerminalId(execution, events);
  if (terminalId === undefined) {
    return "UNRESOLVABLE";
  }
  const canonical = canonicalAncestryIds(terminalId, events);
  if (canonical === undefined) {
    return "UNRESOLVABLE";
  }
  const recorded = recordedDelegationIds(execution.payload.authority_chain_ref);
  const exact = recorded.length === canonical.length && recorded.every((id, index) => id === canonical[index]);
  return exact ? "EXACT" : "MISMATCH";
}

/**
 * Does RECORDED's own claimed terminal (recordedTerminalId) equal the
 * delegation actually named by ACTION_REQUESTED.delegation_id (INVOKED)?
 * Independent of whether RECORDED's own chain is internally exact — a
 * structurally EXACT recorded chain for a wholly different, non-invoked
 * delegation is DIVERGENT here even though recordedChainIntegrity reports
 * EXACT for it.
 */
export function invokedRecordedAlignment(
  request: ActionRequestedEvent,
  execution: ActionExecutedEvent,
  events: CanonicalStore,
): InvokedRecordedAlignment {
  const terminalId = recordedTerminalId(execution, events);
  if (terminalId === undefined) {
    return "UNRESOLVABLE";
  }
  return terminalId === request.payload.delegation_id ? "ALIGNED" : "DIVERGENT";
}
