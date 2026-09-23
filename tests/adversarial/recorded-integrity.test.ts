/**
 * Historical provenance diagnostics (debates/provenance/QUESTION.md in the
 * private research lab): recordedChainIntegrity, invokedRecordedAlignment,
 * recordedValidation. All three are read-only — see
 * tests/integration/recorded-validation-temporal-window.test.ts and
 * tests/adversarial/approval-consumption-coherence.test.ts for the
 * regression-sensitive properties around recordedValidation's temporal
 * anchoring and isApprovalConsumed's chain-coherence, both exercised
 * separately from this file.
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
  subDelegation,
} from "../fixtures/scenarios.js";

const EXECUTOR = principal("recorded-integrity-executor");
const parameters = monetaryParameters(EUR(400));

function baseStore(chain: Parameters<typeof actionExecution>[0]["chain"]) {
  const root = rootDelegation({
    sequence: 1,
    id: "ri-root",
    grantor: THEO,
    grantorType: "HUMAN_ROOT",
    grantee: principal("recorded-integrity-mid"),
    capabilities: [PURCHASE_ORDER_CREATE],
    canDelegate: true,
    amountThresholds: thresholds(1_000, 1_000),
  });
  const leaf = subDelegation({
    sequence: 2,
    id: "ri-leaf",
    parentId: "ri-root",
    grantor: principal("recorded-integrity-mid"),
    grantee: EXECUTOR,
    capabilities: [PURCHASE_ORDER_CREATE],
    canDelegate: false,
    amountThresholds: thresholds(1_000, 1_000),
  });
  const request = actionRequest({
    sequence: 3,
    id: "ri-action",
    requester: EXECUTOR,
    delegationId: "ri-leaf",
    parameters,
  });
  const execution = actionExecution({
    sequence: 4,
    actionId: "ri-action",
    executor: EXECUTOR,
    decisionSequence: 3,
    chain,
    parameters,
  });
  return [root, leaf, request, execution];
}

describe("recordedChainIntegrity / invokedRecordedAlignment — read-only provenance diagnostics", () => {
  it("reports EXACT when the recorded delegation sequence is the invoked chain's canonical ancestry", () => {
    const report = explainAction(baseStore([delegationLink("ri-root"), delegationLink("ri-leaf")]), { actionId: action("ri-action") }, instant(4));

    expect(report.execution?.recordedChainIntegrity).toBe("EXACT");
    expect(report.execution?.invokedRecordedAlignment).toBe("ALIGNED");
  });

  it("reports MISMATCH when the same delegation references are reordered", () => {
    const report = explainAction(baseStore([delegationLink("ri-leaf"), delegationLink("ri-root")]), { actionId: action("ri-action") }, instant(4));

    expect(report.execution?.recordedChainIntegrity).toBe("MISMATCH");
  });

  it("reports UNRESOLVABLE when a recorded delegation reference cannot be found", () => {
    const report = explainAction(baseStore([delegationLink("ri-unknown")]), { actionId: action("ri-action") }, instant(4));

    expect(report.execution?.recordedChainIntegrity).toBe("UNRESOLVABLE");
    expect(report.execution?.invokedRecordedAlignment).toBe("UNRESOLVABLE");
  });

  it("distinguishes structural self-consistency from divergence-from-invoked", () => {
    const mid = principal("align-mid");
    const root = rootDelegation({
      sequence: 1,
      id: "align-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: mid,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: true,
      amountThresholds: thresholds(1_000, 1_000),
    });
    const leafB = subDelegation({
      sequence: 2,
      id: "align-leaf-b",
      parentId: "align-root",
      grantor: mid,
      grantee: EXECUTOR,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(1_000, 1_000),
    });
    const pathA = rootDelegation({
      sequence: 3,
      id: "align-a",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: EXECUTOR,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(1_000, 1_000),
    });
    const request = actionRequest({
      sequence: 4,
      id: "align-action",
      requester: EXECUTOR,
      delegationId: "align-a",
      parameters,
    });
    const execution = actionExecution({
      sequence: 5,
      actionId: "align-action",
      executor: EXECUTOR,
      decisionSequence: 4,
      chain: [delegationLink("align-root"), delegationLink("align-leaf-b")],
      parameters,
    });

    const report = explainAction([root, leafB, pathA, request, execution], { actionId: action("align-action") }, instant(5));

    // The recorded chain is, in itself, a perfectly faithful record of B's ancestry.
    expect(report.execution?.recordedChainIntegrity).toBe("EXACT");
    // But B is not what was invoked (A) — that divergence is a separate fact.
    expect(report.execution?.invokedRecordedAlignment).toBe("DIVERGENT");
  });

  it("resolves the structural leaf even when two successive delegations share the same grantee", () => {
    const executor = principal("leaf-shared-grantee-executor");
    const root = rootDelegation({
      sequence: 1,
      id: "shared-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: executor,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: true,
      amountThresholds: thresholds(1_000, 1_000),
    });
    const leaf = subDelegation({
      sequence: 2,
      id: "shared-leaf",
      parentId: "shared-root",
      grantor: executor,
      grantee: executor,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(1_000, 1_000),
    });
    const request = actionRequest({
      sequence: 3,
      id: "shared-action",
      requester: executor,
      delegationId: "shared-leaf",
      parameters,
    });
    const execution = actionExecution({
      sequence: 4,
      actionId: "shared-action",
      executor,
      decisionSequence: 3,
      chain: [delegationLink("shared-root"), delegationLink("shared-leaf")],
      parameters,
    });

    const report = explainAction([root, leaf, request, execution], { actionId: action("shared-action") }, instant(4));

    // Under a naive "unique delegation cited whose grantee is the executor"
    // rule, both root and leaf would qualify (same grantee) and the
    // terminal would be UNRESOLVABLE. The structural-leaf rule excludes
    // root (it is the parent of another cited delegation) and resolves the
    // unique remaining leaf.
    expect(report.execution?.recordedChainIntegrity).toBe("EXACT");
    expect(report.execution?.invokedRecordedAlignment).toBe("ALIGNED");
  });

  it("does not change I20 accounting when the diagnostic is read", () => {
    const root = rootDelegation({
      sequence: 1,
      id: "ri-read-only-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: EXECUTOR,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      totalBudget: EUR(1_000),
      amountThresholds: thresholds(1_000, 1_000),
    });
    const request = actionRequest({
      sequence: 2,
      id: "ri-read-only-action",
      requester: EXECUTOR,
      delegationId: "ri-read-only-root",
      parameters,
    });
    const execution = actionExecution({
      sequence: 3,
      actionId: "ri-read-only-action",
      executor: EXECUTOR,
      decisionSequence: 2,
      chain: [delegationLink("ri-read-only-root")],
      parameters,
    });
    const store = [root, request, execution];

    const before = remainingBudget(delegation("ri-read-only-root"), EUR(1_000), store);
    expect(explainAction(store, { actionId: action("ri-read-only-action") }, instant(3)).execution?.recordedChainIntegrity).toBe("EXACT");
    const after = remainingBudget(delegation("ri-read-only-root"), EUR(1_000), store);

    expect(before).toBe(600);
    expect(after).toBe(before);
  });
});
