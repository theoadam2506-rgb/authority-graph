/**
 * The smallest commercial Authority demonstration.
 *
 * This is deliberately not an MCP server yet. It uses three MCP-shaped tool
 * actions so that P1 proves the business scenario without mixing transport
 * concerns into the deterministic engine:
 *
 * - customer.delete: automatic delegation;
 * - credit_note.issue: exact-parameter human approval;
 * - role.change: authority disappears after revocation.
 *
 * Run with `npm run demo:proof`. Every narrated claim is asserted; this is a
 * runnable acceptance scenario, not a presentation.
 */
import { computeActionFingerprint } from "../src/domain/events.js";
import {
  capability,
  expiresAt,
  iso8601,
  monetaryParameters,
  money,
  nonMonetaryParameters,
  principalId,
  recipientId,
  sequenceNumber,
  thresholds,
  type AuthorityDecision,
  type AuthorityInstant,
  type IngestOutcome,
  type SequenceNumber,
} from "../src/domain/types.js";
import { authorityAt } from "../src/engine/authority.js";
import { InMemoryEventStore } from "../src/storage/eventStore.js";
import {
  actionExecutionDraft,
  actionRequestDraft,
  approvalGrantDraft,
  approvalLink,
  approvalRequestDraft,
  delegationLink,
  revokeDelegationDraft,
  rootDelegationDraft,
} from "./fixtures.js";

const EPOCH_MS = Date.parse("2025-01-01T00:00:00.000Z");
function hour(value: number): string {
  return new Date(EPOCH_MS + value * 3_600_000).toISOString();
}

let currentHour = 0;
const store = new InMemoryEventStore(
  { authorityTime: () => iso8601(hour(currentHour)) },
  undefined,
  () => new Date(Date.parse(hour(currentHour)) + 5_000).toISOString(),
);

const THEO = principalId("theo");
const AGENT = principalId("support-agent");
const ADMIN_AGENT = principalId("admin-agent");
const CUSTOMER = recipientId("customer-42");
const CUSTOMER_DELETE = capability("customer", "delete");
const CREDIT_NOTE_ISSUE = capability("credit_note", "issue");
const ROLE_CHANGE = capability("role", "change");

function heading(value: string): void {
  console.log(`\n${"=".repeat(78)}\n${value}\n${"=".repeat(78)}`);
}

function pass(value: string): void {
  console.log(`  ✓ ${value}`);
}

function fail(value: string): never {
  throw new Error(value);
}

function accepted(outcome: IngestOutcome | undefined, label: string): SequenceNumber {
  if (outcome === undefined || !outcome.accepted) {
    fail(`${label}: expected a canonical append, got ${JSON.stringify(outcome)}`);
  }
  pass(`${label} (sequence ${outcome.sequence})`);
  return outcome.sequence;
}

function expectOutcome<O extends AuthorityDecision["outcome"]>(
  actual: AuthorityDecision,
  expected: O,
  label: string,
): Extract<AuthorityDecision, { readonly outcome: O }> {
  if (actual.outcome !== expected) {
    fail(`${label}: expected ${expected}, got ${actual.outcome}`);
  }
  pass(`${label} (${expected})`);
  return actual as Extract<AuthorityDecision, { readonly outcome: O }>;
}

async function instant(): Promise<AuthorityInstant> {
  const events = await store.getEvents();
  return { atSequence: sequenceNumber(events.length), authorityTime: iso8601(hour(currentHour)) };
}

async function main(): Promise<void> {
  heading("Authority Proof — mode observation, trois actions MCP");

  // -------------------------------------------------------------------------
  // 1. A destructive operation covered directly by a human delegation.
  // -------------------------------------------------------------------------
  heading("1. customer.delete — délégation automatique");
  currentHour = 0;
  accepted(
    (await store.append([
      rootDelegationDraft({
        id: "delete-root",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT,
        capabilities: [CUSTOMER_DELETE],
        canDelegate: false,
        constraints: { expires_at: expiresAt(iso8601(hour(8))) },
        occurredAt: hour(0),
      }),
    ])).outcomes[0],
    "Theo délègue customer.delete au support-agent",
  );

  const deleteRequest = actionRequestDraft({
    id: "delete-customer-42",
    requester: AGENT,
    delegationId: "delete-root",
    capability: CUSTOMER_DELETE,
    parameters: nonMonetaryParameters(),
    occurredAt: hour(0),
  });
  const deleteDecisionSequence = accepted((await store.append([deleteRequest])).outcomes[0], "L'agent demande customer.delete");
  const deleteEvents = await store.getEvents();
  expectOutcome(
    authorityAt(deleteEvents, { agentId: AGENT, principalId: THEO, capability: CUSTOMER_DELETE, parameters: nonMonetaryParameters() }, await instant()),
    "AUTHORIZED",
    "Le mode observation constate une autorité valide",
  );
  accepted(
    (await store.append([
      actionExecutionDraft({
        actionId: "delete-customer-42",
        executor: AGENT,
        decisionSequence: deleteDecisionSequence,
        chain: [delegationLink("delete-root")],
        fingerprint: computeActionFingerprint(CUSTOMER_DELETE, nonMonetaryParameters()),
        occurredAt: hour(0),
      }),
    ])).outcomes[0],
    "L'action est journalisée avec sa chaîne d'autorité",
  );

  // -------------------------------------------------------------------------
  // 2. A credit note needs a human decision bound to its exact parameters.
  // -------------------------------------------------------------------------
  heading("2. credit_note.issue — approbation liée au montant et au client");
  currentHour = 1;
  accepted(
    (await store.append([
      rootDelegationDraft({
        id: "credit-root",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: AGENT,
        capabilities: [CREDIT_NOTE_ISSUE],
        canDelegate: false,
        constraints: { expires_at: expiresAt(iso8601(hour(8))), thresholds: thresholds(500, 2_000) },
        occurredAt: hour(1),
      }),
    ])).outcomes[0],
    "Theo délègue les avoirs jusqu'à 2 000 EUR",
  );

  const creditParameters = monetaryParameters(money(1_500, "EUR"), CUSTOMER);
  const creditRequest = actionRequestDraft({
    id: "credit-note-1500",
    requester: AGENT,
    delegationId: "credit-root",
    capability: CREDIT_NOTE_ISSUE,
    parameters: creditParameters,
    occurredAt: hour(1),
  });
  const creditDecisionSequence = accepted((await store.append([creditRequest])).outcomes[0], "L'agent demande un avoir de 1 500 EUR");
  let creditEvents = await store.getEvents();
  expectOutcome(
    authorityAt(creditEvents, { agentId: AGENT, principalId: THEO, capability: CREDIT_NOTE_ISSUE, parameters: creditParameters }, await instant()),
    "REQUIRES_APPROVAL",
    "Le moteur ne laisse pas passer l'avoir sans approbation",
  );

  currentHour = 2;
  accepted(
    (await store.append([
      approvalRequestDraft({ id: "approval-credit-1500", actionId: "credit-note-1500", requestedFrom: THEO, requester: AGENT, occurredAt: hour(2) }),
      approvalGrantDraft({ id: "approval-credit-1500", actionId: "credit-note-1500", approver: THEO, occurredAt: hour(2) }),
    ])).outcomes[1],
    "Theo approuve exactement cet avoir",
  );
  creditEvents = await store.getEvents();
  expectOutcome(
    authorityAt(creditEvents, { agentId: AGENT, principalId: THEO, capability: CREDIT_NOTE_ISSUE, parameters: creditParameters }, await instant()),
    "AUTHORIZED",
    "L'approbation déverrouille seulement la demande correspondante",
  );
  accepted(
    (await store.append([
      actionExecutionDraft({
        actionId: "credit-note-1500",
        executor: AGENT,
        decisionSequence: creditDecisionSequence,
        chain: [delegationLink("credit-root"), approvalLink("approval-credit-1500")],
        fingerprint: computeActionFingerprint(CREDIT_NOTE_ISSUE, creditParameters),
        occurredAt: hour(2),
      }),
    ])).outcomes[0],
    "L'avoir conserve la référence de l'approbation consommée",
  );

  // -------------------------------------------------------------------------
  // 3. A subsequent request becomes invalid as soon as its grant is revoked.
  // -------------------------------------------------------------------------
  heading("3. role.change — révocation avant l'action suivante");
  currentHour = 3;
  accepted(
    (await store.append([
      rootDelegationDraft({
        id: "role-root",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: ADMIN_AGENT,
        capabilities: [ROLE_CHANGE],
        canDelegate: false,
        constraints: { expires_at: expiresAt(iso8601(hour(8))) },
        occurredAt: hour(3),
      }),
    ])).outcomes[0],
    "Theo délègue role.change",
  );
  const roleEvents = await store.getEvents();
  expectOutcome(
    authorityAt(roleEvents, { agentId: ADMIN_AGENT, principalId: THEO, capability: ROLE_CHANGE, parameters: nonMonetaryParameters() }, await instant()),
    "AUTHORIZED",
    "Le changement de rôle serait initialement couvert",
  );

  currentHour = 4;
  accepted(
    (await store.append([revokeDelegationDraft({ targetId: "role-root", issuedBy: THEO, reason: "INCIDENT_REVIEW", occurredAt: hour(4) })])).outcomes[0],
    "Theo révoque role.change",
  );
  const revokedEvents = await store.getEvents();
  const afterRevocation = expectOutcome(
    authorityAt(revokedEvents, { agentId: ADMIN_AGENT, principalId: THEO, capability: ROLE_CHANGE, parameters: nonMonetaryParameters() }, await instant()),
    "DENIED",
    "L'action suivante ne possède plus d'autorité",
  );
  if (afterRevocation.reasonCode !== "C12_DELEGATION_REVOKED") {
    fail(`La révocation doit expliquer le refus, got ${afterRevocation.reasonCode}`);
  }
  pass("Le refus identifie la révocation comme cause");

  console.log("\nDemo complete: P1 business scenarios hold. No MCP transport, signature, receipt standard, or cloud is implied.");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
