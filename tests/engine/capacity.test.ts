/**
 * PR3 — pure semantics of the new authority_capacity accounting
 * (src/engine/capacity.ts), sourced from CAPABILITY_ISSUED grants instead
 * of ACTION_EXECUTED. remainingBudget (legacy, I20, evaluateConstraints.ts)
 * is deliberately never imported or exercised for its own sake here —
 * tests D/legacy-isolation below only prove the two worlds do not interfere.
 *
 * Every grant below is built via the local `testOnlyValidatedGrant` cast
 * defined in this file — never through a production-exported factory (none
 * exists, deliberately: see the docstring on `ValidatedGrant` in
 * src/engine/capacity.ts). Nothing here demonstrates that a real
 * admissibility check exists yet (it doesn't — Phase 4/4A). These tests
 * only pin down the pure arithmetic `remainingCapacity` performs ONCE a
 * grant is already known-valid, which is exactly the contract
 * `ValidatedGrant` documents.
 */
import { describe, expect, it } from "vitest";
import { ingestAll } from "../../src/engine/authority.js";
import { remainingBudget } from "../../src/engine/evaluateConstraints.js";
import { remainingCapacity, type CapabilityIssuedEvent, type ValidatedGrant } from "../../src/engine/capacity.js";
import { computeActionFingerprint, isEventType, toDraft, type CapabilityIssuedPayload } from "../../src/domain/events.js";
import { capabilityId, enforcementPointId, iso8601, monetaryParameters, schemaVersion, sequenceNumber, thresholds } from "../../src/domain/types.js";
import { evt, principal } from "../fixtures/ids.js";
import { EUR, PURCHASE_ORDER_CREATE, THEO, actionExecution, actionRequest, delegationLink, rootDelegation, sequentialClock, subDelegation } from "../fixtures/scenarios.js";

const AGENT_A = principal("capacity-test-agent-a");
const AGENT_B = principal("capacity-test-agent-b");
const EP = enforcementPointId("ep-gateway-1");

/** Local, isolated envelope builder — mirrors builders.ts's envelope() shape, exactly like tests/domain/capability-issued.test.ts already does. `principal_id: THEO` is an arbitrary placeholder — see that file's docstring for why. */
function capabilityIssuedEvent(sequence: number, payload: CapabilityIssuedPayload): CapabilityIssuedEvent {
  const at = iso8601(new Date(Date.parse("2025-01-01T00:00:00.000Z") + sequence * 1000).toISOString());
  return {
    event_id: evt(`capability-issued-${sequence}`),
    schema_version: schemaVersion(1),
    occurred_at: at,
    principal_id: THEO, // placeholder only — see tests/domain/capability-issued.test.ts.
    sequence: sequenceNumber(sequence),
    authority_time: at,
    recorded_at: at,
    assurance_level: "ASSERTED_UNVERIFIED",
    event_type: "CAPABILITY_ISSUED",
    payload,
  };
}

/**
 * TEST-ONLY. Not exported from src/ anywhere, and deliberately not shared
 * via a test fixture module either — kept local to each test file that
 * needs it, so there is no reusable, importable shortcut for crossing the
 * ASSERTED -> GRANTED boundary, even inside tests/. This is a plain
 * TypeScript cast, exactly as available to any other caller who chooses to
 * write `as ValidatedGrant` themselves; it does not hide or soften that
 * fact behind a named production API.
 */
function testOnlyValidatedGrant(event: CapabilityIssuedEvent): ValidatedGrant {
  return { event } as ValidatedGrant;
}

describe("remainingCapacity — A: a single validated grant debits its delegation once", () => {
  it("budget 1000, grant 700, remaining = 300", () => {
    const root = rootDelegation({
      sequence: 1,
      id: "d-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      totalBudget: EUR(1000),
      amountThresholds: thresholds(100000, 100000),
    });
    const request = actionRequest({
      sequence: 2,
      id: "act-1",
      requester: AGENT_A,
      delegationId: "d-root",
      parameters: monetaryParameters(EUR(700)),
    });
    const ingested = ingestAll([toDraft(root), toDraft(request)], sequentialClock);
    if (!isEventType(root, "DELEGATION_CREATED") || !isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }

    const grant = testOnlyValidatedGrant(
      capabilityIssuedEvent(3, {
        capability_id: capabilityId("cap-1"),
        action_id: request.payload.action_id,
        action_fingerprint: computeActionFingerprint(PURCHASE_ORDER_CREATE, monetaryParameters(EUR(700))),
        decision_sequence: sequenceNumber(2),
        granted_chain_ref: [delegationLink("d-root")],
        enforcement_point_id: EP,
        expires_at: iso8601("2025-01-01T00:05:00.000Z"),
      }),
    );

    const remaining = remainingCapacity(root.payload.delegation_id, EUR(1000), [grant], ingested.canonicalStore);
    expect(remaining).toBe(300);
  });
});

describe("remainingCapacity — B: an ACTION_EXECUTED in the same store never adds a second debit", () => {
  it("budget 1000, grant 700, plus a legacy ACTION_EXECUTED(700): remaining stays 300", () => {
    const root = rootDelegation({
      sequence: 1,
      id: "d-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      totalBudget: EUR(1000),
      amountThresholds: thresholds(100000, 100000),
    });
    if (!isEventType(root, "DELEGATION_CREATED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const request = actionRequest({
      sequence: 2,
      id: "act-1",
      requester: AGENT_A,
      delegationId: "d-root",
      parameters: monetaryParameters(EUR(700)),
    });
    const execution = actionExecution({
      sequence: 3,
      actionId: "act-1",
      executor: AGENT_A,
      decisionSequence: 2,
      chain: [delegationLink("d-root")],
      parameters: monetaryParameters(EUR(700)),
    });
    if (!isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }

    const grant = testOnlyValidatedGrant(
      capabilityIssuedEvent(4, {
        capability_id: capabilityId("cap-1"),
        action_id: request.payload.action_id,
        action_fingerprint: computeActionFingerprint(PURCHASE_ORDER_CREATE, monetaryParameters(EUR(700))),
        decision_sequence: sequenceNumber(2),
        granted_chain_ref: [delegationLink("d-root")],
        enforcement_point_id: EP,
        expires_at: iso8601("2025-01-01T00:05:00.000Z"),
      }),
    );

    const ingested = ingestAll([toDraft(root), toDraft(request), toDraft(execution)], sequentialClock);

    // The new-world function ignores ACTION_EXECUTED entirely — one debit,
    // from the grant alone, no matter how many legacy execution events sit
    // in the same store.
    const remaining = remainingCapacity(root.payload.delegation_id, EUR(1000), [grant], ingested.canonicalStore);
    expect(remaining).toBe(300);

    // And symmetrically: the legacy path never sees this grant either — it
    // still debits from its own ACTION_EXECUTED, unmoved by anything above.
    const legacyRemaining = remainingBudget(root.payload.delegation_id, EUR(1000), ingested.canonicalStore);
    expect(legacyRemaining).toBe(300);
  });
});

describe("remainingCapacity — C: a canonical two-level chain debits every bounded ancestor independently", () => {
  it("D1 budget 1000, D2 budget 600, grant [D1,D2] amount 400: remaining D1=600, remaining D2=200", () => {
    const d1 = rootDelegation({
      sequence: 1,
      id: "d1",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: true,
      totalBudget: EUR(1000),
      amountThresholds: thresholds(100000, 100000),
    });
    const d2 = subDelegation({
      sequence: 2,
      id: "d2",
      parentId: "d1",
      grantor: AGENT_A,
      grantee: AGENT_B,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      totalBudget: EUR(600),
      amountThresholds: thresholds(100000, 100000),
    });
    const request = actionRequest({
      sequence: 3,
      id: "act-1",
      requester: AGENT_B,
      delegationId: "d2",
      parameters: monetaryParameters(EUR(400)),
    });
    if (!isEventType(d1, "DELEGATION_CREATED") || !isEventType(d2, "SUBDELEGATION_CREATED") || !isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const ingested = ingestAll([toDraft(d1), toDraft(d2), toDraft(request)], sequentialClock);

    const grant = testOnlyValidatedGrant(
      capabilityIssuedEvent(4, {
        capability_id: capabilityId("cap-1"),
        action_id: request.payload.action_id,
        action_fingerprint: computeActionFingerprint(PURCHASE_ORDER_CREATE, monetaryParameters(EUR(400))),
        decision_sequence: sequenceNumber(3),
        granted_chain_ref: [delegationLink("d1"), delegationLink("d2")],
        enforcement_point_id: EP,
        expires_at: iso8601("2025-01-01T00:05:00.000Z"),
      }),
    );

    expect(remainingCapacity(d1.payload.delegation_id, EUR(1000), [grant], ingested.canonicalStore)).toBe(600);
    expect(remainingCapacity(d2.payload.delegation_id, EUR(600), [grant], ingested.canonicalStore)).toBe(200);
  });
});

describe("remainingCapacity — D: a grant whose chain does not contain D never debits D", () => {
  it("an independent grant on a different root leaves D1 untouched", () => {
    const d1 = rootDelegation({
      sequence: 1,
      id: "d1",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      totalBudget: EUR(1000),
      amountThresholds: thresholds(100000, 100000),
    });
    const dOther = rootDelegation({
      sequence: 2,
      id: "d-other",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_B,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(100000, 100000),
    });
    const request = actionRequest({
      sequence: 3,
      id: "act-1",
      requester: AGENT_B,
      delegationId: "d-other",
      parameters: monetaryParameters(EUR(700)),
    });
    if (!isEventType(d1, "DELEGATION_CREATED") || !isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const ingested = ingestAll([toDraft(d1), toDraft(dOther), toDraft(request)], sequentialClock);

    const grant = testOnlyValidatedGrant(
      capabilityIssuedEvent(4, {
        capability_id: capabilityId("cap-1"),
        action_id: request.payload.action_id,
        action_fingerprint: computeActionFingerprint(PURCHASE_ORDER_CREATE, monetaryParameters(EUR(700))),
        decision_sequence: sequenceNumber(3),
        granted_chain_ref: [delegationLink("d-other")],
        enforcement_point_id: EP,
        expires_at: iso8601("2025-01-01T00:05:00.000Z"),
      }),
    );

    expect(remainingCapacity(d1.payload.delegation_id, EUR(1000), [grant], ingested.canonicalStore)).toBe(1000);
  });
});

describe("remainingCapacity — E: two validated grants that together exceed capacity produce a negative signal, never a thrown error or a silent clamp", () => {
  it("two 700 grants against a 1000 budget return -400", () => {
    const root = rootDelegation({
      sequence: 1,
      id: "d-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      totalBudget: EUR(1000),
      amountThresholds: thresholds(100000, 100000),
    });
    const requestOne = actionRequest({
      sequence: 2,
      id: "act-1",
      requester: AGENT_A,
      delegationId: "d-root",
      parameters: monetaryParameters(EUR(700)),
    });
    const requestTwo = actionRequest({
      sequence: 3,
      id: "act-2",
      requester: AGENT_A,
      delegationId: "d-root",
      parameters: monetaryParameters(EUR(700)),
    });
    if (!isEventType(root, "DELEGATION_CREATED") || !isEventType(requestOne, "ACTION_REQUESTED") || !isEventType(requestTwo, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const ingested = ingestAll([toDraft(root), toDraft(requestOne), toDraft(requestTwo)], sequentialClock);

    const grantOne = testOnlyValidatedGrant(
      capabilityIssuedEvent(4, {
        capability_id: capabilityId("cap-1"),
        action_id: requestOne.payload.action_id,
        action_fingerprint: computeActionFingerprint(PURCHASE_ORDER_CREATE, monetaryParameters(EUR(700))),
        decision_sequence: sequenceNumber(2),
        granted_chain_ref: [delegationLink("d-root")],
        enforcement_point_id: EP,
        expires_at: iso8601("2025-01-01T00:05:00.000Z"),
      }),
    );
    const grantTwo = testOnlyValidatedGrant(
      capabilityIssuedEvent(5, {
        capability_id: capabilityId("cap-2"),
        action_id: requestTwo.payload.action_id,
        action_fingerprint: computeActionFingerprint(PURCHASE_ORDER_CREATE, monetaryParameters(EUR(700))),
        decision_sequence: sequenceNumber(3),
        granted_chain_ref: [delegationLink("d-root")],
        enforcement_point_id: EP,
        expires_at: iso8601("2025-01-01T00:05:00.000Z"),
      }),
    );

    // This function does not, and must not, decide whether this pair of
    // grants was ever legitimately co-admitted — that is a future
    // ingestion-time atomicity concern (Layer 2), not this pure function's.
    // It only reports the arithmetic honestly.
    const remaining = remainingCapacity(root.payload.delegation_id, EUR(1000), [grantOne, grantTwo], ingested.canonicalStore);
    expect(remaining).toBe(-400);
  });
});
