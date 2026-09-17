/**
 * PROMPT 6e — reproduction of the gap I20 (PROMPT 6b) left open: I20 only
 * checks that authority_chain_ref's TERMINAL delegation link's grantee is
 * the executor. Nothing checked that every OTHER delegation_id cited in the
 * array was actually an ancestor of that terminal — remainingBudget's
 * passesThroughDelegation only tested array membership.
 *
 * This is a self-written reproduction (not part of the external audit) —
 * kept in its own file so tests/adversarial/independent-audit.test.ts stays
 * an untouched record of what that audit actually found.
 *
 * Same process rule as everywhere else in this repo: if this test fails,
 * the fix belongs in the implementation, never here.
 */
import { describe, expect, it } from "vitest";
import { authorityAt, ingestAll } from "../../src/engine/authority.js";
import { monetaryParameters, thresholds } from "../../src/domain/types.js";
import { toDraft } from "../../src/domain/events.js";
import { principal } from "../fixtures/ids.js";
import {
  EUR,
  PURCHASE_ORDER_CREATE,
  THEO,
  actionExecution,
  actionRequest,
  delegationLink,
  instant,
  rootDelegation,
  sequentialClock,
} from "../fixtures/scenarios.js";

const BOB = principal("bob"); // holds his own delegation, entirely unrelated to Mallory's
const MALLORY = principal("mallory-chain-padder");

describe("Chain padding — an intermediate authority_chain_ref link that is not a real ancestor of the terminal", () => {
  it("does not debit a stranger's total_budget just because their real delegation_id was stuffed into an unrelated, otherwise-legitimate execution", () => {
    const bobRoot = rootDelegation({
      sequence: 1,
      id: "d-bob-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: BOB,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      totalBudget: EUR(100),
      amountThresholds: thresholds(100, 100),
    });
    const malloryRoot = rootDelegation({
      sequence: 2,
      id: "d-mallory-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: MALLORY,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(100, 100),
    });
    const malloryRequest = actionRequest({
      sequence: 3,
      id: "mallory-action",
      requester: MALLORY,
      delegationId: "d-mallory-root",
      parameters: monetaryParameters(EUR(100)),
    });
    // Mallory's own execution is, in every other respect, entirely honest:
    // she requested it, she executed it, and the chain's own TERMINAL link
    // (last entry) really is her own delegation. She simply also stuffs
    // Bob's real, unrelated, causally-prior delegation_id into the same
    // array — a delegation she has no ancestral relationship with at all.
    const malloryExecution = actionExecution({
      sequence: 4,
      actionId: "mallory-action",
      executor: MALLORY,
      decisionSequence: 3,
      chain: [delegationLink("d-bob-root"), delegationLink("d-mallory-root")],
      parameters: monetaryParameters(EUR(100)),
    });

    const ingested = ingestAll([toDraft(bobRoot), toDraft(malloryRoot), toDraft(malloryRequest), toDraft(malloryExecution)], sequentialClock);

    // Bob never spent a cent of his own 100 EUR total_budget. His own,
    // completely unrelated 100 EUR request must still be AUTHORIZED.
    const bobsOwnQuery = {
      agentId: BOB,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: monetaryParameters(EUR(100)),
    };
    expect(authorityAt(ingested.canonicalStore, bobsOwnQuery, instant(4)).outcome).toBe("AUTHORIZED");
  });
});
