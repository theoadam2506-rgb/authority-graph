/**
 * Computes the EXPECTED decision of a scenario probe by calling the existing
 * engine (`ingestAll` + `authorityAt`). No decision logic lives here: this
 * file only translates the declarative scenario into engine drafts.
 */
import { ingestAll } from "../engine/authority.js";
import { authorityAt } from "../engine/authority.js";
import type { DraftAuthorityEvent } from "../domain/events.js";
import {
  CURRENT_SCHEMA_VERSION, capability, delegationId, eventId, iso8601, monetaryParameters, money, noExpiry,
  principalId, reasonCode, sequenceNumber, thresholds, type AuthorityDecision,
} from "../domain/types.js";
import { ScenarioError, type Scenario, type ScenarioEvent } from "./scenario.js";

function cap(s: string) {
  const [resource, action] = s.split(".") as [string, string];
  return capability(resource, action);
}

function toDraft(e: ScenarioEvent, index: number): DraftAuthorityEvent {
  const envelope = {
    event_id: eventId(`conformance-evt-${index + 1}`),
    schema_version: CURRENT_SCHEMA_VERSION,
    occurred_at: iso8601(e.at),
  };
  switch (e.type) {
    case "delegate":
      return {
        ...envelope, principal_id: principalId(e.grantor), event_type: "DELEGATION_CREATED",
        payload: {
          delegation_id: delegationId(e.id), grantor_principal_id: principalId(e.grantor), grantor_type: e.grantor_type,
          grantee_principal_id: principalId(e.grantee), capabilities: e.capabilities.map(cap), can_delegate: e.can_delegate,
          expires_at: noExpiry, thresholds: thresholds(money(e.limit.value, e.limit.currency), money(e.limit.value, e.limit.currency)),
          parent_delegation_id: null,
        },
      };
    case "subdelegate":
      return {
        ...envelope, principal_id: principalId(e.grantor), event_type: "SUBDELEGATION_CREATED",
        payload: {
          delegation_id: delegationId(e.id), parent_delegation_id: delegationId(e.parent),
          grantor_principal_id: principalId(e.grantor), grantee_principal_id: principalId(e.grantee),
          capabilities: e.capabilities.map(cap), can_delegate: e.can_delegate, expires_at: noExpiry,
          thresholds: thresholds(money(e.limit.value, e.limit.currency), money(e.limit.value, e.limit.currency)),
        },
      };
    case "revoke":
      return {
        ...envelope, principal_id: principalId(e.by), event_type: "DELEGATION_REVOKED",
        payload: { delegation_id: delegationId(e.target), revoked_by_principal_id: principalId(e.by), reason_code: reasonCode("CONFORMANCE_SCENARIO_REVOCATION") },
      };
  }
}

export interface ExpectedDecision {
  readonly engine_decision: AuthorityDecision;
}

/** One entry per probe, in scenario order. Throws ScenarioError if the engine does not accept every scenario event. */
export function computeExpected(scenario: Scenario): Map<string, ExpectedDecision> {
  const drafts = scenario.events.map(toDraft);
  const { outcomes, canonicalStore } = ingestAll(drafts, { authorityTime: (_d, i) => iso8601((scenario.events[i] as ScenarioEvent).at) });
  outcomes.forEach((o, i) => {
    if (!o.accepted) {
      throw new ScenarioError(`${scenario.scenario_id}: engine rejected scenario event #${i + 1} at ingestion (${o.reasonCode}); the scenario does not describe a log the engine accepts`);
    }
  });
  const result = new Map<string, ExpectedDecision>();
  for (const p of scenario.probes) {
    const decision = authorityAt(
      canonicalStore,
      { agentId: principalId(p.agent), principalId: principalId(scenario.human_root), capability: cap(p.capability), parameters: monetaryParameters(money(p.amount.value, p.amount.currency)) },
      { atSequence: sequenceNumber(p.after_event), authorityTime: iso8601(p.at) },
    );
    result.set(p.probe_id, { engine_decision: decision });
  }
  return result;
}
