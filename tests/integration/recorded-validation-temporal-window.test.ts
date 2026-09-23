/**
 * recordedValidation (historical provenance investigation —
 * debates/provenance/QUESTION.md in the private research lab) answers "would
 * the recorded chain have authorized this action at the historical decision
 * point" — it must therefore be anchored to decision_sequence exactly like
 * authorityAtDecision already is (see explainAction.ts's
 * resolveActionAuthority), never leaking a later event (a revocation, a
 * later ACTION_EXECUTED) backward into that historical answer. This mirrors
 * T-HIST-001 (tests/integration/historical-explain-invariance.test.ts),
 * extended to the new recordedValidation field.
 */
import { describe, expect, it } from "vitest";
import { explainAction } from "../../src/engine/authority.js";
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

describe("recordedValidation — anchored to decision_sequence, not to now", () => {
  it("is unaffected by a revocation that occurs after decision_sequence", () => {
    const executor = principal("rv-executor");
    const parameters = monetaryParameters(EUR(400));

    const root = rootDelegation({
      sequence: 1,
      id: "rv-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: executor,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(1_000, 1_000),
    });
    const request = actionRequest({
      sequence: 2,
      id: "rv-action",
      requester: executor,
      delegationId: "rv-root",
      parameters,
    });
    const execution = actionExecution({
      sequence: 3,
      actionId: "rv-action",
      executor,
      decisionSequence: 2,
      chain: [delegationLink("rv-root")],
      parameters,
    });
    const laterRevocation = revokeDelegation({ sequence: 4, targetId: "rv-root", issuedBy: THEO });

    const storeWithoutRevocation = [root, request, execution];
    const storeWithRevocation = [root, request, execution, laterRevocation];

    const before = explainAction(storeWithoutRevocation, { actionId: action("rv-action") }, instant(3)).execution?.recordedValidation;
    const after = explainAction(storeWithRevocation, { actionId: action("rv-action") }, instant(4)).execution?.recordedValidation;

    expect(before).toMatchObject({ outcome: "AUTHORIZED" });
    expect(after).toEqual(before);
  });
});
