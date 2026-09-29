/**
 * Unit binding (I25): a monetary quantity is the atomic pair (value,
 * currency). `currency` is opaque and compared by exact equality; Authority
 * never converts or normalizes it.
 *
 * Each `describe` below is tagged with the Round 3 test identifier it
 * implements (M1-M7); F1-F3 live in tests/domain/actionFingerprint.test.ts,
 * and M6 (PR #9 action-instance binding) is the unchanged pre-existing
 * tests/adversarial/independent-audit.test.ts and
 * tests/cli/invoked-authority-rendering.test.ts.
 */
import { describe, expect, it } from "vitest";
import { authorityAt, explainAction, ingestAll } from "../../src/engine/authority.js";
import { remainingBudget } from "../../src/engine/evaluateConstraints.js";
import { validateChain, type DelegationEvent } from "../../src/engine/validateChain.js";
import { toDraft, type AuthorityEvent, type CanonicalStore } from "../../src/domain/events.js";
import { delegationId, iso8601, money, monetaryParameters, thresholds, type ActionParameters, type Money } from "../../src/domain/types.js";
import { action } from "../fixtures/ids.js";
import {
  AGENT_A,
  AGENT_B,
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
  sequentialClock,
  subDelegation,
} from "../fixtures/scenarios.js";

const USD = (value: number): Money => money(value, "USD");
const raw = (value: number, currency: string): Money => ({ value, currency }) as Money; // bypasses money(): models external, unvalidated JSON

function ingest(events: readonly AuthorityEvent[]): CanonicalStore {
  return ingestAll(events.map(toDraft), sequentialClock).canonicalStore;
}

function ask(store: CanonicalStore, agent: typeof AGENT_A, parameters: ActionParameters, atSequence: number) {
  return authorityAt(store, { agentId: agent, principalId: THEO, capability: PURCHASE_ORDER_CREATE, parameters }, instant(atSequence));
}

function eurRoot(extra: { readonly maxAmount?: Money; readonly totalBudget?: Money; readonly amountThresholds?: ReturnType<typeof thresholds> } = {}): AuthorityEvent {
  return rootDelegation({
    sequence: 1,
    id: "d",
    grantor: THEO,
    grantorType: "HUMAN_ROOT",
    grantee: AGENT_A,
    capabilities: [PURCHASE_ORDER_CREATE],
    canDelegate: true,
    amountThresholds: thresholds(EUR(100), EUR(1000)),
    ...extra,
  });
}

describe("M1 — a EUR policy never silently authorizes a USD action", () => {
  const store = ingest([eurRoot({ maxAmount: EUR(1000) })]);

  it("EUR behaves as before (control)", () => {
    expect(ask(store, AGENT_A, monetaryParameters(EUR(50)), 1).outcome).toBe("AUTHORIZED");
    expect(ask(store, AGENT_A, monetaryParameters(EUR(500)), 1).outcome).toBe("REQUIRES_APPROVAL");
    expect(ask(store, AGENT_A, monetaryParameters(EUR(1001)), 1)).toMatchObject({ outcome: "DENIED", reasonCode: "C8_AMOUNT_EXCEEDS_APPROVAL_CEILING" });
  });

  it("USD amounts are never compared numerically against EUR thresholds", () => {
    for (const value of [50, 500, 1001]) {
      expect(ask(store, AGENT_A, monetaryParameters(USD(value)), 1)).toMatchObject({ outcome: "DENIED", reasonCode: "C11_CAPABILITY_NOT_COVERED" });
    }
  });

  it("a delegation with thresholds only (no max_amount) still binds the unit", () => {
    const thresholdsOnly = ingest([eurRoot()]);
    expect(ask(thresholdsOnly, AGENT_A, monetaryParameters(USD(50)), 1)).toMatchObject({ outcome: "DENIED", reasonCode: "C11_CAPABILITY_NOT_COVERED" });
  });

  it("currency is compared exactly: 'eur' is not 'EUR'", () => {
    expect(ask(store, AGENT_A, monetaryParameters(money(50, "eur")), 1)).toMatchObject({ outcome: "DENIED", reasonCode: "C11_CAPABILITY_NOT_COVERED" });
  });

  it("malformed money fails closed as UNKNOWN (C22), not DENIED: empty currency on the action", () => {
    expect(ask(store, AGENT_A, monetaryParameters(raw(50, "")), 1)).toMatchObject({ outcome: "UNKNOWN", reasonCode: "C22_UNKNOWN_CONSTRAINT_TYPE" });
  });

  it("malformed policy fails closed as UNKNOWN (C22): empty currency on a threshold", () => {
    const bad = ingest([eurRoot({ amountThresholds: thresholds(raw(100, ""), raw(1000, "")) })]);
    expect(ask(bad, AGENT_A, monetaryParameters(EUR(50)), 1)).toMatchObject({ outcome: "UNKNOWN", reasonCode: "C22_UNKNOWN_CONSTRAINT_TYPE" });
  });

  it("malformed policy fails closed as UNKNOWN (C22): a delegation mixing currencies internally", () => {
    const mixedThresholds = ingest([eurRoot({ amountThresholds: thresholds(EUR(100), USD(1000)) })]);
    expect(ask(mixedThresholds, AGENT_A, monetaryParameters(EUR(50)), 1)).toMatchObject({ outcome: "UNKNOWN", reasonCode: "C22_UNKNOWN_CONSTRAINT_TYPE" });
    const mixedCap = ingest([eurRoot({ maxAmount: USD(1000) })]);
    expect(ask(mixedCap, AGENT_A, monetaryParameters(EUR(50)), 1)).toMatchObject({ outcome: "UNKNOWN", reasonCode: "C22_UNKNOWN_CONSTRAINT_TYPE" });
    const mixedBudget = ingest([eurRoot({ totalBudget: USD(1000) })]);
    expect(ask(mixedBudget, AGENT_A, monetaryParameters(EUR(50)), 1)).toMatchObject({ outcome: "UNKNOWN", reasonCode: "C22_UNKNOWN_CONSTRAINT_TYPE" });
  });

  it("a pre-unit-binding delegation (bare-number thresholds) fails closed as UNKNOWN (C22)", () => {
    const legacy = ingest([eurRoot({ amountThresholds: { automatic_max_amount: 100, approval_max_amount: 1000 } as unknown as ReturnType<typeof thresholds> })]);
    expect(ask(legacy, AGENT_A, monetaryParameters(EUR(50)), 1)).toMatchObject({ outcome: "UNKNOWN", reasonCode: "C22_UNKNOWN_CONSTRAINT_TYPE" });
  });
});

describe("M2 — a EUR budget never adds or consumes a USD amount", () => {
  const events: AuthorityEvent[] = [
    eurRoot({ totalBudget: EUR(1000), amountThresholds: thresholds(EUR(1000), EUR(1000)) }),
    actionRequest({ sequence: 2, id: "e1", requester: AGENT_A, delegationId: "d", parameters: monetaryParameters(EUR(600)) }),
    actionExecution({ sequence: 3, actionId: "e1", executor: AGENT_A, decisionSequence: 2, chain: [delegationLink("d")], parameters: monetaryParameters(EUR(600)) }),
  ];
  const budget = EUR(1000);

  it("EUR accounting is unchanged (control): 600 EUR spent leaves 400", () => {
    const store = ingest(events);
    expect(remainingBudget(delegationId("d"), budget, store)).toBe(400);
    expect(ask(store, AGENT_A, monetaryParameters(EUR(400)), 3).outcome).toBe("AUTHORIZED");
    expect(ask(store, AGENT_A, monetaryParameters(EUR(401)), 3)).toMatchObject({ outcome: "DENIED", reasonCode: "C9_TOTAL_BUDGET_EXCEEDED" });
  });

  it("400 USD is never authorized against the EUR budget", () => {
    const store = ingest(events);
    expect(ask(store, AGENT_A, monetaryParameters(USD(400)), 3)).toMatchObject({ outcome: "DENIED", reasonCode: "C11_CAPABILITY_NOT_COVERED" });
  });

  it("a recorded USD execution does not consume the EUR budget", () => {
    const store = ingest([
      ...events,
      actionRequest({ sequence: 4, id: "u1", requester: AGENT_A, delegationId: "d", parameters: monetaryParameters(USD(400)) }),
      actionExecution({ sequence: 5, actionId: "u1", executor: AGENT_A, decisionSequence: 4, chain: [delegationLink("d")], parameters: monetaryParameters(USD(400)) }),
    ]);
    expect(remainingBudget(delegationId("d"), budget, store)).toBe(400);
    expect(ask(store, AGENT_A, monetaryParameters(EUR(400)), 5).outcome).toBe("AUTHORIZED");
    expect(ask(store, AGENT_A, monetaryParameters(EUR(401)), 5)).toMatchObject({ outcome: "DENIED", reasonCode: "C9_TOTAL_BUDGET_EXCEEDED" });
  });

  it("and that USD execution is itself not authorized at its own decision", () => {
    const store = ingest([
      ...events,
      actionRequest({ sequence: 4, id: "u1", requester: AGENT_A, delegationId: "d", parameters: monetaryParameters(USD(400)) }),
      actionExecution({ sequence: 5, actionId: "u1", executor: AGENT_A, decisionSequence: 4, chain: [delegationLink("d")], parameters: monetaryParameters(USD(400)) }),
    ]);
    const explanation = explainAction(store, { actionId: action("u1") }, instant(5));
    expect(explanation.execution?.authorityAtDecision).toMatchObject({ outcome: "DENIED", reasonCode: "C11_CAPABILITY_NOT_COVERED" });
  });
});

describe("M3 — approval currency swap within the same action_id", () => {
  const base: AuthorityEvent[] = [
    eurRoot({ maxAmount: EUR(1000) }),
    actionRequest({ sequence: 2, id: "a1", requester: AGENT_A, delegationId: "d", parameters: monetaryParameters(EUR(500)) }),
    approvalRequest({ sequence: 3, id: "p1", actionId: "a1", requestedFrom: THEO, requester: AGENT_A }),
    approvalGrant({ sequence: 4, id: "p1", actionId: "a1", approver: THEO }),
  ];
  const executeAs = (parameters: ActionParameters): CanonicalStore =>
    ingest([...base, actionExecution({ sequence: 5, actionId: "a1", executor: AGENT_A, decisionSequence: 4, chain: [delegationLink("d"), approvalLink("p1")], parameters })]);
  const decisionOf = (store: CanonicalStore) => explainAction(store, { actionId: action("a1") }, instant(5)).execution?.authorityAtDecision;

  it("E1: executed as 500 EUR is AUTHORIZED with P1", () => {
    expect(decisionOf(executeAs(monetaryParameters(EUR(500))))).toMatchObject({ outcome: "AUTHORIZED", approvalId: "p1" });
  });

  it("E2: executed with the fingerprint of 500 USD is C6_ACTION_FINGERPRINT_MISMATCH", () => {
    expect(decisionOf(executeAs(monetaryParameters(USD(500))))).toEqual({ outcome: "DENIED", reasonCode: "C6_ACTION_FINGERPRINT_MISMATCH" });
  });

  it("E3: executed as 501 EUR is C6_ACTION_FINGERPRINT_MISMATCH (control)", () => {
    expect(decisionOf(executeAs(monetaryParameters(EUR(501))))).toEqual({ outcome: "DENIED", reasonCode: "C6_ACTION_FINGERPRINT_MISMATCH" });
  });

  it("A2/A3: a new action_id, in EUR or USD, gets nothing from P1 (PR #9) — and a prospective USD question no longer matches it", () => {
    const store = ingest([
      ...base,
      actionRequest({ sequence: 5, id: "a2", requester: AGENT_A, delegationId: "d", parameters: monetaryParameters(EUR(500)) }),
      actionRequest({ sequence: 6, id: "a3", requester: AGENT_A, delegationId: "d", parameters: monetaryParameters(USD(500)) }),
    ]);
    for (const id of ["a2", "a3"]) {
      const explanation = explainAction(store, { actionId: action(id) }, instant(6));
      expect(explanation.invokedAuthorityNow).not.toMatchObject({ outcome: "AUTHORIZED" });
    }
    expect(ask(store, AGENT_A, monetaryParameters(USD(500)), 6).outcome).not.toBe("AUTHORIZED");
    // P1 is untouched by the failed attempts: the approved action itself is still covered.
    expect(explainAction(store, { actionId: action("a1") }, instant(6)).invokedAuthorityNow).toMatchObject({ outcome: "AUTHORIZED", approvalId: "p1" });
  });
});

describe("M4 — same-currency behavior is unchanged", () => {
  it("EUR thresholds, approval, ceiling and budget behave exactly as before unit binding", () => {
    const store = ingest([
      eurRoot({ maxAmount: EUR(1000), totalBudget: EUR(700) }),
      actionRequest({ sequence: 2, id: "e1", requester: AGENT_A, delegationId: "d", parameters: monetaryParameters(EUR(600)) }),
      approvalRequest({ sequence: 3, id: "p1", actionId: "e1", requestedFrom: THEO, requester: AGENT_A }),
      approvalGrant({ sequence: 4, id: "p1", actionId: "e1", approver: THEO }),
    ]);
    expect(ask(store, AGENT_A, monetaryParameters(EUR(50)), 4).outcome).toBe("AUTHORIZED");
    expect(ask(store, AGENT_A, monetaryParameters(EUR(600)), 4)).toMatchObject({ outcome: "AUTHORIZED", approvalId: "p1" });
    expect(ask(store, AGENT_A, monetaryParameters(EUR(800)), 4)).toMatchObject({ outcome: "DENIED", reasonCode: "C9_TOTAL_BUDGET_EXCEEDED" });
    expect(ask(store, AGENT_A, monetaryParameters(EUR(1001)), 4).outcome).toBe("DENIED");
  });
});

describe("M5 — sub-delegation attenuation compares currency first, value second", () => {
  const parent = eurRoot({ maxAmount: EUR(1000), totalBudget: EUR(5000) });
  const child = (id: string, maxAmount: Money, totalBudget: Money, thresholdsValue: ReturnType<typeof thresholds>): AuthorityEvent =>
    subDelegation({ sequence: 2, id, parentId: "d", grantor: AGENT_A, grantee: AGENT_B, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, maxAmount, totalBudget, amountThresholds: thresholdsValue });

  it("child A (EUR / EUR) is valid", () => {
    const store = ingest([parent, child("s", EUR(500), EUR(2000), thresholds(EUR(100), EUR(500)))]);
    expect(ask(store, AGENT_B, monetaryParameters(EUR(50)), 2).outcome).toBe("AUTHORIZED");
  });

  it("child B (USD / USD) under a EUR parent fails closed, for USD and EUR alike", () => {
    const store = ingest([parent, child("s", USD(500), USD(2000), thresholds(USD(100), USD(500)))]);
    for (const parameters of [monetaryParameters(USD(50)), monetaryParameters(EUR(50))]) {
      expect(ask(store, AGENT_B, parameters, 2).outcome).not.toBe("AUTHORIZED");
    }
    expect(ask(store, AGENT_B, monetaryParameters(USD(50)), 2)).toMatchObject({ outcome: "DENIED", reasonCode: "C11_CAPABILITY_NOT_COVERED" });
  });

  it("child C (max_amount EUR, total_budget USD) mixes currencies internally: UNKNOWN (C22)", () => {
    const store = ingest([parent, child("s", EUR(500), USD(2000), thresholds(EUR(100), EUR(500)))]);
    expect(ask(store, AGENT_B, monetaryParameters(EUR(50)), 2)).toMatchObject({ outcome: "UNKNOWN", reasonCode: "C22_UNKNOWN_CONSTRAINT_TYPE" });
  });

  it("a child whose thresholds are in another currency than the parent's is not an attenuation", () => {
    const store = ingest([parent, child("s", EUR(500), EUR(2000), thresholds(USD(100), USD(500)))]);
    expect(ask(store, AGENT_B, monetaryParameters(EUR(50)), 2).outcome).not.toBe("AUTHORIZED");
  });

  it("chain validation itself (independent of any action) rejects a currency change as a non-attenuation, and accepts the same currency", () => {
    const validate = (maxAmount: Money, totalBudget: Money, thresholdsValue: ReturnType<typeof thresholds>) => {
      const store = ingest([parent, child("s", maxAmount, totalBudget, thresholdsValue)]);
      const terminal = store.find((event): event is DelegationEvent => event.event_type === "SUBDELEGATION_CREATED");
      if (terminal === undefined) {
        throw new Error("fixture: sub-delegation not ingested");
      }
      return validateChain(terminal, PURCHASE_ORDER_CREATE, store, THEO, iso8601("2025-01-01T00:00:00.000Z"));
    };
    expect(validate(EUR(500), EUR(2000), thresholds(EUR(100), EUR(500))).kind).toBe("valid");
    expect(validate(USD(500), USD(2000), thresholds(USD(100), USD(500)))).toEqual({ kind: "denied", reasonCode: "C11_CAPABILITY_NOT_COVERED" });
  });

  it("value attenuation in the same currency is still enforced (control)", () => {
    const store = ingest([parent, child("s", EUR(1500), EUR(2000), thresholds(EUR(100), EUR(500)))]);
    expect(ask(store, AGENT_B, monetaryParameters(EUR(50)), 2).outcome).not.toBe("AUTHORIZED");
  });
});

describe("M7 — same history, same instant, same query: same result", () => {
  const store = ingest([
    eurRoot({ maxAmount: EUR(1000), totalBudget: EUR(1000) }),
    actionRequest({ sequence: 2, id: "a1", requester: AGENT_A, delegationId: "d", parameters: monetaryParameters(EUR(500)) }),
    approvalRequest({ sequence: 3, id: "p1", actionId: "a1", requestedFrom: THEO, requester: AGENT_A }),
    approvalGrant({ sequence: 4, id: "p1", actionId: "a1", approver: THEO }),
    actionExecution({ sequence: 5, actionId: "a1", executor: AGENT_A, decisionSequence: 4, chain: [delegationLink("d"), approvalLink("p1")], parameters: monetaryParameters(USD(500)) }),
  ]);

  it("authorityAt and explainAction are deterministic for a cross-currency history", () => {
    const query = (): unknown => ({
      usd: ask(store, AGENT_A, monetaryParameters(USD(500)), 5),
      eur: ask(store, AGENT_A, monetaryParameters(EUR(500)), 5),
      explanation: explainAction(store, { actionId: action("a1") }, instant(5)),
    });
    const first = JSON.stringify(query());
    for (let i = 0; i < 3; i += 1) {
      expect(JSON.stringify(query())).toBe(first);
    }
  });
});
