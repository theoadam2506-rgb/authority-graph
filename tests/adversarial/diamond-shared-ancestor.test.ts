/**
 * Diamond investigation (tests-first, private research lab: multi-path /
 * diamond debate). A true diamond — one delegation with two real parents —
 * is not representable by the current schema (`parent_delegation_id` is a
 * single `DelegationId`, not an array; see
 * tests/adversarial/multi-path-graph.test.ts for the shape the schema DOES
 * support: two structurally independent single-parent chains converging on
 * the same terminal agent).
 *
 * This file probes a shape that IS representable today and was not
 * previously tested: two independent branches, each with its own single
 * parent, that both descend from the SAME real ancestor delegation — in
 * particular, one that carries a shared `total_budget`. No new semantics
 * are introduced; every assertion here is a consequence of
 * `remainingBudget`/`betterOutcome` as they already exist.
 */
import { describe, expect, it } from "vitest";
import { authorityAt, explainAction } from "../../src/engine/authority.js";
import { remainingBudget } from "../../src/engine/evaluateConstraints.js";
import { monetaryParameters, thresholds } from "../../src/domain/types.js";
import { action, delegation, principal } from "../fixtures/ids.js";
import {
  EUR,
  PURCHASE_ORDER_CREATE,
  THEO,
  actionExecution,
  actionRequest,
  delegationLink,
  instant,
  revokeDelegation,
  rootDelegation,
  subDelegation,
} from "../fixtures/scenarios.js";

const AGENT_X = principal("diamond-agent-x");
const MID_A = principal("diamond-mid-a");
const MID_B = principal("diamond-mid-b");

describe("Diamond investigation — two independent branches sharing a real ancestor", () => {
  it("D2: remainingBudget on the shared ancestor sums debits from both independent branches", () => {
    const root = rootDelegation({
      sequence: 1,
      id: "d2-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: MID_A, // structurally irrelevant field for a root — grantee is who receives THIS grant; branches are separate SUBDELEGATION_CREATED nodes below
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: true,
      totalBudget: EUR(1_000),
      amountThresholds: thresholds(1_000, 1_000),
    });
    const branchA = subDelegation({
      sequence: 2,
      id: "d2-branch-a",
      parentId: "d2-root",
      grantor: MID_A,
      grantee: MID_A, // MID_A both receives the root grant and re-delegates onward; the intermediate identity is not the point under test
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: true,
      totalBudget: EUR(1_000), // total_budget must be explicitly re-declared at every level once a real ancestor bounds it (validateChain.ts's totalBudgetBoundOk) — no implicit inheritance
      amountThresholds: thresholds(1_000, 1_000),
    });
    const leafA = subDelegation({
      sequence: 3,
      id: "d2-leaf-a",
      parentId: "d2-branch-a",
      grantor: MID_A,
      grantee: AGENT_X,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      totalBudget: EUR(1_000),
      amountThresholds: thresholds(1_000, 1_000),
    });
    const branchB = subDelegation({
      sequence: 4,
      id: "d2-branch-b",
      parentId: "d2-root",
      grantor: MID_A,
      grantee: MID_B,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: true,
      totalBudget: EUR(1_000),
      amountThresholds: thresholds(1_000, 1_000),
    });
    const leafB = subDelegation({
      sequence: 5,
      id: "d2-leaf-b",
      parentId: "d2-branch-b",
      grantor: MID_B,
      grantee: AGENT_X,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      totalBudget: EUR(1_000),
      amountThresholds: thresholds(1_000, 1_000),
    });
    const requestA = actionRequest({
      sequence: 6,
      id: "d2-action-a",
      requester: AGENT_X,
      delegationId: "d2-leaf-a",
      parameters: monetaryParameters(EUR(300)),
    });
    const executionA = actionExecution({
      sequence: 7,
      actionId: "d2-action-a",
      executor: AGENT_X,
      decisionSequence: 6,
      chain: [delegationLink("d2-root"), delegationLink("d2-branch-a"), delegationLink("d2-leaf-a")],
      parameters: monetaryParameters(EUR(300)),
    });
    const requestB = actionRequest({
      sequence: 8,
      id: "d2-action-b",
      requester: AGENT_X,
      delegationId: "d2-leaf-b",
      parameters: monetaryParameters(EUR(400)),
    });
    const executionB = actionExecution({
      sequence: 9,
      actionId: "d2-action-b",
      executor: AGENT_X,
      decisionSequence: 8,
      chain: [delegationLink("d2-root"), delegationLink("d2-branch-b"), delegationLink("d2-leaf-b")],
      parameters: monetaryParameters(EUR(400)),
    });

    const store = [root, branchA, leafA, branchB, leafB, requestA, executionA, requestB, executionB];

    expect(remainingBudget(delegation("d2-root"), EUR(1_000), store)).toBe(300);
  });

  it("D3: a branch revoked after its own historical debit does not erase that debit, and the sibling branch stays independently authorized", () => {
    const root = rootDelegation({
      sequence: 1,
      id: "d3-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: MID_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: true,
      totalBudget: EUR(1_000),
      amountThresholds: thresholds(1_000, 1_000),
    });
    const branchA = subDelegation({
      sequence: 2,
      id: "d3-branch-a",
      parentId: "d3-root",
      grantor: MID_A,
      grantee: MID_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: true,
      totalBudget: EUR(1_000),
      amountThresholds: thresholds(1_000, 1_000),
    });
    const leafA = subDelegation({
      sequence: 3,
      id: "d3-leaf-a",
      parentId: "d3-branch-a",
      grantor: MID_A,
      grantee: AGENT_X,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      totalBudget: EUR(1_000),
      amountThresholds: thresholds(1_000, 1_000),
    });
    // Declared well under root's original 1_000, deliberately: a sibling
    // whose own declared total_budget nominally exceeds the shared root's
    // CURRENT remaining (not just its original value) fails chain
    // validation itself (C9, at validateChain, before evaluateConstraints
    // ever compares the actual requested amount) — see the "unexpected
    // behavior" note in the PR/review for this file. 500 stays safely under
    // root's remaining (700) even after branch A's own 300 EUR debit.
    const branchB = subDelegation({
      sequence: 4,
      id: "d3-branch-b",
      parentId: "d3-root",
      grantor: MID_A,
      grantee: MID_B,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: true,
      totalBudget: EUR(500),
      amountThresholds: thresholds(500, 500),
    });
    const leafB = subDelegation({
      sequence: 5,
      id: "d3-leaf-b",
      parentId: "d3-branch-b",
      grantor: MID_B,
      grantee: AGENT_X,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      totalBudget: EUR(500),
      amountThresholds: thresholds(500, 500),
    });
    const requestA = actionRequest({
      sequence: 6,
      id: "d3-action-a",
      requester: AGENT_X,
      delegationId: "d3-leaf-a",
      parameters: monetaryParameters(EUR(300)),
    });
    const executionA = actionExecution({
      sequence: 7,
      actionId: "d3-action-a",
      executor: AGENT_X,
      decisionSequence: 6,
      chain: [delegationLink("d3-root"), delegationLink("d3-branch-a"), delegationLink("d3-leaf-a")],
      parameters: monetaryParameters(EUR(300)),
    });
    // Branch A revoked AFTER its own action already executed historically.
    // Branch B never spends here — this test isolates revocation
    // non-retroactivity from the separate (already-demonstrated, see
    // required-scenarios.test.ts's "I5/I-budget — sibling subdelegations
    // share ancestor total_budget" scenario) fact that a sibling's own
    // declared total_budget must itself stay within the shared ancestor's
    // CURRENT remaining, or its whole chain fails validation — not just its
    // own overspending.
    const revokeBranchA = revokeDelegation({ sequence: 8, targetId: "d3-branch-a", issuedBy: THEO });

    const store = [root, branchA, leafA, branchB, leafB, requestA, executionA, revokeBranchA];

    // Revocation is prospective, never retroactive (already-established
    // invariant) — branch A's historical 300 EUR debit still counts against
    // the shared root's budget even though branch A is now revoked.
    expect(remainingBudget(delegation("d3-root"), EUR(1_000), store)).toBe(700);

    // Branch A's own historical decision, at its own decision_sequence
    // (before the revocation existed), is unaffected by the later
    // revocation — T-HIST-001, re-verified on this shared-ancestor topology.
    const explanationA = explainAction(store, { actionId: action("d3-action-a") }, instant(8));
    expect(explanationA.execution?.authorityAtDecision.outcome).toBe("AUTHORIZED");

    // Branch B remains independently authorized for a fresh query, entirely
    // unaffected by branch A's revocation, despite sharing the same root —
    // and despite root's remaining now being reduced by A's historical
    // spend (1_000 - 300 = 700; B's own declared 500 EUR ceiling still
    // comfortably fits).
    const freshQuery = authorityAt(
      store,
      { agentId: AGENT_X, principalId: THEO, capability: PURCHASE_ORDER_CREATE, parameters: monetaryParameters(EUR(200)) },
      instant(8),
    );
    expect(freshQuery.outcome).toBe("AUTHORIZED");
    expect(freshQuery.outcome === "AUTHORIZED" ? freshQuery.chain : undefined).toEqual(["d3-root", "d3-branch-b", "d3-leaf-b"]);
  });

  it("D3b: a sibling whose declared total_budget matches the root's original value is denied for ANY amount once the other sibling has spent — I5 dynamic revalidation, not reservation", () => {
    const root = rootDelegation({
      sequence: 1,
      id: "d3b-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: MID_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: true,
      totalBudget: EUR(1_000),
      amountThresholds: thresholds(1_000, 1_000),
    });
    const branchA = subDelegation({
      sequence: 2,
      id: "d3b-branch-a",
      parentId: "d3b-root",
      grantor: MID_A,
      grantee: MID_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: true,
      totalBudget: EUR(1_000), // deliberately equal to root's own declared value — no margin
      amountThresholds: thresholds(1_000, 1_000),
    });
    const leafA = subDelegation({
      sequence: 3,
      id: "d3b-leaf-a",
      parentId: "d3b-branch-a",
      grantor: MID_A,
      grantee: AGENT_X,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      totalBudget: EUR(1_000),
      amountThresholds: thresholds(1_000, 1_000),
    });
    // Sibling branch B: same declared ceiling as root, no margin either —
    // this is the shape under test, not something to avoid this time.
    const branchB = subDelegation({
      sequence: 4,
      id: "d3b-branch-b",
      parentId: "d3b-root",
      grantor: MID_A,
      grantee: MID_B,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: true,
      totalBudget: EUR(1_000),
      amountThresholds: thresholds(1_000, 1_000),
    });
    const leafB = subDelegation({
      sequence: 5,
      id: "d3b-leaf-b",
      parentId: "d3b-branch-b",
      grantor: MID_B,
      grantee: AGENT_X,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      totalBudget: EUR(1_000),
      amountThresholds: thresholds(1_000, 1_000),
    });
    const requestA = actionRequest({
      sequence: 6,
      id: "d3b-action-a",
      requester: AGENT_X,
      delegationId: "d3b-leaf-a",
      parameters: monetaryParameters(EUR(300)),
    });
    const executionA = actionExecution({
      sequence: 7,
      actionId: "d3b-action-a",
      executor: AGENT_X,
      decisionSequence: 6,
      chain: [delegationLink("d3b-root"), delegationLink("d3b-branch-a"), delegationLink("d3b-leaf-a")],
      parameters: monetaryParameters(EUR(300)),
    });

    const store = [root, branchA, leafA, branchB, leafB, requestA, executionA];

    // Root's remaining is now 700 (1_000 - 300 spent via A). Branch B's own
    // declared ceiling (1_000) exceeds that remaining, so B's ENTIRE chain
    // fails validation — not because the tiny requested amount itself is
    // too large, but because B's nominal declared capacity, revalidated
    // against the root's CURRENT remaining at every resolution, no longer
    // fits. A one-unit request is denied exactly like a thousand-unit one
    // would be: the failure is structural (validateChain's
    // totalBudgetBoundOk), not a simple "amount > remaining" comparison.
    const tinyQuery = authorityAt(
      store,
      { agentId: AGENT_X, principalId: THEO, capability: PURCHASE_ORDER_CREATE, parameters: monetaryParameters(EUR(1)) },
      instant(7),
    );
    expect(tinyQuery.outcome).toBe("DENIED");
    expect(tinyQuery.outcome === "DENIED" ? tinyQuery.reasonCode : undefined).toBe("C9_TOTAL_BUDGET_EXCEEDED");
  });

  it("D4: two independently valid branches with different thresholds are never combined into one evaluation", () => {
    const root = rootDelegation({
      sequence: 1,
      id: "d4-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: MID_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: true,
      amountThresholds: thresholds(1_000, 1_000),
    });
    const branchA = subDelegation({
      sequence: 2,
      id: "d4-branch-a",
      parentId: "d4-root",
      grantor: MID_A,
      grantee: MID_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: true,
      amountThresholds: thresholds(1_000, 1_000),
    });
    // Branch A's own leaf is deliberately TIGHTER than the shared root: a
    // low automatic ceiling, forcing amounts above 100 into REQUIRES_APPROVAL.
    const leafA = subDelegation({
      sequence: 3,
      id: "d4-leaf-a",
      parentId: "d4-branch-a",
      grantor: MID_A,
      grantee: AGENT_X,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(100, 1_000),
    });
    const branchB = subDelegation({
      sequence: 4,
      id: "d4-branch-b",
      parentId: "d4-root",
      grantor: MID_A,
      grantee: MID_B,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: true,
      amountThresholds: thresholds(1_000, 1_000),
    });
    // Branch B's leaf keeps the shared root's laxer automatic ceiling.
    const leafB = subDelegation({
      sequence: 5,
      id: "d4-leaf-b",
      parentId: "d4-branch-b",
      grantor: MID_B,
      grantee: AGENT_X,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(1_000, 1_000),
    });

    const amount = monetaryParameters(EUR(500)); // above A's automatic ceiling (100), within A's approval band (<=1000); within B's automatic ceiling (1000)

    // With only branch A present, 500 requires approval via A alone.
    const storeAOnly = [root, branchA, leafA];
    const decisionAOnly = authorityAt(
      storeAOnly,
      { agentId: AGENT_X, principalId: THEO, capability: PURCHASE_ORDER_CREATE, parameters: amount },
      instant(5),
    );
    expect(decisionAOnly.outcome).toBe("REQUIRES_APPROVAL");

    // With both branches present, the same query resolves AUTHORIZED — but
    // strictly because branch B, evaluated entirely on its own, is fully
    // valid at this amount. Branch A's tighter threshold is never relaxed by
    // B's presence, and B's chain is what actually authorizes — not some
    // merged capability drawing A's approval-band ceiling and B's automatic
    // ceiling together.
    const storeBoth = [root, branchA, leafA, branchB, leafB];
    const decisionBoth = authorityAt(
      storeBoth,
      { agentId: AGENT_X, principalId: THEO, capability: PURCHASE_ORDER_CREATE, parameters: amount },
      instant(5),
    );
    expect(decisionBoth.outcome).toBe("AUTHORIZED");
    expect(decisionBoth.outcome === "AUTHORIZED" ? decisionBoth.chain : undefined).toEqual(["d4-root", "d4-branch-b", "d4-leaf-b"]);
  });
});
