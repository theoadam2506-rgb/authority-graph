/**
 * Shared scenario for the I6 "approval bound to the action instance" vector.
 * Used by tests/vectors/i6-approval-instance-binding.test.ts, the in-memory
 * issuance test (tests/engine/issueCapability.test.ts) and the PostgreSQL
 * issuance test, so all three surfaces judge the very same event journal.
 *
 * One delegation D1 requires approval in the [100, 1000] EUR band. A1 and A2
 * share capability, parameters (hence fingerprint), requester and invoked
 * delegation; only `action_id` differs. P1 is requested and granted for A1
 * only. `action_id` never appears in `action.parameters`.
 *
 *  1 DELEGATION_CREATED   D1
 *  2 ACTION_REQUESTED     A1 (invokes D1)
 *  3 ACTION_REQUESTED     A2 (invokes D1)
 *  4 APPROVAL_REQUESTED   P1 for A1
 *  5 APPROVAL_GRANTED     P1 for A1
 *  6 ACTION_EXECUTED      forged for A2, citing [D1, P1]
 *  7 APPROVAL_REQUESTED   P2 for A2
 *  8 APPROVAL_GRANTED     P2 for A2
 */
import { monetaryParameters, thresholds } from "../../src/domain/types.js";
import type { AuthorityEvent } from "../../src/domain/events.js";
import { AGENT_A, EUR, PURCHASE_ORDER_CREATE, THEO, actionExecution, actionRequest, approvalGrant, approvalLink, approvalRequest, delegationLink, rootDelegation } from "./scenarios.js";

export const I6_AGENT = AGENT_A;
export const I6_PARAMETERS = monetaryParameters(EUR(500));

export const i6Events: readonly AuthorityEvent[] = [
  rootDelegation({ sequence: 1, id: "D1", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: I6_AGENT, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, amountThresholds: thresholds(EUR(100), EUR(1_000)) }),
  actionRequest({ sequence: 2, id: "A1", requester: I6_AGENT, delegationId: "D1", parameters: I6_PARAMETERS }),
  actionRequest({ sequence: 3, id: "A2", requester: I6_AGENT, delegationId: "D1", parameters: I6_PARAMETERS }),
  approvalRequest({ sequence: 4, id: "P1", actionId: "A1", requestedFrom: THEO, requester: I6_AGENT }),
  approvalGrant({ sequence: 5, id: "P1", actionId: "A1", approver: THEO }),
  actionExecution({ sequence: 6, actionId: "A2", executor: I6_AGENT, decisionSequence: 5, capability: PURCHASE_ORDER_CREATE, parameters: I6_PARAMETERS, chain: [delegationLink("D1"), approvalLink("P1")] }),
  approvalRequest({ sequence: 7, id: "P2", actionId: "A2", requestedFrom: THEO, requester: I6_AGENT }),
  approvalGrant({ sequence: 8, id: "P2", actionId: "A2", approver: THEO }),
];

/** Events 1..n of the journal. */
export const i6Through = (sequence: number): AuthorityEvent[] => i6Events.slice(0, sequence);
