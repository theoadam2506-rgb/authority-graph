/**
 * Multi-path graph — a genuine convergent graph, not a single chain:
 *
 *   HUMAN_ROOT
 *     |-- path A --> MID_A --> AGENT_X
 *     `-- path B --> MID_B --> AGENT_X
 *
 * Two independent two-hop delegation chains terminate at the same agent.
 * SPEC.md's multi-path rule: it suffices that ONE of them be demonstrated
 * fully valid over its entire length for the decision to be AUTHORIZED — a
 * broken, revoked, or incomplete sibling chain never poisons that result.
 * This is the fail-closed principle applied *per candidate chain*, not
 * globally: each path is judged entirely on its own merits, and only the
 * best result among them is reported (`betterOutcome`,
 * src/engine/authorityAt.ts).
 */
import { describe, expect, it } from "vitest";
import { authorityAt } from "../../src/engine/authority.js";
import { nonMonetaryParameters, type AuthorityQuery } from "../../src/domain/types.js";
import { principal } from "../fixtures/ids.js";
import { PURCHASE_ORDER_CREATE, THEO, instant, revokeDelegation, rootDelegation, subDelegation } from "../fixtures/scenarios.js";

const MID_A = principal("mid-a");
const MID_B = principal("mid-b");
const AGENT_X = principal("agent-x");

const query: AuthorityQuery = {
  agentId: AGENT_X,
  principalId: THEO,
  capability: PURCHASE_ORDER_CREATE,
  parameters: nonMonetaryParameters(),
};

function pathADelegations(startSequence: number) {
  return [
    rootDelegation({
      sequence: startSequence,
      id: "d-path-a-1",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: MID_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: true,
    }),
    subDelegation({
      sequence: startSequence + 1,
      id: "d-path-a-2",
      parentId: "d-path-a-1",
      grantor: MID_A,
      grantee: AGENT_X,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
    }),
  ];
}

function pathBDelegations(startSequence: number) {
  return [
    rootDelegation({
      sequence: startSequence,
      id: "d-path-b-1",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: MID_B,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: true,
    }),
    subDelegation({
      sequence: startSequence + 1,
      id: "d-path-b-2",
      parentId: "d-path-b-1",
      grantor: MID_B,
      grantee: AGENT_X,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
    }),
  ];
}

describe("Multi-path convergent graph — fail-closed per branch, not globally", () => {
  it("(A) both independent paths, evaluated alone, each demonstrate AGENT_X's authority on their own", () => {
    const storeWithOnlyPathA = pathADelegations(1);
    expect(authorityAt(storeWithOnlyPathA, query, instant(2)).outcome).toBe("AUTHORIZED");

    const storeWithOnlyPathB = pathBDelegations(1);
    expect(authorityAt(storeWithOnlyPathB, query, instant(2)).outcome).toBe("AUTHORIZED");
  });

  it("(B) path A corrupted (UNKNOWN — its parent was never ingested) does not poison independent, valid path B", () => {
    const corruptPathA = [
      // Only the second hop exists; "d-path-a-1" is never in this store —
      // an incomplete chain (C10), not a revoked or denied one.
      subDelegation({
        sequence: 1,
        id: "d-path-a-2",
        parentId: "d-path-a-1",
        grantor: MID_A,
        grantee: AGENT_X,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
      }),
    ];
    const store = [...corruptPathA, ...pathBDelegations(2)];
    const decision = authorityAt(store, query, instant(3));
    expect(decision.outcome).toBe("AUTHORIZED");
    if (decision.outcome === "AUTHORIZED") {
      expect(decision.chain).toEqual(["d-path-b-1", "d-path-b-2"]);
    }
  });

  it("(C) path A revoked does not poison independent, valid path B", () => {
    const pathA = pathADelegations(1);
    const pathB = pathBDelegations(3);
    const revokePathA = revokeDelegation({ sequence: 5, targetId: "d-path-a-1", issuedBy: THEO });
    const store = [...pathA, ...pathB, revokePathA];
    const decision = authorityAt(store, query, instant(5));
    expect(decision.outcome).toBe("AUTHORIZED");
    if (decision.outcome === "AUTHORIZED") {
      expect(decision.chain).toEqual(["d-path-b-1", "d-path-b-2"]);
    }
  });

  it("(D) neither path is fully valid: the result is never AUTHORIZED", () => {
    const pathA = pathADelegations(1);
    const revokePathA = revokeDelegation({ sequence: 3, targetId: "d-path-a-1", issuedBy: THEO });
    // Path B is also broken here — its own root is missing, exactly like
    // path A in test (B) — so no candidate chain is left standing at all.
    const brokenPathB = [
      subDelegation({
        sequence: 4,
        id: "d-path-b-2",
        parentId: "d-path-b-1",
        grantor: MID_B,
        grantee: AGENT_X,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
      }),
    ];
    const store = [...pathA, revokePathA, ...brokenPathB];
    const decision = authorityAt(store, query, instant(4));
    expect(decision.outcome).not.toBe("AUTHORIZED");
    // Deterministic in this exact construction: a fully-known, revoked
    // chain (path A) outranks an incomplete one (path B) in
    // betterOutcome's priority (DENIED before UNKNOWN) — but the property
    // this test exists to pin down is the negative one above: whichever
    // non-AUTHORIZED code wins, it is never AUTHORIZED when no candidate
    // chain is fully valid.
    expect(decision.outcome).toBe("DENIED");
    expect(decision.outcome === "DENIED" ? decision.reasonCode : undefined).toBe("C12_DELEGATION_REVOKED");
  });
});
