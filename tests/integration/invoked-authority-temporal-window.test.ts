/**
 * M7/M8 (contrat consolidé, debates/invoked-authority/QUESTION.md): every
 * "at decision" view must stay anchored to decision_sequence forever,
 * independent of when it is later queried; every "now" view must reflect
 * the state at the query's own current.atSequence. Mirrors
 * recorded-validation-temporal-window.test.ts, extended to the new
 * INVOKED-focused fields introduced alongside recordedValidation, and to the
 * legacy `chain` field itself (M8).
 *
 * Three regressions this locks down, all caught during design/implementation
 * review before being silently "fixed" without a test:
 *
 * 1. (M7) A DELEGATION_REVOKED event that occurs strictly after
 *    decision_sequence must never leak into an "at decision" chain-link
 *    detail (its `revocations` list) for the new INVOKED fields —
 *    describeDelegation must be called against a view already filtered to
 *    the relevant instant, exactly like recordedValidation's own
 *    decision_sequence filtering.
 * 2. (M7) A delegation invoked by ACTION_REQUESTED but not yet created at
 *    decision_sequence must resolve as UNKNOWN/unresolvable/none "at
 *    decision" (a causal impossibility, not proof of missing authority) —
 *    and must resolve normally "now", once the delegation actually exists.
 * 3. (M8) The same leak as (1), found live in `demo/run.ts`'s own output,
 *    in the legacy `chain` field itself: it was built from the full,
 *    unfiltered `events` store rather than the store visible at its own
 *    instant (decisionSequence post-execution, current.atSequence
 *    pre-execution) — fixed in explainAction.ts's explain(). The only
 *    permitted effect of the fix is dropping temporally-posterior detail
 *    (e.g. a later revocation); every pre-existing decision field
 *    (authorityAtDecision, recordedChainIntegrity, invokedRecordedAlignment,
 *    recordedValidation) keeps its exact value.
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

describe("M8 — the legacy `chain` field's own detail stays temporally filtered to its own window (fixed)", () => {
  it("post-execution: report.chain reflects the store visible at decision_sequence, never a revocation that occurs afterward", () => {
    const executor = principal("m8a-executor");
    const parameters = monetaryParameters(EUR(400));

    const root = rootDelegation({
      sequence: 1,
      id: "m8a-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: executor,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(1_000, 1_000),
    });
    const request = actionRequest({
      sequence: 2,
      id: "m8a-action",
      requester: executor,
      delegationId: "m8a-root",
      parameters,
    });
    const execution = actionExecution({
      sequence: 3,
      actionId: "m8a-action",
      executor,
      decisionSequence: 2,
      chain: [delegationLink("m8a-root")],
      parameters,
    });
    const laterRevocation = revokeDelegation({ sequence: 4, targetId: "m8a-root", issuedBy: THEO });

    const query = { actionId: action("m8a-action") };
    const before = explain([root, request, execution], query, instant(3));
    const after = explain([root, request, execution, laterRevocation], query, instant(4));

    // The old decision fields keep their exact values — this fix touches only chain's own detail.
    expect(after.execution?.authorityAtDecision).toEqual(before.execution?.authorityAtDecision);
    expect(after.execution?.recordedChainIntegrity).toEqual(before.execution?.recordedChainIntegrity);
    expect(after.execution?.invokedRecordedAlignment).toEqual(before.execution?.invokedRecordedAlignment);
    expect(after.execution?.recordedValidation).toEqual(before.execution?.recordedValidation);
    expect(before.execution?.authorityAtDecision).toMatchObject({ outcome: "AUTHORIZED", chain: ["m8a-root"] });

    // report.chain: identical before/after except for the now-correctly-absent future revocation.
    expect(before.chain).toMatchObject([{ delegationId: "m8a-root", revocations: [] }]);
    expect(after.chain).toMatchObject([{ delegationId: "m8a-root", revocations: [] }]);
    expect(after.chain).toEqual(before.chain);

    // "now" naturally reflects the post-revocation state — untouched by this fix.
    expect(after.currentAuthority.outcome).toBe("DENIED");
    expect(after.availableChainNow).toMatchObject({ kind: "none" });

    // M8 (extended): recordedDelegationReferences[].detail is resolved
    // against events visible at execution.sequence, not the full store —
    // the same later revocation must not leak into its detail either,
    // regardless of when the query is made.
    expect(before.recordedDelegationReferences).toMatchObject([{ delegationId: "m8a-root", detail: { revocations: [] } }]);
    expect(after.recordedDelegationReferences).toMatchObject([{ delegationId: "m8a-root", detail: { revocations: [] } }]);
    expect(after.recordedDelegationReferences).toEqual(before.recordedDelegationReferences);
  });

  it("pre-execution: report.chain (AVAILABLE now) reflects the store visible at current.atSequence, and updates as that instant advances", () => {
    const executor = principal("m8b-executor");
    const parameters = monetaryParameters(EUR(400));

    const root = rootDelegation({
      sequence: 1,
      id: "m8b-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: executor,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(1_000, 1_000),
    });
    const request = actionRequest({
      sequence: 2,
      id: "m8b-action",
      requester: executor,
      delegationId: "m8b-root",
      parameters,
    });
    const laterRevocation = revokeDelegation({ sequence: 3, targetId: "m8b-root", issuedBy: THEO });

    const query = { actionId: action("m8b-action") };
    const store = [root, request, laterRevocation];

    const beforeRevocationVisible = explain(store, query, instant(2));
    const afterRevocationVisible = explain(store, query, instant(3));

    expect(beforeRevocationVisible.execution).toBeUndefined();
    expect(beforeRevocationVisible.chain).toMatchObject([{ delegationId: "m8b-root", revocations: [] }]);
    expect(beforeRevocationVisible.currentAuthority.outcome).toBe("AUTHORIZED");

    expect(afterRevocationVisible.chain).toEqual([]);
    expect(afterRevocationVisible.currentAuthority.outcome).toBe("DENIED");
  });
});

describe("M7 — strict temporal-window isolation across all historical/now views", () => {
  it("a revocation after decision_sequence never leaks into any 'at decision' view, but is reflected in every 'now' view", () => {
    const executor = principal("m7a-executor");
    const parameters = monetaryParameters(EUR(400));

    const root = rootDelegation({
      sequence: 1,
      id: "m7a-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: executor,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(1_000, 1_000),
    });
    const request = actionRequest({
      sequence: 2,
      id: "m7a-action",
      requester: executor,
      delegationId: "m7a-root",
      parameters,
    });
    const execution = actionExecution({
      sequence: 3,
      actionId: "m7a-action",
      executor,
      decisionSequence: 2,
      chain: [delegationLink("m7a-root")],
      parameters,
    });
    const laterRevocation = revokeDelegation({ sequence: 4, targetId: "m7a-root", issuedBy: THEO });

    const query = { actionId: action("m7a-action") };
    const before = explain([root, request, execution], query, instant(3));
    const after = explain([root, request, execution, laterRevocation], query, instant(4));

    // "at decision" views: identical before and after the later revocation.
    expect(after.execution?.authorityAtDecision).toEqual(before.execution?.authorityAtDecision);
    expect(after.execution?.invokedAuthorityAtDecision).toEqual(before.execution?.invokedAuthorityAtDecision);
    expect(after.execution?.invokedCanonicalChainAtDecision).toEqual(before.execution?.invokedCanonicalChainAtDecision);
    // Specifically: no revocation is visible on the "at decision" chain-link detail.
    expect(before.execution?.invokedCanonicalChainAtDecision).toMatchObject({
      kind: "resolved",
      chain: [{ delegationId: "m7a-root", revocations: [] }],
    });
    expect(after.execution?.invokedCanonicalChainAtDecision).toMatchObject({
      kind: "resolved",
      chain: [{ delegationId: "m7a-root", revocations: [] }],
    });

    // "now" views: the revocation is visible only once it is causally in the past of current.atSequence.
    expect(before.currentAuthority.outcome).toBe("AUTHORIZED");
    expect(after.currentAuthority.outcome).toBe("DENIED");
    expect(before.invokedAuthorityNow).toMatchObject({ outcome: "AUTHORIZED" });
    expect(after.invokedAuthorityNow).toMatchObject({ outcome: "DENIED" });
    expect(before.availableChainNow).toMatchObject({ kind: "resolved", chain: [{ delegationId: "m7a-root", revocations: [] }] });
    expect(after.availableChainNow).toMatchObject({ kind: "none" });
    expect(before.invokedCanonicalChainNow).toMatchObject({ kind: "resolved", chain: [{ delegationId: "m7a-root", revocations: [] }] });
    expect(after.invokedCanonicalChainNow).toMatchObject({
      kind: "resolved",
      chain: [{ delegationId: "m7a-root", revocations: [{ byPrincipalId: THEO }] }],
    });
  });

  it("a delegation invoked before it is created resolves UNKNOWN/unresolvable/none 'at decision', and correctly 'now' once it exists", () => {
    const executor = principal("m7b-executor");
    const parameters = monetaryParameters(EUR(400));

    // The request names "m7b-d1" before any DELEGATION_CREATED for it exists.
    const request = actionRequest({
      sequence: 1,
      id: "m7b-action",
      requester: executor,
      delegationId: "m7b-d1",
      parameters,
    });
    const execution = actionExecution({
      sequence: 2,
      actionId: "m7b-action",
      executor,
      decisionSequence: 1,
      chain: [delegationLink("m7b-d1")],
      parameters,
    });
    // Only created afterward — causally impossible for it to have backed the decision at sequence 1.
    const d1 = rootDelegation({
      sequence: 3,
      id: "m7b-d1",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: executor,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(1_000, 1_000),
    });

    const store = [request, execution, d1];
    const report = explain(store, { actionId: action("m7b-action") }, instant(3));

    // Exact values "at decision" — never a generic "unresolvable" stand-in for all three.
    expect(report.execution?.authorityAtDecision).toMatchObject({ outcome: "UNKNOWN", reasonCode: "C24_NO_VALID_CHAIN" });
    expect(report.execution?.invokedAuthorityAtDecision).toBe("UNRESOLVABLE");
    expect(report.execution?.invokedCanonicalChainAtDecision).toEqual({ kind: "unresolvable" });

    // "now" (atSequence 3, after m7b-d1 was created): resolves normally.
    expect(report.currentAuthority).toMatchObject({ outcome: "AUTHORIZED" });
    expect(report.invokedAuthorityNow).toMatchObject({ outcome: "AUTHORIZED" });
    expect(report.invokedCanonicalChainNow).toMatchObject({ kind: "resolved", chain: [{ delegationId: "m7b-d1" }] });
    expect(report.availableChainNow).toMatchObject({ kind: "resolved", chain: [{ delegationId: "m7b-d1" }] });
  });
});
