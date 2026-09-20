/**
 * PR4B-2 — COMMAND -> DECISION -> EVENT DATA, entirely in memory. Every
 * test calls `issueCapability`/`issueCapabilityIdempotently` directly,
 * never persists their result unless a scenario explicitly needs a prior
 * emission to already exist in the store (see test L).
 *
 * Tests P/Q/R/S from the design report ("caller cannot choose
 * capability_id/decision_sequence/granted_chain_ref/expires_at") are not
 * repeated here: `IssueCapabilityCommand`'s shape has not changed since
 * PR4B-1, and those four properties are already proven, at compile time,
 * by tests/domain/capabilityCommand.type-guards.ts.
 */
import { describe, expect, it } from "vitest";
import { ingestAll } from "../../src/engine/authority.js";
import { issueCapability, type IssueCapabilityDependencies, type IssuedCapabilityData } from "../../src/engine/issueCapability.js";
import { issueCapabilityIdempotently, EMPTY_IDEMPOTENCY_STATE } from "../../src/engine/issueCapabilityIdempotency.js";
import type { AuthenticatedPrincipal } from "../../src/domain/authenticatedPrincipal.js";
import { isEventType, toDraft, type AuthorityEvent, type CanonicalStore, type CapabilityIssuedPayload } from "../../src/domain/events.js";
import { actionId, capabilityId, clientIdempotencyKey, enforcementPointId, iso8601, monetaryParameters, schemaVersion, sequenceNumber, thresholds, type PrincipalId } from "../../src/domain/types.js";
import type { IssueCapabilityCommand } from "../../src/domain/capabilityCommand.js";
import { evt, principal } from "../fixtures/ids.js";
import { EUR, PURCHASE_ORDER_CREATE, THEO, actionRequest, approvalGrant, approvalRequest, rootDelegation, sequentialClock, subDelegation } from "../fixtures/scenarios.js";

const AGENT = principal("issue-capability-agent");
const AGENT_A = principal("issue-capability-agent-a");
const AGENT_B = principal("issue-capability-agent-b");
const AGENT_C = principal("issue-capability-agent-c");
const OTHER = principal("issue-capability-other-requester");
const EP = enforcementPointId("ep-gateway-1");

/**
 * PRE-COMMIT REVIEW CORRECTION: `issueCapability` now receives
 * `AuthenticatedPrincipal`, not a raw `PrincipalId` — this is the local
 * test-side construction of "an identity the deployment's auth layer has
 * already verified", exactly as `authenticatedPrincipal.ts`'s own
 * docstring describes: there is no smart constructor to call, because
 * this type carries no cryptographic mechanism of its own to enforce. A
 * literal object is the correct, intended way to obtain one here — unlike
 * `ValidatedGrant` (capacity.ts), this is not a brand guarding a
 * non-trivial invariant a test would otherwise have to fake.
 */
function authenticated(principalId: PrincipalId): AuthenticatedPrincipal {
  return { principalId };
}

function makeDependencies(startId = 1): IssueCapabilityDependencies {
  let counter = startId;
  return {
    nextCapabilityId: () => capabilityId(`cap-${counter++}`),
    expiresAt: (snapshotAuthorityTime) => iso8601(new Date(Date.parse(snapshotAuthorityTime) + 5 * 60_000).toISOString()),
  };
}

/** Turns a successful IssuedCapabilityData into a real, ingestible CAPABILITY_ISSUED draft — only used by test L, which needs a prior emission to actually exist in the store. `principal_id: THEO` is the same documented placeholder used throughout this repo's CAPABILITY_ISSUED tests. */
function toCapabilityIssuedDraft(data: IssuedCapabilityData): AuthorityEvent {
  const payload: CapabilityIssuedPayload = {
    capability_id: data.capability_id,
    action_id: data.action_id,
    action_fingerprint: data.action_fingerprint,
    decision_sequence: data.decision_sequence,
    granted_chain_ref: data.granted_chain_ref,
    enforcement_point_id: data.enforcement_point_id,
    expires_at: data.expires_at,
  };
  return {
    event_id: evt(`capability-issued-${data.capability_id}`),
    schema_version: schemaVersion(1),
    occurred_at: iso8601("2025-01-01T00:00:00.000Z"),
    principal_id: THEO,
    sequence: sequenceNumber(0), // overwritten by ingestAll
    authority_time: iso8601("2025-01-01T00:00:00.000Z"),
    recorded_at: iso8601("2025-01-01T00:00:00.000Z"),
    assurance_level: "ASSERTED_UNVERIFIED",
    event_type: "CAPABILITY_ISSUED",
    payload,
  };
}

describe("issueCapability — A: correctly authenticated requester reaches resolution", () => {
  it("succeeds when authenticatedRequesterId matches the request's own requesting_principal_id", () => {
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
    const request = actionRequest({ sequence: 2, id: "act-1", requester: AGENT, delegationId: "d-root", parameters: monetaryParameters(EUR(700)) });
    if (!isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const ingested = ingestAll([toDraft(root), toDraft(request)], sequentialClock);
    const command: IssueCapabilityCommand = { action_id: request.payload.action_id, enforcement_point_id: EP };

    const result = issueCapability(ingested.canonicalStore, authenticated(AGENT), command, makeDependencies());
    expect(result.ok).toBe(true);
  });
});

describe("issueCapability — B: authenticated requester differs from ACTION_REQUESTED.requesting_principal_id", () => {
  it("is rejected with REQUESTER_MISMATCH before any resolution happens", () => {
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
    const request = actionRequest({ sequence: 2, id: "act-1", requester: AGENT, delegationId: "d-root", parameters: monetaryParameters(EUR(700)) });
    if (!isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const ingested = ingestAll([toDraft(root), toDraft(request)], sequentialClock);
    const command: IssueCapabilityCommand = { action_id: request.payload.action_id, enforcement_point_id: EP };

    // OTHER is a real, authenticated principal — just not the one who made this request.
    const result = issueCapability(ingested.canonicalStore, authenticated(OTHER), command, makeDependencies());
    expect(result).toEqual({ ok: false, reason: "REQUESTER_MISMATCH" });
  });
});

describe("issueCapability — C: action_id references no ACTION_REQUESTED", () => {
  it("is rejected with ACTION_NOT_FOUND", () => {
    const command: IssueCapabilityCommand = { action_id: actionId("act-ghost"), enforcement_point_id: EP };
    const result = issueCapability([], authenticated(AGENT), command, makeDependencies());
    expect(result).toEqual({ ok: false, reason: "ACTION_NOT_FOUND" });
  });
});

describe("issueCapability — D: INVOKED AUTHORIZED builds a capability with the canonical GRANTED chain", () => {
  it("granted_chain_ref matches exactly the resolved delegation chain", () => {
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
    const request = actionRequest({ sequence: 2, id: "act-1", requester: AGENT, delegationId: "d-root", parameters: monetaryParameters(EUR(700)) });
    if (!isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const ingested = ingestAll([toDraft(root), toDraft(request)], sequentialClock);
    const command: IssueCapabilityCommand = { action_id: request.payload.action_id, enforcement_point_id: EP };

    const result = issueCapability(ingested.canonicalStore, authenticated(AGENT), command, makeDependencies());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok:true");
    }
    expect(result.capability.granted_chain_ref).toEqual([{ kind: "delegation", delegation_id: "d-root" }]);
    expect(result.capability.decision_sequence).toBe(2);
    expect(result.capability.enforcement_point_id).toBe("ep-gateway-1");
  });
});

function buildHierarchy() {
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
    amountThresholds: thresholds(100000, 100000),
  });
  const request = actionRequest({ sequence: 5, id: "act-1", requester: AGENT_C, delegationId: "d3", parameters: monetaryParameters(EUR(500)) });
  if (!isEventType(request, "ACTION_REQUESTED")) {
    throw new Error("fixture returned an unexpected event_type");
  }
  return { d1, d2, d3, d4, request };
}

describe("issueCapability — E/F: INVOKED REQUIRES_APPROVAL is rejected, never substituted by an unrelated AUTHORIZED alternative", () => {
  it("rejects with NOT_AUTHORIZED/REQUIRES_APPROVAL, and d4 is never consulted", () => {
    const { d1, d2, d3, d4, request } = buildHierarchy();
    const ingested = ingestAll([toDraft(d1), toDraft(d2), toDraft(d3), toDraft(d4), toDraft(request)], sequentialClock);
    const command: IssueCapabilityCommand = { action_id: request.payload.action_id, enforcement_point_id: EP };

    const result = issueCapability(ingested.canonicalStore, authenticated(AGENT_C), command, makeDependencies());
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected ok:false");
    }
    expect(result.reason).toBe("NOT_AUTHORIZED");
    expect(result.decision?.outcome).toBe("REQUIRES_APPROVAL");
  });
});

describe("issueCapability — G: a valid approval on the INVOKED chain allows issuance, still never via d4", () => {
  it("succeeds with granted_chain_ref = [d1,d2,d3,approval] — never d4", () => {
    const { d1, d2, d3, d4, request } = buildHierarchy();
    const approvalReq = approvalRequest({ sequence: 6, id: "appr-1", actionId: "act-1", requestedFrom: AGENT_B, requester: AGENT_C });
    const approvalGranted = approvalGrant({ sequence: 7, id: "appr-1", actionId: "act-1", approver: AGENT_B });
    const ingested = ingestAll(
      [toDraft(d1), toDraft(d2), toDraft(d3), toDraft(d4), toDraft(request), toDraft(approvalReq), toDraft(approvalGranted)],
      sequentialClock,
    );
    const command: IssueCapabilityCommand = { action_id: request.payload.action_id, enforcement_point_id: EP };

    const result = issueCapability(ingested.canonicalStore, authenticated(AGENT_C), command, makeDependencies());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok:true");
    }
    expect(result.capability.granted_chain_ref).toEqual([
      { kind: "delegation", delegation_id: "d1" },
      { kind: "delegation", delegation_id: "d2" },
      { kind: "delegation", delegation_id: "d3" },
      { kind: "approval", approval_id: "appr-1" },
    ]);
  });
});

describe("issueCapability — H: an unbounded delegation in GRANTED imposes no artificial cap", () => {
  it("succeeds for a large amount when the invoked delegation declares no total_budget", () => {
    const root = rootDelegation({
      sequence: 1,
      id: "d-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(1000000, 1000000),
      // no totalBudget at all
    });
    const request = actionRequest({ sequence: 2, id: "act-1", requester: AGENT, delegationId: "d-root", parameters: monetaryParameters(EUR(999999)) });
    if (!isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const ingested = ingestAll([toDraft(root), toDraft(request)], sequentialClock);
    const command: IssueCapabilityCommand = { action_id: request.payload.action_id, enforcement_point_id: EP };

    const result = issueCapability(ingested.canonicalStore, authenticated(AGENT), command, makeDependencies());
    expect(result.ok).toBe(true);
  });
});

describe("issueCapability — I: an insufficient bounded delegation rejects the whole emission", () => {
  it("rejects with CAPACITY_EXCEEDED once prior engagement leaves too little remaining, even though the request alone is within the declared total_budget", () => {
    // NOTE: total_budget is declared at 1000 (not 300) on purpose. A
    // single request whose OWN amount exceeds the declared total_budget
    // is already caught by the pre-existing, legacy structural check
    // inside validateChain/evaluateConstraints (I5/C9 — see
    // src/engine/evaluateConstraints.ts's budgetExceeded), which runs
    // BEFORE this module's new capacity check and would report
    // NOT_AUTHORIZED/DENIED instead. This scenario instead exercises the
    // NEW capacity accounting specifically: the single request amount is
    // well within the raw declared budget, but prior GRANTED engagement
    // (already ingested, exactly as a real deployment would have it)
    // leaves too little remaining capacity.
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
    const priorRequest = actionRequest({ sequence: 2, id: "act-0", requester: AGENT, delegationId: "d-root", parameters: monetaryParameters(EUR(800)) });
    const request = actionRequest({ sequence: 3, id: "act-1", requester: AGENT, delegationId: "d-root", parameters: monetaryParameters(EUR(300)) });
    if (!isEventType(priorRequest, "ACTION_REQUESTED") || !isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const deps = makeDependencies();
    const baseStore = ingestAll([toDraft(root), toDraft(priorRequest), toDraft(request)], sequentialClock).canonicalStore;
    const priorCommand: IssueCapabilityCommand = { action_id: priorRequest.payload.action_id, enforcement_point_id: EP };
    const prior = issueCapability(baseStore, authenticated(AGENT), priorCommand, deps);
    expect(prior.ok).toBe(true);
    if (!prior.ok) {
      throw new Error("expected the prior 800 EUR grant to succeed");
    }
    const store = ingestAll(
      [toDraft(root), toDraft(priorRequest), toDraft(request), toDraft(toCapabilityIssuedDraft(prior.capability))],
      sequentialClock,
    ).canonicalStore;

    const command: IssueCapabilityCommand = { action_id: request.payload.action_id, enforcement_point_id: EP };
    const result = issueCapability(store, authenticated(AGENT), command, deps);
    expect(result).toEqual({ ok: false, reason: "CAPACITY_EXCEEDED" });
  });
});

describe("issueCapability — J: a two-level chain with two sufficient budgets checks both", () => {
  it("succeeds when both D1 and D2 have enough remaining capacity", () => {
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
    const request = actionRequest({ sequence: 3, id: "act-1", requester: AGENT_B, delegationId: "d2", parameters: monetaryParameters(EUR(300)) });
    if (!isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const ingested = ingestAll([toDraft(d1), toDraft(d2), toDraft(request)], sequentialClock);
    const command: IssueCapabilityCommand = { action_id: request.payload.action_id, enforcement_point_id: EP };

    const result = issueCapability(ingested.canonicalStore, authenticated(AGENT_B), command, makeDependencies());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok:true");
    }
    expect(result.capability.granted_chain_ref).toEqual([
      { kind: "delegation", delegation_id: "d1" },
      { kind: "delegation", delegation_id: "d2" },
    ]);
  });
});

describe("issueCapability — K: parent sufficient, child insufficient rejects the whole emission", () => {
  it("rejects with CAPACITY_EXCEEDED even though D1 alone would have been enough", () => {
    // Same reasoning as test I applies here: D2's declared total_budget
    // (250) is kept above the single request amount (200) so the
    // pre-existing legacy structural check never fires; a prior GRANTED
    // engagement of 100 through [d1,d2] is what actually leaves D2 short.
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
      totalBudget: EUR(250),
      amountThresholds: thresholds(100000, 100000),
    });
    const priorRequest = actionRequest({ sequence: 3, id: "act-0", requester: AGENT_B, delegationId: "d2", parameters: monetaryParameters(EUR(100)) });
    const request = actionRequest({ sequence: 4, id: "act-1", requester: AGENT_B, delegationId: "d2", parameters: monetaryParameters(EUR(200)) });
    if (!isEventType(priorRequest, "ACTION_REQUESTED") || !isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const deps = makeDependencies();
    const baseStore = ingestAll([toDraft(d1), toDraft(d2), toDraft(priorRequest), toDraft(request)], sequentialClock).canonicalStore;
    const priorCommand: IssueCapabilityCommand = { action_id: priorRequest.payload.action_id, enforcement_point_id: EP };
    const prior = issueCapability(baseStore, authenticated(AGENT_B), priorCommand, deps);
    expect(prior.ok).toBe(true);
    if (!prior.ok) {
      throw new Error("expected the prior 100 EUR grant to succeed");
    }
    const store = ingestAll(
      [toDraft(d1), toDraft(d2), toDraft(priorRequest), toDraft(request), toDraft(toCapabilityIssuedDraft(prior.capability))],
      sequentialClock,
    ).canonicalStore;

    const command: IssueCapabilityCommand = { action_id: request.payload.action_id, enforcement_point_id: EP };
    const result = issueCapability(store, authenticated(AGENT_B), command, deps);
    expect(result).toEqual({ ok: false, reason: "CAPACITY_EXCEEDED" });
  });
});

describe("issueCapability — L: two sequential emissions that together would exceed total_budget", () => {
  it("the second is rejected once the first has actually been ingested as a real grant", () => {
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
    const requestOne = actionRequest({ sequence: 2, id: "act-1", requester: AGENT, delegationId: "d-root", parameters: monetaryParameters(EUR(700)) });
    const requestTwo = actionRequest({ sequence: 3, id: "act-2", requester: AGENT, delegationId: "d-root", parameters: monetaryParameters(EUR(500)) });
    if (!isEventType(requestOne, "ACTION_REQUESTED") || !isEventType(requestTwo, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    let store: CanonicalStore = ingestAll([toDraft(root), toDraft(requestOne), toDraft(requestTwo)], sequentialClock).canonicalStore;

    const deps = makeDependencies();
    const firstCommand: IssueCapabilityCommand = { action_id: requestOne.payload.action_id, enforcement_point_id: EP };
    const first = issueCapability(store, authenticated(AGENT), firstCommand, deps);
    expect(first.ok).toBe(true);
    if (!first.ok) {
      throw new Error("expected ok:true");
    }

    // Persist the first grant for real, exactly like a future PR4B-3
    // transaction would — this test needs it to exist in the store before
    // the second command is evaluated.
    const reingested = ingestAll(
      [toDraft(root), toDraft(requestOne), toDraft(requestTwo), toDraft(toCapabilityIssuedDraft(first.capability))],
      sequentialClock,
    );
    store = reingested.canonicalStore;

    const secondCommand: IssueCapabilityCommand = { action_id: requestTwo.payload.action_id, enforcement_point_id: EP };
    const second = issueCapability(store, authenticated(AGENT), secondCommand, deps);
    expect(second).toEqual({ ok: false, reason: "CAPACITY_EXCEEDED" });
  });
});

function idempotencySetup() {
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
  const request = actionRequest({ sequence: 2, id: "act-1", requester: AGENT, delegationId: "d-root", parameters: monetaryParameters(EUR(700)) });
  const request2 = actionRequest({ sequence: 3, id: "act-2", requester: AGENT, delegationId: "d-root", parameters: monetaryParameters(EUR(400)) });
  if (!isEventType(request, "ACTION_REQUESTED") || !isEventType(request2, "ACTION_REQUESTED")) {
    throw new Error("fixture returned an unexpected event_type");
  }
  const ingested = ingestAll([toDraft(root), toDraft(request), toDraft(request2)], sequentialClock);
  return { store: ingested.canonicalStore, request, request2 };
}

describe("issueCapabilityIdempotently — M: same scope + same command replays, never a second reservation", () => {
  it("returns the identical result on the second call, marked REPLAYED", () => {
    const { store, request } = idempotencySetup();
    const command: IssueCapabilityCommand = { action_id: request.payload.action_id, enforcement_point_id: EP };
    const deps = makeDependencies();
    const key = clientIdempotencyKey("key-1");

    const first = issueCapabilityIdempotently(EMPTY_IDEMPOTENCY_STATE, store, authenticated(AGENT), key, command, deps);
    expect(first.outcome).toBe("EXECUTED");
    if (first.outcome === "IDEMPOTENCY_CONFLICT") {
      throw new Error("expected EXECUTED");
    }

    const second = issueCapabilityIdempotently(first.nextState, store, authenticated(AGENT), key, command, deps);
    expect(second.outcome).toBe("REPLAYED");
    if (second.outcome === "IDEMPOTENCY_CONFLICT") {
      throw new Error("expected REPLAYED");
    }
    expect(second.result).toEqual(first.result);
  });
});

describe("issueCapabilityIdempotently — N: same scope + a different command conflicts", () => {
  it("returns IDEMPOTENCY_CONFLICT, never silently picking either command", () => {
    const { store, request, request2 } = idempotencySetup();
    const deps = makeDependencies();
    const key = clientIdempotencyKey("key-1");

    const first = issueCapabilityIdempotently(EMPTY_IDEMPOTENCY_STATE, store, authenticated(AGENT), key, { action_id: request.payload.action_id, enforcement_point_id: EP }, deps);
    const second = issueCapabilityIdempotently(
      first.nextState,
      store,
      authenticated(AGENT),
      key,
      { action_id: request2.payload.action_id, enforcement_point_id: EP }, // different action_id, same scope
      deps,
    );
    expect(second.outcome).toBe("IDEMPOTENCY_CONFLICT");
  });
});

describe("issueCapabilityIdempotently — O: same client key, different requester, no cross-requester collision", () => {
  it("both succeed independently, as two distinct scopes", () => {
    const root = rootDelegation({
      sequence: 1,
      id: "d-root-o",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(100000, 100000),
    });
    const rootB = rootDelegation({
      sequence: 2,
      id: "d-root-o-b",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_B,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(100000, 100000),
    });
    const requestA = actionRequest({ sequence: 3, id: "act-o-a", requester: AGENT_A, delegationId: "d-root-o", parameters: monetaryParameters(EUR(100)) });
    const requestB = actionRequest({ sequence: 4, id: "act-o-b", requester: AGENT_B, delegationId: "d-root-o-b", parameters: monetaryParameters(EUR(100)) });
    if (!isEventType(requestA, "ACTION_REQUESTED") || !isEventType(requestB, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const ingested = ingestAll([toDraft(root), toDraft(rootB), toDraft(requestA), toDraft(requestB)], sequentialClock);
    const sameRawKey = clientIdempotencyKey("shared-raw-key");
    const deps = makeDependencies();

    const resultA = issueCapabilityIdempotently(EMPTY_IDEMPOTENCY_STATE, ingested.canonicalStore, authenticated(AGENT_A), sameRawKey, { action_id: requestA.payload.action_id, enforcement_point_id: EP }, deps);
    const resultB = issueCapabilityIdempotently(resultA.nextState, ingested.canonicalStore, authenticated(AGENT_B), sameRawKey, { action_id: requestB.payload.action_id, enforcement_point_id: EP }, deps);

    expect(resultA.outcome).toBe("EXECUTED");
    expect(resultB.outcome).toBe("EXECUTED");
    if (resultA.outcome === "IDEMPOTENCY_CONFLICT" || resultB.outcome === "IDEMPOTENCY_CONFLICT") {
      throw new Error("expected both EXECUTED");
    }
    expect(resultA.result.ok).toBe(true);
    expect(resultB.result.ok).toBe(true);
  });
});

/**
 * PRE-COMMIT REVIEW CORRECTION — locking the C9/remainingCapacity
 * composition as an explicit regression invariant.
 *
 * `issueCapability` calls `selectInvokedGrant`, which reuses
 * `validateChain`/`evaluateConstraints` — the exact same legacy path
 * `authorityAt` uses, including the I5/C9 structural check
 * (`evaluateConstraints.ts`'s `budgetExceeded`, sourced from
 * `remainingBudget`/ACTION_EXECUTED). Only once that check has already
 * passed does `issueCapability` reach its OWN, separate capacity check
 * (`remainingCapacity`, sourced from already-issued `CAPABILITY_ISSUED`
 * grants). This is not a merge of the two accounting worlds — capacity.ts
 * and evaluateConstraints.ts remain untouched and mutually unaware of each
 * other — it is a consequence of `issueCapability`'s own call order: C9
 * first (inside `selectInvokedGrant`), the new capacity loop second
 * (`issueCapability.ts`, after a successful selection). The two tests
 * below turn that call order into something a future refactor cannot
 * silently invert without failing a test.
 */
describe("issueCapability — C9-order-1: C9 (legacy, ACTION_EXECUTED-based) rejects on its own, before remainingCapacity is ever consulted", () => {
  it("a single request whose own amount already exceeds the declared total_budget is NOT_AUTHORIZED/C9, never CAPACITY_EXCEEDED — even with zero CAPABILITY_ISSUED grants in the store", () => {
    const root = rootDelegation({
      sequence: 1,
      id: "d-root-p",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      totalBudget: EUR(100),
      amountThresholds: thresholds(100000, 100000),
    });
    const request = actionRequest({ sequence: 2, id: "act-p", requester: AGENT, delegationId: "d-root-p", parameters: monetaryParameters(EUR(500)) });
    if (!isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const ingested = ingestAll([toDraft(root), toDraft(request)], sequentialClock);
    const command: IssueCapabilityCommand = { action_id: request.payload.action_id, enforcement_point_id: EP };

    // No CAPABILITY_ISSUED exists anywhere in this store: remainingCapacity
    // would report the full, undiminished 100 EUR if it were ever reached.
    // It is never reached — C9 rejects first, inside selectInvokedGrant.
    const result = issueCapability(ingested.canonicalStore, authenticated(AGENT), command, makeDependencies());
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected ok:false");
    }
    expect(result.reason).toBe("NOT_AUTHORIZED");
    if (result.decision?.outcome !== "DENIED") {
      throw new Error("expected decision.outcome === DENIED");
    }
    expect(result.decision.reasonCode).toBe("C9_TOTAL_BUDGET_EXCEEDED");
  });
});

describe("issueCapability — C9-order-2: a request that clears C9 but exceeds capacity already engaged by prior CAPABILITY_ISSUED grants is CAPACITY_EXCEEDED, never re-flagged as C9", () => {
  it("the declared total_budget alone would have allowed this request; only the new capacity accounting rejects it", () => {
    const root = rootDelegation({
      sequence: 1,
      id: "d-root-q",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      totalBudget: EUR(1000),
      amountThresholds: thresholds(100000, 100000),
    });
    const priorRequest = actionRequest({ sequence: 2, id: "act-q-0", requester: AGENT, delegationId: "d-root-q", parameters: monetaryParameters(EUR(800)) });
    const request = actionRequest({ sequence: 3, id: "act-q-1", requester: AGENT, delegationId: "d-root-q", parameters: monetaryParameters(EUR(300)) });
    if (!isEventType(priorRequest, "ACTION_REQUESTED") || !isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const deps = makeDependencies();
    const baseStore = ingestAll([toDraft(root), toDraft(priorRequest), toDraft(request)], sequentialClock).canonicalStore;
    const priorCommand: IssueCapabilityCommand = { action_id: priorRequest.payload.action_id, enforcement_point_id: EP };
    const prior = issueCapability(baseStore, authenticated(AGENT), priorCommand, deps);
    expect(prior.ok).toBe(true);
    if (!prior.ok) {
      throw new Error("expected the prior 800 EUR grant to succeed");
    }
    const store = ingestAll(
      [toDraft(root), toDraft(priorRequest), toDraft(request), toDraft(toCapabilityIssuedDraft(prior.capability))],
      sequentialClock,
    ).canonicalStore;

    // 300 EUR, alone, is well within the declared 1000 EUR total_budget —
    // C9/remainingBudget (ACTION_EXECUTED-based, still zero here) would
    // never reject this on its own. Only remainingCapacity, seeing the
    // prior 800 EUR CAPABILITY_ISSUED grant, rejects it.
    const command: IssueCapabilityCommand = { action_id: request.payload.action_id, enforcement_point_id: EP };
    const result = issueCapability(store, authenticated(AGENT), command, deps);
    expect(result).toEqual({ ok: false, reason: "CAPACITY_EXCEEDED" });
  });
});

