/**
 * Diamond investigation (tests-first, private research lab: multi-path /
 * diamond debate) — D6: ambiguity from two independent leaves.
 *
 * An execution's authority_chain_ref cites two independent, unrelated real
 * delegations, both held by the claimed executor, neither a real ancestor
 * of the other. provenance.ts's recordedTerminalId already defines this as
 * unresolvable (zero or multiple candidate leaves) — this file pins that
 * down explicitly for this specific topology and verifies the two
 * properties the diagnostic must hold: it becomes UNRESOLVABLE for this one
 * execution, and reading it changes neither the shared budget state nor the
 * decision of a fully independent action elsewhere in the store.
 */
import { describe, expect, it } from "vitest";
import { explainAction } from "../../src/engine/authority.js";
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
  rootDelegation,
} from "../fixtures/scenarios.js";

describe("Diamond investigation — ambiguous recorded terminal", () => {
  it("D6: two independent executor-held leaves cited together are UNRESOLVABLE, and reading the diagnostic changes neither the shared budget nor an independent action's decision", () => {
    const executor = principal("diamond-ambiguous-executor");
    const other = principal("diamond-independent-agent");

    const leafX = rootDelegation({
      sequence: 1,
      id: "d6-leaf-x",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: executor,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      totalBudget: EUR(1_000),
      amountThresholds: thresholds(1_000, 1_000),
    });
    const leafY = rootDelegation({
      sequence: 2,
      id: "d6-leaf-y",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: executor,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      totalBudget: EUR(1_000),
      amountThresholds: thresholds(1_000, 1_000),
    });
    // A fully independent action, unrelated delegation, unrelated agent —
    // the control against which "reading the diagnostic changes nothing
    // elsewhere" is checked.
    const independentRoot = rootDelegation({
      sequence: 3,
      id: "d6-independent-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: other,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      totalBudget: EUR(1_000),
      amountThresholds: thresholds(1_000, 1_000),
    });

    const request = actionRequest({
      sequence: 4,
      id: "d6-ambiguous-action",
      requester: executor,
      delegationId: "d6-leaf-x", // invoked = X
      parameters: monetaryParameters(EUR(300)),
    });
    // Recorded chain cites BOTH X and Y: neither is the parent of the
    // other (both are independent roots), and both are held by the
    // executor — exactly two candidate leaves, zero disambiguation.
    const ambiguousExecution = actionExecution({
      sequence: 5,
      actionId: "d6-ambiguous-action",
      executor,
      decisionSequence: 4,
      chain: [delegationLink("d6-leaf-x"), delegationLink("d6-leaf-y")],
      parameters: monetaryParameters(EUR(300)),
    });

    const independentRequest = actionRequest({
      sequence: 6,
      id: "d6-independent-action",
      requester: other,
      delegationId: "d6-independent-root",
      parameters: monetaryParameters(EUR(250)),
    });
    const independentExecution = actionExecution({
      sequence: 7,
      actionId: "d6-independent-action",
      executor: other,
      decisionSequence: 6,
      chain: [delegationLink("d6-independent-root")],
      parameters: monetaryParameters(EUR(250)),
    });

    const store = [leafX, leafY, independentRoot, request, ambiguousExecution, independentRequest, independentExecution];

    // I20's own (invoked-anchored, more permissive) attribution rule still
    // ties this execution to X specifically, independent of the RECORDED
    // ambiguity — this is the same intended I20-vs-provenance tension
    // documented for chain padding: I20 tolerates it, the provenance
    // diagnostics flag it.
    const budgetXBefore = remainingBudget(delegation("d6-leaf-x"), EUR(1_000), store);
    const budgetYBefore = remainingBudget(delegation("d6-leaf-y"), EUR(1_000), store);
    const independentBefore = remainingBudget(delegation("d6-independent-root"), EUR(1_000), store);

    const report = explainAction(store, { actionId: action("d6-ambiguous-action") }, instant(7));

    expect(report.execution?.recordedChainIntegrity).toBe("UNRESOLVABLE");
    expect(report.execution?.invokedRecordedAlignment).toBe("UNRESOLVABLE");
    expect(report.execution?.recordedValidation).toBe("UNRESOLVABLE");

    // Reading the diagnostic changed nothing: same budgets, same independent decision.
    expect(remainingBudget(delegation("d6-leaf-x"), EUR(1_000), store)).toBe(budgetXBefore);
    expect(remainingBudget(delegation("d6-leaf-y"), EUR(1_000), store)).toBe(budgetYBefore);
    expect(remainingBudget(delegation("d6-independent-root"), EUR(1_000), store)).toBe(independentBefore);

    const independentReport = explainAction(store, { actionId: action("d6-independent-action") }, instant(7));
    expect(independentReport.execution?.recordedChainIntegrity).toBe("EXACT");
    expect(independentReport.execution?.authorityAtDecision.outcome).toBe("AUTHORIZED");
  });
});
