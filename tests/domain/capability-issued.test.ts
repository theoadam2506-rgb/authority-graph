/**
 * CAPABILITY_ISSUED — the first event of the new GRANTED model, introduced
 * on its own, ahead of any admissibility check, redemption, or accounting
 * logic that will eventually consume it. Every test here demonstrates
 * ISOLATION: this new event type must be constructible and ingestible
 * without altering, in any way, how the 8 existing event types resolve.
 *
 * `granted_chain_ref` is deliberately unvalidated at this stage — see the
 * docstring on `CapabilityIssuedPayload` in src/domain/events.ts. Nothing
 * below should be read as demonstrating that a caller-supplied chain is
 * trusted; only that the new shape exists and does not (yet) interfere with
 * anything legacy.
 */
import { describe, expect, it } from "vitest";
import { authorityAt, ingestAll } from "../../src/engine/authority.js";
import { explainAction } from "../../src/engine/explainAction.js";
import { remainingBudget } from "../../src/engine/evaluateConstraints.js";
import { computeActionFingerprint, isEventType, toDraft, type AuthorityEvent, type CapabilityIssuedPayload } from "../../src/domain/events.js";
import { capabilityId, enforcementPointId, iso8601, monetaryParameters, schemaVersion, sequenceNumber, thresholds } from "../../src/domain/types.js";
import { evt, principal } from "../fixtures/ids.js";
import { EUR, PURCHASE_ORDER_CREATE, THEO, actionRequest, delegationLink, instant, rootDelegation, sequentialClock } from "../fixtures/scenarios.js";

const AGENT = principal("capability-issued-test-agent");
const EP = enforcementPointId("ep-gateway-1");
const FIVE_HUNDRED_EUR = monetaryParameters(EUR(500));
const FINGERPRINT = computeActionFingerprint(PURCHASE_ORDER_CREATE, FIVE_HUNDRED_EUR);

/**
 * Mirrors tests/fixtures/builders.ts's own envelope() shape exactly, kept
 * local since CAPABILITY_ISSUED has no scenario builder yet.
 *
 * `principal_id: THEO` below is an arbitrary placeholder, not a claim that
 * THEO (or any other existing principal) issues capabilities. It exists
 * only because EventEnvelopeSource currently requires every event to carry
 * a PrincipalId, and no distinct concept for "the identity of the Authority
 * service that issued this capability" exists yet (see the docstring on
 * CapabilityIssuedPayload in src/domain/events.ts). No test below asserts
 * anything about this field's value — it is present purely to satisfy the
 * envelope's current shape.
 */
function capabilityIssuedEvent(sequence: number, payload: CapabilityIssuedPayload): AuthorityEvent {
  const at = iso8601(new Date(Date.parse("2025-01-01T00:00:00.000Z") + sequence * 1000).toISOString());
  return {
    event_id: evt(`capability-issued-${sequence}`),
    schema_version: schemaVersion(1),
    occurred_at: at,
    principal_id: THEO, // placeholder only — see the docstring above.
    sequence: sequenceNumber(sequence),
    authority_time: at,
    recorded_at: at,
    assurance_level: "ASSERTED_UNVERIFIED",
    event_type: "CAPABILITY_ISSUED",
    payload,
  };
}

function baseScenario() {
  const delegationRoot = rootDelegation({
    sequence: 1,
    id: "d-root",
    grantor: THEO,
    grantorType: "HUMAN_ROOT",
    grantee: AGENT,
    capabilities: [PURCHASE_ORDER_CREATE],
    canDelegate: false,
    totalBudget: EUR(1000),
    amountThresholds: thresholds(100000, 100000),
  });
  const request = actionRequest({
    sequence: 2,
    id: "act-1",
    requester: AGENT,
    delegationId: "d-root",
    parameters: FIVE_HUNDRED_EUR,
  });
  if (!isEventType(delegationRoot, "DELEGATION_CREATED") || !isEventType(request, "ACTION_REQUESTED")) {
    throw new Error("fixture builders returned an unexpected event_type");
  }
  return { delegationRoot, request };
}

describe("CAPABILITY_ISSUED — construction", () => {
  it("1. is constructible as a valid AuthorityEvent with the minimal payload", () => {
    const { request } = baseScenario();
    const event = capabilityIssuedEvent(3, {
      capability_id: capabilityId("cap-1"),
      action_id: request.payload.action_id,
      action_fingerprint: FINGERPRINT,
      decision_sequence: sequenceNumber(2),
      granted_chain_ref: [delegationLink("d-root")],
      enforcement_point_id: EP,
      expires_at: iso8601("2025-01-01T00:05:00.000Z"),
    });

    expect(event.event_type).toBe("CAPABILITY_ISSUED");
    if (!isEventType(event, "CAPABILITY_ISSUED")) {
      throw new Error("expected a CAPABILITY_ISSUED event");
    }
    expect(event.payload.capability_id).toBe("cap-1");
    expect(event.payload.enforcement_point_id).toBe("ep-gateway-1");

    // toDraft() must round-trip it exactly like every other event type.
    const draft = toDraft(event);
    expect(draft.event_type).toBe("CAPABILITY_ISSUED");
    expect(draft.payload).toBe(event.payload);
  });
});

describe("CAPABILITY_ISSUED — isolation from legacy resolution", () => {
  it("2 & 3. the 8 existing event types, alone, resolve exactly as before (no capability present)", () => {
    const { delegationRoot, request } = baseScenario();
    const ingested = ingestAll([toDraft(delegationRoot), toDraft(request)], sequentialClock);
    const query = { agentId: AGENT, principalId: THEO, capability: PURCHASE_ORDER_CREATE, parameters: FIVE_HUNDRED_EUR };
    expect(authorityAt(ingested.canonicalStore, query, instant(2)).outcome).toBe("AUTHORIZED");
  });

  it("4. authorityAt() gives the identical outcome whether or not a CAPABILITY_ISSUED event is also present", () => {
    const { delegationRoot, request } = baseScenario();
    const withoutCapability = ingestAll([toDraft(delegationRoot), toDraft(request)], sequentialClock);

    const capabilityEvent = capabilityIssuedEvent(3, {
      capability_id: capabilityId("cap-1"),
      action_id: request.payload.action_id,
      action_fingerprint: FINGERPRINT,
      decision_sequence: sequenceNumber(2),
      granted_chain_ref: [delegationLink("d-root")],
      enforcement_point_id: EP,
      expires_at: iso8601("2025-01-01T00:05:00.000Z"),
    });
    const withCapability = ingestAll([toDraft(delegationRoot), toDraft(request), toDraft(capabilityEvent)], sequentialClock);

    const query = { agentId: AGENT, principalId: THEO, capability: PURCHASE_ORDER_CREATE, parameters: FIVE_HUNDRED_EUR };
    const before = authorityAt(withoutCapability.canonicalStore, query, instant(2));
    const after = authorityAt(withCapability.canonicalStore, query, instant(3));
    expect(after).toEqual(before);
  });

  it("5. CAPABILITY_ISSUED alone must not be interpreted as ACTION_EXECUTED by explainAction", () => {
    const { delegationRoot, request } = baseScenario();
    const capabilityEvent = capabilityIssuedEvent(3, {
      capability_id: capabilityId("cap-1"),
      action_id: request.payload.action_id,
      action_fingerprint: FINGERPRINT,
      decision_sequence: sequenceNumber(2),
      granted_chain_ref: [delegationLink("d-root")],
      enforcement_point_id: EP,
      expires_at: iso8601("2025-01-01T00:05:00.000Z"),
    });
    const ingested = ingestAll([toDraft(delegationRoot), toDraft(request), toDraft(capabilityEvent)], sequentialClock);

    const explanation = explainAction(ingested.canonicalStore, { actionId: request.payload.action_id }, instant(3));
    // No ACTION_EXECUTED exists — explainAction must report no execution at
    // all, never mistake the CAPABILITY_ISSUED event for one.
    expect(explanation.execution).toBeUndefined();
  });

  it("6. CAPABILITY_ISSUED must not move remainingBudget for the legacy accounting path", () => {
    const { delegationRoot, request } = baseScenario();
    const capabilityEvent = capabilityIssuedEvent(3, {
      capability_id: capabilityId("cap-1"),
      action_id: request.payload.action_id,
      action_fingerprint: FINGERPRINT,
      decision_sequence: sequenceNumber(2),
      // Deliberately cites the very same delegation total_budget is bound
      // to — remainingBudget must still ignore this event entirely, since
      // it only ever scans ACTION_EXECUTED.
      granted_chain_ref: [delegationLink("d-root")],
      enforcement_point_id: EP,
      expires_at: iso8601("2025-01-01T00:05:00.000Z"),
    });
    const ingested = ingestAll([toDraft(delegationRoot), toDraft(request), toDraft(capabilityEvent)], sequentialClock);

    const remaining = remainingBudget(delegationRoot.payload.delegation_id, EUR(1000), ingested.canonicalStore);
    expect(remaining).toBe(1000);
  });
});
