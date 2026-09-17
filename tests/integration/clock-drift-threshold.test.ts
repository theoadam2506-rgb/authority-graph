/**
 * PROMPT 5, required test: "changing drift diagnostic threshold cannot
 * increase authority". `CLOCK_DRIFT_THRESHOLD_MS` (and `explain()`'s
 * `clockDriftThresholdMs` override) feed exactly one thing:
 * `findLateOrBackdatedEvents`'s `LATE_OR_BACKDATED_EVENT_OBSERVED` diagnostic
 * (src/engine/explainAction.ts). Varying it must change what the diagnostic
 * reports and nothing else — `execution.authorityAtDecision` and
 * `currentAuthority` must be byte-identical regardless of the threshold.
 *
 * Same process rule as every other file in this repo: if this test ever
 * fails, the fix is in the implementation, never here.
 */
import { describe, expect, it } from "vitest";
import { explain } from "../../src/engine/authority.js";
import { monetaryParameters, sequenceNumber, iso8601, thresholds, type AuthorityInstant } from "../../src/domain/types.js";
import { action } from "../fixtures/ids.js";
import { AGENT_A, EUR, PURCHASE_ORDER_CREATE, THEO, actionExecution, actionRequest, delegationLink, rootDelegation, timeAt } from "../fixtures/scenarios.js";

describe("changing the clock-drift diagnostic threshold cannot change authority", () => {
  const ROOT_ID = "d-root-drift";
  const ACTION_ID = "a-drift-1";

  // The request's occurred_at is wildly backdated relative to its
  // authority_time (timeAt(sequence), the builder's default) — a large,
  // deliberate drift for the diagnostic to have something to disagree about.
  const store = [
    rootDelegation({
      sequence: 1,
      id: ROOT_ID,
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(1000, 1000),
    }),
    actionRequest({
      sequence: 2,
      id: ACTION_ID,
      requester: AGENT_A,
      delegationId: ROOT_ID,
      parameters: monetaryParameters(EUR(500)),
      timing: { occurredAt: timeAt(-1_000_000) },
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
  const current: AuthorityInstant = { atSequence: sequenceNumber(3), authorityTime: iso8601(timeAt(3)) };

  it("flags the backdated event under a tight threshold and not under a loose one — proving the parameter is live", () => {
    const tight = explain(store, query, current, { clockDriftThresholdMs: 0 });
    const loose = explain(store, query, current, { clockDriftThresholdMs: Number.MAX_SAFE_INTEGER });

    expect(tight.lateOrBackdatedEvents.length).toBeGreaterThan(0);
    expect(loose.lateOrBackdatedEvents.length).toBe(0);
  });

  it("never changes execution.authorityAtDecision or currentAuthority between those same two thresholds", () => {
    const tight = explain(store, query, current, { clockDriftThresholdMs: 0 });
    const loose = explain(store, query, current, { clockDriftThresholdMs: Number.MAX_SAFE_INTEGER });

    expect(tight.execution?.authorityAtDecision).toEqual(loose.execution?.authorityAtDecision);
    expect(tight.currentAuthority).toEqual(loose.currentAuthority);
    // Non-vacuous: there is an actual AUTHORIZED decision here to preserve.
    expect(tight.execution?.authorityAtDecision.outcome).toBe("AUTHORIZED");
    expect(tight.currentAuthority.outcome).toBe("AUTHORIZED");
  });
});
