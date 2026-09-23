/**
 * DoS resistance for single-use approvals (historical provenance
 * investigation — debates/provenance/QUESTION.md in the private research
 * lab). findGrantOutcome (evaluateConstraints.ts) already refuses to let an
 * approval granted under one delegation chain *authorize* an execution
 * recorded against a different one (I14/I16: request.payload.delegation_id
 * must equal the candidate chain's own terminal). This file protects the
 * separate, easier-to-miss property that isApprovalConsumed must not let
 * such an execution *burn* the approval either, merely by citing its
 * approval_id under the right action_id.
 */
import { describe, expect, it } from "vitest";
import { authorityAt } from "../../src/engine/authority.js";
import { monetaryParameters, thresholds } from "../../src/domain/types.js";
import { principal } from "../fixtures/ids.js";
import {
  EUR,
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
} from "../fixtures/scenarios.js";

describe("Approval consumption — chain-coherence (DoS resistance)", () => {
  it("a rogue execution citing an unrelated chain does not burn the approval bound to the legitimate chain", () => {
    const executor = principal("dos-executor");
    const parameters = monetaryParameters(EUR(400));

    const pathA = rootDelegation({
      sequence: 1,
      id: "dos-a",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: executor,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(100, 1_000),
    });
    const pathB = rootDelegation({
      sequence: 2,
      id: "dos-b",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: executor,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(100, 1_000),
    });
    const request = actionRequest({
      sequence: 3,
      id: "dos-action",
      requester: executor,
      delegationId: "dos-a",
      parameters,
    });
    const approvalRequested = approvalRequest({
      sequence: 4,
      id: "dos-approval",
      actionId: "dos-action",
      requestedFrom: THEO,
      requester: executor,
    });
    const approvalGranted = approvalGrant({ sequence: 5, id: "dos-approval", actionId: "dos-action", approver: THEO });

    // The DoS attempt: same action_id, cites the approval, but its recorded
    // chain (B) has nothing to do with the delegation the approval was
    // actually granted under (A). findGrantOutcome already refuses to let
    // this grant *authorize* B (delegation_id mismatch) — this test is
    // about whether it wrongly *consumes* the approval anyway.
    const rogueExecution = actionExecution({
      sequence: 6,
      actionId: "dos-action",
      executor,
      decisionSequence: 5,
      chain: [delegationLink("dos-b"), approvalLink("dos-approval")],
      parameters,
    });

    const store = [pathA, pathB, request, approvalRequested, approvalGranted, rogueExecution];

    // A fresh authorization attempt via the legitimate chain A must still
    // find the approval available.
    const decisionForA = authorityAt(
      store,
      { agentId: executor, principalId: THEO, capability: PURCHASE_ORDER_CREATE, parameters },
      instant(6),
    );

    expect(decisionForA.outcome).toBe("AUTHORIZED");
    expect(decisionForA).toMatchObject({ approvalId: "dos-approval" });
  });
});
