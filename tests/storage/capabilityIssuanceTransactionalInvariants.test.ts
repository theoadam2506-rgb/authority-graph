/**
 * PR4B-3A — T1-T9 now run against the real InMemory transactional
 * boundary (`InMemoryCapabilityIssuanceTransaction`), not against bare
 * snapshots of `issueCapability`/`issueCapabilityIdempotently` as the
 * PR4B-3 red-tests round did. "Concurrent" is now genuine: two `issue()`
 * calls are started back-to-back via `Promise.all` on the SAME
 * transaction instance, and the transaction's own private promise-chain
 * mutex — not any accident of missing `await`s — is what must serialize
 * them correctly.
 *
 * T10/T11 are unchanged from the red-tests round: they lock in properties
 * of the pure kernel and of `issueCapabilityIdempotently` itself, neither
 * of which this round touches in behavior.
 */
import { describe, expect, it, vi } from "vitest";
import { ingestAll } from "../../src/engine/authority.js";
import { type IssueCapabilityDependencies, type IssueCapabilityResult } from "../../src/engine/issueCapability.js";
import { issueCapabilityIdempotently, replaceExecutedIdempotencyResult, EMPTY_IDEMPOTENCY_STATE, type IdempotencyState } from "../../src/engine/issueCapabilityIdempotency.js";
import { InMemoryCapabilityIssuanceTransaction, type CapabilityIssuanceOutcome } from "../../src/storage/capabilityIssuanceTransaction.js";
import { InMemoryEventStore } from "../../src/storage/eventStore.js";
import type { AuthenticatedPrincipal } from "../../src/domain/authenticatedPrincipal.js";
import { isEventType, toDraft } from "../../src/domain/events.js";
import { actionId, capabilityId, clientIdempotencyKey, enforcementPointId, expiresAt, iso8601, monetaryParameters, nonMonetaryParameters, thresholds, type PrincipalId } from "../../src/domain/types.js";
import type { IssueCapabilityCommand } from "../../src/domain/capabilityCommand.js";
import { principal } from "../fixtures/ids.js";
import { EUR, PURCHASE_ORDER_CREATE, THEO, actionRequest, rootDelegation, sequentialClock, subDelegation } from "../fixtures/scenarios.js";

const AGENT = principal("pr4b3a-agent");
const AGENT_A = principal("pr4b3a-agent-a");
const AGENT_B = principal("pr4b3a-agent-b");
const EP = enforcementPointId("ep-pr4b3a");

/**
 * PR4B-5 — the explicit prospective authorityTime every transactional call
 * in this file now passes. None of T1-T9/T11's delegations declare a
 * finite `expires_at` (they default to `noExpiry`), so its exact value is
 * inconsequential to any of these tests' outcomes — the T1/T2/T3
 * expiration-under-transaction scenario has its own dedicated tests below.
 */
const AUTHORITY_TIME = iso8601("2025-01-01T00:20:00.000Z");

function authenticated(id: PrincipalId): AuthenticatedPrincipal {
  return { principalId: id };
}

function makeDependencies(startId = 1): IssueCapabilityDependencies {
  let counter = startId;
  return {
    nextCapabilityId: () => capabilityId(`pr4b3a-cap-${counter++}`),
    expiresAt: (snapshotAuthorityTime) => iso8601(new Date(Date.parse(snapshotAuthorityTime) + 5 * 60_000).toISOString()),
  };
}

async function seededStore(drafts: readonly ReturnType<typeof toDraft>[]): Promise<InMemoryEventStore> {
  const store = new InMemoryEventStore(sequentialClock);
  await store.append(drafts);
  return store;
}

/**
 * PR4B-5 — `toDraft` strips `authority_time` (it's an ingested-only field);
 * `seededStore` reassigns it via `sequentialClock`, which ignores whatever
 * `timing.authorityTime` a fixture builder was given. The T12 scenario
 * needs its seed events pinned to one exact, fixed authority_time (T1) —
 * this variant seeds with a clock that always returns that one instant,
 * regardless of draft/index.
 */
async function seededStoreAt(drafts: readonly ReturnType<typeof toDraft>[], authorityTime: ReturnType<typeof iso8601>): Promise<InMemoryEventStore> {
  const store = new InMemoryEventStore({ authorityTime: () => authorityTime });
  await store.append(drafts);
  return store;
}

function isExecutedOk(o: CapabilityIssuanceOutcome): o is { readonly outcome: "EXECUTED"; readonly result: { readonly ok: true; readonly capability: import("../../src/engine/issueCapability.js").IssuedCapabilityData } } {
  return o.outcome === "EXECUTED" && o.result.ok === true;
}

// ---------------------------------------------------------------------------
// T1
// ---------------------------------------------------------------------------

describe("T1 — same requester + same idempotency key + same command, concurrent", () => {
  it("exactly one EXECUTED and one REPLAYED with an identical result, via the real transactional mutex", async () => {
    const root = rootDelegation({ sequence: 1, id: "d-t1", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, amountThresholds: thresholds(100000, 100000) });
    const request = actionRequest({ sequence: 2, id: "act-t1", requester: AGENT, delegationId: "d-t1", parameters: monetaryParameters(EUR(100)) });
    if (!isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const store = await seededStore([toDraft(root), toDraft(request)]);
    const transaction = new InMemoryCapabilityIssuanceTransaction(store);
    const command: IssueCapabilityCommand = { action_id: request.payload.action_id, enforcement_point_id: EP };
    const key = clientIdempotencyKey("t1-key");
    const deps = makeDependencies();

    const [resultA, resultB] = await Promise.all([
      transaction.issue(authenticated(AGENT), key, command, deps, AUTHORITY_TIME),
      transaction.issue(authenticated(AGENT), key, command, deps, AUTHORITY_TIME),
    ]);

    const outcomes = [resultA.outcome, resultB.outcome];
    expect(outcomes.filter((o) => o === "EXECUTED").length).toBe(1);
    expect(outcomes.filter((o) => o === "REPLAYED").length).toBe(1);

    const executed = resultA.outcome === "EXECUTED" ? resultA : resultB;
    const replayed = resultA.outcome === "REPLAYED" ? resultA : resultB;
    if (executed.outcome !== "EXECUTED" || replayed.outcome !== "REPLAYED") {
      throw new Error("expected one EXECUTED and one REPLAYED");
    }
    expect(replayed.result).toEqual(executed.result);

    // Exactly one canonical CAPABILITY_ISSUED — not two.
    const finalStore = await store.getEvents();
    expect(finalStore.filter((e) => e.event_type === "CAPABILITY_ISSUED")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// T2
// ---------------------------------------------------------------------------

describe("T2 — same requester + same idempotency key + different commands, concurrent", () => {
  it("one canonical + one IDEMPOTENCY_CONFLICT, never two CAPABILITY_ISSUED", async () => {
    const root = rootDelegation({ sequence: 1, id: "d-t2", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, amountThresholds: thresholds(100000, 100000) });
    const request1 = actionRequest({ sequence: 2, id: "act-t2-1", requester: AGENT, delegationId: "d-t2", parameters: monetaryParameters(EUR(100)) });
    const request2 = actionRequest({ sequence: 3, id: "act-t2-2", requester: AGENT, delegationId: "d-t2", parameters: monetaryParameters(EUR(100)) });
    if (!isEventType(request1, "ACTION_REQUESTED") || !isEventType(request2, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const store = await seededStore([toDraft(root), toDraft(request1), toDraft(request2)]);
    const transaction = new InMemoryCapabilityIssuanceTransaction(store);
    const key = clientIdempotencyKey("t2-key");
    const deps = makeDependencies();

    const [resultA, resultB] = await Promise.all([
      transaction.issue(authenticated(AGENT), key, { action_id: request1.payload.action_id, enforcement_point_id: EP }, deps, AUTHORITY_TIME),
      transaction.issue(authenticated(AGENT), key, { action_id: request2.payload.action_id, enforcement_point_id: EP }, deps, AUTHORITY_TIME),
    ]);

    const outcomes = [resultA.outcome, resultB.outcome];
    expect(outcomes.filter((o) => o === "EXECUTED").length).toBe(1);
    expect(outcomes.filter((o) => o === "IDEMPOTENCY_CONFLICT").length).toBe(1);

    const finalStore = await store.getEvents();
    expect(finalStore.filter((e) => e.event_type === "CAPABILITY_ISSUED")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// T3
// ---------------------------------------------------------------------------

describe("T3 — different idempotency keys, shared capacity", () => {
  it("remainingCapacity(D)=300, two concurrent 200 EUR reservations, exactly one succeeds", async () => {
    const root = rootDelegation({ sequence: 1, id: "d-t3", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, totalBudget: EUR(300), amountThresholds: thresholds(100000, 100000) });
    const requestA = actionRequest({ sequence: 2, id: "act-t3-a", requester: AGENT, delegationId: "d-t3", parameters: monetaryParameters(EUR(200)) });
    const requestB = actionRequest({ sequence: 3, id: "act-t3-b", requester: AGENT, delegationId: "d-t3", parameters: monetaryParameters(EUR(200)) });
    if (!isEventType(requestA, "ACTION_REQUESTED") || !isEventType(requestB, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const store = await seededStore([toDraft(root), toDraft(requestA), toDraft(requestB)]);
    const transaction = new InMemoryCapabilityIssuanceTransaction(store);
    const deps = makeDependencies();

    const [resultA, resultB] = await Promise.all([
      transaction.issue(authenticated(AGENT), clientIdempotencyKey("t3-key-a"), { action_id: requestA.payload.action_id, enforcement_point_id: EP }, deps, AUTHORITY_TIME),
      transaction.issue(authenticated(AGENT), clientIdempotencyKey("t3-key-b"), { action_id: requestB.payload.action_id, enforcement_point_id: EP }, deps, AUTHORITY_TIME),
    ]);

    const successCount = [resultA, resultB].filter(isExecutedOk).length;
    expect(successCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T4
// ---------------------------------------------------------------------------

describe("T4 — two terminal delegations sharing one bounded ancestor", () => {
  it("the shared ancestor's capacity is never over-reserved across two different invoked delegations", async () => {
    const d1 = rootDelegation({ sequence: 1, id: "d1-t4", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT_A, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: true, totalBudget: EUR(300), amountThresholds: thresholds(100000, 100000) });
    // d2a/d2b each declare their OWN total_budget (individually within
    // d1's 300 EUR) — a bounded parent with an unbounded child is a
    // structural widening violation (validateChain.ts's totalBudgetBoundOk,
    // C9), unrelated to the property this test targets. C9 itself is not
    // modified anywhere in this round.
    const d2a = subDelegation({ sequence: 2, id: "d2a-t4", parentId: "d1-t4", grantor: AGENT_A, grantee: AGENT_A, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, totalBudget: EUR(300), amountThresholds: thresholds(100000, 100000) });
    const d2b = subDelegation({ sequence: 3, id: "d2b-t4", parentId: "d1-t4", grantor: AGENT_A, grantee: AGENT_B, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, totalBudget: EUR(300), amountThresholds: thresholds(100000, 100000) });
    const requestA = actionRequest({ sequence: 4, id: "act-t4-a", requester: AGENT_A, delegationId: "d2a-t4", parameters: monetaryParameters(EUR(200)) });
    const requestB = actionRequest({ sequence: 5, id: "act-t4-b", requester: AGENT_B, delegationId: "d2b-t4", parameters: monetaryParameters(EUR(200)) });
    if (!isEventType(requestA, "ACTION_REQUESTED") || !isEventType(requestB, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const store = await seededStore([toDraft(d1), toDraft(d2a), toDraft(d2b), toDraft(requestA), toDraft(requestB)]);
    const transaction = new InMemoryCapabilityIssuanceTransaction(store);
    const deps = makeDependencies();

    const [resultA, resultB] = await Promise.all([
      transaction.issue(authenticated(AGENT_A), clientIdempotencyKey("t4-key-a"), { action_id: requestA.payload.action_id, enforcement_point_id: EP }, deps, AUTHORITY_TIME),
      transaction.issue(authenticated(AGENT_B), clientIdempotencyKey("t4-key-b"), { action_id: requestB.payload.action_id, enforcement_point_id: EP }, deps, AUTHORITY_TIME),
    ]);

    const successCount = [resultA, resultB].filter(isExecutedOk).length;
    expect(successCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T5
// ---------------------------------------------------------------------------

describe("T5 — N-way concurrency", () => {
  it("capacity=300, five concurrent 100 EUR requests, exactly 3 succeed and never more than 300 engaged", async () => {
    const root = rootDelegation({ sequence: 1, id: "d-t5", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, totalBudget: EUR(300), amountThresholds: thresholds(100000, 100000) });
    const requests = [1, 2, 3, 4, 5].map((n) =>
      actionRequest({ sequence: 1 + n, id: `act-t5-${n}`, requester: AGENT, delegationId: "d-t5", parameters: monetaryParameters(EUR(100)) }),
    );
    for (const request of requests) {
      if (!isEventType(request, "ACTION_REQUESTED")) {
        throw new Error("fixture returned an unexpected event_type");
      }
    }
    const store = await seededStore([toDraft(root), ...requests.map((r) => toDraft(r))]);
    const transaction = new InMemoryCapabilityIssuanceTransaction(store);
    const deps = makeDependencies();

    const results = await Promise.all(
      requests.map((request, index) => {
        if (!isEventType(request, "ACTION_REQUESTED")) {
          throw new Error("fixture returned an unexpected event_type");
        }
        return transaction.issue(authenticated(AGENT), clientIdempotencyKey(`t5-key-${index}`), { action_id: request.payload.action_id, enforcement_point_id: EP }, deps, AUTHORITY_TIME);
      }),
    );

    const successCount = results.filter(isExecutedOk).length;
    const engagedTotal = successCount * 100;

    expect(successCount).toBe(3);
    expect(engagedTotal).toBeLessThanOrEqual(300);
  });
});

// ---------------------------------------------------------------------------
// T6
// ---------------------------------------------------------------------------

describe("T6 — retry after a committed response is lost", () => {
  it("a retry with the same requester/key/command on the same transaction REPLAYs the exact same capability_id/event_id/sequence, never a second emission", async () => {
    const root = rootDelegation({ sequence: 1, id: "d-t6", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, amountThresholds: thresholds(100000, 100000) });
    const request = actionRequest({ sequence: 2, id: "act-t6", requester: AGENT, delegationId: "d-t6", parameters: monetaryParameters(EUR(100)) });
    if (!isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const store = await seededStore([toDraft(root), toDraft(request)]);
    const transaction = new InMemoryCapabilityIssuanceTransaction(store);
    const command: IssueCapabilityCommand = { action_id: request.payload.action_id, enforcement_point_id: EP };
    const key = clientIdempotencyKey("t6-key");
    const deps = makeDependencies();

    const first = await transaction.issue(authenticated(AGENT), key, command, deps, AUTHORITY_TIME);
    if (!isExecutedOk(first)) {
      throw new Error("expected the first attempt to execute and succeed");
    }

    // "The response never reached the original caller" — the caller simply
    // retries with the same requester/key/command. It never needs to know
    // or supply any prior state itself: the transaction owns it.
    const retry = await transaction.issue(authenticated(AGENT), key, command, deps, AUTHORITY_TIME);
    expect(retry.outcome).toBe("REPLAYED");
    if (retry.outcome === "IDEMPOTENCY_CONFLICT" || !retry.result.ok) {
      throw new Error("expected a successful REPLAYED result");
    }
    expect(retry.result.capability.capability_id).toBe(first.result.capability.capability_id);
    expect(retry.result.capability.decision_sequence).toBe(first.result.capability.decision_sequence);

    const finalStore = await store.getEvents();
    expect(finalStore.filter((e) => e.event_type === "CAPABILITY_ISSUED")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// T7
// ---------------------------------------------------------------------------

describe("T7 — atomicity of the event write and the idempotency record", () => {
  it("the transactional API never exposes a success record without its matching canonical event, nor a canonical event without its success record", async () => {
    const root = rootDelegation({ sequence: 1, id: "d-t7", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, amountThresholds: thresholds(100000, 100000) });
    const request = actionRequest({ sequence: 2, id: "act-t7", requester: AGENT, delegationId: "d-t7", parameters: monetaryParameters(EUR(100)) });
    if (!isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const store = await seededStore([toDraft(root), toDraft(request)]);
    const transaction = new InMemoryCapabilityIssuanceTransaction(store);
    const command: IssueCapabilityCommand = { action_id: request.payload.action_id, enforcement_point_id: EP };
    const key = clientIdempotencyKey("t7-key");
    const deps = makeDependencies();

    const result = await transaction.issue(authenticated(AGENT), key, command, deps, AUTHORITY_TIME);
    if (!isExecutedOk(result)) {
      throw new Error("expected this emission to succeed");
    }

    const idempotencyState = transaction.snapshotIdempotencyState();
    const finalStore = await store.getEvents();

    // Direction 1: every success record has a matching canonical event.
    for (const record of idempotencyState.values()) {
      const recordResult = record.result;
      if (recordResult.ok) {
        const matches = finalStore.some((e) => e.event_type === "CAPABILITY_ISSUED" && e.payload.capability_id === recordResult.capability.capability_id);
        expect(matches).toBe(true);
      }
    }
    // Direction 2: the canonical event this command produced has a matching success record.
    const matchingRecord = [...idempotencyState.values()].find((record) => record.result.ok && record.result.capability.capability_id === result.result.capability.capability_id);
    expect(matchingRecord).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// T8
// ---------------------------------------------------------------------------

describe("T8 — forced capability_id collision", () => {
  it("a second emission forced to reuse an already-canonical capability_id is rejected fail-closed, with no success record for it", async () => {
    const root = rootDelegation({ sequence: 1, id: "d-t8", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, amountThresholds: thresholds(100000, 100000) });
    const requestA = actionRequest({ sequence: 2, id: "act-t8-a", requester: AGENT, delegationId: "d-t8", parameters: monetaryParameters(EUR(50)) });
    const requestB = actionRequest({ sequence: 3, id: "act-t8-b", requester: AGENT, delegationId: "d-t8", parameters: monetaryParameters(EUR(50)) });
    if (!isEventType(requestA, "ACTION_REQUESTED") || !isEventType(requestB, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const store = await seededStore([toDraft(root), toDraft(requestA), toDraft(requestB)]);
    const transaction = new InMemoryCapabilityIssuanceTransaction(store);

    // The generator is forced to hand out the exact same capability_id for
    // two otherwise entirely unrelated, individually-valid emissions.
    const collidingId = capabilityId("t8-forced-collision");
    const deps: IssueCapabilityDependencies = {
      nextCapabilityId: () => collidingId,
      expiresAt: (snapshotAuthorityTime) => iso8601(new Date(Date.parse(snapshotAuthorityTime) + 5 * 60_000).toISOString()),
    };

    const first = await transaction.issue(authenticated(AGENT), clientIdempotencyKey("t8-key-a"), { action_id: requestA.payload.action_id, enforcement_point_id: EP }, deps, AUTHORITY_TIME);
    if (!isExecutedOk(first)) {
      throw new Error("expected the first emission to succeed");
    }
    expect(first.result.capability.capability_id).toBe(collidingId);

    const secondKey = clientIdempotencyKey("t8-key-b");
    const secondCommand: IssueCapabilityCommand = { action_id: requestB.payload.action_id, enforcement_point_id: EP };
    const second = await transaction.issue(authenticated(AGENT), secondKey, secondCommand, deps, AUTHORITY_TIME);
    expect(second.outcome).toBe("EXECUTED");
    if (second.outcome !== "EXECUTED") {
      throw new Error("expected EXECUTED (a rejection, not a replay or conflict — different scope)");
    }
    // The refused capability_id is preserved for audit — it must never be
    // read as a canonical success (see issueCapability.ts's own docstring
    // on this branch: a different field, `capability_id`, not `capability`,
    // on a branch whose `ok` is `false`).
    expect(second.result).toEqual({ ok: false, reason: "CAPABILITY_ID_COLLISION", capability_id: collidingId });

    // A retry with the SAME scope+command REPLAYs the exact same failure,
    // including the same refused capability_id — never a fresh attempt,
    // never a different id.
    const retry = await transaction.issue(authenticated(AGENT), secondKey, secondCommand, deps, AUTHORITY_TIME);
    expect(retry.outcome).toBe("REPLAYED");
    if (retry.outcome !== "REPLAYED") {
      throw new Error("expected REPLAYED");
    }
    expect(retry.result).toEqual({ ok: false, reason: "CAPABILITY_ID_COLLISION", capability_id: collidingId });

    // Exactly one canonical CAPABILITY_ISSUED with this capability_id — never two.
    const finalStore = await store.getEvents();
    const withCollidingId = finalStore.filter((e) => e.event_type === "CAPABILITY_ISSUED" && e.payload.capability_id === collidingId);
    expect(withCollidingId).toHaveLength(1);

    // No success record exists for the rejected second emission.
    const idempotencyState = transaction.snapshotIdempotencyState();
    for (const record of idempotencyState.values()) {
      if (record.command.action_id === requestB.payload.action_id) {
        expect(record.result.ok).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// replaceExecutedIdempotencyResult — the pure correction function that
// replaced the raw scopeKey export (PR4B-3A.5 audit correction).
// ---------------------------------------------------------------------------

describe("replaceExecutedIdempotencyResult — pure correction of an already-recorded EXECUTED result", () => {
  // Builds a genuine EXECUTED record the honest way — via
  // issueCapabilityIdempotently itself, exactly as the transactional layer
  // would have one at the point it needs to correct it. This test never
  // needs to know how IdempotencyState represents its keys internally.
  function priorExecutedState() {
    const root = rootDelegation({ sequence: 1, id: "d-correction", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, amountThresholds: thresholds(100000, 100000) });
    const request = actionRequest({ sequence: 2, id: "act-correction", requester: AGENT, delegationId: "d-correction", parameters: monetaryParameters(EUR(10)) });
    if (!isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const store = ingestAll([toDraft(root), toDraft(request)], sequentialClock).canonicalStore;
    const command: IssueCapabilityCommand = { action_id: request.payload.action_id, enforcement_point_id: EP };
    const key = clientIdempotencyKey("correction-key");
    const initial = issueCapabilityIdempotently(EMPTY_IDEMPOTENCY_STATE, store, authenticated(AGENT), key, command, makeDependencies(), AUTHORITY_TIME);
    if (initial.outcome !== "EXECUTED" || !initial.result.ok) {
      throw new Error("expected a genuine EXECUTED/ok:true record to correct");
    }
    return { command, key, priorState: initial.nextState, originalCapabilityId: initial.result.capability.capability_id };
  }

  it("replaces the recorded result for the matching scope, keeping the original command — a subsequent replay returns the corrected result", () => {
    const { command, key, priorState, originalCapabilityId } = priorExecutedState();
    const correctedResult: IssueCapabilityResult = { ok: false, reason: "CAPABILITY_ID_COLLISION", capability_id: originalCapabilityId };

    const nextState = replaceExecutedIdempotencyResult(priorState, authenticated(AGENT), key, command, correctedResult);

    const replayed = issueCapabilityIdempotently(nextState, [], authenticated(AGENT), key, command, makeDependencies(), AUTHORITY_TIME);
    expect(replayed.outcome).toBe("REPLAYED");
    if (replayed.outcome !== "REPLAYED") {
      throw new Error("expected REPLAYED");
    }
    expect(replayed.result).toEqual(correctedResult);
  });

  it("does not mutate the state it was given", () => {
    const { command, key, priorState, originalCapabilityId } = priorExecutedState();
    const priorSnapshot = new Map(priorState);
    const correctedResult: IssueCapabilityResult = { ok: false, reason: "CAPABILITY_ID_COLLISION", capability_id: originalCapabilityId };

    replaceExecutedIdempotencyResult(priorState, authenticated(AGENT), key, command, correctedResult);

    expect(priorState).toEqual(priorSnapshot);
  });

  it("fails closed (throws) when no record exists for the given scope", () => {
    const command: IssueCapabilityCommand = { action_id: actionId("act-ghost-correction"), enforcement_point_id: EP };
    const correctedResult: IssueCapabilityResult = { ok: false, reason: "CAPABILITY_ID_COLLISION", capability_id: capabilityId("cap-ghost") };

    expect(() => replaceExecutedIdempotencyResult(EMPTY_IDEMPOTENCY_STATE, authenticated(AGENT), clientIdempotencyKey("no-such-key"), command, correctedResult)).toThrow();
  });

  it("fails closed (throws) when the expected command does not match the recorded command", () => {
    const { key, priorState, originalCapabilityId } = priorExecutedState();
    const differentCommand: IssueCapabilityCommand = { action_id: actionId("act-different-correction"), enforcement_point_id: EP };
    const correctedResult: IssueCapabilityResult = { ok: false, reason: "CAPABILITY_ID_COLLISION", capability_id: originalCapabilityId };

    expect(() => replaceExecutedIdempotencyResult(priorState, authenticated(AGENT), key, differentCommand, correctedResult)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// T9
// ---------------------------------------------------------------------------

describe("T9 — snapshot/sequence adjacency", () => {
  it("event.sequence === decision_sequence + 1 for a single issuance", async () => {
    const root = rootDelegation({ sequence: 1, id: "d-t9", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, amountThresholds: thresholds(100000, 100000) });
    const request = actionRequest({ sequence: 2, id: "act-t9", requester: AGENT, delegationId: "d-t9", parameters: monetaryParameters(EUR(100)) });
    if (!isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const store = await seededStore([toDraft(root), toDraft(request)]);
    const transaction = new InMemoryCapabilityIssuanceTransaction(store);
    const deps = makeDependencies();

    const result = await transaction.issue(authenticated(AGENT), clientIdempotencyKey("t9-key"), { action_id: request.payload.action_id, enforcement_point_id: EP }, deps, AUTHORITY_TIME);
    if (!isExecutedOk(result)) {
      throw new Error("expected ok:true");
    }

    const finalStore = await store.getEvents();
    const issuedEvent = finalStore.find((e) => e.event_type === "CAPABILITY_ISSUED");
    if (issuedEvent === undefined) {
      throw new Error("expected a canonical CAPABILITY_ISSUED event");
    }
    expect(Number(issuedEvent.sequence)).toBe(Number(result.result.capability.decision_sequence) + 1);
  });

  it("holds independently for each of two concurrent, unrelated issuances — proving the mutex correctly advances the snapshot between turns instead of letting a write interleave between decision and persistence", async () => {
    const root = rootDelegation({ sequence: 1, id: "d-t9b", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, amountThresholds: thresholds(100000, 100000) });
    const requestA = actionRequest({ sequence: 2, id: "act-t9b-a", requester: AGENT, delegationId: "d-t9b", parameters: monetaryParameters(EUR(10)) });
    const requestB = actionRequest({ sequence: 3, id: "act-t9b-b", requester: AGENT, delegationId: "d-t9b", parameters: monetaryParameters(EUR(10)) });
    if (!isEventType(requestA, "ACTION_REQUESTED") || !isEventType(requestB, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const store = await seededStore([toDraft(root), toDraft(requestA), toDraft(requestB)]);
    const transaction = new InMemoryCapabilityIssuanceTransaction(store);
    const deps = makeDependencies();

    const [resultA, resultB] = await Promise.all([
      transaction.issue(authenticated(AGENT), clientIdempotencyKey("t9b-key-a"), { action_id: requestA.payload.action_id, enforcement_point_id: EP }, deps, AUTHORITY_TIME),
      transaction.issue(authenticated(AGENT), clientIdempotencyKey("t9b-key-b"), { action_id: requestB.payload.action_id, enforcement_point_id: EP }, deps, AUTHORITY_TIME),
    ]);
    if (!isExecutedOk(resultA) || !isExecutedOk(resultB)) {
      throw new Error("expected both unrelated issuances to succeed");
    }

    const finalStore = await store.getEvents();
    for (const result of [resultA, resultB]) {
      const issuedEvent = finalStore.find((e) => e.event_type === "CAPABILITY_ISSUED" && e.payload.capability_id === result.result.capability.capability_id);
      if (issuedEvent === undefined) {
        throw new Error("expected a matching canonical event");
      }
      expect(Number(issuedEvent.sequence)).toBe(Number(result.result.capability.decision_sequence) + 1);
    }
    // And the two decision_sequences themselves must differ — the second
    // turn's snapshot necessarily included the first turn's own event.
    expect(resultA.result.capability.decision_sequence).not.toBe(resultB.result.capability.decision_sequence);
  });
});

// ---------------------------------------------------------------------------
// T10 — regression lock, expected GREEN today and after PR4B-3A.
// ---------------------------------------------------------------------------

const KERNEL_AND_TRANSACTION_FILES = [
  "src/engine/issueCapability.ts",
  "src/engine/issueCapabilityIdempotency.ts",
  "src/engine/grantValidation.ts",
  "src/engine/capacity.ts",
  "src/storage/capabilityIssuanceTransaction.ts",
];

/**
 * Several of these files' own docstrings legitimately mention "Date.now()"
 * in prose, explaining exactly why it must never be called — matching raw
 * source text would flag those explanatory comments as violations, which
 * would be an artificial failure (checking the wrong thing), not a real
 * one. Comments are stripped first so only actual call sites can match.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("T10 — no Date.now()/Math.random() anywhere in the pure kernel or the new InMemory transaction (regression lock, expected GREEN)", () => {
  it.each(KERNEL_AND_TRANSACTION_FILES)("%s never calls Date.now() or Math.random() outside of comments", async (relativePath) => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const absolutePath = fileURLToPath(new URL(`../../${relativePath}`, import.meta.url));
    const code = stripComments(readFileSync(absolutePath, "utf8"));
    expect(code).not.toMatch(/Date\.now\(/);
    expect(code).not.toMatch(/Math\.random\(/);
  });
});

// ---------------------------------------------------------------------------
// T11 — regression lock: PR4B-2's own pure idempotency properties under
// correct sequential chaining. Deliberately exercises
// `issueCapabilityIdempotently` directly (not the new transaction), since
// this locks in the pure function's own, unchanged contract.
// ---------------------------------------------------------------------------

describe("T11 — non-regression: issueCapabilityIdempotently's PR4B-2 properties under correct sequential chaining (regression lock, expected GREEN)", () => {
  it("replays under correct state chaining, conflicts on a different command, and keeps cross-requester independence — exactly as tests/engine/issueCapability.test.ts M/N/O already established", () => {
    const root = rootDelegation({ sequence: 1, id: "d-t11", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, amountThresholds: thresholds(100000, 100000) });
    const request = actionRequest({ sequence: 2, id: "act-t11", requester: AGENT, delegationId: "d-t11", parameters: monetaryParameters(EUR(100)) });
    if (!isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const store = ingestAll([toDraft(root), toDraft(request)], sequentialClock).canonicalStore;
    const command: IssueCapabilityCommand = { action_id: request.payload.action_id, enforcement_point_id: EP };
    const key = clientIdempotencyKey("t11-key");
    const deps = makeDependencies();

    const first = issueCapabilityIdempotently(EMPTY_IDEMPOTENCY_STATE, store, authenticated(AGENT), key, command, deps, AUTHORITY_TIME);
    expect(first.outcome).toBe("EXECUTED");
    if (first.outcome === "IDEMPOTENCY_CONFLICT") {
      throw new Error("expected EXECUTED");
    }

    const second = issueCapabilityIdempotently(first.nextState, store, authenticated(AGENT), key, command, deps, AUTHORITY_TIME);
    expect(second.outcome).toBe("REPLAYED");
    if (second.outcome === "IDEMPOTENCY_CONFLICT") {
      throw new Error("expected REPLAYED");
    }
    expect(second.result).toEqual(first.result);
  });
});

// ---------------------------------------------------------------------------
// T12 — PR4B-5: expiration under the real transactional boundary, with
// zero events between the log's own last authority_time and the explicit
// evaluation instant.
// ---------------------------------------------------------------------------

describe("T12 — InMemoryCapabilityIssuanceTransaction rejects issuance past expires_at even with zero events between the log's last authority_time and the explicit evaluation instant", () => {
  it("EXECUTED with result.ok===false, no CAPABILITY_ISSUED written; a retry with the same key at a later authorityTime REPLAYs the same refusal", async () => {
    const T1 = iso8601("2030-01-01T10:00:00.000Z");
    const T2 = "2030-01-01T11:00:00.000Z"; // expires_at
    const T3 = iso8601("2030-01-01T12:00:00.000Z"); // T1 < T2 < T3, first attempt
    const T4 = iso8601("2030-01-01T13:00:00.000Z"); // T3 < T4, retry

    const root = rootDelegation({
      sequence: 1,
      id: "d-t12",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(100000, 100000),
      expires: expiresAt(iso8601(T2)),
      timing: { authorityTime: T1 },
    });
    const request = actionRequest({
      sequence: 2,
      id: "act-t12",
      requester: AGENT,
      delegationId: "d-t12",
      parameters: nonMonetaryParameters(),
      timing: { authorityTime: T1 },
    });
    if (!isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const store = await seededStoreAt([toDraft(root), toDraft(request)], T1);
    const transaction = new InMemoryCapabilityIssuanceTransaction(store);
    const command: IssueCapabilityCommand = { action_id: request.payload.action_id, enforcement_point_id: EP };
    const key = clientIdempotencyKey("t12-key");
    const deps = makeDependencies();

    // No event with authority_time > T1 exists anywhere in this store —
    // the whole point: time (T1 -> T3) passed with zero new events.
    const preStore = await store.getEvents();
    expect(preStore).toHaveLength(2);
    for (const event of preStore) {
      expect(event.authority_time).toBe(T1);
    }

    const first = await transaction.issue(authenticated(AGENT), key, command, deps, T3);
    expect(first.outcome).toBe("EXECUTED");
    if (first.outcome !== "EXECUTED") {
      throw new Error("expected EXECUTED");
    }
    expect(first.result.ok).toBe(false);
    if (first.result.ok) {
      throw new Error("expected ok:false — the delegation must be treated as expired at T3");
    }
    expect(first.result.reason).toBe("NOT_AUTHORIZED");

    const afterFirst = await store.getEvents();
    expect(afterFirst.filter((e) => e.event_type === "CAPABILITY_ISSUED")).toHaveLength(0);

    // Retry, same scope, later real instant T4 — REPLAYED, never
    // re-evaluated at T4, same refusal exactly.
    const retry = await transaction.issue(authenticated(AGENT), key, command, deps, T4);
    expect(retry.outcome).toBe("REPLAYED");
    if (retry.outcome !== "REPLAYED") {
      throw new Error("expected REPLAYED");
    }
    expect(retry.result).toEqual(first.result);

    const finalStore = await store.getEvents();
    expect(finalStore.filter((e) => e.event_type === "CAPABILITY_ISSUED")).toHaveLength(0);
  });

  it("the same scenario, evaluated at an explicit authorityTime strictly before expires_at, is accepted — authority_time/decision_sequence on the produced event are exact", async () => {
    const T1 = iso8601("2030-01-01T10:00:00.000Z");
    const T2 = "2030-01-01T11:00:00.000Z"; // expires_at
    const T3_BEFORE = iso8601("2030-01-01T10:30:00.000Z"); // T1 < T3_BEFORE < T2

    const root = rootDelegation({
      sequence: 1,
      id: "d-t12b",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(100000, 100000),
      expires: expiresAt(iso8601(T2)),
      timing: { authorityTime: T1 },
    });
    const request = actionRequest({
      sequence: 2,
      id: "act-t12b",
      requester: AGENT,
      delegationId: "d-t12b",
      parameters: nonMonetaryParameters(),
      timing: { authorityTime: T1 },
    });
    if (!isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const store = await seededStoreAt([toDraft(root), toDraft(request)], T1);
    const transaction = new InMemoryCapabilityIssuanceTransaction(store);
    const command: IssueCapabilityCommand = { action_id: request.payload.action_id, enforcement_point_id: EP };
    const deps = makeDependencies();

    const result = await transaction.issue(authenticated(AGENT), clientIdempotencyKey("t12b-key"), command, deps, T3_BEFORE);
    if (!isExecutedOk(result)) {
      throw new Error("expected the issuance to succeed before expiration");
    }
    expect(result.result.capability.decision_sequence).toBe(2);

    const finalStore = await store.getEvents();
    const issued = finalStore.find((e) => e.event_type === "CAPABILITY_ISSUED");
    if (issued === undefined) {
      throw new Error("expected a canonical CAPABILITY_ISSUED event");
    }
    expect(issued.authority_time).toBe(T3_BEFORE);
    expect(issued.authority_time).not.toBe(T1);
    if (issued.event_type !== "CAPABILITY_ISSUED") {
      throw new Error("unreachable");
    }
    expect(issued.payload.decision_sequence).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// T13/T14 — PR4B-5A: the hidden InMemoryEventStore.lastTrustedTimeMs
// high-water mark, and its interaction with idempotence.
// ---------------------------------------------------------------------------

describe("T13 — PR4B-5A: a rejected draft's clock reading must not become a hidden high-water mark that silently clamps a later, otherwise-valid explicit authorityTime", () => {
  it("EXECUTED / ok:false / STALE_AUTHORITY_TIME; no CAPABILITY_ISSUED is ever written with T4 silently clamped in", async () => {
    const T1 = iso8601("2030-01-01T10:00:00.000Z");
    const T3 = iso8601("2030-01-01T11:00:00.000Z"); // T1 < T3 < T4
    const T4 = iso8601("2030-01-01T12:00:00.000Z");

    const root = rootDelegation({ sequence: 1, id: "d-t13", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, amountThresholds: thresholds(100000, 100000) });
    const request = actionRequest({ sequence: 2, id: "act-t13", requester: AGENT, delegationId: "d-t13", parameters: monetaryParameters(EUR(100)) });
    if (!isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const store = await seededStoreAt([toDraft(root), toDraft(request)], T1);

    // Advance the store's own PRIVATE lastTrustedTimeMs to T4 by having it
    // process — and REJECT — an unrelated draft whose supplied instant is
    // T4. `d-t13` has canDelegate:false, so any SUBDELEGATION_CREATED
    // naming it as parent is rejected (UNAUTHORIZED_SUBDELEGATION) — never
    // reaching the canonical store. `explicitAuthorityTime` here plays
    // exactly the role a store's own configured IngestionClock would play
    // for this one draft — this is the real public append() API, not a
    // fabricated clock object.
    const rejectedDraft = toDraft(
      subDelegation({ sequence: 3, id: "d-t13-rejected", parentId: "d-t13", grantor: AGENT, grantee: AGENT_B, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false }),
    );
    const rejectionResult = await store.append([rejectedDraft], T4);
    expect(rejectionResult.outcomes).toEqual([{ accepted: false, reasonCode: "UNAUTHORIZED_SUBDELEGATION" }]);

    // The canonical maximum genuinely stays at T1 — the rejected draft
    // never entered the canonical store.
    const preIssueStore = await store.getEvents();
    expect(preIssueStore).toHaveLength(2);
    for (const event of preIssueStore) {
      expect(event.authority_time).toBe(T1);
    }

    const transaction = new InMemoryCapabilityIssuanceTransaction(store);
    const command: IssueCapabilityCommand = { action_id: request.payload.action_id, enforcement_point_id: EP };
    const key = clientIdempotencyKey("t13-key");
    const nextCapabilityId = vi.fn(() => capabilityId("cap-t13-should-never-be-generated"));
    const expiresAtSpy = vi.fn((authorityTime: string) => iso8601(new Date(Date.parse(authorityTime) + 5 * 60_000).toISOString()));
    const deps: IssueCapabilityDependencies = { nextCapabilityId, expiresAt: expiresAtSpy };

    const result = await transaction.issue(authenticated(AGENT), key, command, deps, T3);

    // SECURE, EXPECTED behavior once fixed: EXECUTED with an explicit
    // temporal-consistency refusal, never a silent clamp to T4. ACTUAL,
    // CURRENT behavior: store.append([draft], T3) clamps T3 up to T4 via
    // advanceTrustedTime(this.lastTrustedTimeMs, T3) and silently writes
    // authority_time = T4 — this assertion is the SECURE expectation,
    // expected to fail until PR4B-5A's fix lands.
    expect(result.outcome).toBe("EXECUTED");
    if (result.outcome !== "EXECUTED") {
      throw new Error("expected EXECUTED");
    }
    expect(result.result.ok).toBe(false);
    expect(result.result).toEqual({ ok: false, reason: "STALE_AUTHORITY_TIME" });
    // Unlike the pure-kernel STALE_AUTHORITY_TIME scenario (which never
    // reaches `dependencies`), THIS hidden-high-water-mark case is, by
    // construction, invisible to `issueCapability`: from the kernel's own
    // view of the canonical store (max = T1), T3 is NOT stale — the
    // decision legitimately proceeds and calls both dependencies, exactly
    // as any other successful decision would. Only the persistence layer
    // (InMemoryEventStore.append, which alone knows about
    // lastTrustedTimeMs) detects and refuses the write afterwards. Both
    // dependencies are therefore expected to have been called exactly
    // once — what must never happen is a canonical event actually being
    // written (asserted below).
    expect(nextCapabilityId).toHaveBeenCalledTimes(1);
    expect(expiresAtSpy).toHaveBeenCalledTimes(1);

    const finalStore = await store.getEvents();
    expect(finalStore.filter((e) => e.event_type === "CAPABILITY_ISSUED")).toHaveLength(0);
    // No canonical event of ANY kind was added by this issue() call —
    // still exactly the two seeded events, still both at T1.
    expect(finalStore).toHaveLength(2);
  });
});

describe("T14 — PR4B-5A: idempotence of a STALE_AUTHORITY_TIME refusal", () => {
  it("retry with the same key at a later, individually-valid authorityTime REPLAYs the exact stale refusal, without re-evaluating or generating a capability; a NEW key with that same later instant gets a real, fresh decision", async () => {
    const T1 = iso8601("2030-01-01T10:00:00.000Z");
    const T3 = iso8601("2030-01-01T11:00:00.000Z"); // stale first attempt
    const T4 = iso8601("2030-01-01T12:00:00.000Z"); // the hidden high-water mark
    const T5 = iso8601("2030-01-01T13:00:00.000Z"); // T5 > T4 — individually coherent

    const root = rootDelegation({ sequence: 1, id: "d-t14", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, amountThresholds: thresholds(100000, 100000) });
    const request = actionRequest({ sequence: 2, id: "act-t14", requester: AGENT, delegationId: "d-t14", parameters: monetaryParameters(EUR(100)) });
    if (!isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const store = await seededStoreAt([toDraft(root), toDraft(request)], T1);

    const rejectedDraft = toDraft(
      subDelegation({ sequence: 3, id: "d-t14-rejected", parentId: "d-t14", grantor: AGENT, grantee: AGENT_B, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false }),
    );
    await store.append([rejectedDraft], T4);

    const transaction = new InMemoryCapabilityIssuanceTransaction(store);
    const command: IssueCapabilityCommand = { action_id: request.payload.action_id, enforcement_point_id: EP };
    const key = clientIdempotencyKey("t14-key");
    const deps = makeDependencies();

    const first = await transaction.issue(authenticated(AGENT), key, command, deps, T3);
    if (first.outcome !== "EXECUTED") {
      throw new Error("expected EXECUTED (a stale refusal, not a replay or conflict)");
    }
    expect(first.result).toEqual({ ok: false, reason: "STALE_AUTHORITY_TIME" });

    // Retry: same key, same command, a DIFFERENT (individually coherent,
    // T5 > T4) authorityTime. Must REPLAY the exact original refusal —
    // never re-evaluate, never generate a capability, never become
    // IDEMPOTENCY_CONFLICT merely because authorityTime differs.
    const nextCapabilityIdRetry = vi.fn(() => capabilityId("cap-t14-should-never-be-generated"));
    const expiresAtRetry = vi.fn((authorityTime: string) => iso8601(new Date(Date.parse(authorityTime) + 5 * 60_000).toISOString()));
    const retryDeps: IssueCapabilityDependencies = { nextCapabilityId: nextCapabilityIdRetry, expiresAt: expiresAtRetry };

    const retry = await transaction.issue(authenticated(AGENT), key, command, retryDeps, T5);
    expect(retry.outcome).toBe("REPLAYED");
    if (retry.outcome !== "REPLAYED") {
      throw new Error("expected REPLAYED");
    }
    expect(retry.result).toEqual(first.result);
    expect(nextCapabilityIdRetry).not.toHaveBeenCalled();
    expect(expiresAtRetry).not.toHaveBeenCalled();

    const afterRetryStore = await store.getEvents();
    expect(afterRetryStore.filter((e) => e.event_type === "CAPABILITY_ISSUED")).toHaveLength(0);

    // A NEW clientIdempotencyKey at that same coherent T5 gets a genuine,
    // fresh decision — never blocked by the first key's stale history.
    const key2 = clientIdempotencyKey("t14-key-2");
    const second = await transaction.issue(authenticated(AGENT), key2, command, deps, T5);
    expect(second.outcome).toBe("EXECUTED");
    if (second.outcome !== "EXECUTED") {
      throw new Error("expected EXECUTED");
    }
    expect(second.result.ok).toBe(true);

    const finalStore = await store.getEvents();
    expect(finalStore.filter((e) => e.event_type === "CAPABILITY_ISSUED")).toHaveLength(1);
  });
});
