/**
 * Conservative structural check of a journal snapshot (performance only; it never decides anything).
 *
 * `isJournalShapeSound(store)` answers `true` only when EVERY event has exactly the structure the engine's
 * types promise, field by field (envelope, payload, nested money / capability / chain-link / constraint shapes).
 * On such a journal the grant-validation code cannot throw: every property it reads exists with the right type.
 *
 * It is ONE-SIDED by design: `false` means "do not rely on the fast path, run the original code exactly as before"
 * (including any error it throws); `true` must imply "the original code would not have thrown". It does not judge
 * semantic validity (a forged, mis-chained or mis-fingerprinted grant is shape-sound; the engine still rejects it by
 * its own rules). One deliberate over-restriction: a journal holding action parameters that fail the engine's own
 * `isWellFormedActionParameters` is treated as UNSOUND (the engine tolerates those, see
 * tests/engine/malformedHistoricalParameters.test.ts, but such journals simply keep the original, slower path).
 *
 * It reads the array once, allocates nothing, keeps no state, and trusts nothing about the storage.
 */
import { isWellFormedActionParameters } from "../domain/types.js";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isMoney = (v: unknown): boolean => isObj(v) && typeof v.value === "number" && Number.isSafeInteger(v.value) && v.value >= 0 && isStr(v.currency) && v.currency.length > 0;
const isCapability = (v: unknown): boolean => isObj(v) && isStr(v.resource) && isStr(v.action);
const isChain = (v: unknown): boolean =>
  Array.isArray(v) && v.every((l) => isObj(l) && ((l.kind === "delegation" && isStr(l.delegation_id)) || (l.kind === "approval" && isStr(l.approval_id))));

function isConstraints(p: Record<string, unknown>): boolean {
  const e = p.expires_at;
  if (!isObj(e) || !((e.kind === "at" && isStr(e.value)) || e.kind === "no_expiry")) return false;
  if (p.max_amount !== undefined && !isMoney(p.max_amount)) return false;
  if (p.total_budget !== undefined && !isMoney(p.total_budget)) return false;
  if (p.thresholds !== undefined && !(isObj(p.thresholds) && isMoney(p.thresholds.automatic_max_amount) && isMoney(p.thresholds.approval_max_amount))) return false;
  return true;
}

function isPayloadSound(type: unknown, p: unknown): boolean {
  if (!isObj(p)) return false;
  switch (type) {
    case "DELEGATION_CREATED":
      return isConstraints(p) && isStr(p.delegation_id) && isStr(p.grantor_principal_id) && isStr(p.grantor_type) && isStr(p.grantee_principal_id) && Array.isArray(p.capabilities) && p.capabilities.every(isCapability) && isBool(p.can_delegate) && p.parent_delegation_id === null;
    case "SUBDELEGATION_CREATED":
      return isConstraints(p) && isStr(p.delegation_id) && isStr(p.parent_delegation_id) && isStr(p.grantor_principal_id) && isStr(p.grantee_principal_id) && Array.isArray(p.capabilities) && p.capabilities.every(isCapability) && isBool(p.can_delegate);
    case "DELEGATION_REVOKED":
      return isStr(p.delegation_id) && isStr(p.revoked_by_principal_id) && isStr(p.reason_code);
    case "ACTION_REQUESTED":
      return isStr(p.action_id) && isStr(p.requesting_principal_id) && isStr(p.delegation_id) && isCapability(p.capability_requested) && isWellFormedActionParameters(p.parameters);
    case "APPROVAL_REQUESTED":
      return isStr(p.approval_id) && isStr(p.action_id) && isStr(p.requested_from_principal_id) && isStr(p.policy_reason_code);
    case "APPROVAL_GRANTED":
      return isStr(p.approval_id) && isStr(p.action_id) && isStr(p.approving_principal_id);
    case "APPROVAL_DENIED":
      return isStr(p.approval_id) && isStr(p.action_id) && isStr(p.denying_principal_id) && isStr(p.reason_code);
    case "ACTION_EXECUTED":
      return isStr(p.action_id) && isStr(p.executed_by_principal_id) && isStr(p.action_fingerprint) && isInt(p.decision_sequence) && isChain(p.authority_chain_ref) && isStr(p.execution_result);
    case "CAPABILITY_ISSUED":
      return isStr(p.capability_id) && isStr(p.action_id) && isStr(p.action_fingerprint) && isInt(p.decision_sequence) && isChain(p.granted_chain_ref) && isStr(p.enforcement_point_id) && isStr(p.expires_at);
    case "CAPABILITY_REDEEMED":
      return isStr(p.capability_id) && isStr(p.action_id) && isStr(p.action_fingerprint) && isInt(p.decision_sequence) && isStr(p.enforcement_point_id);
    default:
      return false;
  }
}

export function isJournalShapeSound(store: readonly unknown[]): boolean {
  if (!Array.isArray(store)) return false;
  for (let i = 0; i < store.length; i++) {
    const e: unknown = store[i];
    if (!isObj(e)) return false;
    if (!isStr(e.event_id) || !isInt(e.schema_version) || !isStr(e.occurred_at) || !isStr(e.principal_id)) return false;
    if (!isInt(e.sequence) || !isStr(e.authority_time) || !isStr(e.recorded_at) || !isStr(e.assurance_level)) return false;
    if (!isPayloadSound(e.event_type, e.payload)) return false;
  }
  return true;
}
