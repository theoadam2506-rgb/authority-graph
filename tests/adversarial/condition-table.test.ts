/**
 * One test per row of SPEC.md's exhaustive condition table (C1-C24). Several
 * rows share their underlying mechanism with a THREAT_MODEL row (noted in
 * comments); they are still written out here individually, under their own
 * C-numbered name, because SPEC.md's table is the contract the engine must
 * satisfy independently of any specific attack narrative.
 *
 * PROMPT 2b split the single {actionId}-keyed query into two operations:
 *   - authorityAt(events, {agentId, principalId, capability, parameters}, at)
 *     is PROSPECTIVE and never needs an ACTION_REQUESTED to exist.
 *   - explainAction(events, {actionId}, at) is HISTORICAL.
 * Rows that ask "would this be authorized" use authorityAt; C6 (which is
 * fundamentally about whether a *specific recorded execution* told the
 * truth) uses explainAction.
 *
 * The engine (src/engine/authority.ts) does not exist yet: every test here is
 * EXPECTED TO FAIL. That is the correct state for this prompt (red phase).
 */
import { describe, expect, it } from "vitest";
import { authorityAt, explainAction, ingestAll } from "../../src/engine/authority.js";
import {
  MAX_CHAIN_DEPTH,
  monetaryParameters,
  nonMonetaryParameters,
  thresholds,
  type AuthorityQuery,
} from "../../src/domain/types.js";
import { toDraft, type AuthorityEvent, type DelegationCreatedPayload } from "../../src/domain/events.js";
import { action, principal } from "../fixtures/ids.js";
import {
  AGENT_A,
  AGENT_B,
  AGENT_C,
  EUR,
  MALLORY,
  PURCHASE_ORDER_CREATE,
  THEO,
  actionExecution,
  actionRequest,
  approvalDeny,
  approvalGrant,
  approvalLink,
  approvalRequest,
  delegationLink,
  revokeDelegation,
  rootDelegation,
  simpleAuthorizedChain,
  subDelegation,
  instant,
  sequentialClock,
} from "../fixtures/scenarios.js";

describe("SPEC.md condition table C1-C24", () => {
  it("C1 — a fully known, unexpired, non-revoked, exact-capability chain to a HUMAN_ROOT is AUTHORIZED", () => {
    const { store, query } = simpleAuthorizedChain();
    expect(authorityAt(store, query, instant(1)).outcome).toBe("AUTHORIZED");
  });

  it("C2 — a monetary action at or below automatic_max_amount is AUTHORIZED without any approval", () => {
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
        amountThresholds: thresholds(1000, 10_000),
      }),
    ];
    const query: AuthorityQuery = {
      agentId: AGENT_A,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: monetaryParameters(EUR(500)),
    };
    expect(authorityAt(store, query, instant(1)).outcome).toBe("AUTHORIZED");
  });

  it("C3 — an amount in the approval band, with a valid matching grant, is AUTHORIZED", () => {
    const params = monetaryParameters(EUR(5000));
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
        amountThresholds: thresholds(1000, 10_000),
      }),
      actionRequest({ sequence: 2, id: "a-1", requester: AGENT_A, delegationId: "d-root", parameters: params }),
      approvalRequest({ sequence: 3, id: "ap-1", actionId: "a-1", requestedFrom: THEO, requester: AGENT_A }),
      approvalGrant({ sequence: 4, id: "ap-1", actionId: "a-1", approver: THEO }),
    ];
    const query: AuthorityQuery = { agentId: AGENT_A, principalId: THEO, capability: PURCHASE_ORDER_CREATE, parameters: params };
    expect(authorityAt(store, query, instant(4)).outcome).toBe("AUTHORIZED");
  });

  it("C4 — an amount in the approval band with no decision yet is REQUIRES_APPROVAL", () => {
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
        amountThresholds: thresholds(1000, 10_000),
      }),
    ];
    const query: AuthorityQuery = {
      agentId: AGENT_A,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: monetaryParameters(EUR(5000)),
    };
    expect(authorityAt(store, query, instant(1)).outcome).toBe("REQUIRES_APPROVAL");
  });

  it("C5 — a valid, authorized APPROVAL_DENIED is DENIED", () => {
    const params = monetaryParameters(EUR(5000));
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
        amountThresholds: thresholds(1000, 10_000),
      }),
      actionRequest({ sequence: 2, id: "a-1", requester: AGENT_A, delegationId: "d-root", parameters: params }),
      approvalRequest({ sequence: 3, id: "ap-1", actionId: "a-1", requestedFrom: THEO, requester: AGENT_A }),
      approvalDeny({ sequence: 4, id: "ap-1", actionId: "a-1", denier: THEO }),
    ];
    // Whether a-1 itself was denied is a historical fact about a-1 (see the
    // "eternal fingerprint blacklist" test: a fresh, unrelated authorityAt
    // query for the same fingerprint must NOT be DENIED by this refusal).
    const explanation = explainAction(store, { actionId: action("a-1") }, instant(4));
    expect(explanation.currentAuthority.outcome).toBe("DENIED");
  });

  it("C6 — a recorded execution whose action_fingerprint no longer matches the approved request is DENIED", () => {
    const store = [
      rootDelegation({
        sequence: 1,
        id: "d-root",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        maxAmount: EUR(1_000_000),
        amountThresholds: thresholds(1000, 1_000_000),
      }),
      actionRequest({
        sequence: 2,
        id: "a-1",
        requester: AGENT_A,
        delegationId: "d-root",
        parameters: monetaryParameters(EUR(5000)),
      }),
      approvalRequest({ sequence: 3, id: "ap-1", actionId: "a-1", requestedFrom: THEO, requester: AGENT_A }),
      approvalGrant({ sequence: 4, id: "ap-1", actionId: "a-1", approver: THEO }),
      actionExecution({
        sequence: 5,
        actionId: "a-1",
        executor: AGENT_A,
        decisionSequence: 4,
        chain: [delegationLink("d-root"), approvalLink("ap-1")],
        parameters: monetaryParameters(EUR(999_000)), // executed, not approved, amount
      }),
    ];
    // Whether a specific recorded execution told the truth is a historical
    // question about that execution, not a prospective one.
    const explanation = explainAction(store, { actionId: action("a-1") }, instant(5));
    expect(explanation.execution?.authorityAtDecision.outcome).toBe("DENIED");
  });

  it("C7 — a valid grant already consumed by an earlier-sequence execution is DENIED for any later attempt", () => {
    const params = monetaryParameters(EUR(5000));
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
        amountThresholds: thresholds(1000, 10_000),
      }),
      actionRequest({ sequence: 2, id: "a-1", requester: AGENT_A, delegationId: "d-root", parameters: params }),
      approvalRequest({ sequence: 3, id: "ap-1", actionId: "a-1", requestedFrom: THEO, requester: AGENT_A }),
      approvalGrant({ sequence: 4, id: "ap-1", actionId: "a-1", approver: THEO }),
      actionExecution({
        sequence: 5,
        actionId: "a-1",
        executor: AGENT_A,
        decisionSequence: 4,
        chain: [delegationLink("d-root"), approvalLink("ap-1")],
        parameters: params,
        timing: { eventId: "evt-first" },
      }),
    ];
    const query: AuthorityQuery = { agentId: AGENT_A, principalId: THEO, capability: PURCHASE_ORDER_CREATE, parameters: params };
    // Prospectively, immediately after the one grant is consumed: DENIED.
    expect(authorityAt(store, query, instant(5)).outcome).toBe("DENIED");
  });

  it("C8 — an amount above approval_max_amount is DENIED outright, no approval can rescue it", () => {
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
        amountThresholds: thresholds(1000, 5000),
      }),
    ];
    const query: AuthorityQuery = {
      agentId: AGENT_A,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: monetaryParameters(EUR(9000)), // > approval_max_amount (5000)
    };
    expect(authorityAt(store, query, instant(1)).outcome).toBe("DENIED");
  });

  it("C9 — a request exceeding a bounded ancestor's total_budget is DENIED", () => {
    const store = [
      rootDelegation({
        sequence: 1,
        id: "d-root",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        totalBudget: EUR(1000),
        amountThresholds: thresholds(1000, 1000),
      }),
    ];
    const query: AuthorityQuery = {
      agentId: AGENT_A,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: monetaryParameters(EUR(1500)), // exceeds total_budget outright
    };
    expect(authorityAt(store, query, instant(1)).outcome).toBe("DENIED");
  });

  it("C10 — a chain link referencing an unknown delegation_id at evaluation sequence is UNKNOWN", () => {
    const store = [
      subDelegation({
        sequence: 1,
        id: "d-child",
        parentId: "d-never-exists",
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
    expect(authorityAt(store, query, instant(1)).outcome).toBe("UNKNOWN");
  });

  it("C11 — a fully known chain that does not cover the exact requested capability is DENIED", () => {
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
    const query: AuthorityQuery = {
      agentId: AGENT_A,
      principalId: THEO,
      capability: { resource: "invoice", action: "delete" },
      parameters: nonMonetaryParameters(),
    };
    expect(authorityAt(store, query, instant(1)).outcome).toBe("DENIED");
  });

  it("C12 — an authorized revocation, sequenced before evaluation, DENIES the exclusively-dependent chain", () => {
    const { store: base, query } = simpleAuthorizedChain();
    const revoked = [...base, revokeDelegation({ sequence: 2, targetId: "d-root", issuedBy: THEO })];
    expect(authorityAt(revoked, query, instant(2)).outcome).toBe("DENIED");
  });

  it("C13 — a revocation whose emitter is neither the direct grantor nor the chain root has no effect", () => {
    const { store: base, query } = simpleAuthorizedChain();
    const attempted = [...base, revokeDelegation({ sequence: 2, targetId: "d-root", issuedBy: MALLORY })];
    expect(authorityAt(attempted, query, instant(2)).outcome).toBe("AUTHORIZED");
  });

  it("C14 — a subdelegation whose emitter differs from the parent's grantee is DENIED (can_delegate known)", () => {
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
      subDelegation({
        sequence: 2,
        id: "d-sub",
        parentId: "d-root",
        grantor: MALLORY, // not the parent's grantee
        grantee: AGENT_B,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        emitter: MALLORY,
      }),
    ];
    const query: AuthorityQuery = {
      agentId: AGENT_B,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: nonMonetaryParameters(),
    };
    expect(authorityAt(store, query, instant(2)).outcome).toBe("DENIED");
  });

  it("C15 — a subdelegation whose parent has no can_delegate field at all is UNKNOWN", () => {
    const root = rootDelegation({
      sequence: 1,
      id: "d-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: true,
    });
    const { can_delegate: _dropped, ...payloadWithoutCanDelegate } = root.payload as DelegationCreatedPayload;
    const rootMissingField = { ...root, payload: payloadWithoutCanDelegate } as AuthorityEvent;
    const store = [
      rootMissingField,
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

  it("C16 — an approval decision from an unhabilitated emitter has no effect (action stays REQUIRES_APPROVAL)", () => {
    const params = monetaryParameters(EUR(5000));
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
        amountThresholds: thresholds(1000, 10_000),
      }),
      actionRequest({ sequence: 2, id: "a-1", requester: AGENT_A, delegationId: "d-root", parameters: params }),
      approvalRequest({ sequence: 3, id: "ap-1", actionId: "a-1", requestedFrom: THEO, requester: AGENT_A }),
      approvalDeny({ sequence: 4, id: "ap-1", actionId: "a-1", denier: MALLORY }),
    ];
    const query: AuthorityQuery = { agentId: AGENT_A, principalId: THEO, capability: PURCHASE_ORDER_CREATE, parameters: params };
    expect(authorityAt(store, query, instant(4)).outcome).toBe("REQUIRES_APPROVAL");
  });

  it("C17 — a root delegation whose grantor_type is AGENT is UNKNOWN", () => {
    const store = [
      rootDelegation({
        sequence: 1,
        id: "d-root",
        grantor: AGENT_C,
        grantorType: "AGENT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
      }),
    ];
    const query: AuthorityQuery = {
      agentId: AGENT_A,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: nonMonetaryParameters(),
    };
    expect(authorityAt(store, query, instant(1)).outcome).toBe("UNKNOWN");
  });

  it("C18 — a cycle in the delegation_id chain is UNKNOWN", () => {
    const store = [
      subDelegation({
        sequence: 1,
        id: "d-1",
        parentId: "d-2",
        grantor: AGENT_A,
        grantee: AGENT_B,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: true,
      }),
      subDelegation({
        sequence: 2,
        id: "d-2",
        parentId: "d-1",
        grantor: AGENT_B,
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: true,
      }),
    ];
    const query: AuthorityQuery = {
      agentId: AGENT_A,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: nonMonetaryParameters(),
    };
    expect(authorityAt(store, query, instant(2)).outcome).toBe("UNKNOWN");
  });

  it("C19 — a chain of exactly MAX_CHAIN_DEPTH (32 edges) is resolved normally, not treated as excessive", () => {
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
    // d-0 -> d-1 is the 1st edge; we need MAX_CHAIN_DEPTH edges in total.
    // Every level terminates on its OWN distinct identity, not shared with
    // any other level (and not d-0's own direct grantee AGENT_A) — a shared
    // grantor===grantee reused across levels would make that identity the
    // grantee of multiple delegations at different (shorter) depths, so the
    // shortest one would trivially authorize it regardless of this chain's
    // real depth (mechanical fixture fix, does not touch the invariant under
    // test: see PROMPT 3 notes).
    const deepAgentOk = (level: number) => principal(`deep-agent-c19-ok-${level}`);
    for (let i = 1; i <= MAX_CHAIN_DEPTH; i += 1) {
      store.push(
        subDelegation({
          sequence: i + 1,
          id: `d-${i}`,
          parentId: `d-${i - 1}`,
          grantor: i === 1 ? AGENT_A : deepAgentOk(i - 1),
          grantee: deepAgentOk(i),
          capabilities: [PURCHASE_ORDER_CREATE],
          canDelegate: true,
        }),
      );
    }
    const finalSeq = MAX_CHAIN_DEPTH + 1;
    const query: AuthorityQuery = {
      agentId: deepAgentOk(MAX_CHAIN_DEPTH),
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: nonMonetaryParameters(),
    };
    expect(authorityAt(store, query, instant(finalSeq)).outcome).toBe("AUTHORIZED");
  });

  it("C19 — a chain of MAX_CHAIN_DEPTH + 1 (33 edges) is UNKNOWN (MAX_CHAIN_DEPTH_EXCEEDED)", () => {
    const DEPTH = MAX_CHAIN_DEPTH + 1;
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
    // Same fixture fix as above: every level gets its own distinct identity.
    const deepAgentExceeded = (level: number) => principal(`deep-agent-c19-exceeded-${level}`);
    for (let i = 1; i <= DEPTH; i += 1) {
      store.push(
        subDelegation({
          sequence: i + 1,
          id: `d-${i}`,
          parentId: `d-${i - 1}`,
          grantor: i === 1 ? AGENT_A : deepAgentExceeded(i - 1),
          grantee: deepAgentExceeded(i),
          capabilities: [PURCHASE_ORDER_CREATE],
          canDelegate: true,
        }),
      );
    }
    const finalSeq = DEPTH + 1;
    const query: AuthorityQuery = {
      agentId: deepAgentExceeded(DEPTH),
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: nonMonetaryParameters(),
    };
    const decision = authorityAt(store, query, instant(finalSeq));
    expect(decision.outcome).toBe("UNKNOWN");
    expect(decision).toMatchObject({ reasonCode: "MAX_CHAIN_DEPTH_EXCEEDED" });
  });

  it("C20 — an event_id conflict at ingestion returns UNKNOWN synchronously, without touching the canonical store", () => {
    const e1 = rootDelegation({
      sequence: 1,
      id: "d-1",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      timing: { eventId: "evt-c20" },
    });
    const e2 = rootDelegation({
      sequence: 2,
      id: "d-2",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_C,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      timing: { eventId: "evt-c20" },
    });
    const result = ingestAll([toDraft(e1), toDraft(e2)], sequentialClock);
    expect(result.outcomes[1]).toEqual({ accepted: false, reasonCode: "EVENT_ID_CONFLICT" });
    // e1 legitimately shares this same event_id (that is the point of the
    // conflict), so checking "no stored event has this event_id" would be
    // false regardless of correctness — checking the store's size, as A7
    // does, is what actually verifies e2 was never incorporated (mechanical
    // assertion fix: see PROMPT 3 notes).
    expect(result.canonicalStore).toHaveLength(1);
  });

  it("C21 — a business-id collision (same delegation_id, different content, different event_id) is rejected", () => {
    const e1 = rootDelegation({
      sequence: 1,
      id: "d-shared-c21",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      timing: { eventId: "evt-c21-a" },
    });
    const e2 = rootDelegation({
      sequence: 2,
      id: "d-shared-c21",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_C,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      timing: { eventId: "evt-c21-b" },
    });
    const result = ingestAll([toDraft(e1), toDraft(e2)], sequentialClock);
    expect(result.outcomes[1]).toEqual({ accepted: false, reasonCode: "BUSINESS_ID_COLLISION" });
  });

  it("C22 — an unrecognized constraint type on a delegation makes any dependent resolution UNKNOWN", () => {
    const root = rootDelegation({
      sequence: 1,
      id: "d-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
    });
    // Inject a constraint our type system cannot express, simulating a
    // malformed or future-version payload arriving from outside this module.
    const withUnknownConstraint = {
      ...root,
      payload: { ...root.payload, geo_fence: { countries: ["FR"] } },
    } as unknown as AuthorityEvent;
    const store = [withUnknownConstraint];
    const query: AuthorityQuery = {
      agentId: AGENT_A,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: nonMonetaryParameters(),
    };
    expect(authorityAt(store, query, instant(1)).outcome).toBe("UNKNOWN");
  });

  it("C23 — one fully valid chain suffices for AUTHORIZED even when another chain to the same principal is broken", () => {
    const store = [
      rootDelegation({
        sequence: 1,
        id: "d-valid",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
      }),
      // a second, independent chain to AGENT_A that is broken (missing parent)
      subDelegation({
        sequence: 2,
        id: "d-broken",
        parentId: "d-missing-parent",
        grantor: MALLORY,
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
      }),
    ];
    const query: AuthorityQuery = {
      agentId: AGENT_A,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: nonMonetaryParameters(),
    };
    expect(authorityAt(store, query, instant(2)).outcome).toBe("AUTHORIZED");
  });

  it("C24 — when no chain to the principal is both fully known and valid, the outcome is UNKNOWN", () => {
    const store = [
      subDelegation({
        sequence: 1,
        id: "d-only-chain",
        parentId: "d-missing-parent",
        grantor: MALLORY,
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
      }),
    ];
    const query: AuthorityQuery = {
      agentId: AGENT_A,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: nonMonetaryParameters(),
    };
    expect(authorityAt(store, query, instant(1)).outcome).toBe("UNKNOWN");
  });
});
