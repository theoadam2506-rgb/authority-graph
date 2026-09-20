/**
 * PR4A — the ASSERTED CAPABILITY_ISSUED -> GRANTED CAPABILITY boundary
 * (src/engine/grantValidation.ts). Every scenario here is adversarial:
 * each one demonstrates a specific way a raw, caller-supplied
 * CAPABILITY_ISSUED event can fail to become a `ValidatedGrant`, or (in
 * the happy-path test) how it succeeds when every check holds.
 *
 * ingest.ts is not touched anywhere in this file — validateAndSelectGrant
 * is exercised directly, as a pure function, against stores built with
 * ingestAll exactly as every other adversarial test in this repo already
 * does.
 */
import { describe, expect, it } from "vitest";
import { ingestAll } from "../../src/engine/authority.js";
import { remainingCapacity } from "../../src/engine/capacity.js";
import { findCapabilityIdCollision, validateAndSelectGrant } from "../../src/engine/grantValidation.js";
import { computeActionFingerprint, isEventType, toDraft, type AuthorityEvent, type CapabilityIssuedPayload } from "../../src/domain/events.js";
import { actionId, capabilityId, enforcementPointId, iso8601, monetaryParameters, schemaVersion, sequenceNumber, thresholds } from "../../src/domain/types.js";
import { evt, principal } from "../fixtures/ids.js";
import {
  EUR,
  PURCHASE_ORDER_CREATE,
  THEO,
  actionRequest,
  approvalGrant,
  approvalLink,
  approvalRequest,
  delegationLink,
  rootDelegation,
  revokeDelegation,
  sequentialClock,
  subDelegation,
} from "../fixtures/scenarios.js";

const AGENT = principal("grant-validation-test-agent");
const AGENT_A = principal("grant-validation-agent-a");
const AGENT_B = principal("grant-validation-agent-b");
const AGENT_C = principal("grant-validation-agent-c");
const EP = enforcementPointId("ep-gateway-1");

/** Local, isolated envelope builder — same convention as every other CAPABILITY_ISSUED test file in this repo. `principal_id: THEO` is an arbitrary placeholder — see tests/domain/capability-issued.test.ts's docstring for why. */
function capabilityIssuedEvent(sequence: number, payload: CapabilityIssuedPayload, eventIdOverride?: string): AuthorityEvent {
  const at = iso8601(new Date(Date.parse("2025-01-01T00:00:00.000Z") + sequence * 1000).toISOString());
  return {
    event_id: evt(eventIdOverride ?? `capability-issued-${sequence}`),
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

const SEVEN_HUNDRED = monetaryParameters(EUR(700));
const SEVEN_HUNDRED_FINGERPRINT = computeActionFingerprint(PURCHASE_ORDER_CREATE, SEVEN_HUNDRED);

describe("validateAndSelectGrant — happy path", () => {
  it("a correctly-formed capability, invoking an AUTHORIZED delegation, is promoted to a ValidatedGrant usable by remainingCapacity", () => {
    const root = rootDelegation({
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
    const request = actionRequest({ sequence: 2, id: "act-1", requester: AGENT, delegationId: "d-root", parameters: SEVEN_HUNDRED });
    if (!isEventType(root, "DELEGATION_CREATED") || !isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const capabilityEvent = capabilityIssuedEvent(3, {
      capability_id: capabilityId("cap-1"),
      action_id: request.payload.action_id,
      action_fingerprint: SEVEN_HUNDRED_FINGERPRINT,
      decision_sequence: sequenceNumber(2),
      granted_chain_ref: [delegationLink("d-root")],
      enforcement_point_id: EP,
      expires_at: iso8601("2025-01-01T00:05:00.000Z"),
    });
    if (!isEventType(capabilityEvent, "CAPABILITY_ISSUED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const ingested = ingestAll([toDraft(root), toDraft(request), toDraft(capabilityEvent)], sequentialClock);

    const result = validateAndSelectGrant(ingested.canonicalStore, capabilityEvent);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok:true");
    }

    const remaining = remainingCapacity(root.payload.delegation_id, EUR(1000), [result.grant], ingested.canonicalStore);
    expect(remaining).toBe(300);
  });
});

describe("validateAndSelectGrant — B: action_id does not reference any ACTION_REQUESTED", () => {
  it("is rejected with ACTION_NOT_FOUND", () => {
    const root = rootDelegation({
      sequence: 1,
      id: "d-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(100000, 100000),
    });
    const capabilityEvent = capabilityIssuedEvent(2, {
      capability_id: capabilityId("cap-1"),
      action_id: actionId("does-not-exist"),
      action_fingerprint: SEVEN_HUNDRED_FINGERPRINT,
      decision_sequence: sequenceNumber(1),
      granted_chain_ref: [delegationLink("d-root")],
      enforcement_point_id: EP,
      expires_at: iso8601("2025-01-01T00:05:00.000Z"),
    });
    if (!isEventType(capabilityEvent, "CAPABILITY_ISSUED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const ingested = ingestAll([toDraft(root), toDraft(capabilityEvent)], sequentialClock);

    const result = validateAndSelectGrant(ingested.canonicalStore, capabilityEvent);
    expect(result).toEqual({ ok: false, reason: "ACTION_NOT_FOUND" });
  });
});

describe("validateAndSelectGrant — C: action_fingerprint does not match the immutable ACTION_REQUESTED", () => {
  it("is rejected with FINGERPRINT_MISMATCH", () => {
    const root = rootDelegation({
      sequence: 1,
      id: "d-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(100000, 100000),
    });
    const request = actionRequest({ sequence: 2, id: "act-1", requester: AGENT, delegationId: "d-root", parameters: SEVEN_HUNDRED });
    if (!isEventType(root, "DELEGATION_CREATED") || !isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const wrongFingerprint = computeActionFingerprint(PURCHASE_ORDER_CREATE, monetaryParameters(EUR(999)));
    const capabilityEvent = capabilityIssuedEvent(3, {
      capability_id: capabilityId("cap-1"),
      action_id: request.payload.action_id,
      action_fingerprint: wrongFingerprint,
      decision_sequence: sequenceNumber(2),
      granted_chain_ref: [delegationLink("d-root")],
      enforcement_point_id: EP,
      expires_at: iso8601("2025-01-01T00:05:00.000Z"),
    });
    if (!isEventType(capabilityEvent, "CAPABILITY_ISSUED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const ingested = ingestAll([toDraft(root), toDraft(request), toDraft(capabilityEvent)], sequentialClock);

    const result = validateAndSelectGrant(ingested.canonicalStore, capabilityEvent);
    expect(result).toEqual({ ok: false, reason: "FINGERPRINT_MISMATCH" });
  });
});

describe("validateAndSelectGrant — D: granted_chain_ref names a delegation that is not the one actually resolved", () => {
  it("is rejected with GRANTED_CHAIN_MISMATCH when the cited delegation_id does not exist at all", () => {
    const root = rootDelegation({
      sequence: 1,
      id: "d-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(100000, 100000),
    });
    const request = actionRequest({ sequence: 2, id: "act-1", requester: AGENT, delegationId: "d-root", parameters: SEVEN_HUNDRED });
    if (!isEventType(root, "DELEGATION_CREATED") || !isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const capabilityEvent = capabilityIssuedEvent(3, {
      capability_id: capabilityId("cap-1"),
      action_id: request.payload.action_id,
      action_fingerprint: SEVEN_HUNDRED_FINGERPRINT,
      decision_sequence: sequenceNumber(2),
      granted_chain_ref: [delegationLink("d-ghost")], // never created
      enforcement_point_id: EP,
      expires_at: iso8601("2025-01-01T00:05:00.000Z"),
    });
    if (!isEventType(capabilityEvent, "CAPABILITY_ISSUED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const ingested = ingestAll([toDraft(root), toDraft(request), toDraft(capabilityEvent)], sequentialClock);

    const result = validateAndSelectGrant(ingested.canonicalStore, capabilityEvent);
    expect(result).toEqual({ ok: false, reason: "GRANTED_CHAIN_MISMATCH" });
  });
});

describe("validateAndSelectGrant — E: the delegation actually invoked by the request does not exist", () => {
  it("is rejected with INVOKED_DELEGATION_NOT_FOUND", () => {
    // ACTION_REQUESTED names a delegation_id that was never created —
    // ingestion accepts this (no ingestion-time authority check exists for
    // ACTION_REQUESTED), so this is exactly the structural case the
    // resolver must reject on its own.
    const request = actionRequest({ sequence: 1, id: "act-1", requester: AGENT, delegationId: "d-never-created", parameters: SEVEN_HUNDRED });
    if (!isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const capabilityEvent = capabilityIssuedEvent(2, {
      capability_id: capabilityId("cap-1"),
      action_id: request.payload.action_id,
      action_fingerprint: SEVEN_HUNDRED_FINGERPRINT,
      decision_sequence: sequenceNumber(1),
      granted_chain_ref: [delegationLink("d-never-created")],
      enforcement_point_id: EP,
      expires_at: iso8601("2025-01-01T00:05:00.000Z"),
    });
    if (!isEventType(capabilityEvent, "CAPABILITY_ISSUED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const ingested = ingestAll([toDraft(request), toDraft(capabilityEvent)], sequentialClock);

    const result = validateAndSelectGrant(ingested.canonicalStore, capabilityEvent);
    expect(result).toEqual({ ok: false, reason: "INVOKED_DELEGATION_NOT_FOUND" });
  });
});

describe("validateAndSelectGrant — F/J: the invoked delegation resolves, but is DENIED (revoked before the decision point)", () => {
  it("is rejected with NOT_AUTHORIZED, carrying the DENIED decision", () => {
    const root = rootDelegation({
      sequence: 1,
      id: "d-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(100000, 100000),
    });
    const request = actionRequest({ sequence: 2, id: "act-1", requester: AGENT, delegationId: "d-root", parameters: SEVEN_HUNDRED });
    const revocation = revokeDelegation({ sequence: 3, targetId: "d-root", issuedBy: THEO });
    if (!isEventType(root, "DELEGATION_CREATED") || !isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const capabilityEvent = capabilityIssuedEvent(4, {
      capability_id: capabilityId("cap-1"),
      action_id: request.payload.action_id,
      action_fingerprint: SEVEN_HUNDRED_FINGERPRINT,
      decision_sequence: sequenceNumber(3), // = candidate.sequence(4) - 1, and the revocation (seq 3) is visible at this point
      granted_chain_ref: [delegationLink("d-root")],
      enforcement_point_id: EP,
      expires_at: iso8601("2025-01-01T00:05:00.000Z"),
    });
    if (!isEventType(capabilityEvent, "CAPABILITY_ISSUED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const ingested = ingestAll([toDraft(root), toDraft(request), toDraft(revocation), toDraft(capabilityEvent)], sequentialClock);

    const result = validateAndSelectGrant(ingested.canonicalStore, capabilityEvent);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected ok:false");
    }
    expect(result.reason).toBe("NOT_AUTHORIZED");
    expect(result.decision?.outcome).toBe("DENIED");
  });
});

describe("validateAndSelectGrant — G: the invoked delegation resolves to REQUIRES_APPROVAL, with no valid grant", () => {
  it("is rejected with NOT_AUTHORIZED, never silently promoted to AUTHORIZED", () => {
    const root = rootDelegation({
      sequence: 1,
      id: "d-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(100, 1000), // 700 falls in the approval band
    });
    const request = actionRequest({ sequence: 2, id: "act-1", requester: AGENT, delegationId: "d-root", parameters: SEVEN_HUNDRED });
    if (!isEventType(root, "DELEGATION_CREATED") || !isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const capabilityEvent = capabilityIssuedEvent(3, {
      capability_id: capabilityId("cap-1"),
      action_id: request.payload.action_id,
      action_fingerprint: SEVEN_HUNDRED_FINGERPRINT,
      decision_sequence: sequenceNumber(2),
      granted_chain_ref: [delegationLink("d-root")],
      enforcement_point_id: EP,
      expires_at: iso8601("2025-01-01T00:05:00.000Z"),
    });
    if (!isEventType(capabilityEvent, "CAPABILITY_ISSUED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const ingested = ingestAll([toDraft(root), toDraft(request), toDraft(capabilityEvent)], sequentialClock);

    const result = validateAndSelectGrant(ingested.canonicalStore, capabilityEvent);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected ok:false");
    }
    expect(result.reason).toBe("NOT_AUTHORIZED");
    expect(result.decision?.outcome).toBe("REQUIRES_APPROVAL");
  });
});

describe("validateAndSelectGrant — H: INVOKED names delegation A, the capability tries to register delegation B", () => {
  it("is rejected with GRANTED_CHAIN_MISMATCH, never silently accepted via B", () => {
    const dA = rootDelegation({
      sequence: 1,
      id: "d-a",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(100000, 100000),
    });
    const dB = rootDelegation({
      sequence: 2,
      id: "d-b",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(100000, 100000),
    });
    const request = actionRequest({ sequence: 3, id: "act-1", requester: AGENT, delegationId: "d-a", parameters: SEVEN_HUNDRED });
    if (!isEventType(dA, "DELEGATION_CREATED") || !isEventType(dB, "DELEGATION_CREATED") || !isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const capabilityEvent = capabilityIssuedEvent(4, {
      capability_id: capabilityId("cap-1"),
      action_id: request.payload.action_id,
      action_fingerprint: SEVEN_HUNDRED_FINGERPRINT,
      decision_sequence: sequenceNumber(3),
      granted_chain_ref: [delegationLink("d-b")], // wrong — INVOKED named d-a
      enforcement_point_id: EP,
      expires_at: iso8601("2025-01-01T00:05:00.000Z"),
    });
    if (!isEventType(capabilityEvent, "CAPABILITY_ISSUED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const ingested = ingestAll([toDraft(dA), toDraft(dB), toDraft(request), toDraft(capabilityEvent)], sequentialClock);

    const result = validateAndSelectGrant(ingested.canonicalStore, capabilityEvent);
    expect(result).toEqual({ ok: false, reason: "GRANTED_CHAIN_MISMATCH" });
  });
});

describe("validateAndSelectGrant — I: an alternative AUTHORIZED delegation the requester also holds never changes the outcome, regardless of insertion order", () => {
  it("succeeds identically whether the alternative delegation is created before or after the invoked one", () => {
    function run(order: "invoked-first" | "alternative-first") {
      const invoked = rootDelegation({
        sequence: order === "invoked-first" ? 1 : 2,
        id: "d-invoked",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        amountThresholds: thresholds(100000, 100000),
      });
      const alternative = rootDelegation({
        sequence: order === "invoked-first" ? 2 : 1,
        id: "d-alternative",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        amountThresholds: thresholds(100000, 100000),
      });
      const request = actionRequest({ sequence: 3, id: "act-1", requester: AGENT, delegationId: "d-invoked", parameters: SEVEN_HUNDRED });
      if (!isEventType(request, "ACTION_REQUESTED")) {
        throw new Error("fixture returned an unexpected event_type");
      }
      const capabilityEvent = capabilityIssuedEvent(4, {
        capability_id: capabilityId("cap-1"),
        action_id: request.payload.action_id,
        action_fingerprint: SEVEN_HUNDRED_FINGERPRINT,
        decision_sequence: sequenceNumber(3),
        granted_chain_ref: [delegationLink("d-invoked")],
        enforcement_point_id: EP,
        expires_at: iso8601("2025-01-01T00:05:00.000Z"),
      });
      if (!isEventType(capabilityEvent, "CAPABILITY_ISSUED")) {
        throw new Error("fixture returned an unexpected event_type");
      }
      const events = order === "invoked-first" ? [invoked, alternative] : [alternative, invoked];
      const ingested = ingestAll([...events.map(toDraft), toDraft(request), toDraft(capabilityEvent)], sequentialClock);
      return validateAndSelectGrant(ingested.canonicalStore, capabilityEvent);
    }

    const invokedFirst = run("invoked-first");
    const alternativeFirst = run("alternative-first");
    expect(invokedFirst.ok).toBe(true);
    expect(alternativeFirst.ok).toBe(true);
  });
});

describe("validateAndSelectGrant — K: decision_sequence backdated to an instant before a later revocation", () => {
  it("is rejected with DECISION_SEQUENCE_NOT_IMMEDIATE, regardless of what the backdated instant would itself have resolved to", () => {
    const root = rootDelegation({
      sequence: 1,
      id: "d-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(100000, 100000),
    });
    const request = actionRequest({ sequence: 2, id: "act-1", requester: AGENT, delegationId: "d-root", parameters: SEVEN_HUNDRED });
    const revocation = revokeDelegation({ sequence: 3, targetId: "d-root", issuedBy: THEO });
    if (!isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    // Deliberately picks decision_sequence = 2 (before the revocation at 3),
    // even though the capability is only issued at sequence 4 — an attempt
    // to "resolve" at a moment when authority still held, to route around
    // the revocation that has since happened.
    const capabilityEvent = capabilityIssuedEvent(4, {
      capability_id: capabilityId("cap-1"),
      action_id: request.payload.action_id,
      action_fingerprint: SEVEN_HUNDRED_FINGERPRINT,
      decision_sequence: sequenceNumber(2),
      granted_chain_ref: [delegationLink("d-root")],
      enforcement_point_id: EP,
      expires_at: iso8601("2025-01-01T00:05:00.000Z"),
    });
    if (!isEventType(capabilityEvent, "CAPABILITY_ISSUED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const ingested = ingestAll([toDraft(root), toDraft(request), toDraft(revocation), toDraft(capabilityEvent)], sequentialClock);

    const result = validateAndSelectGrant(ingested.canonicalStore, capabilityEvent);
    // Caught by the freshness rule alone — the function never even reaches
    // the point of asking whether sequence 2 would have resolved AUTHORIZED.
    expect(result).toEqual({ ok: false, reason: "DECISION_SEQUENCE_NOT_IMMEDIATE" });
  });
});

describe("findCapabilityIdCollision — L: capability_id reused by a distinct emission", () => {
  it("reports the earlier event when a different event_id claims the same capability_id", () => {
    const first = capabilityIssuedEvent(
      1,
      {
        capability_id: capabilityId("cap-dup"),
        action_id: actionId("act-1"),
        action_fingerprint: SEVEN_HUNDRED_FINGERPRINT,
        decision_sequence: sequenceNumber(0),
        granted_chain_ref: [delegationLink("d-root")],
        enforcement_point_id: EP,
        expires_at: iso8601("2025-01-01T00:05:00.000Z"),
      },
      "evt-A",
    );
    const second = capabilityIssuedEvent(
      2,
      {
        capability_id: capabilityId("cap-dup"),
        action_id: actionId("act-1"),
        action_fingerprint: SEVEN_HUNDRED_FINGERPRINT,
        decision_sequence: sequenceNumber(1),
        granted_chain_ref: [delegationLink("d-root")],
        enforcement_point_id: EP,
        expires_at: iso8601("2025-01-01T00:05:00.000Z"),
      },
      "evt-B",
    );
    const store = [first, second] as const;

    const collision = findCapabilityIdCollision(capabilityId("cap-dup"), evt("evt-B"), store);
    expect(collision?.event_id).toBe("evt-A");
  });

  it("does not flag a retry that reuses its own event_id as a collision", () => {
    const only = capabilityIssuedEvent(
      1,
      {
        capability_id: capabilityId("cap-dup"),
        action_id: actionId("act-1"),
        action_fingerprint: SEVEN_HUNDRED_FINGERPRINT,
        decision_sequence: sequenceNumber(0),
        granted_chain_ref: [delegationLink("d-root")],
        enforcement_point_id: EP,
        expires_at: iso8601("2025-01-01T00:05:00.000Z"),
      },
      "evt-A",
    );
    const collision = findCapabilityIdCollision(capabilityId("cap-dup"), evt("evt-A"), [only]);
    expect(collision).toBeUndefined();
  });
});

describe("validateAndSelectGrant — multi-hop INVOKED chain, never substituted by an unrelated AUTHORIZED alternative", () => {
  /**
   * THEO -d1-> AGENT_A -d2-> AGENT_B -d3-> AGENT_C, all three levels sharing
   * the same (100, 1000) automatic/approval band, so a 500 EUR request
   * falls in the approval band at every level. AGENT_C invokes d3
   * explicitly. THEO also grants AGENT_C a completely independent, direct,
   * automatically-authorized delegation d4 — the "tempting" alternative
   * this test proves Authority never reaches for.
   */
  function buildHierarchy(includeApproval: boolean) {
    const d1 = rootDelegation({
      sequence: 1,
      id: "d1",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: true,
      amountThresholds: thresholds(100, 1000),
    });
    const d2 = subDelegation({
      sequence: 2,
      id: "d2",
      parentId: "d1",
      grantor: AGENT_A,
      grantee: AGENT_B,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: true,
      amountThresholds: thresholds(100, 1000),
    });
    const d3 = subDelegation({
      sequence: 3,
      id: "d3",
      parentId: "d2",
      grantor: AGENT_B,
      grantee: AGENT_C,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(100, 1000),
    });
    const d4 = rootDelegation({
      sequence: 4,
      id: "d4",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_C,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(100000, 100000), // would resolve AUTHORIZED instantly, if ever consulted
    });
    const fiveHundred = monetaryParameters(EUR(500));
    const request = actionRequest({ sequence: 5, id: "act-1", requester: AGENT_C, delegationId: "d3", parameters: fiveHundred });
    const drafts = [d1, d2, d3, d4, request].map(toDraft);

    if (!includeApproval) {
      const capabilityEvent = capabilityIssuedEvent(6, {
        capability_id: capabilityId("cap-no-approval"),
        action_id: actionId("act-1"),
        action_fingerprint: computeActionFingerprint(PURCHASE_ORDER_CREATE, fiveHundred),
        decision_sequence: sequenceNumber(5),
        granted_chain_ref: [delegationLink("d1"), delegationLink("d2"), delegationLink("d3")],
        enforcement_point_id: EP,
        expires_at: iso8601("2025-01-01T00:05:00.000Z"),
      });
      const ingested = ingestAll([...drafts, toDraft(capabilityEvent)], sequentialClock);
      return { ingested, capabilityEvent };
    }

    const approvalReq = approvalRequest({ sequence: 6, id: "appr-1", actionId: "act-1", requestedFrom: AGENT_B, requester: AGENT_C });
    const approvalGranted = approvalGrant({ sequence: 7, id: "appr-1", actionId: "act-1", approver: AGENT_B });
    const capabilityEvent = capabilityIssuedEvent(8, {
      capability_id: capabilityId("cap-with-approval"),
      action_id: actionId("act-1"),
      action_fingerprint: computeActionFingerprint(PURCHASE_ORDER_CREATE, fiveHundred),
      decision_sequence: sequenceNumber(7),
      granted_chain_ref: [delegationLink("d1"), delegationLink("d2"), delegationLink("d3"), approvalLink("appr-1")],
      enforcement_point_id: EP,
      expires_at: iso8601("2025-01-01T00:05:00.000Z"),
    });
    const ingested = ingestAll([...drafts, toDraft(approvalReq), toDraft(approvalGranted), toDraft(capabilityEvent)], sequentialClock);
    return { ingested, capabilityEvent };
  }

  it("before approval: REQUIRES_APPROVAL on the invoked [d1,d2,d3] chain — d4 is never substituted", () => {
    const { ingested, capabilityEvent } = buildHierarchy(false);
    if (!isEventType(capabilityEvent, "CAPABILITY_ISSUED")) {
      throw new Error("fixture returned an unexpected event_type");
    }

    const result = validateAndSelectGrant(ingested.canonicalStore, capabilityEvent);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected ok:false");
    }
    expect(result.reason).toBe("NOT_AUTHORIZED");
    expect(result.decision?.outcome).toBe("REQUIRES_APPROVAL");
  });

  it("after a valid approval on the invoked chain: GRANTED = [d1,d2,d3] + the approval — never d4", () => {
    const { ingested, capabilityEvent } = buildHierarchy(true);
    if (!isEventType(capabilityEvent, "CAPABILITY_ISSUED")) {
      throw new Error("fixture returned an unexpected event_type");
    }

    const result = validateAndSelectGrant(ingested.canonicalStore, capabilityEvent);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok:true");
    }
    // The ValidatedGrant wraps exactly the candidate event — its
    // granted_chain_ref is the full three-hop chain plus the approval,
    // never d4, and never just the terminal d3 alone.
    expect(result.grant.event.payload.granted_chain_ref).toEqual([
      { kind: "delegation", delegation_id: "d1" },
      { kind: "delegation", delegation_id: "d2" },
      { kind: "delegation", delegation_id: "d3" },
      { kind: "approval", approval_id: "appr-1" },
    ]);
  });
});

describe("validateAndSelectGrant — UNKNOWN: a structurally invalid (cyclic) invoked chain never yields a grant", () => {
  it("a cycle in the delegation graph resolves to UNKNOWN, rejected as NOT_AUTHORIZED, fail-closed", () => {
    // Two SUBDELEGATION_CREATED events whose parent_delegation_id point at
    // each other — walkUpChain (validateChain.ts) detects this as a cycle
    // (C18_CYCLE_DETECTED) before any grantor/grantee check even runs.
    const dx = subDelegation({
      sequence: 1,
      id: "d-x",
      parentId: "d-y",
      grantor: AGENT_A,
      grantee: AGENT_B,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: true,
    });
    const dy = subDelegation({
      sequence: 2,
      id: "d-y",
      parentId: "d-x",
      grantor: AGENT_A,
      grantee: AGENT_B,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: true,
    });
    const request = actionRequest({ sequence: 3, id: "act-1", requester: AGENT_B, delegationId: "d-x", parameters: SEVEN_HUNDRED });
    if (!isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const capabilityEvent = capabilityIssuedEvent(4, {
      capability_id: capabilityId("cap-cycle"),
      action_id: request.payload.action_id,
      action_fingerprint: SEVEN_HUNDRED_FINGERPRINT,
      decision_sequence: sequenceNumber(3),
      granted_chain_ref: [delegationLink("d-x")],
      enforcement_point_id: EP,
      expires_at: iso8601("2025-01-01T00:05:00.000Z"),
    });
    if (!isEventType(capabilityEvent, "CAPABILITY_ISSUED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const ingested = ingestAll([toDraft(dx), toDraft(dy), toDraft(request), toDraft(capabilityEvent)], sequentialClock);

    const result = validateAndSelectGrant(ingested.canonicalStore, capabilityEvent);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected ok:false");
    }
    expect(result.reason).toBe("NOT_AUTHORIZED");
    expect(result.decision?.outcome).toBe("UNKNOWN");
  });
});

