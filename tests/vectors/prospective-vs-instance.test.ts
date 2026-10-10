/**
 * Reproduction vector: prospective authority is not execution authority.
 *
 * Three questions are asked of one and the same ordered event history:
 *
 * - prospective authority (`authorityAt`, and `currentAuthority` of
 *   `explainAction`): is there, for this agent, this capability and these
 *   parameters, a compatible delegation and a valid, unconsumed approval?
 *   Nothing here names an action instance or the delegation it invokes.
 * - instance-bound authority (`invokedAuthorityNow` of `explainAction`): is
 *   this exact action_id, under the delegation it actually invoked, covered?
 * - recorded validation (`execution.recordedValidation` of `explainAction`):
 *   was a recorded execution covered at its own decision point, judged
 *   against its own recorded citations?
 *
 * Cast: one human principal, one agent, two delegations.
 * - G1 covers supplier-api/quote.read only.
 * - G2 covers supplier-api/order.create, automatic up to 500 EUR, with an
 *   approval band up to 2 500 EUR.
 * Actions: A1 reads under G1. A2 creates an order of 1 800 EUR under G2 and
 * is covered by approval P1. A3 repeats A2's capability, parameters, agent
 * and delegation under a distinct action_id. A4 is an order creation that
 * invokes G1.
 *
 * Only outcomes (AUTHORIZED, REQUIRES_APPROVAL, DENIED) and the delegation /
 * approval references that are part of an outcome are asserted. Reason codes
 * are deliberately not asserted.
 */
import { describe, expect, it } from "vitest";
import { authorityAt, explainAction, ingestAll } from "../../src/engine/authority.js";
import { toDraft, type AuthorityEvent, type CanonicalStore } from "../../src/domain/events.js";
import { capability, monetaryParameters, nonMonetaryParameters, thresholds } from "../../src/domain/types.js";
import { action, principal } from "../fixtures/ids.js";
import {
  EUR,
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
} from "../fixtures/scenarios.js";

const AGENT = principal("procurement-agent");
const QUOTE_READ = capability("supplier-api", "quote.read");
const ORDER_CREATE = capability("supplier-api", "order.create");
const ORDER_PARAMETERS = monetaryParameters(EUR(1800));

// Events 1..8: everything that exists before A2 is executed.
const beforeExecution: AuthorityEvent[] = [
  rootDelegation({ sequence: 1, id: "G1", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT, capabilities: [QUOTE_READ], canDelegate: false }),
  rootDelegation({
    sequence: 2,
    id: "G2",
    grantor: THEO,
    grantorType: "HUMAN_ROOT",
    grantee: AGENT,
    capabilities: [ORDER_CREATE],
    canDelegate: false,
    maxAmount: EUR(2500),
    amountThresholds: thresholds(EUR(500), EUR(2500)),
  }),
  actionRequest({ sequence: 3, id: "A1", requester: AGENT, delegationId: "G1", capability: QUOTE_READ, parameters: nonMonetaryParameters() }),
  actionRequest({ sequence: 4, id: "A2", requester: AGENT, delegationId: "G2", capability: ORDER_CREATE, parameters: ORDER_PARAMETERS }),
  approvalRequest({ sequence: 5, id: "P1", actionId: "A2", requestedFrom: THEO, requester: AGENT }),
  approvalGrant({ sequence: 6, id: "P1", actionId: "A2", approver: THEO }),
  actionRequest({ sequence: 7, id: "A3", requester: AGENT, delegationId: "G2", capability: ORDER_CREATE, parameters: ORDER_PARAMETERS }),
  actionRequest({ sequence: 8, id: "A4", requester: AGENT, delegationId: "G1", capability: ORDER_CREATE, parameters: ORDER_PARAMETERS }),
];

// Event 9: A2 is executed, citing the delegation it invoked and its approval.
const executeA2 = actionExecution({
  sequence: 9,
  actionId: "A2",
  executor: AGENT,
  decisionSequence: 8,
  capability: ORDER_CREATE,
  parameters: ORDER_PARAMETERS,
  chain: [delegationLink("G2"), approvalLink("P1")],
});

// Event 10: an execution is attempted for A3, citing the same references.
const attemptA3 = actionExecution({
  sequence: 10,
  actionId: "A3",
  executor: AGENT,
  decisionSequence: 9,
  capability: ORDER_CREATE,
  parameters: ORDER_PARAMETERS,
  chain: [delegationLink("G2"), approvalLink("P1")],
});

const ingest = (events: readonly AuthorityEvent[]): CanonicalStore => ingestAll(events.map(toDraft), sequentialClock).canonicalStore;

const phase1 = ingest(beforeExecution); // before A2 is executed, evaluated at sequence 8
const phase2 = ingest([...beforeExecution, executeA2]); // after A2, evaluated at sequence 9
const phase3 = ingest([...beforeExecution, executeA2, attemptA3]); // after the A3 attempt, evaluated at sequence 10

const explain = (store: CanonicalStore, actionName: string, atSequence: number) => explainAction(store, { actionId: action(actionName) }, instant(atSequence));

/** Prospective discovery for the order capability and parameters: no action_id, no invoked delegation. */
const discoverOrder = (store: CanonicalStore, atSequence: number) =>
  authorityAt(store, { agentId: AGENT, principalId: THEO, capability: ORDER_CREATE, parameters: ORDER_PARAMETERS }, instant(atSequence));

describe("prospective versus instance-bound authority", () => {
  describe("phase 1: before A2 is executed", () => {
    it("A1 is AUTHORIZED under G1, prospectively and for the instance", () => {
      const a1 = explain(phase1, "A1", 8);
      expect(a1.invokedAuthorityNow).toMatchObject({ outcome: "AUTHORIZED", chain: ["G1"] });
      expect(a1.currentAuthority).toMatchObject({ outcome: "AUTHORIZED", chain: ["G1"] });
    });

    it("A2 is AUTHORIZED under G2 with P1, prospectively and for the instance", () => {
      const a2 = explain(phase1, "A2", 8);
      expect(a2.invokedAuthorityNow).toMatchObject({ outcome: "AUTHORIZED", chain: ["G2"], approvalId: "P1" });
      expect(a2.currentAuthority).toMatchObject({ outcome: "AUTHORIZED", chain: ["G2"], approvalId: "P1" });
    });

    it("A3: prospective discovery is AUTHORIZED through G2 and P1, while the instance-bound decision is REQUIRES_APPROVAL", () => {
      const a3 = explain(phase1, "A3", 8);
      expect(a3.currentAuthority).toMatchObject({ outcome: "AUTHORIZED", chain: ["G2"], approvalId: "P1" });
      expect(discoverOrder(phase1, 8)).toMatchObject({ outcome: "AUTHORIZED", chain: ["G2"], approvalId: "P1" });
      expect(a3.invokedAuthorityNow).toMatchObject({ outcome: "REQUIRES_APPROVAL", viaDelegation: "G2" });
      expect(a3.invokedAuthorityNow).not.toHaveProperty("approvalId");
    });

    it("A4: prospective discovery, unconstrained by the invoked delegation, finds G2 and P1; the instance-bound decision under G1 is DENIED", () => {
      const a4 = explain(phase1, "A4", 8);
      expect(discoverOrder(phase1, 8)).toMatchObject({ outcome: "AUTHORIZED", chain: ["G2"], approvalId: "P1" });
      expect(a4.currentAuthority).toMatchObject({ outcome: "AUTHORIZED", chain: ["G2"], approvalId: "P1" });
      expect(a4.invokedAuthorityNow).toMatchObject({ outcome: "DENIED" });
    });
  });

  describe("phase 2: after A2 is executed", () => {
    const a2 = explain(phase2, "A2", 9);

    it("A2 stays explainable and AUTHORIZED at its own decision point, on a canonical, aligned chain, citing P1", () => {
      expect(a2.execution?.authorityAtDecision).toMatchObject({ outcome: "AUTHORIZED", chain: ["G2"], approvalId: "P1" });
      expect(a2.execution?.invokedAuthorityAtDecision).toMatchObject({ outcome: "AUTHORIZED", chain: ["G2"], approvalId: "P1" });
      expect(a2.execution?.recordedValidation).toMatchObject({ outcome: "AUTHORIZED", chain: ["G2"], approvalId: "P1" });
      expect(a2.execution?.recordedChainIntegrity).toBe("EXACT");
      expect(a2.execution?.invokedRecordedAlignment).toBe("ALIGNED");
    });

    it("P1 is consumed by A2: A2 no longer holds a usable approval, and its execution reports P1", () => {
      expect(a2.execution?.consumedApprovalId).toBe("P1");
      expect(a2.invokedAuthorityNow).toMatchObject({ outcome: "DENIED" });
    });

    it("A3 remains REQUIRES_APPROVAL for the instance and is no longer authorized prospectively", () => {
      const a3 = explain(phase2, "A3", 9);
      expect(a3.invokedAuthorityNow).toMatchObject({ outcome: "REQUIRES_APPROVAL", viaDelegation: "G2" });
      expect(a3.currentAuthority.outcome).toBe("DENIED");
      expect(discoverOrder(phase2, 9).outcome).toBe("DENIED");
    });
  });

  describe("phase 3: after an execution is attempted for A3 with the same references", () => {
    it("the attempt is not authorized: its recorded validation is REQUIRES_APPROVAL under G2", () => {
      const a3 = explain(phase3, "A3", 10);
      expect(a3.execution?.invokedAuthorityAtDecision).toMatchObject({ outcome: "REQUIRES_APPROVAL", viaDelegation: "G2" });
      expect(a3.execution?.recordedValidation).toMatchObject({ outcome: "REQUIRES_APPROVAL", viaDelegation: "G2" });
      expect(a3.invokedAuthorityNow).toMatchObject({ outcome: "REQUIRES_APPROVAL", viaDelegation: "G2" });
    });

    it("the attempt changes neither A2's authorized history nor the consumption attributed to A2", () => {
      const before = explain(phase2, "A2", 9);
      const after = explain(phase3, "A2", 10);
      expect(after.execution?.authorityAtDecision).toEqual(before.execution?.authorityAtDecision);
      expect(after.execution?.invokedAuthorityAtDecision).toEqual(before.execution?.invokedAuthorityAtDecision);
      expect(after.execution?.recordedValidation).toEqual(before.execution?.recordedValidation);
      expect(after.execution?.recordedChainIntegrity).toBe("EXACT");
      expect(after.execution?.consumedApprovalId).toBe("P1");
      expect(after.invokedAuthorityNow).toMatchObject({ outcome: "DENIED" });
    });

    it("A3 is never AUTHORIZED through P1 in any view, and discovery stays DENIED", () => {
      const a3 = explain(phase3, "A3", 10);
      for (const view of [a3.invokedAuthorityNow, a3.currentAuthority, a3.execution?.authorityAtDecision, a3.execution?.invokedAuthorityAtDecision, a3.execution?.recordedValidation]) {
        expect(view).toBeDefined();
        expect(view).not.toMatchObject({ outcome: "AUTHORIZED", approvalId: "P1" });
      }
      expect(discoverOrder(phase3, 10).outcome).toBe("DENIED");
    });
  });
});
