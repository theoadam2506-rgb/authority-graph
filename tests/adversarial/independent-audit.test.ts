/**
 * Reproductions written by the independent security audit.
 *
 * They state the contract in SPEC.md / EVENT_MODEL.md and deliberately do
 * not modify the production implementation.  They are expected to fail on
 * the audited revision when a finding is present.
 */
import { describe, expect, it } from "vitest";
import { authorityAt, explainAction, ingestAll } from "../../src/engine/authority.js";
import { monetaryParameters, thresholds } from "../../src/domain/types.js";
import { toDraft } from "../../src/domain/events.js";
import { action } from "../fixtures/ids.js";
import {
  AGENT_A,
  EUR,
  MALLORY,
  PURCHASE_ORDER_CREATE,
  THEO,
  actionExecution,
  actionRequest,
  approvalGrant,
  approvalLink,
  approvalRequest,
  delegationLink,
  instant,
  rootDelegation,
  sequentialClock,
} from "../fixtures/scenarios.js";

describe("Independent adversarial audit", () => {
  it("I6/I14 — an APPROVAL_GRANTED without its required APPROVAL_REQUESTED cannot authorize", () => {
    const root = rootDelegation({
      sequence: 1,
      id: "audit-approval-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      maxAmount: EUR(1_000),
      amountThresholds: thresholds(100, 1_000),
    });
    const request = actionRequest({
      sequence: 2,
      id: "audit-approval-action",
      requester: AGENT_A,
      delegationId: "audit-approval-root",
      parameters: monetaryParameters(EUR(500)),
    });
    // No APPROVAL_REQUESTED with approval_id "audit-invented-approval" exists.
    const inventedGrant = approvalGrant({
      sequence: 3,
      id: "audit-invented-approval",
      actionId: "audit-approval-action",
      approver: THEO,
    });
    const ingested = ingestAll([toDraft(root), toDraft(request), toDraft(inventedGrant)], sequentialClock);

    // EVENT_MODEL.md requires APPROVAL_GRANTED.approval_id to reference an
    // existing APPROVAL_REQUESTED.  Without it, the request remains in C4.
    expect(
      authorityAt(
        ingested.canonicalStore,
        {
          agentId: AGENT_A,
          principalId: THEO,
          capability: PURCHASE_ORDER_CREATE,
          parameters: monetaryParameters(EUR(500)),
        },
        instant(3),
      ).outcome,
    ).toBe("REQUIRES_APPROVAL");
  });

  it("total_budget — an ACTION_EXECUTED without a demonstrably authorized decision cannot debit another principal's budget", () => {
    const root = rootDelegation({
      sequence: 1,
      id: "audit-budget-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      totalBudget: EUR(100),
      maxAmount: EUR(100),
      amountThresholds: thresholds(100, 100),
    });
    const request = actionRequest({
      sequence: 2,
      id: "audit-budget-action",
      requester: AGENT_A,
      delegationId: "audit-budget-root",
      parameters: monetaryParameters(EUR(100)),
    });
    // Mallory supplies an execution record.  It asserts a chain but there is
    // no validation at ingestion that this execution had an AUTHORIZED
    // decision, that Mallory is the requesting principal, or that its cited
    // chain was the decision's chain.
    const forgedExecution = actionExecution({
      sequence: 3,
      actionId: "audit-budget-action",
      executor: MALLORY,
      decisionSequence: 2,
      chain: [delegationLink("audit-budget-root")],
      parameters: monetaryParameters(EUR(100)),
    });
    const ingested = ingestAll([toDraft(root), toDraft(request), toDraft(forgedExecution)], sequentialClock);

    // EVENT_MODEL.md limits spending to ACTION_EXECUTED with a demonstrably
    // AUTHORIZED decision.  The forged record must therefore have no effect.
    expect(
      authorityAt(
        ingested.canonicalStore,
        {
          agentId: AGENT_A,
          principalId: THEO,
          capability: PURCHASE_ORDER_CREATE,
          parameters: monetaryParameters(EUR(100)),
        },
        instant(3),
      ).outcome,
    ).toBe("AUTHORIZED");
  });

  it("I16 — an execution for a different action cannot consume an approval it does not bind", () => {
    const root = rootDelegation({
      sequence: 1,
      id: "audit-consumption-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      maxAmount: EUR(1_000),
      amountThresholds: thresholds(100, 1_000),
    });
    const approvedAction = actionRequest({
      sequence: 2,
      id: "audit-approved-action",
      requester: AGENT_A,
      delegationId: "audit-consumption-root",
      parameters: monetaryParameters(EUR(500)),
    });
    // This is the only approval request and it is bound to approvedAction.
    const approvalRequestEvent = approvalRequest({
      sequence: 3,
      id: "audit-consumption-approval",
      actionId: "audit-approved-action",
      requestedFrom: THEO,
      requester: AGENT_A,
    });
    const grant = approvalGrant({
      sequence: 4,
      id: "audit-consumption-approval",
      actionId: "audit-approved-action",
      approver: THEO,
    });
    const unrelatedAction = actionRequest({
      sequence: 5,
      id: "audit-unrelated-action",
      requester: AGENT_A,
      delegationId: "audit-consumption-root",
      parameters: monetaryParameters(EUR(500)),
    });
    // Mallory binds the approval for approvedAction to a different execution.
    const forgedConsumption = actionExecution({
      sequence: 6,
      actionId: "audit-unrelated-action",
      executor: MALLORY,
      decisionSequence: 5,
      chain: [delegationLink("audit-consumption-root"), approvalLink("audit-consumption-approval")],
      parameters: monetaryParameters(EUR(500)),
    });
    const ingested = ingestAll(
      [toDraft(root), toDraft(approvedAction), toDraft(approvalRequestEvent), toDraft(grant), toDraft(unrelatedAction), toDraft(forgedConsumption)],
      sequentialClock,
    );

    // The grant for approvedAction remains unconsumed: its approval_id cannot
    // be consumed by an execution with another action_id.
    expect(
      authorityAt(
        ingested.canonicalStore,
        {
          agentId: AGENT_A,
          principalId: THEO,
          capability: PURCHASE_ORDER_CREATE,
          parameters: monetaryParameters(EUR(500)),
        },
        instant(6),
      ).outcome,
    ).toBe("AUTHORIZED");
  });

  it("I4 — an execution cannot cite a future decision_sequence to be authorized by a later delegation", () => {
    // At sequence 1, A has no delegation at all.  The request is deliberately
    // accepted as an out-of-order draft, but its authority is UNKNOWN then.
    const request = actionRequest({
      sequence: 1,
      id: "audit-backdated-action",
      requester: AGENT_A,
      delegationId: "audit-late-root",
    });
    const execution = actionExecution({
      sequence: 2,
      actionId: "audit-backdated-action",
      executor: AGENT_A,
      // This cannot be a decision actually available at execution sequence 2.
      decisionSequence: 4,
      chain: [delegationLink("audit-late-root")],
    });
    // The authority is asserted only *after* execution, but before the forged
    // future sequence.  It cannot authenticate the prior action.
    const lateRoot = rootDelegation({
      sequence: 3,
      id: "audit-late-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
    });
    const ingested = ingestAll([toDraft(request), toDraft(execution), toDraft(lateRoot)], sequentialClock);

    // I4 makes the canonical sequence the causal boundary.  An execution at
    // sequence 2 cannot be authorized by an event assigned sequence 3.
    expect(explainAction(ingested.canonicalStore, { actionId: action("audit-backdated-action") }, instant(3)).execution?.authorityAtDecision.outcome).toBe("UNKNOWN");
  });
});
