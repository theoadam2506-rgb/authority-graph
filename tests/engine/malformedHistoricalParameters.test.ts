import { describe, expect, it } from "vitest";
import { authorityAt } from "../../src/engine/authority.js";
import { toDraft, type CanonicalStore } from "../../src/domain/events.js";
import { enforcementPointId, iso8601, money, monetaryParameters, thresholds } from "../../src/domain/types.js";
import { remainingCapacity, type ValidatedGrant } from "../../src/engine/capacity.js";
import { remainingBudget } from "../../src/engine/evaluateConstraints.js";
import { ingestAll } from "../../src/engine/ingest.js";
import { issueCapability } from "../../src/engine/issueCapability.js";
import { AGENT_A, EUR, PURCHASE_ORDER_CREATE, THEO, actionExecution, actionRequest, delegationLink, instant, rootDelegation, sequentialClock } from "../fixtures/scenarios.js";

describe("malformed monetary parameters", () => {
  it("rejects negative, fractional, non-finite and unsafe amounts at ingress", () => {
    const root = toDraft(rootDelegation({ sequence: 1, id: "d-negative", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT_A, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false }));
    for (const [index, value] of [-1, 0.5, Number.NaN, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1].entries()) {
      const request = toDraft(actionRequest({ sequence: index + 2, id: `a-negative-${index}`, requester: AGENT_A, delegationId: "d-negative" }));
      const hostile = {
        ...request,
        payload: { ...request.payload, parameters: { kind: "monetary", amount: { value, currency: "EUR" } } },
      } as typeof request;
      const result = ingestAll([root, hostile], sequentialClock);
      expect(result.outcomes[1]).toEqual({ accepted: false, reasonCode: "MALFORMED_ACTION_PARAMETERS" });
    }
    expect(() => money(Number.MAX_SAFE_INTEGER + 1, "EUR")).toThrow(/safe integer/);
  });

  it("contains legacy malformed requests so another agent's budget decision remains intact", () => {
    const root = rootDelegation({
      sequence: 1,
      id: "d-legacy-safe",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      totalBudget: EUR(1000),
      amountThresholds: thresholds(EUR(1000), EUR(1000)),
    });
    const malformedRequest = actionRequest({ sequence: 2, id: "a-legacy-malformed", requester: AGENT_A, delegationId: "d-legacy-safe" });
    const historicalRequest = {
      ...malformedRequest,
      payload: { ...malformedRequest.payload, parameters: { kind: "monetary" } },
    } as typeof malformedRequest;
    const execution = actionExecution({
      sequence: 3,
      actionId: "a-legacy-malformed",
      executor: AGENT_A,
      decisionSequence: 2,
      chain: [delegationLink("d-legacy-safe")],
      fingerprintOverride: "historical-malformed",
    });
    if (root.event_type !== "DELEGATION_CREATED" || historicalRequest.event_type !== "ACTION_REQUESTED") {
      throw new Error("fixture must create the expected event types");
    }
    const store = [root, historicalRequest, execution] as CanonicalStore;
    expect(remainingBudget(root.payload.delegation_id, EUR(1000), store)).toBe(1000);
    const assertedGrant = {
      event: { payload: { action_id: historicalRequest.payload.action_id, granted_chain_ref: [delegationLink("d-legacy-safe")] } },
    } as unknown as ValidatedGrant;
    expect(remainingCapacity(root.payload.delegation_id, EUR(1000), [assertedGrant], store)).toBe(1000);
    expect(authorityAt(store, {
      agentId: AGENT_A,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: monetaryParameters(EUR(500)),
    }, instant(3))).toMatchObject({ outcome: "AUTHORIZED" });
    expect(issueCapability(
      store,
      { principalId: AGENT_A },
      { action_id: historicalRequest.payload.action_id, enforcement_point_id: enforcementPointId("ep-test") },
      {} as never,
      iso8601("2025-01-01T00:00:03.000Z"),
    )).toEqual({
      ok: false,
      reason: "NOT_AUTHORIZED",
      decision: { outcome: "UNKNOWN", reasonCode: "C22_UNKNOWN_CONSTRAINT_TYPE" },
    });
  });
});
