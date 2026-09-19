/**
 * Security regression — NOT a new finding. Every property this test checks
 * was already guaranteed by the engine before this file existed (I15's
 * fingerprint binding, I16's single-use consumption as precised in PROMPT
 * 6d, and the pre-existing requesting_principal_id/delegation_id match in
 * evaluateConstraints.ts's findGrantOutcome). This file exists to pin that
 * guarantee down explicitly for the specific case that is easiest to get
 * wrong: two *different* principals, under two *independent* delegation
 * chains, requesting an action whose `(capability, parameters)` are
 * identical byte-for-byte — and therefore share the exact same
 * `action_fingerprint` (I15) — even though they are, and must remain, two
 * entirely unrelated authority questions.
 *
 * Vocabulary this test leans on:
 * - `action_fingerprint` (I15) binds an approval to the *parameters* of an
 *   action (resource, action, amount, recipient) — nothing about *which*
 *   principal or *which* delegation asked for it.
 * - `action_id` is what actually identifies *the* action an approval
 *   belongs to, and what a consuming ACTION_EXECUTED must match to draw
 *   down that approval (I16, precised in PROMPT 6d — see
 *   src/engine/evaluateConstraints.ts's `isApprovalConsumed`). Two actions
 *   can share a fingerprint; they can never share an action_id (I8/business
 *   ID uniqueness), and it is action_id — not fingerprint — that consumption
 *   is keyed on.
 */
import { describe, expect, it } from "vitest";
import { authorityAt, explainAction } from "../../src/engine/authority.js";
import { computeActionFingerprint } from "../../src/domain/events.js";
import { monetaryParameters, thresholds } from "../../src/domain/types.js";
import { action } from "../fixtures/ids.js";
import {
  AGENT_A,
  AGENT_C,
  EUR,
  PURCHASE_ORDER_CREATE,
  THEO,
  VENDOR,
  actionExecution,
  actionRequest,
  approvalGrant,
  approvalLink,
  approvalRequest,
  delegationLink,
  instant,
  rootDelegation,
} from "../fixtures/scenarios.js";

describe("Cross-principal action_fingerprint collision — regression", () => {
  // Two independent root delegations, from the same HUMAN_ROOT, to two
  // different agents. Both cover the same capability and the same amount
  // band: nothing about that is illegitimate on its own.
  const chain1Root = rootDelegation({
    sequence: 1,
    id: "d-chain1-root",
    grantor: THEO,
    grantorType: "HUMAN_ROOT",
    grantee: AGENT_A,
    capabilities: [PURCHASE_ORDER_CREATE],
    canDelegate: false,
    amountThresholds: thresholds(100, 1000),
  });
  const chain2Root = rootDelegation({
    sequence: 2,
    id: "d-chain2-root",
    grantor: THEO,
    grantorType: "HUMAN_ROOT",
    grantee: AGENT_C,
    capabilities: [PURCHASE_ORDER_CREATE],
    canDelegate: false,
    amountThresholds: thresholds(100, 1000),
  });

  // Deliberately identical parameters: same resource/action (via the same
  // capability), same amount, same recipient. Different requesting
  // principal, different delegation, different action_id.
  const sharedParams = monetaryParameters(EUR(500), VENDOR);

  const chain1Request = actionRequest({
    sequence: 3,
    id: "action-chain1",
    requester: AGENT_A,
    delegationId: "d-chain1-root",
    parameters: sharedParams,
  });
  const chain2Request = actionRequest({
    sequence: 4,
    id: "action-chain2",
    requester: AGENT_C,
    delegationId: "d-chain2-root",
    parameters: sharedParams,
  });

  const approvalRequestEvent = approvalRequest({
    sequence: 5,
    id: "appr-chain1",
    actionId: "action-chain1",
    requestedFrom: THEO,
    requester: AGENT_A,
  });
  // Granted for chain 1's action specifically — this is the approval an
  // attacker on chain 2 will try to borrow.
  const grant = approvalGrant({ sequence: 6, id: "appr-chain1", actionId: "action-chain1", approver: THEO });

  it("(A) the two actions really do share one action_fingerprint", () => {
    const fingerprint1 = computeActionFingerprint(PURCHASE_ORDER_CREATE, sharedParams);
    const fingerprint2 = computeActionFingerprint(PURCHASE_ORDER_CREATE, sharedParams);
    expect(fingerprint1).toBe(fingerprint2);
  });

  it("(B)-(E) borrowing chain 1's approval for chain 2 never authorizes it, never consumes it, chain 1 stays authorized, and single-use still holds once chain 1 legitimately consumes it", () => {
    // Chain 2's own ACTION_EXECUTED cites chain 1's real, causally-prior
    // approval_id in its authority_chain_ref — the exact shape of PROMPT
    // 6d finding #3, now demonstrated across principals rather than within
    // one.
    const forgedExecution = actionExecution({
      sequence: 7,
      actionId: "action-chain2",
      executor: AGENT_C,
      decisionSequence: 6,
      chain: [delegationLink("d-chain2-root"), approvalLink("appr-chain1")],
      parameters: sharedParams,
    });

    const storeAfterForgery = [chain1Root, chain2Root, chain1Request, chain2Request, approvalRequestEvent, grant, forgedExecution];
    const afterForgery = instant(7);

    // (B) A fresh, unrelated prospective question about chain 2's own
    // fingerprint is not authorized on the strength of chain 1's approval:
    // findGrantOutcome (src/engine/evaluateConstraints.ts) only credits a
    // grant to the requesting_principal_id/delegation_id it was actually
    // bound to — AGENT_A / d-chain1-root, never AGENT_C / d-chain2-root.
    const chain2Query = authorityAt(storeAfterForgery, { agentId: AGENT_C, principalId: THEO, capability: PURCHASE_ORDER_CREATE, parameters: sharedParams }, afterForgery);
    expect(chain2Query.outcome).toBe("REQUIRES_APPROVAL");

    // The forged execution's own historical authority is no better: it
    // resolves to the exact same REQUIRES_APPROVAL, never AUTHORIZED.
    const forgedExplanation = explainAction(storeAfterForgery, { actionId: action("action-chain2") }, afterForgery);
    expect(forgedExplanation.execution?.authorityAtDecision.outcome).toBe("REQUIRES_APPROVAL");

    // (C) & (D) Chain 1's own, legitimate approval is untouched: the
    // forgery attempt did not consume it (isApprovalConsumed requires the
    // consuming execution's action_id to match the grant's own — I16,
    // precised PROMPT 6d) — chain 1's fingerprint remains AUTHORIZED via
    // that exact, still-unconsumed approval.
    const chain1Query = authorityAt(storeAfterForgery, { agentId: AGENT_A, principalId: THEO, capability: PURCHASE_ORDER_CREATE, parameters: sharedParams }, afterForgery);
    const chain1Authorized = chain1Query.outcome === "AUTHORIZED" ? chain1Query : undefined;
    expect(chain1Query.outcome).toBe("AUTHORIZED");
    expect(String(chain1Authorized?.approvalId)).toBe("appr-chain1");

    // (E) Now chain 1 legitimately consumes its own approval via its own,
    // correctly-bound execution. A subsequent attempt to reuse the exact
    // same fingerprint against the exact same delegation must now be
    // DENIED (I16 — ordinary single-use, no cross-principal element left).
    const legitimateExecution = actionExecution({
      sequence: 8,
      actionId: "action-chain1",
      executor: AGENT_A,
      decisionSequence: 6,
      chain: [delegationLink("d-chain1-root"), approvalLink("appr-chain1")],
      parameters: sharedParams,
    });
    const storeAfterConsumption = [...storeAfterForgery, legitimateExecution];
    const afterConsumption = instant(8);

    const chain1AfterConsumption = authorityAt(
      storeAfterConsumption,
      { agentId: AGENT_A, principalId: THEO, capability: PURCHASE_ORDER_CREATE, parameters: sharedParams },
      afterConsumption,
    );
    expect(chain1AfterConsumption.outcome).toBe("DENIED");
    expect(chain1AfterConsumption.outcome === "DENIED" ? chain1AfterConsumption.reasonCode : undefined).toBe("C7_APPROVAL_ALREADY_CONSUMED");
  });
});
