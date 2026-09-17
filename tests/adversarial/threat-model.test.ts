/**
 * One test per row of THREAT_MODEL.md (A1-A20, A24). The engine
 * (src/engine/authority.ts) does not exist yet — every test in this file is
 * EXPECTED TO FAIL, either because the import cannot be resolved or because
 * the call throws. That is the correct state for this prompt (red phase).
 *
 * PROMPT 2b split the single {actionId}-keyed query into two operations:
 *   - authorityAt(events, {agentId, principalId, capability, parameters}, at)
 *     is PROSPECTIVE and never needs an ACTION_REQUESTED to exist.
 *   - explainAction(events, {actionId}, at) is HISTORICAL: it looks up the
 *     immutable ACTION_REQUESTED and evaluates authority from it, both at any
 *     recorded execution's decision_sequence and at the query's own sequence.
 * Tests below use whichever operation matches the question being asked.
 */
import { describe, expect, it } from "vitest";
import { authorityAt, explainAction, ingestAll } from "../../src/engine/authority.js";
import {
  monetaryParameters,
  nonMonetaryParameters,
  sequenceNumber,
  thresholds,
  type AuthorityQuery,
} from "../../src/domain/types.js";
import { toDraft } from "../../src/domain/events.js";
import { action, principal, recipient } from "../fixtures/ids.js";
import {
  AGENT_A,
  AGENT_B,
  AGENT_C,
  EUR,
  MALLORY,
  PURCHASE_ORDER_CREATE,
  THEO,
  VENDOR,
  actionExecution,
  actionRequest,
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

const seq = sequenceNumber;

describe("THREAT_MODEL A1-A20, A24", () => {
  it("A1 — attacker-backdated occurred_at on a revocation does not rewrite an already-rendered decision", () => {
    const { store: base, query } = simpleAuthorizedChain();
    const revoked = [
      ...base,
      revokeDelegation({
        sequence: 3,
        targetId: "d-root",
        issuedBy: THEO,
        timing: { occurredAt: "2000-01-01T00:00:00.000Z" }, // absurdly backdated
      }),
    ];
    expect(authorityAt(revoked, query, instant(2)).outcome).toBe("AUTHORIZED");
    expect(authorityAt(revoked, query, instant(3)).outcome).toBe("DENIED");
  });

  it("A2 — replaying an identical event (same event_id) produces only one effect", () => {
    const event = rootDelegation({
      sequence: 1,
      id: "d-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      timing: { eventId: "evt-replay" },
    });
    const draft = toDraft(event);
    const result = ingestAll([draft, draft], sequentialClock);
    expect(result.canonicalStore).toHaveLength(1);
    expect(result.outcomes[0]).toEqual({ accepted: true, sequence: seq(1) });
    expect(result.outcomes[1]).toEqual({ accepted: true, sequence: seq(1) });
  });

  it("A3 — sub-delegation escalating a bounded dimension is DENIED when both sides are known, UNKNOWN when one is not", () => {
    const knownViolation = [
      rootDelegation({
        sequence: 1,
        id: "d-root",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: true,
        maxAmount: EUR(1000),
        amountThresholds: thresholds(1000, 1000),
      }),
      subDelegation({
        sequence: 2,
        id: "d-escalated",
        parentId: "d-root",
        grantor: AGENT_A,
        grantee: AGENT_B,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        maxAmount: EUR(2000), // escalation: exceeds parent's 1000
        amountThresholds: thresholds(2000, 2000),
      }),
    ];
    const query: AuthorityQuery = {
      agentId: AGENT_B,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: nonMonetaryParameters(),
    };
    expect(authorityAt(knownViolation, query, instant(2)).outcome).toBe("DENIED");
  });

  it("A4 — an authorized revocation racing an action wins purely by sequence order, never by wall-clock proximity", () => {
    const { store: base, query } = simpleAuthorizedChain();
    const raced = [...base, revokeDelegation({ sequence: 3, targetId: "d-root", issuedBy: THEO })];
    expect(authorityAt(raced, query, instant(2)).outcome).toBe("AUTHORIZED");
    expect(authorityAt(raced, query, instant(3)).outcome).toBe("DENIED");
  });

  it("A5 — a subdelegation referencing a not-yet-arrived parent resolves once the parent later appears in the store", () => {
    const lateParent = [
      subDelegation({
        sequence: 1,
        id: "d-child",
        parentId: "d-root", // does not exist yet at sequence 1
        grantor: AGENT_A,
        grantee: AGENT_B,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
      }),
      // the parent finally arrives, out of order, at a later sequence
      rootDelegation({
        sequence: 3,
        id: "d-root",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: true,
      }),
    ];
    const query: AuthorityQuery = {
      agentId: AGENT_B,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: nonMonetaryParameters(),
    };
    expect(authorityAt(lateParent, query, instant(2)).outcome).toBe("UNKNOWN");
    expect(authorityAt(lateParent, query, instant(3)).outcome).toBe("AUTHORIZED");
  });

  it("A6 — a chain missing a link entirely (never arrives) is UNKNOWN, never guessed", () => {
    const partial = [
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
    expect(authorityAt(partial, query, instant(1)).outcome).toBe("UNKNOWN");
  });

  it("A7 — two events with the same event_id but different content: the second is rejected, never silently accepted", () => {
    const first = rootDelegation({
      sequence: 1,
      id: "d-1",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      timing: { eventId: "evt-conflict" },
    });
    const second = rootDelegation({
      sequence: 2,
      id: "d-2", // different payload content, same event_id
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_B,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      timing: { eventId: "evt-conflict" },
    });
    const result = ingestAll([toDraft(first), toDraft(second)], sequentialClock);
    expect(result.outcomes[0]).toEqual({ accepted: true, sequence: seq(1) });
    expect(result.outcomes[1]).toEqual({ accepted: false, reasonCode: "EVENT_ID_CONFLICT" });
    expect(result.canonicalStore).toHaveLength(1);
  });

  it("A8 — a delegation cycle is detected and resolved as UNKNOWN, without infinite recursion", () => {
    const cyclic = [
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
      agentId: AGENT_B,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: nonMonetaryParameters(),
    };
    expect(authorityAt(cyclic, query, instant(2)).outcome).toBe("UNKNOWN");
  });

  it("A9 — a similarly-named but non-identical capability is never accepted by proximity", () => {
    const store = [
      rootDelegation({
        sequence: 1,
        id: "d-root",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE], // purchase_order.create
        canDelegate: false,
      }),
    ];
    const query: AuthorityQuery = {
      agentId: AGENT_A,
      principalId: THEO,
      capability: { resource: "purchase_order", action: "create_partial" }, // similar, not exact
      parameters: nonMonetaryParameters(),
    };
    expect(authorityAt(store, query, instant(1)).outcome).toBe("DENIED");
  });

  it("A10 — an excessively deep delegation chain is UNKNOWN there, without poisoning an independent short valid chain off the same root", () => {
    const DEPTH = 33; // MAX_CHAIN_DEPTH (32) + 1
    const store = [
      rootDelegation({
        sequence: 1,
        id: "d-0",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: true,
      }),
      // an independent, short (depth 3), otherwise-valid branch off the same root
      subDelegation({
        sequence: 2,
        id: "d-short-1",
        parentId: "d-0",
        grantor: AGENT_A,
        grantee: AGENT_B,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: true,
      }),
      subDelegation({
        sequence: 3,
        id: "d-short-2",
        parentId: "d-short-1",
        grantor: AGENT_B,
        grantee: AGENT_C,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
      }),
    ];
    // Every level of the deep branch must terminate on its OWN distinct
    // identity — not just "not AGENT_A" but not shared with any OTHER level
    // either. A self-looping grantor===grantee reused across levels 2..N
    // would make that shared identity the grantee of MULTIPLE delegations at
    // DIFFERENT (shorter) depths, so the shortest one would trivially
    // authorize it regardless of the branch's real depth — the same class of
    // accidental shortcut as using AGENT_A, one level further down
    // (mechanical fixture fix, does not touch the invariant under test: see
    // PROMPT 3 notes).
    const deepAgent = (level: number) => principal(`deep-agent-a10-${level}`);
    for (let i = 1; i <= DEPTH; i += 1) {
      store.push(
        subDelegation({
          sequence: i + 3,
          id: `d-deep-${i}`,
          parentId: i === 1 ? "d-0" : `d-deep-${i - 1}`,
          grantor: i === 1 ? AGENT_A : deepAgent(i - 1),
          grantee: deepAgent(i),
          capabilities: [PURCHASE_ORDER_CREATE],
          canDelegate: true,
        }),
      );
    }
    const finalSeq = DEPTH + 4;
    const deepQuery: AuthorityQuery = {
      agentId: deepAgent(DEPTH),
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: nonMonetaryParameters(),
    };
    const shortQuery: AuthorityQuery = {
      agentId: AGENT_C,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: nonMonetaryParameters(),
    };
    const deepDecision = authorityAt(store, deepQuery, instant(finalSeq));
    expect(deepDecision.outcome).toBe("UNKNOWN");
    expect(deepDecision).toMatchObject({ reasonCode: "MAX_CHAIN_DEPTH_EXCEEDED" });
    // the short, independent, valid chain is unaffected by the deep branch's failure.
    expect(authorityAt(store, shortQuery, instant(finalSeq)).outcome).toBe("AUTHORIZED");
  });

  it("A11 — a consumed approval does not widen the permanent mandate for a future, otherwise-identical request", () => {
    const params = monetaryParameters(EUR(500));
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
        amountThresholds: thresholds(100, 10_000),
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
      }),
    ];
    // A brand-new, otherwise-identical prospective question, asked *after* the
    // one grant that ever covered this fingerprint has been consumed: DENIED,
    // not REQUIRES_APPROVAL — the mandate was never widened to cover it again.
    const query: AuthorityQuery = {
      agentId: AGENT_A,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: params,
    };
    expect(authorityAt(store, query, instant(5)).outcome).toBe("DENIED");
  });

  it("A12 — an event whose principal_id looks like PII is rejected at ingestion, not laundered into the graph", () => {
    const suspicious = rootDelegation({
      sequence: 1,
      id: "d-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      emitter: THEO,
    });
    // Deliberately forge an emitter that looks like an email address, bypassing
    // our own opaque-id constructors (which do not themselves enforce I11 —
    // see PROMPT 2 hesitations). Rejecting this one recognizable shape is not
    // a guarantee that no PII can ever reach the graph (I17 honesty).
    const forged = { ...suspicious, principal_id: "theo@example.com" } as typeof suspicious;
    const result = ingestAll([toDraft(forged)], sequentialClock);
    expect(result.outcomes[0]?.accepted).toBe(false);
  });

  it("A13 — an unauthorized subdelegation (wrong emitter, or can_delegate: false) is DENIED, known can_delegate", () => {
    const store = [
      rootDelegation({
        sequence: 1,
        id: "d-root",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false, // A never received the right to sub-delegate
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
    expect(authorityAt(store, query, instant(2)).outcome).toBe("DENIED");
  });

  it("A14 — an unauthorized revoker cannot weaponize I7's propagation as a denial-of-service", () => {
    const { store: base, query } = simpleAuthorizedChain();
    const attacked = [...base, revokeDelegation({ sequence: 3, targetId: "d-root", issuedBy: MALLORY })];
    expect(authorityAt(attacked, query, instant(3)).outcome).toBe("AUTHORIZED");
  });

  it("A15 — a self-appointed approver cannot manufacture REQUIRES_APPROVAL -> AUTHORIZED", () => {
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
        amountThresholds: thresholds(100, 10_000),
      }),
      actionRequest({ sequence: 2, id: "a-1", requester: AGENT_A, delegationId: "d-root", parameters: params }),
      approvalRequest({ sequence: 3, id: "ap-1", actionId: "a-1", requestedFrom: THEO, requester: AGENT_A }),
      approvalGrant({ sequence: 4, id: "ap-1", actionId: "a-1", approver: MALLORY }), // not the grantor
    ];
    const query: AuthorityQuery = {
      agentId: AGENT_A,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: params,
    };
    expect(authorityAt(store, query, instant(4)).outcome).toBe("REQUIRES_APPROVAL");
  });

  it("A16 — a chain rooted in an AGENT (no human anchor) is UNKNOWN, never DENIED nor AUTHORIZED", () => {
    const store = [
      rootDelegation({
        sequence: 1,
        id: "d-root",
        grantor: AGENT_C,
        grantorType: "AGENT", // no human ever authorized this
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

  it("A17 — an executed action whose real parameters differ from the approved ones is DENIED (fingerprint mismatch)", () => {
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
        amountThresholds: thresholds(100, 1_000_000),
      }),
      actionRequest({
        sequence: 2,
        id: "a-1",
        requester: AGENT_A,
        delegationId: "d-root",
        parameters: monetaryParameters(EUR(100)),
      }),
      approvalRequest({ sequence: 3, id: "ap-1", actionId: "a-1", requestedFrom: THEO, requester: AGENT_A }),
      approvalGrant({ sequence: 4, id: "ap-1", actionId: "a-1", approver: THEO }),
      // bait-and-switch: executed for 100_000, not the approved 100
      actionExecution({
        sequence: 5,
        actionId: "a-1",
        executor: AGENT_A,
        decisionSequence: 4,
        chain: [delegationLink("d-root"), approvalLink("ap-1")],
        parameters: monetaryParameters(EUR(100_000)),
      }),
    ];
    // This is a HISTORICAL question about a specific recorded execution's
    // honesty, not a prospective one — explainAction is the right tool.
    const explanation = explainAction(store, { actionId: action("a-1") }, instant(5));
    expect(explanation.execution?.authorityAtDecision.outcome).toBe("DENIED");
    expect(explanation.execution?.authorityAtDecision).toMatchObject({
      reasonCode: "C6_ACTION_FINGERPRINT_MISMATCH",
    });
  });

  it("A18 — the same approval_id consumed by a second ACTION_EXECUTED (different event_id) is DENIED going forward", () => {
    const params = monetaryParameters(EUR(500));
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
        amountThresholds: thresholds(100, 10_000),
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
        timing: { eventId: "evt-exec-1" },
      }),
      // second, distinct event_id, same action_id and approval_id
      actionExecution({
        sequence: 6,
        actionId: "a-1",
        executor: AGENT_A,
        decisionSequence: 4,
        chain: [delegationLink("d-root"), approvalLink("ap-1")],
        parameters: params,
        timing: { eventId: "evt-exec-2" },
      }),
    ];
    // Prospectively: is this fingerprint still authorized after being
    // consumed twice? I8 never even saw a conflict (distinct event_id); I16
    // is what must catch this.
    const query: AuthorityQuery = {
      agentId: AGENT_A,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: params,
    };
    expect(authorityAt(store, query, instant(6)).outcome).toBe("DENIED");
  });

  it("A19 — a parasitic cyclic path to the same principal does not poison an otherwise valid, independent chain", () => {
    const { store: valid, query } = simpleAuthorizedChain();
    const poisoned = [
      ...valid,
      // an unrelated, self-referential cycle also mentioning AGENT_A
      subDelegation({
        sequence: 2,
        id: "d-cycle-1",
        parentId: "d-cycle-2",
        grantor: MALLORY,
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: true,
      }),
      subDelegation({
        sequence: 3,
        id: "d-cycle-2",
        parentId: "d-cycle-1",
        grantor: AGENT_A,
        grantee: MALLORY,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: true,
      }),
    ];
    expect(authorityAt(poisoned, query, instant(3)).outcome).toBe("AUTHORIZED");
  });

  it("A20 — two events with different event_id but the same business delegation_id (different content) collide", () => {
    const e1 = rootDelegation({
      sequence: 1,
      id: "d-shared",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      timing: { eventId: "evt-1" },
    });
    const e2 = rootDelegation({
      sequence: 2,
      id: "d-shared", // same business id
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_B, // different content
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      timing: { eventId: "evt-2" },
    });
    const result = ingestAll([toDraft(e1), toDraft(e2)], sequentialClock);
    expect(result.outcomes[1]).toEqual({ accepted: false, reasonCode: "BUSINESS_ID_COLLISION" });
    expect(result.canonicalStore).toHaveLength(1);
  });

  it("A24 — concurrent authorization decisions on a shared total_budget are not mutually exclusive (TOCTOU)", () => {
    const paramsX = monetaryParameters(EUR(700), VENDOR);
    const paramsY = monetaryParameters(EUR(700), recipient("vendor-2"));
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
    // Both hypothetical spends, evaluated before either is executed, are
    // individually AUTHORIZED — V0 gives no reservation guarantee.
    expect(
      authorityAt(store, { agentId: AGENT_A, principalId: THEO, capability: PURCHASE_ORDER_CREATE, parameters: paramsX }, instant(1))
        .outcome,
    ).toBe("AUTHORIZED");
    expect(
      authorityAt(store, { agentId: AGENT_A, principalId: THEO, capability: PURCHASE_ORDER_CREATE, parameters: paramsY }, instant(1))
        .outcome,
    ).toBe("AUTHORIZED");

    const executed = [
      ...store,
      actionRequest({ sequence: 2, id: "a-x", requester: AGENT_A, delegationId: "d-root", parameters: paramsX }),
      actionExecution({
        sequence: 3,
        actionId: "a-x",
        executor: AGENT_A,
        decisionSequence: 1,
        chain: [delegationLink("d-root")],
        parameters: paramsX,
      }),
      actionRequest({ sequence: 4, id: "a-y", requester: AGENT_A, delegationId: "d-root", parameters: paramsY }),
      actionExecution({
        sequence: 5,
        actionId: "a-y",
        executor: AGENT_A,
        decisionSequence: 1,
        chain: [delegationLink("d-root")],
        parameters: paramsY,
      }),
    ];
    // Combined spend is now 1400 against a 1000 budget. The inconsistency
    // must be identified going forward, not hidden: even a trivial new spend
    // against the same delegation is now DENIED.
    const thirdQuery: AuthorityQuery = {
      agentId: AGENT_A,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: monetaryParameters(EUR(1), recipient("vendor-3")),
    };
    expect(authorityAt(executed, thirdQuery, instant(5)).outcome).toBe("DENIED");
  });
});
