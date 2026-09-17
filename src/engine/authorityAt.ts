/**
 * authorityAt — the prospective operation (SPEC.md, "question prospective").
 * Pure function: no I/O, no Date.now(), no global state, no mutation of its
 * inputs. Never requires an ACTION_REQUESTED to exist anywhere in `events`.
 */
import type { AuthorityDecision, AuthorityInstant, AuthorityQuery, Iso8601 } from "../domain/types.js";
import type { CanonicalStore } from "../domain/events.js";
import { findCandidates, validateChain } from "./validateChain.js";
import { evaluateConstraints } from "./evaluateConstraints.js";

const OUTCOME_RANK = { AUTHORIZED: 0, REQUIRES_APPROVAL: 1, DENIED: 2, UNKNOWN: 3 } as const;

/**
 * Multi-path aggregation: the best outcome found across independently
 * evaluated candidate chains wins. A broken or excessive branch never
 * degrades an independent, fully valid one; but no chain is ever credited
 * without having been demonstrated valid over its entire length.
 */
export function betterOutcome(a: AuthorityDecision, b: AuthorityDecision): AuthorityDecision {
  return OUTCOME_RANK[a.outcome] <= OUTCOME_RANK[b.outcome] ? a : b;
}

const NO_CANDIDATE: AuthorityDecision = { outcome: "UNKNOWN", reasonCode: "C24_NO_VALID_CHAIN" };

/**
 * Resolves (agentId, capability, parameters) against `visibleStore` at the
 * given trusted `authorityTime`, optionally pinned to a specific expected
 * HUMAN_ROOT (`expectedHumanRoot`). Shared by authorityAt (which always pins
 * it, and always supplies the caller's own current instant) and
 * explainAction's internal, action-agnostic resolution (which does not pin
 * the root, and may supply either the caller's current instant or a
 * reconstructed historical one — see explainAction.ts).
 *
 * `visibleStore` must already be filtered to the events visible at whatever
 * `atSequence` this evaluation corresponds to (I4: causal order) — this
 * function itself only ever consults the `authorityTime` value it is given,
 * never a sequence, never a live clock.
 */
export function resolveAuthority(
  visibleStore: CanonicalStore,
  agentId: AuthorityQuery["agentId"],
  capability: AuthorityQuery["capability"],
  parameters: AuthorityQuery["parameters"],
  expectedHumanRoot: AuthorityQuery["principalId"] | undefined,
  authorityTime: Iso8601,
): AuthorityDecision {
  const candidates = findCandidates(agentId, visibleStore);
  if (candidates.length === 0) {
    return NO_CANDIDATE;
  }

  // No placeholder participates in the comparison below: with only one
  // candidate whose own verdict is UNKNOWN, a placeholder tied at the same
  // rank would otherwise win the tie-break and silently swallow that
  // candidate's real (and more specific) reason code.
  let best: AuthorityDecision | undefined;
  for (const candidate of candidates) {
    const validation = validateChain(candidate, capability, visibleStore, expectedHumanRoot, authorityTime);
    let decision: AuthorityDecision;
    if (validation.kind === "valid") {
      decision = evaluateConstraints(validation.chain, capability, parameters, visibleStore, agentId);
    } else if (validation.kind === "denied") {
      decision = { outcome: "DENIED", reasonCode: validation.reasonCode };
    } else {
      decision = { outcome: "UNKNOWN", reasonCode: validation.reasonCode };
    }
    best = best === undefined ? decision : betterOutcome(best, decision);
    if (best.outcome === "AUTHORIZED") {
      break; // nothing can improve on AUTHORIZED
    }
  }
  return best ?? NO_CANDIDATE;
}

export function authorityAt(events: CanonicalStore, query: AuthorityQuery, at: AuthorityInstant): AuthorityDecision {
  const visible = events.filter((event) => event.sequence <= at.atSequence);
  return resolveAuthority(visible, query.agentId, query.capability, query.parameters, query.principalId, at.authorityTime);
}
