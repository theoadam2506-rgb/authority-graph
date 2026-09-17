/**
 * Massive, deliberately redundant coverage of UNKNOWN-producing conditions
 * (I1 fail-closed). Several of these overlap in spirit with a single row of
 * SPEC.md's condition table or THREAT_MODEL.md, but each explores a
 * different *shape* of the same underlying gap (missing link at different
 * depths, unknown field on different event types, etc.) — the point of this
 * file is breadth, not novelty.
 *
 * All queries here use authorityAt (prospective) — none of these scenarios
 * concerns a specific historical action's own record, so none need
 * explainAction.
 *
 * The engine (src/engine/authority.ts) does not exist yet: every test here is
 * EXPECTED TO FAIL. That is the correct state for this prompt (red phase).
 */
import { describe, expect, it } from "vitest";
import { authorityAt, explainAction } from "../../src/engine/authority.js";
import {
  monetaryParameters,
  nonMonetaryParameters,
  thresholds,
  type AuthorityQuery,
} from "../../src/domain/types.js";
import type { AuthorityEvent, DelegationCreatedPayload, SubdelegationCreatedPayload } from "../../src/domain/events.js";
import { action, principal } from "../fixtures/ids.js";
import {
  AGENT_A,
  AGENT_B,
  AGENT_C,
  EUR,
  PURCHASE_ORDER_CREATE,
  THEO,
  rootDelegation,
  simpleAuthorizedChain,
  subDelegation,
  instant,
} from "../fixtures/scenarios.js";

describe("UNKNOWN coverage (I1 fail-closed)", () => {
  it("UNKNOWN — an agent with no delegation events at all in the store", () => {
    const store: AuthorityEvent[] = [];
    const query: AuthorityQuery = {
      agentId: AGENT_A,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: nonMonetaryParameters(),
    };
    expect(authorityAt(store, query, instant(0)).outcome).toBe("UNKNOWN");
  });

  it("UNKNOWN — explainAction on an actionId that has no ACTION_REQUESTED at all in the store", () => {
    const store = [
      rootDelegation({
        sequence: 1,
        id: "d-root",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
      }),
    ];
    expect(explainAction(store, { actionId: action("a-never-requested") }, instant(1)).currentAuthority.outcome).toBe(
      "UNKNOWN",
    );
  });

  it("UNKNOWN — a missing link two levels up (grandparent), not the immediate parent", () => {
    const store = [
      // "d-root" is never created at all.
      subDelegation({
        sequence: 1,
        id: "d-mid",
        parentId: "d-root",
        grantor: AGENT_A,
        grantee: AGENT_B,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: true,
      }),
      subDelegation({
        sequence: 2,
        id: "d-leaf",
        parentId: "d-mid",
        grantor: AGENT_B,
        grantee: AGENT_C,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
      }),
    ];
    const query: AuthorityQuery = {
      agentId: AGENT_C,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: nonMonetaryParameters(),
    };
    expect(authorityAt(store, query, instant(2)).outcome).toBe("UNKNOWN");
  });

  it("UNKNOWN — can_delegate missing on the direct parent of the invoked delegation", () => {
    const root = rootDelegation({
      sequence: 1,
      id: "d-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: true,
    });
    const { can_delegate: _drop, ...rest } = root.payload as DelegationCreatedPayload;
    const rootMissingCanDelegate = { ...root, payload: rest } as AuthorityEvent;
    const store = [
      rootMissingCanDelegate,
      subDelegation({
        sequence: 2,
        id: "d-sub",
        parentId: "d-root",
        grantor: AGENT_A,
        grantee: AGENT_B,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
      }),
    ];
    const query: AuthorityQuery = {
      agentId: AGENT_B,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: nonMonetaryParameters(),
    };
    expect(authorityAt(store, query, instant(2)).outcome).toBe("UNKNOWN");
  });

  it("UNKNOWN — can_delegate missing higher up the chain (grandparent), not the immediate parent", () => {
    const root = rootDelegation({
      sequence: 1,
      id: "d-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: true,
    });
    const { can_delegate: _drop, ...rest } = root.payload as DelegationCreatedPayload;
    const rootMissingCanDelegate = { ...root, payload: rest } as AuthorityEvent;
    const store = [
      rootMissingCanDelegate,
      subDelegation({
        sequence: 2,
        id: "d-mid",
        parentId: "d-root",
        grantor: AGENT_A,
        grantee: AGENT_B,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: true, // explicit and known at this level
      }),
      subDelegation({
        sequence: 3,
        id: "d-leaf",
        parentId: "d-mid",
        grantor: AGENT_B,
        grantee: AGENT_C,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
      }),
    ];
    const query: AuthorityQuery = {
      agentId: AGENT_C,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: nonMonetaryParameters(),
    };
    expect(authorityAt(store, query, instant(3)).outcome).toBe("UNKNOWN");
  });

  it("UNKNOWN — a valid-looking sub-chain hanging off an AGENT-rooted (no human anchor) delegation", () => {
    const store = [
      rootDelegation({
        sequence: 1,
        id: "d-root",
        grantor: AGENT_C,
        grantorType: "AGENT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: true,
      }),
      subDelegation({
        sequence: 2,
        id: "d-sub",
        parentId: "d-root",
        grantor: AGENT_A,
        grantee: AGENT_B,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
      }),
    ];
    const query: AuthorityQuery = {
      agentId: AGENT_B,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: nonMonetaryParameters(),
    };
    expect(authorityAt(store, query, instant(2)).outcome).toBe("UNKNOWN");
  });

  it("UNKNOWN — an unrecognized constraint on a SUBDELEGATION_CREATED, not just a root", () => {
    const store = [
      rootDelegation({
        sequence: 1,
        id: "d-root",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: true,
      }),
      (() => {
        const sub = subDelegation({
          sequence: 2,
          id: "d-sub",
          parentId: "d-root",
          grantor: AGENT_A,
          grantee: AGENT_B,
          capabilities: [PURCHASE_ORDER_CREATE],
          canDelegate: false,
        });
        return {
          ...sub,
          payload: { ...(sub.payload as SubdelegationCreatedPayload), time_of_day_window: "09:00-17:00" },
        } as unknown as AuthorityEvent;
      })(),
    ];
    const query: AuthorityQuery = {
      agentId: AGENT_B,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: nonMonetaryParameters(),
    };
    expect(authorityAt(store, query, instant(2)).outcome).toBe("UNKNOWN");
  });

  it("UNKNOWN — a longer cycle (three delegations referencing each other in a loop)", () => {
    const store = [
      subDelegation({
        sequence: 1,
        id: "d-1",
        parentId: "d-3",
        grantor: AGENT_C,
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: true,
      }),
      subDelegation({
        sequence: 2,
        id: "d-2",
        parentId: "d-1",
        grantor: AGENT_A,
        grantee: AGENT_B,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: true,
      }),
      subDelegation({
        sequence: 3,
        id: "d-3",
        parentId: "d-2",
        grantor: AGENT_B,
        grantee: AGENT_C,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: true,
      }),
    ];
    const query: AuthorityQuery = {
      agentId: AGENT_C,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: nonMonetaryParameters(),
    };
    expect(authorityAt(store, query, instant(3)).outcome).toBe("UNKNOWN");
  });

  it("UNKNOWN — depth exceeded in a wide-and-deep tree, evaluated at its deepest leaf", () => {
    const DEPTH = 150; // deliberately far beyond MAX_CHAIN_DEPTH (32)
    const store: AuthorityEvent[] = [
      rootDelegation({
        sequence: 1,
        id: "d-0",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: true,
      }),
    ];
    // A wide branch off the root that goes nowhere near the depth limit.
    store.push(
      subDelegation({
        sequence: 2,
        id: "d-shallow-branch",
        parentId: "d-0",
        grantor: AGENT_A,
        grantee: AGENT_B,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
      }),
    );
    // The deep branch that actually exceeds the limit. Every level gets its
    // own distinct identity, not shared with any other level and not AGENT_A
    // (d-0's own direct grantee) — a shared grantor===grantee reused across
    // levels would make that identity the grantee of multiple delegations at
    // different (shorter) depths, so the shortest one would trivially
    // authorize it regardless of this branch's real depth (mechanical
    // fixture fix, does not touch the invariant under test: see PROMPT 3
    // notes).
    const deepAgent = (level: number) => principal(`deep-agent-unknown-coverage-${level}`);
    for (let i = 1; i <= DEPTH; i += 1) {
      store.push(
        subDelegation({
          sequence: i + 2,
          id: `d-deep-${i}`,
          parentId: i === 1 ? "d-0" : `d-deep-${i - 1}`,
          grantor: i === 1 ? AGENT_A : deepAgent(i - 1),
          grantee: deepAgent(i),
          capabilities: [PURCHASE_ORDER_CREATE],
          canDelegate: true,
        }),
      );
    }
    const finalSeq = DEPTH + 3;
    const query: AuthorityQuery = {
      agentId: deepAgent(DEPTH),
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: nonMonetaryParameters(),
    };
    const decision = authorityAt(store, query, instant(finalSeq));
    expect(decision.outcome).toBe("UNKNOWN");
    expect(decision).toMatchObject({ reasonCode: "MAX_CHAIN_DEPTH_EXCEEDED" });
  });

  it("UNKNOWN — an event declaring an unsupported schema_version", () => {
    const root = rootDelegation({
      sequence: 1,
      id: "d-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      timing: { schemaVersion: 999 }, // V0 only understands schema_version 1
    });
    const store = [root];
    const query: AuthorityQuery = {
      agentId: AGENT_A,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: nonMonetaryParameters(),
    };
    expect(authorityAt(store, query, instant(1)).outcome).toBe("UNKNOWN");
  });

  it("UNKNOWN schema_version poisons only resolutions that depend on that event, not an unrelated valid chain", () => {
    const { store: valid, query: validQuery } = simpleAuthorizedChain();
    const unrelatedBadVersion = rootDelegation({
      sequence: 2,
      id: "d-unrelated",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_C, // a completely different agent, never queried below
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      timing: { schemaVersion: 999 },
    });
    const store = [...valid, unrelatedBadVersion];
    // The unrelated, foreign bad-schema event does not poison AGENT_A's chain.
    expect(authorityAt(store, validQuery, instant(2)).outcome).toBe("AUTHORIZED");
    // But a query that actually depends on the bad event is UNKNOWN.
    const dependentQuery: AuthorityQuery = {
      agentId: AGENT_C,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: nonMonetaryParameters(),
    };
    expect(authorityAt(store, dependentQuery, instant(2)).outcome).toBe("UNKNOWN");
  });

  it("UNKNOWN — malformed amount thresholds (automatic_max_amount above approval_max_amount)", () => {
    const store = [
      rootDelegation({
        sequence: 1,
        id: "d-root",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        maxAmount: EUR(10_000),
        amountThresholds: thresholds(9000, 1000), // automatic > approval: nonsensical
      }),
    ];
    const query: AuthorityQuery = {
      agentId: AGENT_A,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: monetaryParameters(EUR(500)),
    };
    expect(authorityAt(store, query, instant(1)).outcome).toBe("UNKNOWN");
  });

  it("UNKNOWN — a monetary action requested against a delegation with no thresholds declared at all", () => {
    const store = [
      rootDelegation({
        sequence: 1,
        id: "d-root",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        // no maxAmount, no totalBudget, no amountThresholds at all
      }),
    ];
    const query: AuthorityQuery = {
      agentId: AGENT_A,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: monetaryParameters(EUR(1)),
    };
    expect(authorityAt(store, query, instant(1)).outcome).toBe("UNKNOWN");
  });
});
