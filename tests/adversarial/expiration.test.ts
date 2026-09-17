/**
 * PROMPT 3b, point 5: the expiration boundary itself (I4's clock, as opposed
 * to its causal order) had zero test coverage before this file — no test in
 * this suite ever built a delegation with a finite `expires_at`. These tests
 * exercise the exact convention documented in SPEC.md I4:
 *
 *   authorityTime <  expires_at  -> still valid
 *   authorityTime >= expires_at  -> expired (the boundary itself is expired)
 *
 * and specifically demonstrate why `max(authority_time of visible events)`
 * (PROMPT 3's approach) is not an acceptable definition of "now": time can
 * pass with no new event at all, so the *caller* must supply the trusted
 * current instant explicitly (`authorityAt`'s `AuthorityInstant`).
 */
import { describe, expect, it } from "vitest";
import { authorityAt, ingestAll } from "../../src/engine/authority.js";
import { toDraft } from "../../src/domain/events.js";
import {
  expiresAt,
  iso8601,
  monetaryParameters,
  nonMonetaryParameters,
  sequenceNumber,
  thresholds,
  type AuthorityQuery,
} from "../../src/domain/types.js";
import {
  AGENT_A,
  AGENT_B,
  EUR,
  PURCHASE_ORDER_CREATE,
  THEO,
  actionRequest,
  approvalGrant,
  approvalRequest,
  rootDelegation,
  subDelegation,
} from "../fixtures/scenarios.js";

const seq = sequenceNumber;

describe("Expiration boundary (PROMPT 3b)", () => {
  it("boundary: authorityTime == expires_at is expired (exclusive convention)", () => {
    const EXPIRES = "2025-06-01T14:00:00.000Z";
    const store = [
      rootDelegation({
        sequence: 1,
        id: "d-boundary",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        expires: expiresAt(iso8601(EXPIRES)),
      }),
    ];
    const query: AuthorityQuery = {
      agentId: AGENT_A,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: nonMonetaryParameters(),
    };
    const decision = authorityAt(store, query, { atSequence: seq(1), authorityTime: iso8601(EXPIRES) });
    expect(decision.outcome).toBe("DENIED");
  });

  it("time passing with no new event: same atSequence, same graph, two authorityTime values — AUTHORIZED before, DENIED after", () => {
    const EXPIRES = "2025-06-01T14:00:00.000Z";
    const store = [
      rootDelegation({
        sequence: 1,
        id: "d-time-passes",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        expires: expiresAt(iso8601(EXPIRES)),
      }),
    ];
    const query: AuthorityQuery = {
      agentId: AGENT_A,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: nonMonetaryParameters(),
    };
    // Same store, same atSequence — only the trusted "now" differs. No event
    // was logged between these two instants; max(event.authority_time) over
    // this unchanged graph would be identical for both queries and would
    // therefore (wrongly) keep reporting AUTHORIZED forever.
    const before = authorityAt(store, query, { atSequence: seq(1), authorityTime: iso8601("2025-06-01T13:59:59.000Z") });
    const after = authorityAt(store, query, { atSequence: seq(1), authorityTime: iso8601("2025-06-01T14:00:01.000Z") });
    expect(before.outcome).toBe("AUTHORIZED");
    expect(after.outcome).toBe("DENIED");
  });

  it("hostile occurred_at cannot restore AUTHORIZED after expiry: only occurred_at differs, the decision is identical", () => {
    const EXPIRES = "2025-06-01T14:00:00.000Z";
    const fixedTrustedTime = iso8601("2025-06-01T15:00:00.000Z"); // the admission layer's own reading, regardless of occurred_at
    const fixedClock = { authorityTime: () => fixedTrustedTime };

    function ingestWithOccurredAt(occurredAt: string) {
      const draft = toDraft(
        rootDelegation({
          sequence: 1,
          id: "d-hostile-occurred-at",
          grantor: THEO,
          grantorType: "HUMAN_ROOT",
          grantee: AGENT_A,
          capabilities: [PURCHASE_ORDER_CREATE],
          canDelegate: false,
          expires: expiresAt(iso8601(EXPIRES)),
          timing: { occurredAt },
        }),
      );
      return ingestAll([draft], fixedClock);
    }

    // Honest: claims to have occurred shortly before expiry.
    const honest = ingestWithOccurredAt("2025-06-01T13:00:00.000Z");
    // Hostile: claims to have occurred long before expiry (backdated further),
    // hoping to look "more clearly valid at the time" than the honest one.
    const hostile = ingestWithOccurredAt("2025-01-01T09:00:00.000Z");

    expect(honest.outcomes[0]).toEqual({ accepted: true, sequence: seq(1) });
    expect(hostile.outcomes[0]).toEqual({ accepted: true, sequence: seq(1) });

    const query: AuthorityQuery = {
      agentId: AGENT_A,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: nonMonetaryParameters(),
    };
    const at = { atSequence: seq(1), authorityTime: iso8601("2025-06-01T15:30:00.000Z") };
    const honestDecision = authorityAt(honest.canonicalStore, query, at);
    const hostileDecision = authorityAt(hostile.canonicalStore, query, at);

    expect(honestDecision.outcome).toBe("DENIED");
    // Varying occurred_at alone never changes the decision.
    expect(hostileDecision).toEqual(honestDecision);
  });

  it("sub-delegation expiry: child claiming a later expiry than its parent is an I5 violation; an earlier one is valid but expires on its own", () => {
    const PARENT_EXPIRES = "2025-06-01T14:00:00.000Z";
    const CHILD_LATER = "2025-06-01T15:00:00.000Z";
    const CHILD_EARLIER = "2025-06-01T13:00:00.000Z";

    const storeWideningChild = [
      rootDelegation({
        sequence: 1,
        id: "d-parent-widening",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: true,
        expires: expiresAt(iso8601(PARENT_EXPIRES)),
      }),
      subDelegation({
        sequence: 2,
        id: "d-child-widening",
        parentId: "d-parent-widening",
        grantor: AGENT_A,
        grantee: AGENT_B,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        expires: expiresAt(iso8601(CHILD_LATER)), // later than the parent: I5 violation
      }),
    ];
    const wideningQuery: AuthorityQuery = {
      agentId: AGENT_B,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: nonMonetaryParameters(),
    };
    // Structural I5 violation — DENIED regardless of what time it is.
    expect(
      authorityAt(storeWideningChild, wideningQuery, { atSequence: seq(2), authorityTime: iso8601("2025-06-01T12:00:00.000Z") }).outcome,
    ).toBe("DENIED");

    const storeValidChild = [
      rootDelegation({
        sequence: 1,
        id: "d-parent-valid",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: true,
        expires: expiresAt(iso8601(PARENT_EXPIRES)),
      }),
      subDelegation({
        sequence: 2,
        id: "d-child-valid",
        parentId: "d-parent-valid",
        grantor: AGENT_A,
        grantee: AGENT_B,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        expires: expiresAt(iso8601(CHILD_EARLIER)), // earlier than the parent: I5 holds
      }),
    ];
    const validQuery: AuthorityQuery = {
      agentId: AGENT_B,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: nonMonetaryParameters(),
    };
    // Well before either expiry: AUTHORIZED.
    expect(
      authorityAt(storeValidChild, validQuery, { atSequence: seq(2), authorityTime: iso8601("2025-06-01T12:00:00.000Z") }).outcome,
    ).toBe("AUTHORIZED");
    // At 13:30, the CHILD (13:00) has expired even though the PARENT (14:00) has not.
    expect(
      authorityAt(storeValidChild, validQuery, { atSequence: seq(2), authorityTime: iso8601("2025-06-01T13:30:00.000Z") }).outcome,
    ).toBe("DENIED");
  });

  it("approval path is gated by the delegation's own expiry, independently of the delegation-expiry tests above", () => {
    const EXPIRES = "2025-06-01T14:00:00.000Z";
    const params = monetaryParameters(EUR(5000));
    const store = [
      rootDelegation({
        sequence: 1,
        id: "d-root-approval-expiry",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        expires: expiresAt(iso8601(EXPIRES)),
        maxAmount: EUR(10_000),
        amountThresholds: thresholds(1000, 10_000),
      }),
      actionRequest({ sequence: 2, id: "a-approval-expiry", requester: AGENT_A, delegationId: "d-root-approval-expiry", parameters: params }),
      approvalRequest({ sequence: 3, id: "ap-approval-expiry", actionId: "a-approval-expiry", requestedFrom: THEO, requester: AGENT_A }),
      approvalGrant({ sequence: 4, id: "ap-approval-expiry", actionId: "a-approval-expiry", approver: THEO }),
    ];
    const query: AuthorityQuery = {
      agentId: AGENT_A,
      principalId: THEO,
      capability: PURCHASE_ORDER_CREATE,
      parameters: params,
    };
    // Before expiry, the unconsumed grant authorizes it.
    expect(
      authorityAt(store, query, { atSequence: seq(4), authorityTime: iso8601("2025-06-01T13:59:00.000Z") }).outcome,
    ).toBe("AUTHORIZED");
    // At 14:01, the SAME unconsumed grant no longer helps: the delegation
    // backing it has itself expired.
    expect(
      authorityAt(store, query, { atSequence: seq(4), authorityTime: iso8601("2025-06-01T14:01:00.000Z") }).outcome,
    ).toBe("DENIED");
  });
});
