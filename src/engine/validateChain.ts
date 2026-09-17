/**
 * Chain resolution: walks a candidate delegation back to its root, revalidating
 * I5 (bounding), I12 (right to delegate), I13 (right to revoke, via revocation
 * checks), I17/trust-anchor (HUMAN_ROOT), I10 (cycle/depth), I1 (fail-closed on
 * anything structurally incomplete) — every time, from the canonical store
 * alone. Never trusts that ingestion already did this work (there is no
 * ingestion-time validation state carried over here at all).
 *
 * Pure: no I/O, no Date.now(), no mutation of its inputs.
 */
import {
  sameCapability,
  type AmountThresholds,
  type Capability,
  type DelegationId,
  type DenialReasonCode,
  type ExpiresAt,
  type Iso8601,
  type Money,
  type PrincipalId,
  type UnknownReasonCode,
} from "../domain/types.js";
import { CURRENT_SCHEMA_VERSION, MAX_CHAIN_DEPTH } from "../domain/types.js";
import type { AuthorityEvent, CanonicalStore } from "../domain/events.js";
import { remainingBudget } from "./evaluateConstraints.js";

export type DelegationEvent = Extract<
  AuthorityEvent,
  { readonly event_type: "DELEGATION_CREATED" | "SUBDELEGATION_CREATED" }
>;

export function asDelegationEvent(event: AuthorityEvent): DelegationEvent | undefined {
  if (event.event_type === "DELEGATION_CREATED" || event.event_type === "SUBDELEGATION_CREATED") {
    return event;
  }
  return undefined;
}

/** Every delegation (root or sub) whose grantee is agentId — the candidate terminal links for a query. */
export function findCandidates(agentId: PrincipalId, visibleStore: CanonicalStore): readonly DelegationEvent[] {
  const candidates: DelegationEvent[] = [];
  for (const event of visibleStore) {
    const delegation = asDelegationEvent(event);
    if (delegation !== undefined && delegation.payload.grantee_principal_id === agentId) {
      candidates.push(delegation);
    }
  }
  return candidates;
}

export type ChainValidationResult =
  | { readonly kind: "valid"; readonly chain: readonly DelegationEvent[] }
  | { readonly kind: "denied"; readonly reasonCode: DenialReasonCode }
  | { readonly kind: "unknown"; readonly reasonCode: UnknownReasonCode };

const DELEGATION_CREATED_KEYS = new Set([
  "delegation_id",
  "grantor_principal_id",
  "grantor_type",
  "grantee_principal_id",
  "capabilities",
  "can_delegate",
  "expires_at",
  "max_amount",
  "total_budget",
  "thresholds",
  "parent_delegation_id",
]);

const SUBDELEGATION_CREATED_KEYS = new Set([
  "delegation_id",
  "parent_delegation_id",
  "grantor_principal_id",
  "grantee_principal_id",
  "capabilities",
  "can_delegate",
  "expires_at",
  "max_amount",
  "total_budget",
  "thresholds",
]);

function hasUnknownConstraintKeys(node: DelegationEvent): boolean {
  const knownKeys = node.event_type === "DELEGATION_CREATED" ? DELEGATION_CREATED_KEYS : SUBDELEGATION_CREATED_KEYS;
  return Object.keys(node.payload).some((key) => !knownKeys.has(key));
}

function buildDelegationIndex(visibleStore: CanonicalStore): ReadonlyMap<DelegationId, DelegationEvent> {
  const index = new Map<DelegationId, DelegationEvent>();
  for (const event of visibleStore) {
    const delegation = asDelegationEvent(event);
    if (delegation !== undefined) {
      index.set(delegation.payload.delegation_id, delegation);
    }
  }
  return index;
}

type WalkResult =
  | { readonly ok: true; readonly chain: readonly DelegationEvent[] }
  | { readonly ok: false; readonly reason: "missing" | "cycle" | "depth" };

/** Walks from a terminal delegation up to its root, root-to-terminal ordered on success. */
function walkUpChain(
  startId: DelegationId,
  index: ReadonlyMap<DelegationId, DelegationEvent>,
): WalkResult {
  const visiting = new Set<DelegationId>();
  const reversedChain: DelegationEvent[] = [];
  let currentId: DelegationId = startId;
  let edges = 0;
  for (;;) {
    if (visiting.has(currentId)) {
      return { ok: false, reason: "cycle" };
    }
    visiting.add(currentId);
    const node = index.get(currentId);
    if (node === undefined) {
      return { ok: false, reason: "missing" };
    }
    reversedChain.push(node);
    if (node.event_type === "DELEGATION_CREATED") {
      return { ok: true, chain: reversedChain.reverse() };
    }
    edges += 1;
    if (edges > MAX_CHAIN_DEPTH) {
      return { ok: false, reason: "depth" };
    }
    currentId = node.payload.parent_delegation_id;
  }
}

function findRoot(
  delegationId: DelegationId,
  index: ReadonlyMap<DelegationId, DelegationEvent>,
): DelegationEvent | undefined {
  const visiting = new Set<DelegationId>();
  let currentId: DelegationId = delegationId;
  for (;;) {
    if (visiting.has(currentId)) {
      return undefined;
    }
    visiting.add(currentId);
    const node = index.get(currentId);
    if (node === undefined) {
      return undefined;
    }
    if (node.event_type === "DELEGATION_CREATED") {
      return node;
    }
    currentId = node.payload.parent_delegation_id;
  }
}

/** I13: only the delegation's own direct grantor, or the grantor of its chain's root, may revoke it with effect. */
function isRevoked(
  node: DelegationEvent,
  visibleStore: CanonicalStore,
  index: ReadonlyMap<DelegationId, DelegationEvent>,
): boolean {
  const directGrantor = node.payload.grantor_principal_id;
  const root = findRoot(node.payload.delegation_id, index);
  const rootGrantor = root !== undefined ? root.payload.grantor_principal_id : undefined;
  return visibleStore.some(
    (event) =>
      event.event_type === "DELEGATION_REVOKED" &&
      event.payload.delegation_id === node.payload.delegation_id &&
      (event.principal_id === directGrantor || (rootGrantor !== undefined && event.principal_id === rootGrantor)),
  );
}

/**
 * I4 / SPEC.md expiration convention: authorityTime < expires_at is still
 * valid; authorityTime >= expires_at is expired (the boundary itself counts
 * as expired — exclusive). `authorityTime` is always the caller-supplied
 * trusted instant (PROMPT 3b) — never derived from occurred_at, never a
 * `max(...)` over visible events' own authority_time (time can pass with no
 * new event at all; that derivation would make a delegation that expired
 * three hours ago look valid forever, for want of a subsequent event).
 */
function isExpired(expires: ExpiresAt, authorityTime: Iso8601): boolean {
  if (expires.kind === "no_expiry") {
    return false;
  }
  return Date.parse(authorityTime) >= Date.parse(expires.value);
}

/** Absence on the parent side means unbounded (+Infinity); absence on the child side while the parent bounds it is a widening violation. */
function numericBoundOk(childValue: number | undefined, parentValue: number | undefined): boolean {
  if (parentValue === undefined) {
    return true;
  }
  if (childValue === undefined) {
    return false;
  }
  return childValue <= parentValue;
}

function expiryWithinBound(child: ExpiresAt, parent: ExpiresAt): boolean {
  if (parent.kind === "no_expiry") {
    return true;
  }
  if (child.kind === "no_expiry") {
    return false;
  }
  return Date.parse(child.value) <= Date.parse(parent.value);
}

function thresholdsBoundOk(child: AmountThresholds | undefined, parent: AmountThresholds | undefined): boolean {
  if (parent === undefined) {
    return true;
  }
  if (child === undefined) {
    return false;
  }
  return child.automatic_max_amount <= parent.automatic_max_amount && child.approval_max_amount <= parent.approval_max_amount;
}

function totalBudgetBoundOk(child: Money | undefined, parent: Money | undefined, parentId: DelegationId, visibleStore: CanonicalStore): boolean {
  if (parent === undefined) {
    return true;
  }
  if (child === undefined) {
    return false;
  }
  return child.value <= remainingBudget(parentId, parent, visibleStore);
}

function capabilitiesSubset(child: readonly Capability[], parent: readonly Capability[]): boolean {
  return child.every((childCapability) => parent.some((parentCapability) => sameCapability(childCapability, parentCapability)));
}

/**
 * Validates one candidate chain, from `candidate` (terminal, grantee ===
 * agentId) back to its root. `expectedHumanRoot` pins the query to a specific
 * accountable HUMAN_ROOT (authorityAt's contract); pass `undefined` to accept
 * any HUMAN_ROOT (explainAction's internal, action-agnostic resolution).
 */
export function validateChain(
  candidate: DelegationEvent,
  capability: Capability,
  visibleStore: CanonicalStore,
  expectedHumanRoot: PrincipalId | undefined,
  authorityTime: Iso8601,
): ChainValidationResult {
  const index = buildDelegationIndex(visibleStore);
  const walk = walkUpChain(candidate.payload.delegation_id, index);
  if (!walk.ok) {
    if (walk.reason === "missing") {
      return { kind: "unknown", reasonCode: "C10_INCOMPLETE_CHAIN" };
    }
    if (walk.reason === "cycle") {
      return { kind: "unknown", reasonCode: "C18_CYCLE_DETECTED" };
    }
    return { kind: "unknown", reasonCode: "MAX_CHAIN_DEPTH_EXCEEDED" };
  }
  const chain = walk.chain;

  // I1 fail-closed: every structural gap (unsupported schema, unrecognized
  // constraint keys, a missing can_delegate) must be resolved before ANY
  // DENIED verdict is considered — DENIED requires full knowledge.
  for (const node of chain) {
    if (node.schema_version !== CURRENT_SCHEMA_VERSION) {
      return { kind: "unknown", reasonCode: "UNKNOWN_SCHEMA_VERSION" };
    }
    if (hasUnknownConstraintKeys(node)) {
      return { kind: "unknown", reasonCode: "C22_UNKNOWN_CONSTRAINT_TYPE" };
    }
    if (typeof node.payload.can_delegate !== "boolean") {
      return { kind: "unknown", reasonCode: "C15_MISSING_CAN_DELEGATE" };
    }
  }

  const root = chain[0];
  if (root === undefined || root.event_type !== "DELEGATION_CREATED") {
    return { kind: "unknown", reasonCode: "C10_INCOMPLETE_CHAIN" };
  }
  if (root.payload.grantor_type === "AGENT") {
    return { kind: "unknown", reasonCode: "C17_AGENT_ROOT_NO_HUMAN_ANCHOR" };
  }
  if (expectedHumanRoot !== undefined && root.payload.grantor_principal_id !== expectedHumanRoot) {
    // A chain that is otherwise fully valid but rooted at a different
    // HUMAN_ROOT than asserted is positive proof this pairing lacks
    // authority — DENIED, not UNKNOWN (SPEC.md, trust anchor).
    return { kind: "denied", reasonCode: "C11_CAPABILITY_NOT_COVERED" };
  }

  for (const node of chain) {
    if (isExpired(node.payload.expires_at, authorityTime)) {
      return { kind: "denied", reasonCode: "C11_CAPABILITY_NOT_COVERED" };
    }
    if (isRevoked(node, visibleStore, index)) {
      return { kind: "denied", reasonCode: "C12_DELEGATION_REVOKED" };
    }
  }

  for (let i = 1; i < chain.length; i += 1) {
    const parent = chain[i - 1];
    const child = chain[i];
    if (parent === undefined || child === undefined) {
      return { kind: "unknown", reasonCode: "C10_INCOMPLETE_CHAIN" };
    }
    const parentGrantee = parent.payload.grantee_principal_id;
    if (child.principal_id !== parentGrantee || child.payload.grantor_principal_id !== parentGrantee) {
      return { kind: "denied", reasonCode: "C11_CAPABILITY_NOT_COVERED" };
    }
    if (parent.payload.can_delegate !== true) {
      return { kind: "denied", reasonCode: "C11_CAPABILITY_NOT_COVERED" };
    }
    if (!capabilitiesSubset(child.payload.capabilities, parent.payload.capabilities)) {
      return { kind: "denied", reasonCode: "C11_CAPABILITY_NOT_COVERED" };
    }
    if (!expiryWithinBound(child.payload.expires_at, parent.payload.expires_at)) {
      return { kind: "denied", reasonCode: "C11_CAPABILITY_NOT_COVERED" };
    }
    if (!numericBoundOk(child.payload.max_amount?.value, parent.payload.max_amount?.value)) {
      return { kind: "denied", reasonCode: "C11_CAPABILITY_NOT_COVERED" };
    }
    if (!thresholdsBoundOk(child.payload.thresholds, parent.payload.thresholds)) {
      return { kind: "denied", reasonCode: "C11_CAPABILITY_NOT_COVERED" };
    }
    if (!totalBudgetBoundOk(child.payload.total_budget, parent.payload.total_budget, parent.payload.delegation_id, visibleStore)) {
      return { kind: "denied", reasonCode: "C9_TOTAL_BUDGET_EXCEEDED" };
    }
  }

  const terminal = chain[chain.length - 1];
  if (terminal === undefined || !terminal.payload.capabilities.some((c) => sameCapability(c, capability))) {
    return { kind: "denied", reasonCode: "C11_CAPABILITY_NOT_COVERED" };
  }

  return { kind: "valid", chain };
}
