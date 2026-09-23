/**
 * M2, M4, M5 (contrat consolidé, debates/invoked-authority/QUESTION.md).
 *
 * M2: availableChainNow reflects live state post-execution, and can
 * genuinely diverge from the "at decision" chain (a sibling delegation
 * created after execution, expanding what is AVAILABLE now, without
 * changing anything about the historical decision).
 *
 * M4: recordedDelegationReferences is a raw, unfiltered readout of
 * authority_chain_ref's delegation-kind links (array order, duplicates
 * preserved) — independent of recordedChainIntegrity's structural
 * judgment. A padded/duplicated citation is visible here even when
 * recordedChainIntegrity reports MISMATCH.
 *
 * M5: invokedAuthorityNow and invokedCanonicalChainNow are present and
 * meaningful before any ACTION_EXECUTED exists — unlike
 * invokedAuthorityAtDecision/invokedCanonicalChainAtDecision, which live
 * under `execution` and require one.
 */
import { describe, expect, it } from "vitest";
import { explain } from "../../src/engine/authority.js";
import { monetaryParameters, thresholds } from "../../src/domain/types.js";
import { action, principal } from "../fixtures/ids.js";
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
} from "../fixtures/scenarios.js";

describe("M2 — availableChainNow reflects live state, independent of the historical decision", () => {
  it("D1 is revoked after execution, then D2 (a different root) is created: the historical decision stays on D1, 'now' moves entirely to D2", () => {
    const executor = principal("m2-executor");
    const parameters = monetaryParameters(EUR(400));

    // D1: authorizes the execution at decisionSequence.
    const d1 = rootDelegation({
      sequence: 1,
      id: "m2-d1",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: executor,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(1_000, 1_000),
    });
    const request = actionRequest({
      sequence: 2,
      id: "m2-action",
      requester: executor,
      delegationId: "m2-d1",
      parameters,
    });
    const execution = actionExecution({
      sequence: 3,
      actionId: "m2-action",
      executor,
      decisionSequence: 2,
      chain: [delegationLink("m2-d1")],
      parameters,
    });
    // D1 is revoked after the execution it backed.
    const d1Revoked = revokeDelegation({ sequence: 4, targetId: "m2-d1", issuedBy: THEO });
    // D2: a different root entirely, wide enough, created only after the revocation —
    // cannot possibly have backed the historical decision.
    const d2 = rootDelegation({
      sequence: 5,
      id: "m2-d2",
      grantor: principal("m2-root-pprime"),
      grantorType: "HUMAN_ROOT",
      grantee: executor,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(1_000, 1_000),
    });

    const store = [d1, request, execution, d1Revoked, d2];
    // Queried after D2 exists.
    const report = explain(store, { actionId: action("m2-action") }, instant(5));

    // "At decision": stays anchored to D1, untouched by D1's later revocation or D2's later creation.
    expect(report.execution?.authorityAtDecision).toMatchObject({ outcome: "AUTHORIZED", chain: ["m2-d1"] });
    expect(report.chain.map((c) => c.delegationId)).toEqual(["m2-d1"]);

    // "Now": D1 is revoked, so the root-agnostic AVAILABLE search can only succeed via D2.
    expect(report.currentAuthority).toMatchObject({ outcome: "AUTHORIZED", chain: ["m2-d2"] });
    expect(report.availableChainNow).toMatchObject({ kind: "resolved", chain: [{ delegationId: "m2-d2" }] });
    // D2 is not silently mixed into the historical view, nor is D1 silently retained "now".
    expect(report.availableChainNow.kind === "resolved" ? report.availableChainNow.chain.map((c) => c.delegationId) : undefined).toEqual(["m2-d2"]);

    // INVOKED "now" evaluates D1 alone (the delegation the request actually named) — revoked, so DENIED.
    expect(report.invokedAuthorityNow).toMatchObject({ outcome: "DENIED", reasonCode: "C12_DELEGATION_REVOKED" });
  });
});

describe("M4 — recordedDelegationReferences is a raw, unfiltered readout of the citation array", () => {
  it("shows a duplicated/padded citation even when recordedChainIntegrity reports MISMATCH", () => {
    const executor = principal("m4-executor");
    const parameters = monetaryParameters(EUR(400));

    const root = rootDelegation({
      sequence: 1,
      id: "m4-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: executor,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(1_000, 1_000),
    });
    const request = actionRequest({
      sequence: 2,
      id: "m4-action",
      requester: executor,
      delegationId: "m4-root",
      parameters,
    });
    // Padded citation: the same delegation cited twice — structurally not the
    // canonical single-element ancestry, so recordedChainIntegrity: MISMATCH.
    const execution = actionExecution({
      sequence: 3,
      actionId: "m4-action",
      executor,
      decisionSequence: 2,
      chain: [delegationLink("m4-root"), delegationLink("m4-root")],
      parameters,
    });

    const report = explain([root, request, execution], { actionId: action("m4-action") }, instant(3));

    expect(report.execution?.recordedChainIntegrity).toBe("MISMATCH");
    // The raw references array still faithfully shows both citations, in order.
    expect(report.recordedDelegationReferences?.map((r) => r.delegationId)).toEqual(["m4-root", "m4-root"]);
  });
});

describe("M5 — INVOKED is evaluated under the requester, RECORDED under the claimed executor", () => {
  it("A requests naming D1 (A's own delegation); B's execution cites the same D1 — INVOKED (under A) and RECORDED (under B) diverge", () => {
    const AGENT_A = principal("m5-agent-a");
    const AGENT_B = principal("m5-agent-b");
    const parameters = monetaryParameters(EUR(400));

    // D1: granted to A, wide enough to auto-authorize — A's own delegation.
    const d1 = rootDelegation({
      sequence: 1,
      id: "m5-d1",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(1_000, 1_000),
    });
    // A requests, naming D1 (A's own delegation).
    const request = actionRequest({
      sequence: 2,
      id: "m5-action",
      requester: AGENT_A,
      delegationId: "m5-d1",
      parameters,
    });
    // B — not A — claims to have executed it, citing the same D1.
    const execution = actionExecution({
      sequence: 3,
      actionId: "m5-action",
      executor: AGENT_B,
      decisionSequence: 2,
      chain: [delegationLink("m5-d1")],
      parameters,
    });

    const store = [d1, request, execution];
    const report = explain(store, { actionId: action("m5-action") }, instant(3));

    // INVOKED is evaluated under the REQUESTER (A, request.payload.requesting_principal_id):
    // D1 is A's own delegation, wide enough — AUTHORIZED.
    expect(report.execution?.invokedAuthorityAtDecision).toMatchObject({ outcome: "AUTHORIZED", chain: ["m5-d1"] });

    // RECORDED is anchored to the structural-leaf rule (provenance.ts's recordedTerminalId),
    // which requires the cited delegation's own grantee to equal the claimed EXECUTOR (B).
    // D1's grantee is A, not B — no candidate leaf qualifies, so RECORDED cannot even
    // resolve a terminal: UNRESOLVABLE, not DENIED and not AUTHORIZED.
    expect(report.execution?.recordedValidation).toBe("UNRESOLVABLE");
    expect(report.execution?.recordedChainIntegrity).toBe("UNRESOLVABLE");
    expect(report.execution?.invokedRecordedAlignment).toBe("UNRESOLVABLE");

    // Locked down: two genuinely different results for the same cited delegation,
    // driven purely by which identity (requester vs. claimed executor) each axis evaluates under.
    expect(report.execution?.invokedAuthorityAtDecision).not.toEqual(report.execution?.recordedValidation);
  });
});

describe("invokedAuthorityNow/invokedCanonicalChainNow exist before any execution", () => {
  it("resolves INVOKED authority and its structural chain from ACTION_REQUESTED alone, with no execution recorded yet", () => {
    const executor = principal("m5b-executor");
    const parameters = monetaryParameters(EUR(400));

    const root = rootDelegation({
      sequence: 1,
      id: "m5b-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: executor,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(1_000, 1_000),
    });
    const request = actionRequest({
      sequence: 2,
      id: "m5b-action",
      requester: executor,
      delegationId: "m5b-root",
      parameters,
    });

    const report = explain([root, request], { actionId: action("m5b-action") }, instant(2));

    expect(report.execution).toBeUndefined();
    expect(report.invokedAuthorityNow).toMatchObject({ outcome: "AUTHORIZED", chain: ["m5b-root"] });
    expect(report.invokedCanonicalChainNow).toMatchObject({ kind: "resolved", chain: [{ delegationId: "m5b-root" }] });
  });
});
