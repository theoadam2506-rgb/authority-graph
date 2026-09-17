/**
 * PROMPT 3b, point 4: the I12/I13/I14 ingestion-time boundaries
 * (`ingestionAuthorityFailure` in src/engine/ingest.ts) were implemented in
 * PROMPT 3 but exercised by nothing — the resolver (validateChain)
 * revalidates everything independently at resolution time, so there was no
 * exploitable gap, but the "rejected at ingestion" half of the architectural
 * promise (SPEC.md, "Séparation store canonique / journal de sécurité") had
 * zero test coverage. This file closes that gap.
 *
 * Cross-cutting property asserted throughout: a rejected draft never
 * acquires a canonical sequence — `IngestOutcome`'s rejected variant has no
 * `sequence` field at all (checked here at the value level, not just the
 * type level), and the canonical store never grows for it.
 */
import { describe, expect, it } from "vitest";
import { ingestAll } from "../../src/engine/authority.js";
import { monetaryParameters, sequenceNumber, thresholds } from "../../src/domain/types.js";
import { toDraft } from "../../src/domain/events.js";
import {
  AGENT_A,
  AGENT_B,
  EUR,
  MALLORY,
  PURCHASE_ORDER_CREATE,
  THEO,
  actionRequest,
  approvalDeny,
  approvalGrant,
  approvalRequest,
  revokeDelegation,
  rootDelegation,
  sequentialClock,
  subDelegation,
} from "../fixtures/scenarios.js";

const seq = sequenceNumber;

describe("Ingestion boundaries — I12/I13/I14 (PROMPT 3b)", () => {
  describe("I12 — right to sub-delegate", () => {
    it("Root -> A (can_delegate: false), then A -> B, is rejected at ingestion", () => {
      const root = rootDelegation({
        sequence: 1,
        id: "d-root-i12-a",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
      });
      const sub = subDelegation({
        sequence: 2,
        id: "d-sub-i12-a",
        parentId: "d-root-i12-a",
        grantor: AGENT_A,
        grantee: AGENT_B,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
      });
      const result = ingestAll([toDraft(root), toDraft(sub)], sequentialClock);
      expect(result.outcomes[0]).toEqual({ accepted: true, sequence: seq(1) });
      expect(result.outcomes[1]).toEqual({ accepted: false, reasonCode: "UNAUTHORIZED_SUBDELEGATION" });
      expect(result.outcomes[1] && "sequence" in result.outcomes[1]).toBe(false);
      expect(result.canonicalStore).toHaveLength(1);
    });

    it("Root -> A (can_delegate: true), then A -> B, is accepted when I5 holds", () => {
      const root = rootDelegation({
        sequence: 1,
        id: "d-root-i12-b",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: true,
        maxAmount: EUR(1000),
      });
      const sub = subDelegation({
        sequence: 2,
        id: "d-sub-i12-b",
        parentId: "d-root-i12-b",
        grantor: AGENT_A,
        grantee: AGENT_B,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        maxAmount: EUR(500), // <= parent's 1000: I5 holds
      });
      const result = ingestAll([toDraft(root), toDraft(sub)], sequentialClock);
      expect(result.outcomes[1]).toEqual({ accepted: true, sequence: seq(2) });
      expect(result.canonicalStore).toHaveLength(2);
    });

    it("Mallory referencing a real Root -> A delegation, attempting Mallory -> B with perfectly restrictive constraints, is rejected on I12 alone", () => {
      const root = rootDelegation({
        sequence: 1,
        id: "d-root-i12-c",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: true,
        maxAmount: EUR(1000),
      });
      // I5 is trivially satisfied (1 <= 1000): the only thing wrong here is
      // that Mallory is not A, the parent's actual grantee.
      const forged = subDelegation({
        sequence: 2,
        id: "d-forged-i12-c",
        parentId: "d-root-i12-c",
        grantor: MALLORY,
        grantee: AGENT_B,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        maxAmount: EUR(1),
        emitter: MALLORY,
      });
      const result = ingestAll([toDraft(root), toDraft(forged)], sequentialClock);
      expect(result.outcomes[1]).toEqual({ accepted: false, reasonCode: "UNAUTHORIZED_SUBDELEGATION" });
      expect(result.canonicalStore).toHaveLength(1);
    });
  });

  describe("I13 — right to revoke", () => {
    it("Root -> A; Mallory's DELEGATION_REVOKED(A) never revokes A", () => {
      const root = rootDelegation({
        sequence: 1,
        id: "d-root-i13-a",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
      });
      const badRevoke = revokeDelegation({ sequence: 2, targetId: "d-root-i13-a", issuedBy: MALLORY });
      const result = ingestAll([toDraft(root), toDraft(badRevoke)], sequentialClock);
      expect(result.outcomes[1]).toEqual({ accepted: false, reasonCode: "UNAUTHORIZED_REVOCATION" });
      expect(result.canonicalStore).toHaveLength(1);
    });

    it("The legitimate grantor's revocation is accepted", () => {
      const root = rootDelegation({
        sequence: 1,
        id: "d-root-i13-b",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
      });
      const goodRevoke = revokeDelegation({ sequence: 2, targetId: "d-root-i13-b", issuedBy: THEO });
      const result = ingestAll([toDraft(root), toDraft(goodRevoke)], sequentialClock);
      expect(result.outcomes[1]).toEqual({ accepted: true, sequence: seq(2) });
      expect(result.canonicalStore).toHaveLength(2);
    });

    it("The chain root's grantor may also revoke a descendant sub-delegation (SPEC.md grants it this right too)", () => {
      const root = rootDelegation({
        sequence: 1,
        id: "d-root-i13-c",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: true,
      });
      const sub = subDelegation({
        sequence: 2,
        id: "d-sub-i13-c",
        parentId: "d-root-i13-c",
        grantor: AGENT_A,
        grantee: AGENT_B,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
      });
      // THEO is not d-sub-i13-c's direct grantor (A is) but is the chain root.
      const revokeByRoot = revokeDelegation({ sequence: 3, targetId: "d-sub-i13-c", issuedBy: THEO });
      const result = ingestAll([toDraft(root), toDraft(sub), toDraft(revokeByRoot)], sequentialClock);
      expect(result.outcomes[2]).toEqual({ accepted: true, sequence: seq(3) });
      expect(result.canonicalStore).toHaveLength(3);
    });
  });

  describe("I14 — right to decide an approval", () => {
    function baseline() {
      const root = rootDelegation({
        sequence: 1,
        id: "d-root-i14",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT_A,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        maxAmount: EUR(10_000),
        amountThresholds: thresholds(1000, 10_000),
      });
      const request = actionRequest({
        sequence: 2,
        id: "a-i14",
        requester: AGENT_A,
        delegationId: "d-root-i14",
        parameters: monetaryParameters(EUR(5000)),
      });
      const approvalRequested = approvalRequest({
        sequence: 3,
        id: "ap-i14",
        actionId: "a-i14",
        requestedFrom: THEO,
        requester: AGENT_A,
      });
      return [root, request, approvalRequested] as const;
    }

    it("Mallory's APPROVAL_GRANTED is rejected; the habilitated grantor's is accepted", () => {
      const [root, request, approvalRequested] = baseline();

      const badGrant = approvalGrant({ sequence: 4, id: "ap-i14", actionId: "a-i14", approver: MALLORY });
      const rejected = ingestAll([toDraft(root), toDraft(request), toDraft(approvalRequested), toDraft(badGrant)], sequentialClock);
      expect(rejected.outcomes[3]).toEqual({ accepted: false, reasonCode: "UNAUTHORIZED_APPROVAL_DECISION" });
      expect(rejected.canonicalStore).toHaveLength(3);

      const goodGrant = approvalGrant({ sequence: 4, id: "ap-i14", actionId: "a-i14", approver: THEO });
      const accepted = ingestAll([toDraft(root), toDraft(request), toDraft(approvalRequested), toDraft(goodGrant)], sequentialClock);
      expect(accepted.outcomes[3]).toEqual({ accepted: true, sequence: seq(4) });
      expect(accepted.canonicalStore).toHaveLength(4);
    });

    it("symmetrically for APPROVAL_DENIED: Mallory's is rejected, the habilitated grantor's is accepted", () => {
      const [root, request, approvalRequested] = baseline();

      const badDeny = approvalDeny({ sequence: 4, id: "ap-i14", actionId: "a-i14", denier: MALLORY });
      const rejected = ingestAll([toDraft(root), toDraft(request), toDraft(approvalRequested), toDraft(badDeny)], sequentialClock);
      expect(rejected.outcomes[3]).toEqual({ accepted: false, reasonCode: "UNAUTHORIZED_APPROVAL_DECISION" });
      expect(rejected.canonicalStore).toHaveLength(3);

      const goodDeny = approvalDeny({ sequence: 4, id: "ap-i14", actionId: "a-i14", denier: THEO });
      const accepted = ingestAll([toDraft(root), toDraft(request), toDraft(approvalRequested), toDraft(goodDeny)], sequentialClock);
      expect(accepted.outcomes[3]).toEqual({ accepted: true, sequence: seq(4) });
      expect(accepted.canonicalStore).toHaveLength(4);
    });
  });

  it("cross-cutting property: a rejected draft never acquires a canonical sequence, across every rejection kind above", () => {
    const root = rootDelegation({
      sequence: 1,
      id: "d-root-transverse",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
    });
    const unauthorizedSub = subDelegation({
      sequence: 2,
      id: "d-sub-transverse",
      parentId: "d-root-transverse",
      grantor: AGENT_A,
      grantee: AGENT_B,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
    });
    const unauthorizedRevoke = revokeDelegation({ sequence: 3, targetId: "d-root-transverse", issuedBy: MALLORY });

    const result = ingestAll([toDraft(root), toDraft(unauthorizedSub), toDraft(unauthorizedRevoke)], sequentialClock);

    expect(result.canonicalStore).toHaveLength(1); // only the root
    for (const outcome of result.outcomes) {
      if (!outcome.accepted) {
        expect("sequence" in outcome).toBe(false);
      }
    }
    expect(result.outcomes.filter((o) => !o.accepted)).toHaveLength(2);
  });
});
