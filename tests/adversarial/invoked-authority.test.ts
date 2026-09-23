/**
 * Principal binding / confused deputy investigation (tests-first, private
 * research lab debate). Same agent, two independent delegations rooted at
 * two different HUMAN_ROOTs (P and P'), same capability.
 *
 * PB1 documents an existing, already-known design consequence — not a
 * vulnerability, not "confused deputy": explainAction's authorityAtDecision
 * / currentAuthority intentionally do not pin the invoked delegation_id or
 * HUMAN_ROOT (see resolveActionAuthority's own comment, explainAction.ts),
 * so they can diverge from recordedValidation, which is anchored to
 * RECORDED's own claimed terminal. This test makes that divergence visible
 * and locked down as current behavior, without correcting it.
 *
 * PB2 confirms an already-guaranteed invariant for the same-agent,
 * cross-delegation shape specifically: an execution citing a different
 * delegation than the one an approval was granted under neither gains
 * authority through that other delegation, nor consumes the legitimate
 * approval.
 */
import { describe, expect, it } from "vitest";
import { authorityAt, explainAction } from "../../src/engine/authority.js";
import { monetaryParameters, thresholds } from "../../src/domain/types.js";
import { action, principal } from "../fixtures/ids.js";
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

describe("Principal binding — AVAILABLE/INVOKED divergence (PB1)", () => {
  it("PB1: authorityAtDecision (AVAILABLE via P') diverges from recordedValidation (INVOKED, P alone) on the same report", () => {
    const P = THEO;
    const Pprime = principal("pb1-root-pprime");
    const AGENT_X = principal("pb1-agent-x");
    const amount = monetaryParameters(EUR(500));

    // D1, rooted at P: automatic ceiling below 500 — alone, 500 requires approval.
    const d1 = rootDelegation({
      sequence: 1,
      id: "pb1-d1",
      grantor: P,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_X,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(100, 1_000),
    });
    // D2, rooted at an entirely independent P': automatic ceiling covers 500 outright.
    const d2 = rootDelegation({
      sequence: 2,
      id: "pb1-d2",
      grantor: Pprime,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_X,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(1_000, 1_000),
    });
    // Request nominally invokes D1 (P's context) only.
    const request = actionRequest({
      sequence: 3,
      id: "pb1-action",
      requester: AGENT_X,
      delegationId: "pb1-d1",
      parameters: amount,
    });
    // Recorded honestly against D1 alone — no padding, no forgery.
    const execution = actionExecution({
      sequence: 4,
      actionId: "pb1-action",
      executor: AGENT_X,
      decisionSequence: 3,
      chain: [delegationLink("pb1-d1")],
      parameters: amount,
    });

    const store = [d1, d2, request, execution];
    const report = explainAction(store, { actionId: action("pb1-action") }, instant(4));

    // AVAILABLE (any valid chain for this agent+fingerprint, root-agnostic
    // by explicit design in resolveActionAuthority): credits P' via D2.
    expect(report.execution?.authorityAtDecision.outcome).toBe("AUTHORIZED");

    // INVOKED-anchored (recordedValidation evaluates RECORDED's own claimed
    // terminal, D1, alone — never searches D2): correctly requires approval.
    expect(report.execution?.recordedValidation).toMatchObject({ outcome: "REQUIRES_APPROVAL" });

    // Provenance diagnostics are internally consistent with this being an
    // honest, exact recording of D1 specifically — the divergence above is
    // not a symptom of a malformed or ambiguous recorded chain.
    expect(report.execution?.recordedChainIntegrity).toBe("EXACT");
    expect(report.execution?.invokedRecordedAlignment).toBe("ALIGNED");
  });
});

describe("Principal binding — approval stays chain-bound for the same agent (PB2)", () => {
  it("PB2: an execution citing D2 with the same action_id neither authorizes via D2 nor consumes D1's approval", () => {
    const P = THEO;
    const Pprime = principal("pb2-root-pprime");
    const AGENT_X = principal("pb2-agent-x");
    const amount = monetaryParameters(EUR(500));

    const d1 = rootDelegation({
      sequence: 1,
      id: "pb2-d1",
      grantor: P,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_X,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(100, 1_000),
    });
    const d2 = rootDelegation({
      sequence: 2,
      id: "pb2-d2",
      grantor: Pprime,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_X,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(100, 1_000), // also approval-banded — D2 alone can never auto-authorize 500
    });
    const request = actionRequest({
      sequence: 3,
      id: "pb2-action", // same action_id used throughout, including by the rogue execution below
      requester: AGENT_X,
      delegationId: "pb2-d1",
      parameters: amount,
    });
    const approvalRequested = approvalRequest({
      sequence: 4,
      id: "pb2-approval",
      actionId: "pb2-action",
      requestedFrom: P,
      requester: AGENT_X,
    });
    // Granted by D1's own grantor (P) specifically.
    const approvalGranted = approvalGrant({ sequence: 5, id: "pb2-approval", actionId: "pb2-action", approver: P });

    // Same action_id as the legitimate request, but the recorded chain
    // cites D2 (P') instead of D1 (P) — the same-agent, cross-principal
    // shape this investigation targets.
    const rogueExecution = actionExecution({
      sequence: 6,
      actionId: "pb2-action",
      executor: AGENT_X,
      decisionSequence: 5,
      chain: [delegationLink("pb2-d2"), approvalLink("pb2-approval")],
      parameters: amount,
    });

    const store = [d1, d2, request, approvalRequested, approvalGranted, rogueExecution];

    // D2 alone, queried under its own root P', is never authorized by P's
    // grant — P's approval does not match D2's own grantor (P'), so D2
    // stays in the approval band, ungranted. Pinned explicitly to P' here
    // so this checks D2 in isolation, not the root-agnostic AVAILABLE
    // search PB1 already documents.
    const freshViaD2 = authorityAt(
      store,
      { agentId: AGENT_X, principalId: Pprime, capability: PURCHASE_ORDER_CREATE, parameters: amount },
      instant(6),
    );
    expect(freshViaD2.outcome).toBe("REQUIRES_APPROVAL");

    // D1's legitimate approval remains available for a fresh query pinned
    // to D1's own root P — the rogue D2 citation neither authorized
    // anything through D2 nor burned D1's approval.
    const freshViaD1 = authorityAt(
      store,
      { agentId: AGENT_X, principalId: P, capability: PURCHASE_ORDER_CREATE, parameters: amount },
      instant(6),
    );
    expect(freshViaD1.outcome).toBe("AUTHORIZED");
    expect(freshViaD1.outcome === "AUTHORIZED" ? freshViaD1.approvalId : undefined).toBe("pb2-approval");
  });
});
