/**
 * The scenarios PROMPT 2 and PROMPT 2b require to appear by name, verbatim.
 * Some overlap in mechanism with a THREAT_MODEL/condition-table test (noted
 * where relevant) but are written independently here, sometimes from a
 * complementary angle, because the instruction is that these exact titles
 * must exist as their own tests.
 *
 * PROMPT 2b split the single {actionId}-keyed query into two operations:
 *   - authorityAt(events, {agentId, principalId, capability, parameters}, at)
 *     is PROSPECTIVE and never needs an ACTION_REQUESTED to exist. It can
 *     only ever find AUTHORIZED via an *unconsumed* valid grant for a given
 *     fingerprint — an explicit APPROVAL_DENIED is inherently about one past,
 *     specific request and has no power to block an unrelated future one.
 *   - explainAction(events, {actionId}, at) is HISTORICAL: it resolves the
 *     immutable ACTION_REQUESTED's own fingerprint, reports whether ITS OWN
 *     approval flow (if any) still stands, and evaluates authority both at
 *     any recorded execution's decision_sequence and at the query's sequence.
 *
 * The engine (src/engine/authority.ts) does not exist yet: every test here is
 * EXPECTED TO FAIL. That is the correct state for this prompt (red phase).
 */
import { describe, expect, it } from "vitest";
import { authorityAt, explainAction, ingestAll } from "../../src/engine/authority.js";
import {
  monetaryParameters,
  nonMonetaryParameters,
  sequenceNumber,
  thresholds,
  type AuthorityQuery,
} from "../../src/domain/types.js";
import { toDraft } from "../../src/domain/events.js";
import { action, recipient } from "../fixtures/ids.js";
import {
  AGENT_A,
  AGENT_B,
  AGENT_C,
  EUR,
  MALLORY,
  PURCHASE_ORDER_CREATE,
  THEO,
  VENDOR,
  actionExecution,
  actionRequest,
  approvalDeny,
  approvalGrant,
  approvalLink,
  approvalRequest,
  delegationLink,
  launderingChain,
  revokeDelegation,
  rootDelegation,
  simpleAuthorizedChain,
  siblingsSharingBudget,
  subDelegation,
  instant,
  sequentialClock,
} from "../fixtures/scenarios.js";

const seq = sequenceNumber;

describe("Mandatory named scenarios (PROMPT 2 / PROMPT 2b)", () => {
  it("I5/I-budget — sibling subdelegations share ancestor total_budget at execution", () => {
    // Parent total_budget=1000; two siblings each individually declare 800,
    // which is <= reste(parent)=1000 at *creation* time for each of them
    // independently (I5 is satisfied by both, since nothing has been spent
    // yet when either sibling is created). The conflict only appears once
    // executions actually happen.
    const base = siblingsSharingBudget(1000, 800);
    const store = [
      ...base,
      actionRequest({
        sequence: 4,
        id: "a-sib1",
        requester: AGENT_B,
        delegationId: "d-sibling-1",
        parameters: monetaryParameters(EUR(800)),
      }),
      actionExecution({
        sequence: 5,
        actionId: "a-sib1",
        executor: AGENT_B,
        decisionSequence: 4,
        chain: [delegationLink("d-root"), delegationLink("d-sibling-1")],
        parameters: monetaryParameters(EUR(800)),
      }),
    ];
    // Sibling 2's own total_budget (800) is not exceeded, but the shared
    // ancestor's remaining budget (1000 - 800 already spent by sibling 1 = 200)
    // is: 800 > 200 must be DENIED.
    const query: AuthorityQuery = {
      agentId: AGENT_C,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: monetaryParameters(EUR(800)),
    };
    expect(authorityAt(store, query, instant(5)).outcome).toBe("DENIED");
  });

  it("I-budget — execution is charged against every bounded ancestor in the authority chain", () => {
    const store = [
      rootDelegation({
        sequence: 1,
        id: "d-root",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: true,
        totalBudget: EUR(500),
        amountThresholds: thresholds(500, 500),
      }),
      subDelegation({
        sequence: 2,
        id: "d-mid",
        parentId: "d-root",
        grantor: AGENT_A,
        grantee: AGENT_B,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: true,
        totalBudget: EUR(500),
        amountThresholds: thresholds(500, 500),
      }),
      subDelegation({
        sequence: 3,
        id: "d-leaf",
        parentId: "d-mid",
        grantor: AGENT_B,
        grantee: AGENT_C,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        totalBudget: EUR(500),
        amountThresholds: thresholds(500, 500),
      }),
      actionRequest({
        sequence: 4,
        id: "a-leaf",
        requester: AGENT_C,
        delegationId: "d-leaf",
        parameters: monetaryParameters(EUR(500)),
      }),
      actionExecution({
        sequence: 5,
        actionId: "a-leaf",
        executor: AGENT_C,
        decisionSequence: 4,
        chain: [delegationLink("d-root"), delegationLink("d-mid"), delegationLink("d-leaf")],
        parameters: monetaryParameters(EUR(500)),
      }),
    ];
    // The root's total_budget was exhausted by the leaf's execution, three
    // levels down — proving the debit propagated to every bounded ancestor,
    // not only the immediate parent. A completely different, tiny request
    // directly against the root (the leaf's grandparent) is now DENIED.
    const query: AuthorityQuery = {
      agentId: AGENT_A,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: monetaryParameters(EUR(1)),
    };
    expect(authorityAt(store, query, instant(5)).outcome).toBe("DENIED");
  });

  it("A24 — concurrent authorization does not imply budget reservation", () => {
    // authorityAt is a pure function of the store (I2): calling it for two
    // competing hypothetical spends, before either is executed, must not
    // behave as though the first call had reserved anything for itself.
    const paramsX = monetaryParameters(EUR(100), VENDOR);
    const paramsY = monetaryParameters(EUR(100), recipient("vendor-2"));
    const store = [
      rootDelegation({
        sequence: 1,
        id: "d-root",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        totalBudget: EUR(100),
        amountThresholds: thresholds(100, 100),
      }),
    ];
    const firstCall = authorityAt(
      store,
      { agentId: AGENT_A, principalId: THEO, capability: PURCHASE_ORDER_CREATE, parameters: paramsX }, instant(1));
    const secondCall = authorityAt(
      store,
      { agentId: AGENT_A, principalId: THEO, capability: PURCHASE_ORDER_CREATE, parameters: paramsY }, instant(1));
    expect(firstCall.outcome).toBe("AUTHORIZED");
    expect(secondCall.outcome).toBe("AUTHORIZED");
    // Re-evaluating the first question again afterwards yields the exact same
    // result (I2, purity) — no hidden mutable "reservation" state.
    expect(
      authorityAt(
        store,
        { agentId: AGENT_A, principalId: THEO, capability: PURCHASE_ORDER_CREATE, parameters: paramsX }, instant(1)),
    ).toEqual(firstCall);
  });

  it("multi-path — one execution is charged exactly once through its selected authority chain", () => {
    const params = monetaryParameters(EUR(100));
    const store = [
      rootDelegation({
        sequence: 1,
        id: "d-poor",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        totalBudget: EUR(100),
        amountThresholds: thresholds(100, 100),
      }),
      rootDelegation({
        sequence: 2,
        id: "d-rich",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        totalBudget: EUR(10_000),
        amountThresholds: thresholds(10_000, 10_000),
      }),
      actionRequest({ sequence: 3, id: "a-1", requester: AGENT_A, delegationId: "d-poor", parameters: params }),
      actionExecution({
        sequence: 4,
        actionId: "a-1",
        executor: AGENT_A,
        decisionSequence: 3,
        chain: [delegationLink("d-poor")], // exclusively debits d-poor
        parameters: params,
      }),
    ];
    // d-poor is now fully spent. A fresh prospective question for the same
    // shape of spend must still find d-rich, untouched, via multi-path search.
    const query: AuthorityQuery = {
      agentId: AGENT_A,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: params,
    };
    expect(authorityAt(store, query, instant(4)).outcome).toBe("AUTHORIZED");
  });

  it("authorityAt — does not require ACTION_REQUESTED for a prospective query", () => {
    // simpleAuthorizedChain's store contains exactly one DELEGATION_CREATED
    // and nothing else — no ACTION_REQUESTED anywhere.
    const { store, query } = simpleAuthorizedChain();
    expect(store.some((e) => e.event_type === "ACTION_REQUESTED")).toBe(false);
    expect(authorityAt(store, query, instant(1)).outcome).toBe("AUTHORIZED");
  });

  it("authorityAt — consumed single-use approval cannot authorize prospectively", () => {
    const params = monetaryParameters(EUR(5000));
    const store = [
      rootDelegation({
        sequence: 1,
        id: "d-root",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        maxAmount: EUR(10_000),
        amountThresholds: thresholds(1000, 10_000),
      }),
      actionRequest({ sequence: 2, id: "a-1", requester: AGENT_A, delegationId: "d-root", parameters: params }),
      approvalRequest({ sequence: 3, id: "ap-1", actionId: "a-1", requestedFrom: THEO, requester: AGENT_A }),
      approvalGrant({ sequence: 4, id: "ap-1", actionId: "a-1", approver: THEO }),
    ];
    const query: AuthorityQuery = { agentId: AGENT_A, principalId: THEO, capability: PURCHASE_ORDER_CREATE, parameters: params };
    // Before consumption: AUTHORIZED.
    expect(authorityAt(store, query, instant(4)).outcome).toBe("AUTHORIZED");

    const consumed = [
      ...store,
      actionExecution({
        sequence: 5,
        actionId: "a-1",
        executor: AGENT_A,
        decisionSequence: 4,
        chain: [delegationLink("d-root"), approvalLink("ap-1")],
        parameters: params,
      }),
    ];
    // After consumption, the exact same prospective question: DENIED, never
    // AUTHORIZED again on the strength of "it was legitimate six months ago".
    expect(authorityAt(consumed, query, instant(5)).outcome).toBe("DENIED");
  });

  it("explainAction — historical execution remains explainable as authorized after its grant was consumed", () => {
    const params = monetaryParameters(EUR(5000));
    const store = [
      rootDelegation({
        sequence: 1,
        id: "d-root",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        maxAmount: EUR(10_000),
        amountThresholds: thresholds(1000, 10_000),
      }),
      actionRequest({ sequence: 150, id: "a-1", requester: AGENT_A, delegationId: "d-root", parameters: params }),
      approvalRequest({ sequence: 151, id: "ap-1", actionId: "a-1", requestedFrom: THEO, requester: AGENT_A }),
      // Mechanical fix (PROMPT 3): must be visible AT decision_sequence (151)
      // for the execution below to have been AUTHORIZED at that point — it
      // cannot be sequenced at 152, the execution's own sequence.
      approvalGrant({ sequence: 151, id: "ap-1", actionId: "a-1", approver: THEO, timing: { eventId: "evt-grant" } }),
      actionExecution({
        sequence: 152,
        actionId: "a-1",
        executor: AGENT_A,
        decisionSequence: 151,
        chain: [delegationLink("d-root"), approvalLink("ap-1")],
        parameters: params,
        timing: { eventId: "evt-execute" },
      }),
    ];
    // Composite output, matching PROMPT 2b's worked example:
    //   ACTION_EXECUTED at sequence 152
    //   authority at decision sequence 151: AUTHORIZED
    //   approval consumed by execution 152
    //   current authority at sequence 190: DENIED
    const explanation = explainAction(store, { actionId: action("a-1") }, instant(190));
    expect(explanation.execution?.executedAtSequence).toBe(seq(152));
    expect(explanation.execution?.decisionSequence).toBe(seq(151));
    expect(explanation.execution?.authorityAtDecision.outcome).toBe("AUTHORIZED");
    expect(explanation.execution?.consumedApprovalId).toBeDefined();
    // The single-use grant is spent: the CURRENT authority for this same
    // fingerprint, at a much later sequence, is DENIED — but this does not
    // erase or contradict the fact that the execution was legitimate when it happened.
    expect(explanation.currentAuthority.outcome).toBe("DENIED");
  });

  it("explainAction — resolves the immutable ACTION_REQUESTED fingerprint and evaluates authority at the execution decision point", () => {
    const requested = monetaryParameters(EUR(100));
    const store = [
      rootDelegation({
        sequence: 1,
        id: "d-root",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        maxAmount: EUR(10_000),
        amountThresholds: thresholds(1000, 10_000), // 100 is comfortably auto-approved
      }),
      actionRequest({ sequence: 2, id: "a-1", requester: AGENT_A, delegationId: "d-root", parameters: requested }),
      // The ACTION_EXECUTED payload carries only a fingerprint (a hash), never
      // raw parameters (EVENT_MODEL.md): explainAction can only know what was
      // actually decided by looking up the immutable ACTION_REQUESTED for a-1.
      actionExecution({
        sequence: 3,
        actionId: "a-1",
        executor: AGENT_A,
        decisionSequence: 2,
        chain: [delegationLink("d-root")],
        parameters: requested, // honest: matches the request
      }),
    ];
    const explanation = explainAction(store, { actionId: action("a-1") }, instant(3));
    expect(explanation.requestedAtSequence).toBe(seq(2));
    expect(explanation.execution?.decisionSequence).toBe(seq(2));
    expect(explanation.execution?.authorityAtDecision.outcome).toBe("AUTHORIZED");
  });

  it("I14 — approval denial is not an eternal fingerprint blacklist", () => {
    const params = monetaryParameters(EUR(5000));
    const denied = [
      rootDelegation({
        sequence: 1,
        id: "d-root",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        maxAmount: EUR(10_000),
        amountThresholds: thresholds(1000, 10_000),
      }),
      actionRequest({ sequence: 2, id: "a-1", requester: AGENT_A, delegationId: "d-root", parameters: params }),
      approvalRequest({ sequence: 3, id: "ap-1", actionId: "a-1", requestedFrom: THEO, requester: AGENT_A }),
      approvalDeny({ sequence: 4, id: "ap-1", actionId: "a-1", denier: THEO }),
    ];
    // Whether a-1 itself was denied is a historical fact about a-1.
    expect(explainAction(denied, { actionId: action("a-1") }, instant(4)).currentAuthority.outcome).toBe("DENIED");

    // A brand-new, unrelated prospective question for the exact same
    // fingerprint (capability + amount) is not tainted by a-1's denial: no
    // grant has ever existed for this fingerprint, so it is undecided, not refused.
    const freshQuery: AuthorityQuery = {
      agentId: AGENT_A,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: params,
    };
    expect(authorityAt(denied, freshQuery, instant(4)).outcome).toBe("REQUIRES_APPROVAL");

    const secondApproved = [
      ...denied,
      actionRequest({ sequence: 5, id: "a-2", requester: AGENT_A, delegationId: "d-root", parameters: params }),
      approvalRequest({ sequence: 6, id: "ap-2", actionId: "a-2", requestedFrom: THEO, requester: AGENT_A }),
      approvalGrant({ sequence: 7, id: "ap-2", actionId: "a-2", approver: THEO }),
    ];
    expect(authorityAt(secondApproved, freshQuery, instant(7)).outcome).toBe("AUTHORIZED");
  });

  it("I12 — restrictive descendants cannot launder an unauthorized subdelegation", () => {
    // Theo -> A (<= 5000, can_delegate: false) -> A creates B (<= 1000) -> B creates C (<= 500).
    // Every link is more restrictive than its parent (I5 holds everywhere),
    // but the chain is illegitimate from A -> B onward. C must never be AUTHORIZED.
    const { store, query } = launderingChain();
    const decision = authorityAt(store, query, instant(3));
    expect(decision.outcome).not.toBe("AUTHORIZED");
    expect(decision.outcome).toBe("DENIED");
  });

  it("I13 — unauthorized revoker cannot weaponize revocation propagation", () => {
    const store = [
      rootDelegation({
        sequence: 1,
        id: "d-root",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: true,
      }),
      subDelegation({
        sequence: 2,
        id: "d-sub",
        parentId: "d-root",
        grantor: AGENT_A,
        grantee: AGENT_B,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
      }),
      // Mallory, who is neither A (the direct grantor) nor Theo (chain root),
      // tries to weaponize I7's propagation against B.
      revokeDelegation({ sequence: 3, targetId: "d-sub", issuedBy: MALLORY }),
    ];
    const query: AuthorityQuery = {
      agentId: AGENT_B,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: nonMonetaryParameters(),
    };
    expect(authorityAt(store, query, instant(3)).outcome).toBe("AUTHORIZED");
  });

  it("I14 — unauthorized approver cannot create valid authority", () => {
    const params = monetaryParameters(EUR(5000));
    const store = [
      rootDelegation({
        sequence: 1,
        id: "d-root",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        maxAmount: EUR(10_000),
        amountThresholds: thresholds(1000, 10_000),
      }),
      actionRequest({ sequence: 2, id: "a-1", requester: AGENT_A, delegationId: "d-root", parameters: params }),
      approvalRequest({ sequence: 3, id: "ap-1", actionId: "a-1", requestedFrom: THEO, requester: AGENT_A }),
      approvalGrant({ sequence: 4, id: "ap-1", actionId: "a-1", approver: MALLORY }),
    ];
    const query: AuthorityQuery = { agentId: AGENT_A, principalId: THEO, capability: PURCHASE_ORDER_CREATE, parameters: params };
    expect(authorityAt(store, query, instant(4)).outcome).toBe("REQUIRES_APPROVAL");

    const withRealGrant = [
      ...store,
      approvalGrant({
        sequence: 5,
        id: "ap-1",
        actionId: "a-1",
        approver: THEO,
        timing: { eventId: "evt-real-grant" },
      }),
    ];
    expect(authorityAt(withRealGrant, query, instant(5)).outcome).toBe("AUTHORIZED");
  });

  it("I16 — same approval consumed through different event_ids remains single-use", () => {
    const params = monetaryParameters(EUR(5000));
    const upToFirstExecution = [
      rootDelegation({
        sequence: 1,
        id: "d-root",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        maxAmount: EUR(10_000),
        amountThresholds: thresholds(1000, 10_000),
      }),
      actionRequest({ sequence: 2, id: "a-1", requester: AGENT_A, delegationId: "d-root", parameters: params }),
      approvalRequest({ sequence: 3, id: "ap-1", actionId: "a-1", requestedFrom: THEO, requester: AGENT_A }),
      approvalGrant({ sequence: 4, id: "ap-1", actionId: "a-1", approver: THEO }),
      actionExecution({
        sequence: 5,
        actionId: "a-1",
        executor: AGENT_A,
        decisionSequence: 4,
        chain: [delegationLink("d-root"), approvalLink("ap-1")],
        parameters: params,
        timing: { eventId: "evt-exec-first" },
      }),
    ];
    const query: AuthorityQuery = { agentId: AGENT_A, principalId: THEO, capability: PURCHASE_ORDER_CREATE, parameters: params };
    expect(authorityAt(upToFirstExecution, query, instant(5)).outcome).toBe("DENIED");

    const withSecondConsumption = [
      ...upToFirstExecution,
      actionExecution({
        sequence: 6,
        actionId: "a-1",
        executor: AGENT_A,
        decisionSequence: 4,
        chain: [delegationLink("d-root"), approvalLink("ap-1")],
        parameters: params,
        timing: { eventId: "evt-exec-second" }, // I8 does not intercept this: distinct event_id
      }),
    ];
    // Still DENIED — a second consumption via a different event_id changes nothing.
    expect(authorityAt(withSecondConsumption, query, instant(6)).outcome).toBe("DENIED");
  });

  it("I15 — action_id reuse with different fingerprint cannot reuse approval", () => {
    const original = actionRequest({
      sequence: 2,
      id: "a-1",
      requester: AGENT_A,
      delegationId: "d-root",
      parameters: monetaryParameters(EUR(100)),
      timing: { eventId: "evt-request-original" },
    });
    const conflicting = actionRequest({
      sequence: 3,
      id: "a-1", // same business action_id
      requester: AGENT_A,
      delegationId: "d-root",
      parameters: monetaryParameters(EUR(100_000)), // different fingerprint
      timing: { eventId: "evt-request-conflicting" },
    });
    const ingestion = ingestAll([toDraft(original), toDraft(conflicting)], sequentialClock);
    expect(ingestion.outcomes[1]).toEqual({ accepted: false, reasonCode: "BUSINESS_ID_COLLISION" });
    expect(ingestion.canonicalStore).toHaveLength(1);

    // Even if such a mismatched pair somehow reached the canonical store, the
    // resolver's own I15 check (not just ingestion) must still catch a
    // fingerprint mismatch between what was requested/approved and what was
    // executed for that action_id — a historical question about a-1 itself.
    const store = [
      rootDelegation({
        sequence: 1,
        id: "d-root",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        maxAmount: EUR(1_000_000),
        amountThresholds: thresholds(1000, 1_000_000),
      }),
      original,
      approvalRequest({ sequence: 4, id: "ap-1", actionId: "a-1", requestedFrom: THEO, requester: AGENT_A }),
      approvalGrant({ sequence: 5, id: "ap-1", actionId: "a-1", approver: THEO }),
      actionExecution({
        sequence: 6,
        actionId: "a-1",
        executor: AGENT_A,
        decisionSequence: 5,
        chain: [delegationLink("d-root"), approvalLink("ap-1")],
        parameters: monetaryParameters(EUR(100_000)), // the conflicting amount
      }),
    ];
    const explanation = explainAction(store, { actionId: action("a-1") }, instant(6));
    expect(explanation.execution?.authorityAtDecision.outcome).toBe("DENIED");
  });

  it("A19 — valid path plus attacker-created cyclic path does not poison independent valid authority", () => {
    const store = [
      rootDelegation({
        sequence: 1,
        id: "d-valid",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
      }),
      // parasitic cycle also naming AGENT_A
      subDelegation({
        sequence: 2,
        id: "d-cycle-1",
        parentId: "d-cycle-2",
        grantor: MALLORY,
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: true,
      }),
      subDelegation({
        sequence: 3,
        id: "d-cycle-2",
        parentId: "d-cycle-1",
        grantor: AGENT_A,
        grantee: MALLORY,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: true,
      }),
      // a second kind of noise: a revoked (but structurally separate) chain
      rootDelegation({
        sequence: 4,
        id: "d-revoked",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
      }),
      revokeDelegation({ sequence: 5, targetId: "d-revoked", issuedBy: THEO }),
    ];
    const query: AuthorityQuery = {
      agentId: AGENT_A,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: nonMonetaryParameters(),
    };
    expect(authorityAt(store, query, instant(5)).outcome).toBe("AUTHORIZED");
  });
});
