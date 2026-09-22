/**
 * The authority-graph demo — a single, narrated run of the whole engine
 * against one scripted scenario, entirely in memory (no database, no
 * network, no API key). This is the product's first narrative integration
 * test: every step below makes an assertion, not just a print statement. If
 * an assumption this script relies on stops holding, the script throws and
 * exits non-zero — it does not silently print a wrong number.
 *
 * Run with: npm run demo
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { computeActionFingerprint } from "../src/domain/events.js";
import {
  capability,
  expiresAt,
  iso8601,
  monetaryParameters,
  money,
  noExpiry,
  nonMonetaryParameters,
  principalId,
  recipientId,
  sequenceNumber,
  thresholds,
  type AuthorityDecision,
  type AuthorityInstant,
  type IngestOutcome,
  type IngestRejectionCode,
  type SequenceNumber,
} from "../src/domain/types.js";
import { authorityAt, explain, findLateOrBackdatedEvents } from "../src/engine/authority.js";
import { InMemoryEventStore } from "../src/storage/eventStore.js";
import { runExplain } from "../src/cli/authority.js";
import {
  actionExecutionDraft,
  actionRequestDraft,
  approvalGrantDraft,
  approvalLink,
  approvalRequestDraft,
  delegationLink,
  revokeDelegationDraft,
  rootDelegationDraft,
  subDelegationDraft,
} from "./fixtures.js";

// ---------------------------------------------------------------------------
// Narration helpers
// ---------------------------------------------------------------------------

let stepCount = 0;
function section(title: string): void {
  stepCount += 1;
  console.log(`\n${"=".repeat(78)}`);
  console.log(`${stepCount}. ${title}`);
  console.log("=".repeat(78));
}
function note(msg: string): void {
  console.log(`  ${msg}`);
}
function ok(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

function describeDecision(decision: AuthorityDecision): string {
  if (decision.outcome === "AUTHORIZED") {
    return `AUTHORIZED (chain: ${decision.chain.join(" -> ")}${decision.approvalId !== undefined ? `, approval: ${decision.approvalId}` : ""})`;
  }
  if (decision.outcome === "DENIED") {
    return `DENIED (${decision.reasonCode})`;
  }
  if (decision.outcome === "REQUIRES_APPROVAL") {
    return `REQUIRES_APPROVAL (via ${decision.viaDelegation})`;
  }
  return `UNKNOWN (${decision.reasonCode})`;
}

// ---------------------------------------------------------------------------
// Assertion helpers — each one is a property check, not decoration. A thrown
// Error here means the engine did not do what this narrative claims it does.
// ---------------------------------------------------------------------------

function expectOutcome<O extends AuthorityDecision["outcome"]>(
  decision: AuthorityDecision,
  outcome: O,
  label: string,
): Extract<AuthorityDecision, { readonly outcome: O }> {
  if (decision.outcome !== outcome) {
    throw new Error(`${label}: expected outcome ${outcome}, got ${describeDecision(decision)}`);
  }
  ok(`${label} -> ${describeDecision(decision)}`);
  return decision as Extract<AuthorityDecision, { readonly outcome: O }>;
}

function expectDenied(decision: AuthorityDecision, reasonCode: string, label: string): void {
  const denied = expectOutcome(decision, "DENIED", label);
  if (denied.reasonCode !== reasonCode) {
    throw new Error(`${label}: expected reasonCode ${reasonCode}, got ${denied.reasonCode}`);
  }
}

function expectAccepted(outcome: IngestOutcome | undefined, label: string): SequenceNumber {
  if (outcome === undefined || outcome.accepted !== true) {
    throw new Error(`${label}: expected the append to be accepted, got ${JSON.stringify(outcome)}`);
  }
  ok(`${label} -> accepted at sequence ${outcome.sequence}`);
  return outcome.sequence;
}

function expectRejected(outcome: IngestOutcome | undefined, reasonCode: IngestRejectionCode, label: string): void {
  if (outcome === undefined || outcome.accepted !== false) {
    throw new Error(`${label}: expected the append to be rejected, got ${JSON.stringify(outcome)}`);
  }
  if (outcome.reasonCode !== reasonCode) {
    throw new Error(`${label}: expected rejection reasonCode ${reasonCode}, got ${outcome.reasonCode}`);
  }
  if ("sequence" in outcome) {
    throw new Error(`${label}: a rejected draft must never carry a sequence`);
  }
  ok(`${label} -> rejected at ingestion (${reasonCode}), no canonical sequence assigned`);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// Deterministic clock — no Date.now() anywhere in this script's authority
// claims. `currentHour` is advanced explicitly by the narrative itself: time
// only passes when the story says it does.
// ---------------------------------------------------------------------------

const EPOCH_MS = Date.parse("2025-01-01T00:00:00.000Z");
function hour(n: number): string {
  return new Date(EPOCH_MS + n * 3600_000).toISOString();
}

let currentHour = 0;
const clock = { authorityTime: () => iso8601(hour(currentHour)) };
// recorded_at: a genuinely separate infrastructure-clock reading (I4) —
// modeled here as "5 seconds of ingestion latency" after the trusted instant.
const readInfrastructureClock = () => new Date(Date.parse(hour(currentHour)) + 5_000).toISOString();

const store = new InMemoryEventStore(clock, undefined, readInfrastructureClock);

// ---------------------------------------------------------------------------
// Cast: principals, capability, recipient
// ---------------------------------------------------------------------------

const USER = principalId("user"); // HUMAN_ROOT
const AGENT_A = principalId("agent-a");
const AGENT_B = principalId("agent-b");
const MALLORY = principalId("mallory"); // never granted anything
const VENDOR = recipientId("vendor-1");
const OTHER_VENDOR = recipientId("vendor-2");
const PO_CREATE = capability("purchase_order", "create");

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  section("Root delegation: User → Agent A");
  // -------------------------------------------------------------------------
  currentHour = 0;
  const rootDraft = rootDelegationDraft({
    id: "d-user-a",
    grantor: USER,
    grantorType: "HUMAN_ROOT",
    grantee: AGENT_A,
    capabilities: [PO_CREATE],
    canDelegate: true,
    constraints: { expires_at: expiresAt(iso8601(hour(10))), thresholds: thresholds(2500, 5000) },
    occurredAt: hour(0),
  });
  expectAccepted((await store.append([rootDraft])).outcomes[0], "Root delegation user -> A");

  {
    const events = await store.getEvents();
    const at: AuthorityInstant = { atSequence: sequenceNumber(events.length), authorityTime: iso8601(hour(0)) };
    const decision = authorityAt(events, { agentId: AGENT_A, principalId: USER, capability: PO_CREATE, parameters: nonMonetaryParameters() }, at);
    expectOutcome(decision, "AUTHORIZED", "A holds purchase_order.create directly from the user");
  }

  // -------------------------------------------------------------------------
  section("Valid sub-delegation: A → B, ≤ 2000");
  // -------------------------------------------------------------------------
  currentHour = 1;
  const subDraft = subDelegationDraft({
    id: "d-a-b",
    parentId: "d-user-a",
    grantor: AGENT_A,
    grantee: AGENT_B,
    capabilities: [PO_CREATE],
    canDelegate: false,
    constraints: { expires_at: expiresAt(iso8601(hour(8))), thresholds: thresholds(2000, 2000) },
    occurredAt: hour(1),
  });
  expectAccepted((await store.append([subDraft])).outcomes[0], "Sub-delegation A -> B (<=2000, bounded within user -> A per I5)");

  // -------------------------------------------------------------------------
  section("Laundering rejected: Mallory (never granted anything) attempts an invalid chain");
  // -------------------------------------------------------------------------
  const beforeMallory = await store.getEvents();
  const malloryDraft = subDelegationDraft({
    id: "d-mallory-fake",
    parentId: "d-user-a", // references a REAL delegation
    grantor: MALLORY,
    grantee: MALLORY,
    capabilities: [PO_CREATE],
    canDelegate: false,
    constraints: { expires_at: noExpiry },
    occurredAt: hour(1),
  });
  const malloryAppend = await store.append([malloryDraft]);
  expectRejected(malloryAppend.outcomes[0], "UNAUTHORIZED_SUBDELEGATION", "Mallory's forged sub-delegation off user -> A");

  const securityLog = await store.getSecurityLog();
  const loggedEntry = securityLog.find((e) => e.eventId === malloryDraft.event_id);
  if (loggedEntry === undefined) {
    throw new Error("Mallory's rejected draft must appear in the security log");
  }
  ok(`Rejected draft appears in the security log (reasonCode: ${loggedEntry.reasonCode}), event_id ${loggedEntry.eventId}`);

  const afterMallory = await store.getEvents();
  assertEqual(afterMallory.length, beforeMallory.length, "Canonical store length must be unchanged by a rejected append");
  ok(`Canonical store still has ${afterMallory.length} events. The rejected draft never entered it`);

  {
    const at: AuthorityInstant = { atSequence: sequenceNumber(afterMallory.length), authorityTime: iso8601(hour(1)) };
    const decision = authorityAt(afterMallory, { agentId: MALLORY, principalId: USER, capability: PO_CREATE, parameters: nonMonetaryParameters() }, at);
    expectOutcome(decision, "UNKNOWN", "Mallory holds no authority whatsoever (her fabricated delegation never existed canonically)");
  }

  // -------------------------------------------------------------------------
  section("Normal action: B attempts 1800 → AUTHORIZED");
  // -------------------------------------------------------------------------
  currentHour = 2;
  const paramsNormal = monetaryParameters(money(1800, "EUR"), VENDOR);
  const reqBDraft = actionRequestDraft({ id: "a-b-1800", requester: AGENT_B, delegationId: "d-a-b", capability: PO_CREATE, parameters: paramsNormal, occurredAt: hour(2) });
  const reqBSeq = expectAccepted((await store.append([reqBDraft])).outcomes[0], "B requests purchase_order.create for 1800 EUR");

  const fpNormal = computeActionFingerprint(PO_CREATE, paramsNormal);
  const execBDraft = actionExecutionDraft({
    actionId: "a-b-1800",
    executor: AGENT_B,
    decisionSequence: reqBSeq,
    chain: [delegationLink("d-a-b")],
    fingerprint: fpNormal,
    occurredAt: hour(2),
  });
  expectAccepted((await store.append([execBDraft])).outcomes[0], "B executes the 1800 EUR action");

  {
    const events = await store.getEvents();
    const at: AuthorityInstant = { atSequence: sequenceNumber(events.length), authorityTime: iso8601(hour(2)) };
    const report = explain(events, { actionId: reqBDraft.payload.action_id }, at);
    if (report.execution === undefined) {
      throw new Error("a-b-1800 must have a recorded execution");
    }
    expectOutcome(report.currentAuthority, "AUTHORIZED", "B's 1800 EUR action is authorized, automatically, within its own band");
  }

  // -------------------------------------------------------------------------
  section("Escalation: 4800 exceeds B, goes through A via the root delegation");
  // -------------------------------------------------------------------------
  currentHour = 3;
  const paramsEsc = monetaryParameters(money(4800, "EUR"), VENDOR);

  {
    const events = await store.getEvents();
    const at: AuthorityInstant = { atSequence: sequenceNumber(events.length), authorityTime: iso8601(hour(3)) };
    const forB = authorityAt(events, { agentId: AGENT_B, principalId: USER, capability: PO_CREATE, parameters: paramsEsc }, at);
    expectDenied(forB, "C8_AMOUNT_EXCEEDS_APPROVAL_CEILING", "B cannot reach 4800 EUR (its own delegation caps it at 2000)");

    const forA = authorityAt(events, { agentId: AGENT_A, principalId: USER, capability: PO_CREATE, parameters: paramsEsc }, at);
    expectOutcome(forA, "REQUIRES_APPROVAL", "A can reach 4800 EUR via the root delegation, but it falls in the approval band (2500 < 4800 <= 5000)");
  }

  const reqADraft = actionRequestDraft({ id: "a-a-4800", requester: AGENT_A, delegationId: "d-user-a", capability: PO_CREATE, parameters: paramsEsc, occurredAt: hour(3) });
  expectAccepted((await store.append([reqADraft])).outcomes[0], "A requests purchase_order.create for 4800 EUR");

  // -------------------------------------------------------------------------
  section("Approval binding: User approves exactly the 4800 action");
  // -------------------------------------------------------------------------
  currentHour = 4;
  const apprReqDraft = approvalRequestDraft({ id: "appr-4800", actionId: "a-a-4800", requestedFrom: USER, requester: AGENT_A, occurredAt: hour(4) });
  expectAccepted((await store.append([apprReqDraft])).outcomes[0], "A requests the user's approval for the 4800 EUR action");

  currentHour = 5;
  const apprGrantDraft = approvalGrantDraft({ id: "appr-4800", actionId: "a-a-4800", approver: USER, occurredAt: hour(5) });
  const grantSeq = expectAccepted((await store.append([apprGrantDraft])).outcomes[0], "The user grants approval appr-4800");

  {
    const events = await store.getEvents();
    const at: AuthorityInstant = { atSequence: sequenceNumber(events.length), authorityTime: iso8601(hour(5)) };

    const authorized = expectOutcome(
      authorityAt(events, { agentId: AGENT_A, principalId: USER, capability: PO_CREATE, parameters: paramsEsc }, at),
      "AUTHORIZED",
      "The exact approved action (4800 EUR, vendor-1) is now authorized",
    );
    assertEqual(String(authorized.approvalId), "appr-4800", "The authorized decision must cite the approval that unlocked it");

    const wrongAmount = monetaryParameters(money(4801, "EUR"), VENDOR);
    expectOutcome(
      authorityAt(events, { agentId: AGENT_A, principalId: USER, capability: PO_CREATE, parameters: wrongAmount }, at),
      "REQUIRES_APPROVAL",
      "Changing the amount by 1 EUR makes the same approval unusable (I15 binds the exact fingerprint)",
    );

    const wrongRecipient = monetaryParameters(money(4800, "EUR"), OTHER_VENDOR);
    expectOutcome(
      authorityAt(events, { agentId: AGENT_A, principalId: USER, capability: PO_CREATE, parameters: wrongRecipient }, at),
      "REQUIRES_APPROVAL",
      "Changing the recipient makes the same approval unusable",
    );
  }

  // -------------------------------------------------------------------------
  section("Single use: valid execution, then a second consumption attempt → denied");
  // -------------------------------------------------------------------------
  currentHour = 6;
  const fpEsc = computeActionFingerprint(PO_CREATE, paramsEsc);
  const execADraft = actionExecutionDraft({
    actionId: "a-a-4800",
    executor: AGENT_A,
    decisionSequence: grantSeq,
    chain: [delegationLink("d-user-a"), approvalLink("appr-4800")],
    fingerprint: fpEsc,
    occurredAt: hour(6),
  });
  expectAccepted((await store.append([execADraft])).outcomes[0], "A executes the 4800 EUR action, consuming appr-4800");

  {
    const events = await store.getEvents();
    const at: AuthorityInstant = { atSequence: sequenceNumber(events.length), authorityTime: iso8601(hour(6)) };
    const report = explain(events, { actionId: reqADraft.payload.action_id }, at);
    if (report.execution === undefined) {
      throw new Error("a-a-4800 must have a recorded execution");
    }
    expectOutcome(report.execution.authorityAtDecision, "AUTHORIZED", "a-a-4800's execution was authorized at its own decision sequence");
    assertEqual(String(report.execution.consumedApprovalId), "appr-4800", "the report must name the consumed approval");

    const reuse = authorityAt(events, { agentId: AGENT_A, principalId: USER, capability: PO_CREATE, parameters: paramsEsc }, at);
    expectDenied(reuse, "C7_APPROVAL_ALREADY_CONSUMED", "The exact same request, asked again, is now denied: the approval is spent");
  }

  currentHour = 7;
  const reqA2Draft = actionRequestDraft({ id: "a-a-4800-second", requester: AGENT_A, delegationId: "d-user-a", capability: PO_CREATE, parameters: paramsEsc, occurredAt: hour(7) });
  const req2Seq = expectAccepted((await store.append([reqA2Draft])).outcomes[0], "A second, identical 4800 EUR request is recorded");

  const execA2Draft = actionExecutionDraft({
    actionId: "a-a-4800-second",
    executor: AGENT_A,
    decisionSequence: req2Seq,
    chain: [delegationLink("d-user-a"), approvalLink("appr-4800")],
    fingerprint: fpEsc,
    occurredAt: hour(7),
  });
  expectAccepted(
    (await store.append([execA2Draft])).outcomes[0],
    "The log accepts a second ACTION_EXECUTED reusing appr-4800 (I3: append-only never blocks a structurally valid record)",
  );

  {
    const events = await store.getEvents();
    const at: AuthorityInstant = { atSequence: sequenceNumber(events.length), authorityTime: iso8601(hour(7)) };
    const report = explain(events, { actionId: execA2Draft.payload.action_id }, at);
    if (report.execution === undefined) {
      throw new Error("a-a-4800-second must have a recorded execution");
    }
    expectDenied(report.execution.authorityAtDecision, "C7_APPROVAL_ALREADY_CONSUMED", "But resolution denies it: the log recording it does not grant it authority");
  }

  // -------------------------------------------------------------------------
  section("Revocation: User revokes d-user-a; descendants that depend on it exclusively fall too");
  // -------------------------------------------------------------------------
  currentHour = 8;
  const revokeDraft = revokeDelegationDraft({ targetId: "d-user-a", issuedBy: USER, reason: "POLICY_REVIEW", occurredAt: hour(8) });
  const revokeSeq = expectAccepted((await store.append([revokeDraft])).outcomes[0], "The user revokes d-user-a");

  {
    const events = await store.getEvents();
    const at: AuthorityInstant = { atSequence: sequenceNumber(events.length), authorityTime: iso8601(hour(8)) };
    const forA = authorityAt(events, { agentId: AGENT_A, principalId: USER, capability: PO_CREATE, parameters: nonMonetaryParameters() }, at);
    expectDenied(forA, "C12_DELEGATION_REVOKED", "A's own authority is gone immediately");

    const forB = authorityAt(events, { agentId: AGENT_B, principalId: USER, capability: PO_CREATE, parameters: monetaryParameters(money(500, "EUR"), VENDOR) }, at);
    expectDenied(forB, "C12_DELEGATION_REVOKED", "B's authority (which only ever existed through d-user-a) falls too, even though d-a-b itself was never touched");
  }

  // -------------------------------------------------------------------------
  section("Backdating: an earlier occurred_at is injected; authority is not restored");
  // -------------------------------------------------------------------------
  currentHour = 9;
  const paramsBackdated = monetaryParameters(money(100, "EUR"), VENDOR);
  const backdatedDraft = actionRequestDraft({
    id: "a-a-backdated",
    requester: AGENT_A,
    delegationId: "d-user-a",
    capability: PO_CREATE,
    parameters: paramsBackdated,
    occurredAt: "2020-01-01T00:00:00.000Z", // claims to have happened years before the delegation even existed
  });
  expectAccepted(
    (await store.append([backdatedDraft])).outcomes[0],
    "Ingestion accepts the structurally valid request regardless of its occurred_at claim (I4: occurred_at is never decisional)",
  );

  {
    const events = await store.getEvents();
    const at: AuthorityInstant = { atSequence: sequenceNumber(events.length), authorityTime: iso8601(hour(9)) };
    const decision = authorityAt(events, { agentId: AGENT_A, principalId: USER, capability: PO_CREATE, parameters: paramsBackdated }, at);
    expectDenied(decision, "C12_DELEGATION_REVOKED", "The backdated occurred_at does not resurrect a revoked delegation: sequence and authority_time are unmoved");

    const drift = findLateOrBackdatedEvents(events);
    const flagged = drift.find((d) => d.eventId === backdatedDraft.event_id);
    if (flagged === undefined) {
      throw new Error("explain()'s diagnostic must flag the backdated event as LATE_OR_BACKDATED_EVENT_OBSERVED");
    }
    ok(`explain() flags LATE_OR_BACKDATED_EVENT_OBSERVED for this event (drift: ${flagged.driftMs}ms), diagnostic only, and it changed no decision above`);
  }

  // -------------------------------------------------------------------------
  section("Historical explain: yesterday's authority, explained today");
  // -------------------------------------------------------------------------
  const finalEvents = await store.getEvents();
  const farFuture = hour(50); // well past both the revocation (hour 8) and d-user-a's own expiry (hour 10)

  // The invariant itself, checked in-process before we ever touch the CLI:
  // the decision AT the decision point must not move when "now" moves.
  const atExecutionTime: AuthorityInstant = { atSequence: sequenceNumber(8), authorityTime: iso8601(hour(6)) };
  const atFarFuture: AuthorityInstant = { atSequence: sequenceNumber(finalEvents.length), authorityTime: iso8601(farFuture) };
  const reportNearby = explain(finalEvents, { actionId: execADraft.payload.action_id }, atExecutionTime);
  const reportLater = explain(finalEvents, { actionId: execADraft.payload.action_id }, atFarFuture);
  if (JSON.stringify(reportNearby.execution?.authorityAtDecision) !== JSON.stringify(reportLater.execution?.authorityAtDecision)) {
    throw new Error("execution.authorityAtDecision must not depend on the current instant");
  }
  ok("execution.authorityAtDecision is identical whether asked right after execution or 44 hours later");
  expectOutcome(reportLater.currentAuthority, "DENIED", "...while currentAuthority, asked today, reflects that this authority no longer exists");
  note(`(the chain is both revoked, at sequence ${revokeSeq}, and, independently, expired past ${hour(10)}: either fact alone would deny it today)`);

  // Now the real CLI, end to end, against an exported JSON file — exactly
  // the artifact a human operator would have on hand.
  const tmpDir = await mkdtemp(path.join(tmpdir(), "authority-graph-demo-"));
  const eventsFile = path.join(tmpDir, "events.json");
  try {
    await writeFile(eventsFile, JSON.stringify(finalEvents, null, 2), "utf8");

    const textResult = await runExplain(["explain", "a-a-4800", "--events", eventsFile, "--at-sequence", String(finalEvents.length), "--authority-time", farFuture]);
    console.log("\n  --- authority explain a-a-4800 (real CLI output) ---\n");
    console.log(textResult.output.replace(/^(?=.)/gm, "  "));

    const jsonResult = await runExplain(["explain", "a-a-4800", "--json", "--events", eventsFile, "--at-sequence", String(finalEvents.length), "--authority-time", farFuture]);
    const parsed: { readonly execution?: { readonly authorityAtDecision: AuthorityDecision }; readonly currentAuthority: AuthorityDecision; readonly source: string } = JSON.parse(
      jsonResult.output,
    );
    if (parsed.execution === undefined) {
      throw new Error("CLI report for a-a-4800 must include its execution");
    }
    expectOutcome(parsed.execution.authorityAtDecision, "AUTHORIZED", "CLI confirms: authorized at its own decision sequence");
    expectOutcome(parsed.currentAuthority, "DENIED", "CLI confirms: not authorized today");
    assertEqual(parsed.source, "imported canonical event export", "CLI must label a --events file's provenance, never imply Authority validated it");
    ok("The real `authority explain` CLI reproduces exactly the properties checked above, from a plain JSON export, with no database and no network");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n${"=".repeat(78)}`);
  console.log("All properties held. Demo complete.");
  console.log("=".repeat(78));
}

main().catch((err: unknown) => {
  console.error(`\nDEMO FAILED: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack !== undefined) {
    console.error(err.stack);
  }
  process.exitCode = 1;
});
