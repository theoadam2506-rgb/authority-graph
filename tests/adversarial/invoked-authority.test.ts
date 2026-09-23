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
  revokeDelegation,
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

describe("Principal binding — INVOKED validation is a third, independent axis (M1)", () => {
  it("M1: AVAILABLE, INVOKED, and RECORDED reach three distinct conclusions on the same report", () => {
    const P = THEO;
    const Pprime = principal("m1-root-pprime");
    const Pdoubleprime = principal("m1-root-pdoubleprime");
    const AGENT_X = principal("m1-agent-x");
    const amount = monetaryParameters(EUR(500));

    // D1, rooted at P: too tight — 500 requires approval alone. Named by
    // ACTION_REQUESTED.delegation_id — this is INVOKED.
    const d1 = rootDelegation({
      sequence: 1,
      id: "m1-d1",
      grantor: P,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_X,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(100, 1_000),
    });
    // D2, rooted at an unrelated P': wide enough to auto-authorize 500 on its
    // own. Not invoked, not recorded — only reachable by the root-agnostic
    // AVAILABLE search (authorityAtDecision/currentAuthority).
    const d2 = rootDelegation({
      sequence: 2,
      id: "m1-d2",
      grantor: Pprime,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_X,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(1_000, 1_000),
    });
    // D3, rooted at yet another unrelated P'': structurally valid, but
    // revoked before decision_sequence. Cited alone in authority_chain_ref —
    // this is RECORDED's own claimed terminal, and diverges from INVOKED
    // (D1): invokedRecordedAlignment DIVERGENT.
    const d3 = rootDelegation({
      sequence: 3,
      id: "m1-d3",
      grantor: Pdoubleprime,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_X,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(1_000, 1_000),
    });
    const d3Revoked = revokeDelegation({ sequence: 4, targetId: "m1-d3", issuedBy: Pdoubleprime });
    // Request nominally invokes D1.
    const request = actionRequest({
      sequence: 5,
      id: "m1-action",
      requester: AGENT_X,
      delegationId: "m1-d1",
      parameters: amount,
    });
    // The execution actually records D3 alone, not D1.
    const execution = actionExecution({
      sequence: 6,
      actionId: "m1-action",
      executor: AGENT_X,
      decisionSequence: 5,
      chain: [delegationLink("m1-d3")],
      parameters: amount,
    });

    const store = [d1, d2, d3, d3Revoked, request, execution];
    const report = explainAction(store, { actionId: action("m1-action") }, instant(6));

    // AVAILABLE: root-agnostic search finds D2, wide enough — AUTHORIZED.
    expect(report.execution?.authorityAtDecision).toMatchObject({ outcome: "AUTHORIZED", chain: ["m1-d2"] });

    // INVOKED: D1 alone, the delegation the request actually named — too tight, REQUIRES_APPROVAL.
    expect(report.execution?.invokedAuthorityAtDecision).toMatchObject({ outcome: "REQUIRES_APPROVAL", viaDelegation: "m1-d1" });

    // RECORDED: D3 alone, the delegation the execution actually cited — revoked before decision_sequence, DENIED.
    expect(report.execution?.recordedValidation).toMatchObject({ outcome: "DENIED", reasonCode: "C12_DELEGATION_REVOKED" });

    // Three distinct outcomes (AUTHORIZED / REQUIRES_APPROVAL / DENIED) on one report, from one execution.
    const outcomes = new Set([
      report.execution?.authorityAtDecision.outcome,
      report.execution?.invokedAuthorityAtDecision === "UNRESOLVABLE" ? "UNRESOLVABLE" : report.execution?.invokedAuthorityAtDecision.outcome,
      report.execution?.recordedValidation === "UNRESOLVABLE" ? "UNRESOLVABLE" : report.execution?.recordedValidation.outcome,
    ]);
    expect(outcomes.size).toBe(3);

    // The divergence is not a symptom of a malformed or ambiguous recorded chain:
    // D3 alone is exactly, structurally what got recorded (EXACT), it is simply
    // not what was invoked (DIVERGENT from D1).
    expect(report.execution?.recordedChainIntegrity).toBe("EXACT");
    expect(report.execution?.invokedRecordedAlignment).toBe("DIVERGENT");
  });
});

describe("INVOKED validation requires the requester to actually hold the invoked delegation (M9)", () => {
  it("M9: D1 exists and is structurally valid, but is granted to B while ACTION_REQUESTED.requesting_principal_id = A — never AUTHORIZED via D1", () => {
    const P = THEO;
    const AGENT_A = principal("m9-agent-a");
    const AGENT_B = principal("m9-agent-b");
    const amount = monetaryParameters(EUR(400));

    // D1: structurally valid, wide enough to auto-authorize — but granted to B, not A.
    const d1 = rootDelegation({
      sequence: 1,
      id: "m9-d1",
      grantor: P,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_B,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(1_000, 1_000),
    });
    // A requests, naming D1 (B's delegation, not A's) as the invoked delegation.
    const request = actionRequest({
      sequence: 2,
      id: "m9-action",
      requester: AGENT_A,
      delegationId: "m9-d1",
      parameters: amount,
    });
    const execution = actionExecution({
      sequence: 3,
      actionId: "m9-action",
      executor: AGENT_A,
      decisionSequence: 2,
      chain: [delegationLink("m9-d1")],
      parameters: amount,
    });

    const store = [d1, request, execution];
    const report = explainAction(store, { actionId: action("m9-action") }, instant(3));

    // Neither the "at decision" nor the "now" INVOKED view may ever be AUTHORIZED through B's delegation.
    expect(report.execution?.invokedAuthorityAtDecision).toEqual({ outcome: "UNKNOWN", reasonCode: "C24_NO_VALID_CHAIN" });
    expect(report.invokedAuthorityNow).toEqual({ outcome: "UNKNOWN", reasonCode: "C24_NO_VALID_CHAIN" });
  });
});

describe("Invoked canonical chain is verdict-independent (M6)", () => {
  it("M6: invokedCanonicalChainAtDecision resolves structurally even when the decision is REQUIRES_APPROVAL, not only when AUTHORIZED", async () => {
    const { explain } = await import("../../src/engine/authority.js");
    const P = THEO;
    const AGENT_X = principal("m6-agent-x");
    const amount = monetaryParameters(EUR(500));

    // D1: too tight to auto-authorize 500 — REQUIRES_APPROVAL, so AuthorityDecision.chain does not exist.
    const d1 = rootDelegation({
      sequence: 1,
      id: "m6-d1",
      grantor: P,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_X,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(100, 1_000),
    });
    const request = actionRequest({
      sequence: 2,
      id: "m6-action",
      requester: AGENT_X,
      delegationId: "m6-d1",
      parameters: amount,
    });
    const execution = actionExecution({
      sequence: 3,
      actionId: "m6-action",
      executor: AGENT_X,
      decisionSequence: 2,
      chain: [delegationLink("m6-d1")],
      parameters: amount,
    });

    const store = [d1, request, execution];
    const report = explain(store, { actionId: action("m6-action") }, instant(3));

    // The verdict itself carries no chain (REQUIRES_APPROVAL never does).
    expect(report.execution?.authorityAtDecision).toMatchObject({ outcome: "REQUIRES_APPROVAL" });
    expect(report.execution?.invokedAuthorityAtDecision).toMatchObject({ outcome: "REQUIRES_APPROVAL" });

    // Yet the structural reconstruction still resolves — it never depends on the verdict.
    expect(report.execution?.invokedCanonicalChainAtDecision).toMatchObject({
      kind: "resolved",
      chain: [{ delegationId: "m6-d1" }],
    });
  });
});
