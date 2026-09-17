/**
 * PROMPT 5, required test: "historical explain is invariant to current CLI
 * clock". `execution.authorityAtDecision` is computed from the execution's
 * own immutable `decision_sequence` (src/engine/explainAction.ts,
 * `resolveActionAuthority`) — it must never move just because the caller's
 * own "now" (`current: AuthorityInstant`, exactly what the CLI's
 * `--at-sequence`/`--authority-time` flags — or their wall-clock default —
 * ultimately become) moves. An action authorized yesterday, whose delegation
 * has since expired, must always explain itself as authorized at the moment
 * it ran.
 *
 * Same process rule as every other file in this repo: if this test ever
 * fails, the fix is in the implementation, never here.
 */
import { describe, expect, it } from "vitest";
import { explain } from "../../src/engine/authority.js";
import { expiresAt, iso8601, monetaryParameters, sequenceNumber, thresholds, type AuthorityInstant } from "../../src/domain/types.js";
import { action } from "../fixtures/ids.js";
import { AGENT_A, EUR, PURCHASE_ORDER_CREATE, THEO, actionExecution, actionRequest, delegationLink, rootDelegation, timeAt } from "../fixtures/scenarios.js";

describe("historical explain is invariant to current CLI clock", () => {
  const ROOT_ID = "d-root-invariance";
  const ACTION_ID = "a-invariance-1";

  const store = [
    rootDelegation({
      sequence: 1,
      id: ROOT_ID,
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      expires: expiresAt(iso8601(timeAt(5))),
      amountThresholds: thresholds(1000, 1000),
    }),
    actionRequest({
      sequence: 2,
      id: ACTION_ID,
      requester: AGENT_A,
      delegationId: ROOT_ID,
      parameters: monetaryParameters(EUR(500)),
    }),
    actionExecution({
      sequence: 3,
      actionId: ACTION_ID,
      executor: AGENT_A,
      decisionSequence: 2,
      chain: [delegationLink(ROOT_ID)],
      parameters: monetaryParameters(EUR(500)),
    }),
  ];

  const query = { actionId: action(ACTION_ID) };

  it("keeps execution.authorityAtDecision identical across wildly different current instants, including well past expiry", () => {
    const instants: readonly AuthorityInstant[] = [
      { atSequence: sequenceNumber(3), authorityTime: iso8601(timeAt(0)) }, // before expiry
      { atSequence: sequenceNumber(3), authorityTime: iso8601(timeAt(6)) }, // just past expiry
      { atSequence: sequenceNumber(3), authorityTime: iso8601(timeAt(100_000)) }, // far future
      { atSequence: sequenceNumber(1_000_000), authorityTime: iso8601(timeAt(100_000)) }, // atSequence beyond the store entirely
    ];

    const decisions = instants.map((current) => explain(store, query, current).execution?.authorityAtDecision);

    for (const decision of decisions) {
      expect(decision).toEqual(decisions[0]);
    }
    expect(decisions[0]).toEqual({ outcome: "AUTHORIZED", chain: [ROOT_ID] });
  });

  it("is not a vacuous invariant: currentAuthority for the very same action DOES change with time, only the historical decision does not", () => {
    const beforeExpiry: AuthorityInstant = { atSequence: sequenceNumber(3), authorityTime: iso8601(timeAt(0)) };
    const afterExpiry: AuthorityInstant = { atSequence: sequenceNumber(3), authorityTime: iso8601(timeAt(100_000)) };

    const early = explain(store, query, beforeExpiry);
    const late = explain(store, query, afterExpiry);

    expect(early.currentAuthority.outcome).toBe("AUTHORIZED");
    expect(late.currentAuthority.outcome).toBe("DENIED");
    // ...yet both agree on what happened at the decision point itself.
    expect(early.execution?.authorityAtDecision).toEqual(late.execution?.authorityAtDecision);
    expect(early.execution?.authorityAtDecision.outcome).toBe("AUTHORIZED");
  });
});
