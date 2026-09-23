/**
 * I20 (extended, PROMPT 6f): total_budget attribution now anchors on the
 * delegation actually INVOKED by ACTION_REQUESTED, not on array
 * position/order within authority_chain_ref. See
 * src/engine/evaluateConstraints.ts's terminalDelegationOf — deliberately a
 * different, more permissive rule than provenance.ts's recordedTerminalId
 * (tests/adversarial/recorded-integrity.test.ts), which anchors on
 * RECORDED's own claimed terminal instead.
 */
import { describe, expect, it } from "vitest";
import { remainingBudget } from "../../src/engine/evaluateConstraints.js";
import { monetaryParameters, thresholds } from "../../src/domain/types.js";
import { delegation, principal } from "../fixtures/ids.js";
import {
  EUR,
  PURCHASE_ORDER_CREATE,
  THEO,
  actionExecution,
  actionRequest,
  delegationLink,
  rootDelegation,
  subDelegation,
} from "../fixtures/scenarios.js";

describe("I20 — terminal attribution is invariant under chain-ref permutation", () => {
  it("charges the same ancestral budget when the same two delegation references are permuted", () => {
    const intermediate = principal("i20-order-mid");
    const executor = principal("i20-order-executor");
    const root = rootDelegation({
      sequence: 1, id: "i20-order-root", grantor: THEO, grantorType: "HUMAN_ROOT",
      grantee: intermediate, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: true,
      totalBudget: EUR(1_000), amountThresholds: thresholds(1_000, 1_000),
    });
    const leaf = subDelegation({
      sequence: 2, id: "i20-order-leaf", parentId: "i20-order-root",
      grantor: intermediate, grantee: executor, capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false, amountThresholds: thresholds(1_000, 1_000),
    });
    const request = actionRequest({
      sequence: 3, id: "i20-order-action", requester: executor,
      delegationId: "i20-order-leaf", parameters: monetaryParameters(EUR(400)),
    });
    const normal = actionExecution({
      sequence: 4, actionId: "i20-order-action", executor, decisionSequence: 3,
      chain: [delegationLink("i20-order-root"), delegationLink("i20-order-leaf")],
      parameters: monetaryParameters(EUR(400)),
    });
    const permuted = actionExecution({
      sequence: 4, actionId: "i20-order-action", executor, decisionSequence: 3,
      chain: [delegationLink("i20-order-leaf"), delegationLink("i20-order-root")],
      parameters: monetaryParameters(EUR(400)),
    });

    const normalRemaining = remainingBudget(delegation("i20-order-root"), EUR(1_000), [root, leaf, request, normal]);
    const permutedRemaining = remainingBudget(delegation("i20-order-root"), EUR(1_000), [root, leaf, request, permuted]);
    expect(normalRemaining).toBe(600);
    expect(permutedRemaining).toBe(normalRemaining);
  });

  it("charges the invoked path, not a second executor-held delegation injected into the recorded reference", () => {
    const executor = principal("i20-invoked-executor");
    const pathA = rootDelegation({
      sequence: 1, id: "i20-invoked-a", grantor: THEO, grantorType: "HUMAN_ROOT",
      grantee: executor, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false,
      totalBudget: EUR(1_000), amountThresholds: thresholds(1_000, 1_000),
    });
    const pathB = rootDelegation({
      sequence: 2, id: "i20-invoked-b", grantor: THEO, grantorType: "HUMAN_ROOT",
      grantee: executor, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false,
      totalBudget: EUR(1_000), amountThresholds: thresholds(1_000, 1_000),
    });
    const request = actionRequest({
      sequence: 3, id: "i20-invoked-action", requester: executor,
      delegationId: "i20-invoked-a", parameters: monetaryParameters(EUR(400)),
    });
    const execution = actionExecution({
      sequence: 4, actionId: "i20-invoked-action", executor, decisionSequence: 3,
      chain: [delegationLink("i20-invoked-b"), delegationLink("i20-invoked-a")],
      parameters: monetaryParameters(EUR(400)),
    });
    const store = [pathA, pathB, request, execution];

    expect(remainingBudget(delegation("i20-invoked-a"), EUR(1_000), store)).toBe(600);
    expect(remainingBudget(delegation("i20-invoked-b"), EUR(1_000), store)).toBe(1_000);
  });

  it("does not debit either path when the recorded reference omits the invoked delegation", () => {
    const executor = principal("i20-mismatch-executor");
    const pathA = rootDelegation({
      sequence: 1, id: "i20-mismatch-a", grantor: THEO, grantorType: "HUMAN_ROOT",
      grantee: executor, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false,
      totalBudget: EUR(1_000), amountThresholds: thresholds(1_000, 1_000),
    });
    const pathB = rootDelegation({
      sequence: 2, id: "i20-mismatch-b", grantor: THEO, grantorType: "HUMAN_ROOT",
      grantee: executor, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false,
      totalBudget: EUR(1_000), amountThresholds: thresholds(1_000, 1_000),
    });
    const request = actionRequest({
      sequence: 3, id: "i20-mismatch-action", requester: executor,
      delegationId: "i20-mismatch-a", parameters: monetaryParameters(EUR(400)),
    });
    const execution = actionExecution({
      sequence: 4, actionId: "i20-mismatch-action", executor, decisionSequence: 3,
      chain: [delegationLink("i20-mismatch-b")], parameters: monetaryParameters(EUR(400)),
    });
    const store = [pathA, pathB, request, execution];

    expect(remainingBudget(delegation("i20-mismatch-a"), EUR(1_000), store)).toBe(1_000);
    expect(remainingBudget(delegation("i20-mismatch-b"), EUR(1_000), store)).toBe(1_000);
  });

  it("counts one budget debit when the same logical execution is replayed with a new event id", () => {
    const executor = principal("i20-replay-executor");
    const root = rootDelegation({
      sequence: 1, id: "i20-replay-root", grantor: THEO, grantorType: "HUMAN_ROOT",
      grantee: executor, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false,
      totalBudget: EUR(1_000), amountThresholds: thresholds(1_000, 1_000),
    });
    const request = actionRequest({
      sequence: 2, id: "i20-replay-action", requester: executor,
      delegationId: "i20-replay-root", parameters: monetaryParameters(EUR(400)),
    });
    const first = actionExecution({
      sequence: 3, actionId: "i20-replay-action", executor, decisionSequence: 2,
      chain: [delegationLink("i20-replay-root")], parameters: monetaryParameters(EUR(400)),
      timing: { eventId: "evt-i20-replay-1" },
    });
    const replay = actionExecution({
      sequence: 4, actionId: "i20-replay-action", executor, decisionSequence: 2,
      chain: [delegationLink("i20-replay-root")], parameters: monetaryParameters(EUR(400)),
      timing: { eventId: "evt-i20-replay-2" },
    });

    expect(remainingBudget(delegation("i20-replay-root"), EUR(1_000), [root, request, first, replay])).toBe(600);
  });
});
