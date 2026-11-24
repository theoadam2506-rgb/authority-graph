/**
 * Architecture B (experimental): the coordinator, the order registry and the divergences between Authority and the OpenAI
 * state. The model is scripted; the store is in memory; the tokens are simulated. Nothing here is a production claim.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, Runner, RunState, tool } from "@openai/agents";
import { ScriptedModel, assistantMessage, functionCall, modelError } from "@openai/agents/testing";
import { z } from "zod";
import { ApprovalCoordinator, InMemoryApprovalStore, SimulatedTokenAuthenticator, type RunOutcome } from "../src/approval.js";
import { callOrder, createBridgeKit, order, type BridgeKit } from "../src/bridgeKit.js";
import { AuthorityRejectedError, createHost, type HostFaults } from "../src/host.js";
import { InMemoryOrderRegistry, registryPrecheck } from "../src/orderRegistry.js";
import { toolOutputsOf } from "../src/scripted.js";

const FINAL = [assistantMessage("done")];
const ALICE = "token-alice";

/** Runs the scripted model until it pauses for a human, and returns the paused outcome. */
async function pause(kit: BridgeKit, o = order("ORDER-7"), callId = "call_1") {
  kit.register(o);
  const outcome = await kit.coordinator.start(kit.agent([[callOrder(o, callId)], FINAL]), "place the order");
  assert.equal(outcome.status, "WAITING");
  if (outcome.status !== "WAITING") throw new Error("unreachable");
  return outcome;
}

const decideAs = (kit: BridgeKit, approvalId: string, credential: unknown, decision: "approve" | "reject" = "approve") => kit.coordinator.decide({ approvalId, decision, credential });
const results = (outcome: RunOutcome) => (outcome.status === "DONE" ? outcome.toolResults : []);

// ---------------------------------------------------------------------------------------------------------------------
test("the complete flow: pause, bound interruption, authenticated decision, resume, one execution", async () => {
  const kit = await createBridgeKit();
  const paused = await pause(kit);
  const [approval] = paused.approvals;
  // The interruption is bound to the validated arguments, the Authority action and the SDK's tool-call id.
  assert.equal(paused.approvals.length, 1);
  assert.deepEqual(approval?.summary, { actionId: "po:ORDER-7", amount: { value: 2400, currency: "EUR" }, recipient: "vendor-1", args: { orderRef: "ORDER-7", sku: "A-100", qty: 7 } });
  assert.equal(approval?.callId, "call_1");
  assert.equal(kit.host.supplier.orders.length, 0, "nothing runs while the run is paused");
  assert.ok(!(await kit.host.journal()).includes("APPROVAL_GRANTED"));

  assert.deepEqual(await decideAs(kit, approval!.approvalId, ALICE), { status: "DECIDED", decision: "approve" });
  const done = await kit.coordinator.resume(paused.runId);
  assert.deepEqual(results(done), [{ status: "EXECUTED", value: { confirmation: "CONF-1" }, recorded: true }]);
  assert.equal(kit.host.supplier.orders.length, 1);
  const journal = await kit.host.journal();
  assert.ok(journal.indexOf("APPROVAL_GRANTED") < journal.indexOf("CAPABILITY_ISSUED"));
  assert.equal(journal.at(-1), "ACTION_EXECUTED(EXECUTED)");
});

test("a decision carries only an approval id, a decision and a credential: anything else the client sends is ignored", async () => {
  const kit = await createBridgeKit();
  const paused = await pause(kit);
  const forged = { approvalId: paused.approvals[0]!.approvalId, decision: "approve", credential: ALICE, arguments: { orderRef: "ORDER-X", amountEur: 1 }, callId: "call_99", snapshot: "{}", actionId: "po:OTHER" };
  assert.equal((await kit.coordinator.decide(forged as never)).status, "DECIDED");
  const journal = (await kit.host.authority.events()) as unknown as { event_type: string; payload: { action_id?: string } }[];
  assert.deepEqual(journal.filter((e) => e.event_type === "APPROVAL_GRANTED").map((e) => e.payload.action_id), ["po:ORDER-7"]);
  assert.equal(results(await kit.coordinator.resume(paused.runId))[0]?.status, "EXECUTED");
});

// ---------------------------------------------------------------------------------------------------------------------
test("the reviewer is authenticated before anything is recorded: no credential, an unknown token, inherited object keys", async () => {
  const kit = await createBridgeKit();
  const paused = await pause(kit);
  const id = paused.approvals[0]!.approvalId;
  for (const credential of [undefined, null, 42, "", "token-unknown", "__proto__", "toString", "constructor"]) {
    assert.deepEqual(await decideAs(kit, id, credential), { status: "REFUSED", reason: "NOT_AUTHENTICATED" }, String(credential));
  }
  const journal = await kit.host.journal();
  assert.ok(!journal.includes("APPROVAL_REQUESTED") && !journal.includes("APPROVAL_GRANTED"), "an unauthenticated attempt writes nothing");
  assert.equal((await kit.store.getApproval(id))?.status, "PENDING");
});

test("an authenticated reviewer who is not authorized for the approval is refused by the HOST before anything is claimed or written", async () => {
  const kit = await createBridgeKit();
  const paused = await pause(kit);
  const id = paused.approvals[0]!.approvalId;
  for (const token of ["token-mallory", "token-agent"]) {
    assert.deepEqual(await decideAs(kit, id, token), { status: "REFUSED", reason: "NOT_AUTHORIZED_FOR_THIS_APPROVAL" });
    assert.deepEqual(await decideAs(kit, id, token, "reject"), { status: "REFUSED", reason: "NOT_AUTHORIZED_FOR_THIS_APPROVAL" });
  }
  const journal = await kit.host.journal();
  assert.ok(!journal.includes("APPROVAL_REQUESTED") && !journal.includes("APPROVAL_GRANTED") && !journal.includes("APPROVAL_DENIED"));
  const record = await kit.store.getApproval(id);
  assert.equal(record?.status, "PENDING");
  assert.equal(record?.claimToken, undefined, "nothing was claimed");
  assert.equal((await decideAs(kit, id, ALICE)).status, "DECIDED");
  assert.equal(results(await kit.coordinator.resume(paused.runId))[0]?.status, "EXECUTED");
});

test("a MISCONFIGURED host check does not matter: Authority refuses a non-grantor too, an explicit refusal releases the claim, alice can still decide", async () => {
  const kit = await createBridgeKit({ permissiveReviewerCheck: true });
  const paused = await pause(kit);
  const id = paused.approvals[0]!.approvalId;
  for (const token of ["token-mallory", "token-agent"]) {
    assert.deepEqual(await decideAs(kit, id, token), { status: "REFUSED", reason: "NOT_ACCEPTED_BY_AUTHORITY", detail: "UNAUTHORIZED_APPROVAL_DECISION" });
    assert.deepEqual(await decideAs(kit, id, token, "reject"), { status: "REFUSED", reason: "NOT_ACCEPTED_BY_AUTHORITY", detail: "UNAUTHORIZED_APPROVAL_DECISION" });
  }
  assert.ok(!(await kit.host.journal()).some((e) => e === "APPROVAL_GRANTED" || e === "APPROVAL_DENIED"));
  const released = await kit.store.getApproval(id);
  assert.equal(released?.status, "PENDING", "Authority refused explicitly: nothing was decided, so the claim is released");
  assert.equal(released?.intent, undefined);
  assert.equal(released?.decidedBy, undefined);
  assert.equal((await decideAs(kit, id, ALICE)).status, "DECIDED");
  assert.equal(results(await kit.coordinator.resume(paused.runId))[0]?.status, "EXECUTED");
});

test("record() answers RECORDED even when an outcome is refused: recordChecked turns that into an error, never into a silent success", async () => {
  const host = await createHost({ approval: "authority" });
  await host.authority.authorize({ actionId: "po:X", agentId: "procurement-agent", delegationId: "d-1", capability: { resource: "purchase_order", action: "create" }, amount: { value: 2400, currency: "EUR" }, recipient: "v", args: {} });
  const raw = await host.authority.record([host.events.approvalGranted({ approvalId: "ap-raw", actionId: "po:X", approver: "mallory" })]);
  assert.equal(raw.status, "RECORDED", "the raw call looks like a success");
  assert.equal(raw.status === "RECORDED" && raw.outcomes[0]?.accepted, false);
  await assert.rejects(host.recorder.approve("po:X", "mallory"), AuthorityRejectedError);
  await host.recorder.approve("po:X", "alice");
});

// ---------------------------------------------------------------------------------------------------------------------
test("double decision: only one passes the atomic claim, Authority holds one approval", async () => {
  const kit = await createBridgeKit();
  const paused = await pause(kit);
  const id = paused.approvals[0]!.approvalId;
  const outcomes = await Promise.all([decideAs(kit, id, ALICE), decideAs(kit, id, ALICE), decideAs(kit, id, ALICE, "reject")]);
  assert.deepEqual(outcomes.map((o) => o.status).sort(), ["DECIDED", "REFUSED", "REFUSED"]);
  assert.equal(outcomes.filter((o) => o.status === "REFUSED" && o.reason === "ALREADY_DECIDED").length, 2);
  assert.equal((await kit.host.journal()).filter((e) => e === "APPROVAL_GRANTED" || e === "APPROVAL_DENIED").length, 1);
});

test("double resume: one passes the compare-and-set; a later resume is refused; the effect ran once", async () => {
  const kit = await createBridgeKit();
  const paused = await pause(kit);
  await decideAs(kit, paused.approvals[0]!.approvalId, ALICE);
  const outcomes = await Promise.all([kit.coordinator.resume(paused.runId), kit.coordinator.resume(paused.runId)]);
  assert.deepEqual(outcomes.map((o) => o.status).sort(), ["DONE", "REFUSED"]);
  assert.deepEqual(await kit.coordinator.resume(paused.runId), { status: "REFUSED", reason: "NOT_RESUMABLE" });
  assert.equal(kit.host.supplier.orders.length, 1);
});

test("a resume before the decisions are made is refused and leaves the run resumable", async () => {
  const kit = await createBridgeKit();
  const paused = await pause(kit);
  assert.deepEqual(await kit.coordinator.resume(paused.runId), { status: "REFUSED", reason: "DECISIONS_PENDING" });
  assert.deepEqual(await kit.coordinator.resume("run-unknown"), { status: "REFUSED", reason: "UNKNOWN_RUN" });
  await decideAs(kit, paused.approvals[0]!.approvalId, ALICE);
  assert.equal((await kit.coordinator.resume(paused.runId)).status, "DONE");
  assert.deepEqual(await decideAs(kit, "appr-unknown", ALICE), { status: "REFUSED", reason: "UNKNOWN_APPROVAL" });
});

// ---------------------------------------------------------------------------------------------------------------------
test("divergence: the SDK approves, Authority was never told: guard() refuses, the supplier is not called", async () => {
  const kit = await createBridgeKit();
  const o = kit.register(order("ORDER-7"));
  const agent = kit.agent([[callOrder(o, "call_1")], FINAL]);
  const runner = new Runner({ tracingDisabled: true });
  const first = await runner.run(agent, "go");
  first.state.approve(first.interruptions![0]!);
  const second = await runner.run(agent, first.state);
  assert.equal(toolOutputsOf(second)[0]?.status, "APPROVAL_REQUIRED");
  assert.equal(kit.host.supplier.orders.length, 0);
});

test("divergence: a sticky alwaysApprove removes the pause, never the check: the second order is APPROVAL_REQUIRED", async () => {
  const kit = await createBridgeKit();
  const first = kit.register(order("ORDER-7"));
  const second = kit.register(order("ORDER-8"));
  const agent = kit.agent([[callOrder(first, "call_1")], [callOrder(second, "call_2")], FINAL]);
  const runner = new Runner({ tracingDisabled: true });
  const paused = await runner.run(agent, "go");
  await kit.host.approve("po:ORDER-7");
  paused.state.approve(paused.interruptions![0]!, { alwaysApprove: true });
  const done = await runner.run(agent, paused.state);
  assert.equal(done.interruptions?.length ?? 0, 0, "the SDK stopped asking");
  assert.deepEqual(toolOutputsOf(done).map((o) => o.status), ["EXECUTED", "APPROVAL_REQUIRED"]);
  assert.deepEqual(kit.host.supplier.orders.map((o) => o.orderRef), ["ORDER-7"]);
});

test("the coordinator never makes an approval sticky: the next order of the same run pauses again", async () => {
  const kit = await createBridgeKit();
  const first = kit.register(order("ORDER-7"));
  const second = kit.register(order("ORDER-8"));
  const paused = await kit.coordinator.start(kit.agent([[callOrder(first, "call_1")], FINAL]), "go");
  assert.equal(paused.status, "WAITING");
  if (paused.status !== "WAITING") return;
  kit.queueResume([[callOrder(second, "call_2")], FINAL]);
  await decideAs(kit, paused.approvals[0]!.approvalId, ALICE);
  const again = await kit.coordinator.resume(paused.runId);
  assert.equal(again.status, "WAITING", "ORDER-8 needs its own human");
  assert.equal(kit.host.supplier.orders.length, 1);
});

test("divergence: needsApproval answering false for an order that needs a human does not run it", async () => {
  const kit = await createBridgeKit();
  const o = kit.register(order("ORDER-7"));
  // The same tool WITHOUT the bridge (architecture A): no pause, and guard() still refuses.
  const plain = await createHost({ registry: kit.registry });
  const agent = new Agent({ name: "buyer", model: new ScriptedModel([[callOrder(o, "call_1")], FINAL] as never), tools: [plain.tool] });
  const result = await new Runner({ tracingDisabled: true }).run(agent, "go");
  assert.equal(result.interruptions?.length ?? 0, 0);
  assert.equal(toolOutputsOf(result)[0]?.status, "APPROVAL_REQUIRED");
  assert.equal(plain.supplier.orders.length, 0);
});

test("divergence: Authority already holds the approval while the SDK run is paused: the same decision completes it, the order runs once", async () => {
  const kit = await createBridgeKit();
  const paused = await pause(kit);
  await kit.host.approve("po:ORDER-7"); // recorded in Authority only
  assert.deepEqual(await kit.coordinator.resume(paused.runId), { status: "REFUSED", reason: "DECISIONS_PENDING" });
  assert.equal((await decideAs(kit, paused.approvals[0]!.approvalId, ALICE)).status, "DECIDED");
  assert.equal(results(await kit.coordinator.resume(paused.runId))[0]?.status, "EXECUTED");
  assert.equal(kit.host.supplier.orders.length, 1);
});

test("an interruption for a tool the coordinator cannot bind is rejected at once (fail closed) and the tool never runs", async () => {
  const kit = await createBridgeKit();
  let ran = 0;
  const stray = tool({ name: "delete_everything", description: "x", parameters: z.object({}), needsApproval: true, execute: async () => { ran++; return "deleted"; } });
  const strayAgent = (steps: unknown[]) => new Agent({ name: "buyer", model: new ScriptedModel(steps as never), tools: [stray] });
  const coordinator = new ApprovalCoordinator(kit.coordinatorConfig({ store: new InMemoryApprovalStore(), authenticator: new SimulatedTokenAuthenticator({}), agentFactory: () => strayAgent([FINAL]) }));
  const outcome = await coordinator.start(strayAgent([[functionCall("delete_everything", {}, { callId: "call_9" })], FINAL]), "go");
  assert.equal(outcome.status, "DONE");
  assert.match(JSON.stringify(results(outcome)), /could not be matched/);
  assert.equal(ran, 0);
});

// ---------------------------------------------------------------------------------------------------------------------
test("a human rejection: no effect, the refusal is journaled, and asking again needs a human again (a denial is not terminal)", async () => {
  const kit = await createBridgeKit();
  const paused = await pause(kit);
  assert.deepEqual(await decideAs(kit, paused.approvals[0]!.approvalId, ALICE, "reject"), { status: "DECIDED", decision: "reject" });
  const done = await kit.coordinator.resume(paused.runId);
  assert.match(JSON.stringify(results(done)), /A human rejected this order/);
  assert.equal(kit.host.supplier.orders.length, 0);
  assert.ok((await kit.host.journal()).includes("APPROVAL_DENIED"));
  const again = await kit.coordinator.start(kit.agent([[callOrder(order("ORDER-7"), "call_2")], FINAL]), "ask again");
  assert.equal(again.status, "WAITING", "the same order pauses for a human again");
});

test("revocation while a human is deciding: refused before the decision (B3a) and at resume after it (B3b), the supplier is never called", async () => {
  const a = await createBridgeKit();
  const pausedA = await pause(a);
  await a.host.revoke();
  assert.deepEqual(await decideAs(a, pausedA.approvals[0]!.approvalId, ALICE), { status: "REFUSED", reason: "NO_LONGER_WAITING", detail: "C12_DELEGATION_REVOKED" });
  assert.equal((await a.store.getApproval(pausedA.approvals[0]!.approvalId))?.status, "VOID");
  assert.match(JSON.stringify(results(await a.coordinator.resume(pausedA.runId))), /no longer waiting/);
  assert.equal(a.host.supplier.orders.length, 0);

  const b = await createBridgeKit();
  const pausedB = await pause(b);
  assert.equal((await decideAs(b, pausedB.approvals[0]!.approvalId, ALICE)).status, "DECIDED");
  await b.host.revoke();
  const outcome = await b.coordinator.resume(pausedB.runId);
  assert.deepEqual(results(outcome).map((r) => (r.status === "NOT_EXECUTED" ? r.reason : r.status)), ["C12_DELEGATION_REVOKED"]);
  assert.equal(b.host.supplier.orders.length, 0);
});

test("two interruptions for the same action: one approval covers the action, the effect runs once", async () => {
  const kit = await createBridgeKit();
  const o = kit.register(order("ORDER-7"));
  const agent = kit.agent([[callOrder(o, "call_1"), callOrder(o, "call_2")], FINAL]);
  const paused = await kit.coordinator.start(agent, "go");
  assert.equal(paused.status, "WAITING");
  if (paused.status !== "WAITING") return;
  assert.equal(paused.approvals.length, 2);
  for (const approval of paused.approvals) assert.equal((await decideAs(kit, approval.approvalId, ALICE)).status, "DECIDED");
  const done = await kit.coordinator.resume(paused.runId);
  assert.deepEqual(results(done).map((r) => r.status), ["EXECUTED", "NOT_EXECUTED"]);
  assert.equal(kit.host.supplier.orders.length, 1);
});

// ---------------------------------------------------------------------------------------------------------------------
test("a tampered stored snapshot is not approved: the coordinator compares it with its own record, the supplier is never called", async () => {
  const kit = await createBridgeKit();
  const paused = await pause(kit);
  await decideAs(kit, paused.approvals[0]!.approvalId, ALICE);
  kit.restart((data) => {
    for (const run of data.runs) run.snapshot = run.snapshot.replaceAll("2400", "4900");
  });
  const outcome = await kit.coordinator.resume(paused.runId);
  assert.match(JSON.stringify(results(outcome)), /no longer matches what was approved/);
  assert.equal(kit.host.supplier.orders.length, 0);
});

test("a tampered coordinator record is not approved either", async () => {
  const kit = await createBridgeKit();
  const paused = await pause(kit);
  await decideAs(kit, paused.approvals[0]!.approvalId, ALICE);
  kit.restart((data) => {
    for (const approval of data.approvals) if (approval.call.amount) approval.call.amount.value = 4900;
  });
  assert.match(JSON.stringify(results(await kit.coordinator.resume(paused.runId))), /no longer matches what was approved/);
  assert.equal(kit.host.supplier.orders.length, 0);
});

test("the Agents SDK itself refuses an approved invocation whose arguments changed (its own check, bypassing the coordinator)", async () => {
  const kit = await createBridgeKit();
  const o = kit.register(order("ORDER-7"));
  const agent = kit.agent([[callOrder(o, "call_1")], FINAL]);
  const runner = new Runner({ tracingDisabled: true });
  const first = await runner.run(agent, "go");
  await kit.host.approve("po:ORDER-7");
  first.state.approve(first.interruptions![0]!);
  const tampered = first.state.toString().replaceAll("2400", "4900");
  const restored = await RunState.fromString(kit.agent([FINAL]), tampered);
  await assert.rejects(runner.run(kit.agent([FINAL]), restored), /reused for a different invocation after an approval decision/);
  assert.equal(kit.host.supplier.orders.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------------
test("the order registry refuses an invented reference BEFORE Authority: no interruption, nothing journaled, nobody asked", async () => {
  const kit = await createBridgeKit();
  const outcome = await kit.coordinator.start(kit.agent([[callOrder(order("ORDER-INVENTED"), "call_1")], FINAL]), "go");
  assert.equal(outcome.status, "DONE");
  assert.deepEqual(results(outcome).map((r) => (r.status === "NOT_EXECUTED" ? r.reason : r.status)), ["UNREGISTERED_ORDER_REFERENCE"]);
  assert.deepEqual(await kit.host.journal(), ["DELEGATION_CREATED"]);
  assert.equal(kit.host.supplier.orders.length, 0);
});

test("the order registry refuses arguments that differ from the registration, for any argument", async () => {
  const kit = await createBridgeKit();
  const o = kit.register(order("ORDER-7"));
  for (const change of [{ amountEur: 4900 }, { qty: 8 }, { sku: "B-200" }, { supplier: "vendor-2" }]) {
    const outcome = await kit.coordinator.start(kit.agent([[callOrder(o, "call_1", change)], FINAL]), "go");
    assert.deepEqual(results(outcome).map((r) => (r.status === "NOT_EXECUTED" ? r.reason : r.status)), ["ORDER_DOES_NOT_MATCH_REGISTRATION"], JSON.stringify(change));
  }
  assert.deepEqual(await kit.host.journal(), ["DELEGATION_CREATED"]);
});

test("after an uncertain result: the same reference is refused, an invented retry reference is refused, a reference the HOST registers is NOT prevented", async () => {
  const kit = await createBridgeKit({ supplier: "completes-then-loses-reply" });
  const paused = await pause(kit, order("ORDER-7"));
  await decideAs(kit, paused.approvals[0]!.approvalId, ALICE);
  const uncertain = await kit.coordinator.resume(paused.runId);
  assert.equal(results(uncertain)[0]?.status, "OUTCOME_UNKNOWN");
  assert.equal(kit.host.supplier.orders.length, 1, "the supplier did record the order");

  const same = await kit.coordinator.start(kit.agent([[callOrder(order("ORDER-7"), "call_2")], FINAL]), "retry");
  assert.match(JSON.stringify(results(same)), /C7_APPROVAL_ALREADY_CONSUMED/);
  assert.match(JSON.stringify(results(same)), /already processed by an earlier attempt/);

  const invented = await kit.coordinator.start(kit.agent([[callOrder(order("ORDER-7-RETRY"), "call_3")], FINAL]), "retry");
  assert.deepEqual(results(invented).map((r) => (r.status === "NOT_EXECUTED" ? r.reason : r.status)), ["UNREGISTERED_ORDER_REFERENCE"]);
  assert.equal(kit.host.supplier.orders.length, 1);

  // The limit: the host itself registers a second order for the same purchase. Neither the registry nor Authority can know.
  kit.host.supplier.behaviour = "ok";
  const second = await pause(kit, order("ORDER-7B"), "call_4");
  await decideAs(kit, second.approvals[0]!.approvalId, ALICE);
  assert.equal(results(await kit.coordinator.resume(second.runId))[0]?.status, "EXECUTED");
  assert.equal(kit.host.supplier.orders.length, 2, "the duplicate is NOT prevented: the target must deduplicate");
  assert.notEqual(kit.host.supplier.orders[0]?.idempotencyKey, kit.host.supplier.orders[1]?.idempotencyKey);
});

test("the registry: a reference is registered once and only by the host", async () => {
  const registry = new InMemoryOrderRegistry();
  registry.register(order("ORDER-1"));
  assert.throws(() => registry.register(order("ORDER-1")), /already registered/);
  assert.equal(await registry.lookup("ORDER-2"), undefined);
  assert.deepEqual(await registryPrecheck(registry)(order("ORDER-2")), { ok: false, reason: "UNREGISTERED_ORDER_REFERENCE" });
  assert.deepEqual(await registryPrecheck(registry)(order("ORDER-1")), { ok: true });
});

// ---------------------------------------------------------------------------------------------------------------------
test("window 1: Authority wrote the approval, the coordinator could not persist it: nothing resumes, the decision cannot be flipped, the operator completes the SAME intent", async () => {
  const kit = await createBridgeKit();
  const paused = await pause(kit);
  const id = paused.approvals[0]!.approvalId;
  kit.store.failTransitionTo = ["APPROVED"];
  assert.deepEqual(await decideAs(kit, id, ALICE), { status: "REFUSED", reason: "PERSISTENCE_FAILED" });
  assert.ok((await kit.host.journal()).includes("APPROVAL_GRANTED"), "Authority holds the approval");
  const stuck = await kit.store.getApproval(id);
  assert.equal(stuck?.status, "DECIDING");
  assert.equal(stuck?.intent, "approve");
  assert.equal(stuck?.decidedBy, "alice");
  assert.deepEqual(await kit.coordinator.resume(paused.runId), { status: "REFUSED", reason: "DECISIONS_PENDING" });
  assert.equal(kit.host.supplier.orders.length, 0, "nothing runs from a decision that was not persisted");
  assert.deepEqual(await decideAs(kit, id, ALICE), { status: "REFUSED", reason: "ALREADY_DECIDED" });
  assert.deepEqual(await decideAs(kit, id, ALICE, "reject"), { status: "REFUSED", reason: "ALREADY_DECIDED" }, "the opposite decision cannot follow");
  assert.deepEqual((await kit.coordinator.listStuckDecisions()).map((r) => r.approvalId), [id]);
  assert.deepEqual(await kit.coordinator.completeStuckDecision(id), { status: "DECIDED", decision: "approve" });
  assert.equal(results(await kit.coordinator.resume(paused.runId))[0]?.status, "EXECUTED");
  assert.equal(kit.host.supplier.orders.length, 1);
  assert.equal((await kit.host.journal()).filter((e) => e === "APPROVAL_GRANTED").length, 1, "the already-recorded approval was not written twice");
  assert.ok(!(await kit.host.journal()).includes("APPROVAL_DENIED"));
});

test("window 1b: an Authority write whose outcome is not known keeps the approval DECIDING: it is not released, and only the same intent can complete it", async () => {
  const faults: HostFaults = { failToRecordApproval: true };
  const kit = await createBridgeKit({ faults });
  const paused = await pause(kit);
  const id = paused.approvals[0]!.approvalId;
  assert.deepEqual(await decideAs(kit, id, ALICE), { status: "REFUSED", reason: "DECISION_UNCERTAIN" });
  const held = await kit.store.getApproval(id);
  assert.equal(held?.status, "DECIDING", "not released to PENDING: the write may have reached the journal");
  assert.equal(held?.intent, "approve");
  assert.deepEqual(await decideAs(kit, id, ALICE, "reject"), { status: "REFUSED", reason: "ALREADY_DECIDED" });
  faults.failToRecordApproval = false;
  assert.deepEqual(await kit.coordinator.completeStuckDecision(id), { status: "DECIDED", decision: "approve" });
  assert.equal(results(await kit.coordinator.resume(paused.runId))[0]?.status, "EXECUTED");
  assert.ok(!(await kit.host.journal()).includes("APPROVAL_DENIED"));
});

test("window 2: the decision is persisted, the process restarts before the resume: the rebuilt coordinator resumes it, once", async () => {
  const kit = await createBridgeKit();
  const paused = await pause(kit);
  await decideAs(kit, paused.approvals[0]!.approvalId, ALICE);
  kit.restart();
  assert.equal(results(await kit.coordinator.resume(paused.runId))[0]?.status, "EXECUTED");
  assert.deepEqual(await kit.coordinator.resume(paused.runId), { status: "REFUSED", reason: "NOT_RESUMABLE" });
  assert.equal(kit.host.supplier.orders.length, 1);
});

test("window 2b: a restart while a human has not decided yet: the pending approval survives and can still be decided", async () => {
  const kit = await createBridgeKit();
  const paused = await pause(kit);
  kit.restart();
  assert.equal((await decideAs(kit, paused.approvals[0]!.approvalId, ALICE)).status, "DECIDED");
  assert.equal(results(await kit.coordinator.resume(paused.runId))[0]?.status, "EXECUTED");
});

test("window 3: the effect runs, then the next model call fails: FAILED, the effect is NOT rerun by the retry, and the model is not told it was not placed", async () => {
  const kit = await createBridgeKit();
  const paused = await pause(kit);
  await decideAs(kit, paused.approvals[0]!.approvalId, ALICE);
  kit.queueResume([modelError(new Error("model unavailable"))], [FINAL]);
  const failed = await kit.coordinator.resume(paused.runId);
  assert.equal(failed.status, "FAILED");
  assert.equal(kit.host.supplier.orders.length, 1, "the effect ran before the failure");
  assert.deepEqual(await kit.coordinator.resume(paused.runId), { status: "REFUSED", reason: "NOT_RESUMABLE" }, "a plain resume is refused after a failure");
  const retried = await kit.coordinator.retryResume(paused.runId);
  assert.equal(retried.status, "DONE");
  assert.equal(kit.host.supplier.orders.length, 1, "retrying did not rerun the effect");
  assert.match(JSON.stringify(results(retried)), /already processed by an earlier attempt/);
  assert.doesNotMatch(JSON.stringify(results(retried)), /was not placed/);
});

test("window 4: the effect ran, the journal write failed, the coordinator crashed before recording FINISHED: the replay is ALREADY_REDEEMED", async () => {
  const kit = await createBridgeKit({ faults: { failToReportExecution: true } });
  const paused = await pause(kit);
  await decideAs(kit, paused.approvals[0]!.approvalId, ALICE);
  const first = await kit.coordinator.resume(paused.runId);
  assert.deepEqual(results(first), [{ status: "EXECUTED", value: { confirmation: "CONF-1" }, recorded: false }]);
  kit.restart((data) => {
    for (const run of data.runs) run.status = "WAITING";
  });
  const replay = await kit.coordinator.resume(paused.runId);
  assert.deepEqual(results(replay).map((r) => (r.status === "NOT_EXECUTED" ? r.reason : r.status)), ["ALREADY_REDEEMED"]);
  assert.equal(kit.host.supplier.orders.length, 1);
});

// ---------------------------------------------------------------------------------------------------------------------
test("the simulated authenticator and the in-memory store: the contracts the coordinator relies on", async () => {
  const authenticator = new SimulatedTokenAuthenticator({ t: "alice" });
  assert.deepEqual(await authenticator.authenticate("t"), { principalId: "alice" });
  assert.equal(await authenticator.authenticate("T"), undefined);

  const store = new InMemoryApprovalStore();
  await store.putRun({ runId: "r", snapshot: "{}", approvalIds: ["a"], status: "WAITING" }, [{ approvalId: "a", runId: "r", callId: "c", actionId: "x", call: {} as never, summary: { actionId: "x", args: {} }, status: "PENDING" }]);
  assert.equal(await store.transitionApproval("a", ["DECIDING"], "APPROVED"), false, "wrong source status");
  assert.equal(await store.transitionApproval("zzz", ["PENDING"], "DECIDING"), false, "unknown id");
  assert.equal(await store.transitionApproval("a", ["PENDING"], "DECIDING"), true);
  assert.equal(await store.transitionApproval("a", ["PENDING"], "DECIDING"), false, "a second claim fails");
  assert.deepEqual((await store.listDeciding()).map((a) => a.approvalId), ["a"]);
  const restored = InMemoryApprovalStore.restore(store.export());
  assert.equal((await restored.getApproval("a"))?.status, "DECIDING");
});

test("describeInterruption fails closed: another tool, malformed JSON or arguments the schema rejects are not bound", async () => {
  const kit = await createBridgeKit();
  const make = (name: string, args: string) => ({ rawItem: { type: "function_call", name, callId: "c", arguments: args, status: "completed" } }) as never;
  const good = JSON.stringify({ orderRef: "ORDER-7", sku: "A-100", qty: 7, amountEur: 2400, supplier: "vendor-1" });
  assert.equal(kit.host.describeInterruption(make("place_supplier_order", good))?.actionId, "po:ORDER-7");
  assert.equal(kit.host.describeInterruption(make("other_tool", good)), undefined);
  assert.equal(kit.host.describeInterruption(make("place_supplier_order", "{not json")), undefined);
  assert.equal(kit.host.describeInterruption(make("place_supplier_order", JSON.stringify({ orderRef: "ORDER-7" }))), undefined);
  assert.equal(kit.host.describeInterruption({ rawItem: { type: "hosted_tool_call", name: "place_supplier_order" } } as never), undefined);
});

// ---------------------------------------------------------------------------------------------------------------------
// F-1: ONE decision per approval; a late concurrent decision cannot bypass a human rejection
// ---------------------------------------------------------------------------------------------------------------------

/** Holds an Authority write of the human's decision until `release()`: a slow worker, not a dead one. */
function slowWrite(kit: BridgeKit, which: "approve" | "deny") {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const real = kit.host.recorder[which].bind(kit.host.recorder);
  kit.host.recorder[which] = async (actionId: string, who: string) => {
    await gate;
    return real(actionId, who);
  };
  return { release, restore: () => (kit.host.recorder[which] = real) };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const eventTypes = async (kit: BridgeKit) => await kit.host.journal();

test("F-1: a human REJECTION in flight cannot be bypassed by a late concurrent APPROVE; the rejected order needs a human again", async () => {
  const kit = await createBridgeKit();
  const paused = await pause(kit);
  const id = paused.approvals[0]!.approvalId;
  const slow = slowWrite(kit, "deny");
  const rejection = decideAs(kit, id, ALICE, "reject"); // the Authority write of the rejection is slow
  await tick();
  slow.restore();
  const claimed = await kit.store.getApproval(id);
  assert.equal(claimed?.status, "DECIDING");
  assert.equal(claimed?.intent, "reject");

  assert.deepEqual(await decideAs(kit, id, ALICE, "approve"), { status: "REFUSED", reason: "ALREADY_DECIDED" }, "the late approve cannot take the claim");
  assert.deepEqual(await kit.coordinator.completeStuckDecision(id), { status: "DECIDED", decision: "reject" }, "the operator completes the SAME intent");
  slow.release();
  assert.deepEqual(await rejection, { status: "REFUSED", reason: "PERSISTENCE_FAILED" }, "the original, slow writer is fenced by the claim token");

  assert.equal((await kit.store.getApproval(id))?.status, "REJECTED");
  const journal = await eventTypes(kit);
  assert.ok(!journal.includes("APPROVAL_GRANTED"), "no approval was ever written for a rejected decision");
  assert.match(JSON.stringify(results(await kit.coordinator.resume(paused.runId))), /A human rejected this order/);
  assert.equal(kit.host.supplier.orders.length, 0);

  // Rejection followed by a new request: it pauses for a human again and does NOT run.
  const again = await kit.coordinator.start(kit.agent([[callOrder(order("ORDER-7"), "call_2")], FINAL]), "ask again");
  assert.equal(again.status, "WAITING");
  assert.equal(kit.host.supplier.orders.length, 0);
  assert.ok(!(await eventTypes(kit)).includes("APPROVAL_GRANTED"));
});

test("F-1: an APPROVE in flight cannot be turned into a rejection, or the other way round, by a concurrent decision", async () => {
  const kit = await createBridgeKit();
  const paused = await pause(kit);
  const id = paused.approvals[0]!.approvalId;
  const slow = slowWrite(kit, "approve");
  const approval = decideAs(kit, id, ALICE, "approve");
  await tick();
  slow.restore();
  assert.deepEqual(await decideAs(kit, id, ALICE, "reject"), { status: "REFUSED", reason: "ALREADY_DECIDED" });
  assert.deepEqual(await kit.coordinator.completeStuckDecision(id), { status: "DECIDED", decision: "approve" });
  slow.release();
  assert.deepEqual(await approval, { status: "REFUSED", reason: "PERSISTENCE_FAILED" });
  const journal = await eventTypes(kit);
  assert.ok(!journal.includes("APPROVAL_DENIED"), "no refusal was ever written next to the approval");
  assert.equal(results(await kit.coordinator.resume(paused.runId))[0]?.status, "EXECUTED");
  assert.equal(kit.host.supplier.orders.length, 1);
});

test("F-1: the original writer that lands AFTER the completion only adds a duplicate of the SAME intent, never a conflicting one", async () => {
  const kit = await createBridgeKit();
  const paused = await pause(kit);
  const id = paused.approvals[0]!.approvalId;
  const slow = slowWrite(kit, "deny");
  const rejection = decideAs(kit, id, ALICE, "reject");
  await tick();
  slow.restore();
  await kit.coordinator.completeStuckDecision(id);
  slow.release();
  await rejection;
  const journal = await eventTypes(kit);
  assert.equal(journal.filter((e) => e === "APPROVAL_DENIED").length, 2, "the documented residual: a duplicate refusal");
  assert.equal(journal.filter((e) => e === "APPROVAL_GRANTED").length, 0, "and nothing that conflicts with it");
});

test("F-1: there is no automatic release of a claimed decision: the dangerous recovery is gone, completion is explicit and checks the reviewer again", async () => {
  const kit = await createBridgeKit();
  assert.equal((kit.coordinator as unknown as Record<string, unknown>).recoverStuckDecisions, undefined);
  const paused = await pause(kit);
  const id = paused.approvals[0]!.approvalId;
  kit.store.failTransitionTo = ["APPROVED"];
  await decideAs(kit, id, ALICE);
  // The host stops authorizing alice (for example her mandate ended): completion must not apply her stale decision.
  const revoked = new ApprovalCoordinator(kit.coordinatorConfig({ authorizeReviewer: async () => false }));
  assert.deepEqual(await revoked.completeStuckDecision(id), { status: "REFUSED", reason: "NOT_AUTHORIZED_FOR_THIS_APPROVAL" });
  assert.equal((await kit.store.getApproval(id))?.status, "DECIDING", "still held, not released");
  // The delegation is revoked meanwhile: completion re-checks the binding with Authority and voids the decision.
  await kit.host.revoke();
  assert.deepEqual(await kit.coordinator.completeStuckDecision(id), { status: "REFUSED", reason: "NO_LONGER_WAITING", detail: "C12_DELEGATION_REVOKED" });
  assert.equal((await kit.store.getApproval(id))?.status, "VOID");
  // Not stuck, unknown, or already finished: refused.
  assert.deepEqual(await kit.coordinator.completeStuckDecision(id), { status: "REFUSED", reason: "NOT_STUCK" });
  assert.deepEqual(await kit.coordinator.completeStuckDecision("appr-unknown"), { status: "REFUSED", reason: "NOT_STUCK" });
});

test("F-1: the claim token fences the store: a stale finisher cannot move a record that it no longer owns", async () => {
  const store = new InMemoryApprovalStore();
  const call = {} as never;
  await store.putRun({ runId: "r", snapshot: "{}", approvalIds: ["a"], status: "WAITING" }, [{ approvalId: "a", runId: "r", callId: "c", actionId: "x", call, summary: { actionId: "x", args: {} }, status: "PENDING" }]);
  assert.equal(await store.transitionApproval("a", ["PENDING"], "DECIDING", { decidedBy: "alice", intent: "approve", claimToken: "t1" }), true);
  assert.equal(await store.transitionApproval("a", ["DECIDING"], "DECIDING", { claimToken: "t2" }, "t1"), true, "the operator takes the claim over");
  assert.equal(await store.transitionApproval("a", ["DECIDING"], "APPROVED", { claimToken: null }, "t1"), false, "the stale owner is fenced");
  assert.equal((await store.getApproval("a"))?.status, "DECIDING");
  assert.equal(await store.transitionApproval("a", ["DECIDING"], "APPROVED", { claimToken: null }, "t2"), true);
  assert.equal((await store.getApproval("a"))?.claimToken, undefined);
  assert.equal((await store.getApproval("a"))?.intent, "approve", "the intent stays on the record");
});

// ---------------------------------------------------------------------------------------------------------------------
// F-2: unique ids, no overwrite
// ---------------------------------------------------------------------------------------------------------------------

test("F-2: after a restart no id is reused and the first approval still decides ITS action, whatever the id generator", async () => {
  for (const randomIds of [false, true]) {
    const kit = await createBridgeKit({ randomIds });
    const first = await pause(kit, order("ORDER-7"), "call_1");
    kit.restart();
    const second = await pause(kit, order("ORDER-9", 2500), "call_2");
    assert.notEqual(first.runId, second.runId);
    assert.notEqual(first.approvals[0]!.approvalId, second.approvals[0]!.approvalId);
    if (randomIds) {
      assert.match(first.runId, /^run-[0-9a-f-]{36}$/);
      assert.match(first.approvals[0]!.approvalId, /^appr-[0-9a-f-]{36}$/);
    }
    assert.equal((await kit.store.getApproval(first.approvals[0]!.approvalId))?.actionId, "po:ORDER-7", "the first record was not overwritten");
    assert.equal((await decideAs(kit, first.approvals[0]!.approvalId, ALICE)).status, "DECIDED");
    const granted = ((await kit.host.authority.events()) as unknown as { event_type: string; payload: { action_id?: string } }[]).filter((e) => e.event_type === "APPROVAL_GRANTED").map((e) => e.payload.action_id);
    assert.deepEqual(granted, ["po:ORDER-7"], "the reviewer who saw ORDER-7 approved ORDER-7, not ORDER-9");
    assert.equal((await kit.store.getApproval(second.approvals[0]!.approvalId))?.status, "PENDING");
  }
});

test("F-2: a repeated id is an ERROR, never an overwrite: the store refuses it and the first records are intact", async () => {
  const kit = await createBridgeKit();
  const first = await pause(kit, order("ORDER-7"), "call_1");
  const buggy = new ApprovalCoordinator(kit.coordinatorConfig({ newId: (prefix) => `${prefix}-1` })); // a generator that restarts from 1
  const o9 = kit.register(order("ORDER-9", 2500));
  await assert.rejects(buggy.start(kit.agent([[callOrder(o9, "call_2")], FINAL]), "go"), /duplicate (run|approval) id/);
  assert.equal((await kit.store.getApproval(first.approvals[0]!.approvalId))?.actionId, "po:ORDER-7");
  assert.equal((await kit.store.getRun(first.runId))?.status, "WAITING");
  const store = new InMemoryApprovalStore();
  const record = { approvalId: "a", runId: "r", callId: "c", actionId: "x", call: {} as never, summary: { actionId: "x", args: {} }, status: "PENDING" as const };
  await store.putRun({ runId: "r", snapshot: "{}", approvalIds: ["a"], status: "WAITING" }, [record]);
  await assert.rejects(store.putRun({ runId: "r2", snapshot: "{}", approvalIds: ["a"], status: "WAITING" }, [record]), /duplicate approval id/);
  await assert.rejects(store.putRun({ runId: "r", snapshot: "{}", approvalIds: [], status: "WAITING" }, []), /duplicate run id/);
  await assert.rejects(store.putRun({ runId: "r3", snapshot: "{}", approvalIds: ["b", "b"], status: "WAITING" }, [{ ...record, approvalId: "b" }, { ...record, approvalId: "b" }]), /duplicate approval id/);
  assert.equal(await store.getRun("r3"), undefined, "a refused putRun writes nothing");
});

test("F-2: the approval event ids written to the journal are unique across hosts (processes)", async () => {
  const ids = new Set<string>();
  for (let n = 0; n < 3; n++) {
    const host = await createHost({ approval: "authority" }); // a new host, as after a restart: no counter carries over
    await host.authority.authorize({ actionId: "po:X", agentId: "procurement-agent", delegationId: "d-1", capability: { resource: "purchase_order", action: "create" }, amount: { value: 2400, currency: "EUR" }, recipient: "v", args: {} });
    await host.recorder.approve("po:X", "alice");
    const events = (await host.authority.events()) as unknown as { event_type: string; payload: { approval_id?: string } }[];
    const approvalId = events.find((e) => e.event_type === "APPROVAL_REQUESTED")!.payload.approval_id!;
    assert.match(approvalId, /^ap-[0-9a-f-]{36}$/);
    ids.add(approvalId);
  }
  assert.equal(ids.size, 3);
});

// ---------------------------------------------------------------------------------------------------------------------
// F-3 to F-7
// ---------------------------------------------------------------------------------------------------------------------

test("F-3: a transient Authority outage during the binding check is not a refusal: the claim is released and the decision can be retried", async () => {
  for (const failure of ["unavailable", "throws"] as const) {
    const kit = await createBridgeKit();
    const paused = await pause(kit);
    const id = paused.approvals[0]!.approvalId;
    const real = kit.host.authority.authorize.bind(kit.host.authority);
    let down = true;
    (kit.host.authority as { authorize: unknown }).authorize = async (call: never) => {
      if (!down) return real(call);
      if (failure === "throws") throw new Error("connection reset");
      return { status: "UNAVAILABLE", code: "BACKEND_UNREACHABLE", diagnosticId: "diag" };
    };
    assert.deepEqual(await decideAs(kit, id, ALICE), { status: "REFUSED", reason: "UNAVAILABLE" }, failure);
    const released = await kit.store.getApproval(id);
    assert.equal(released?.status, "PENDING", "not VOID: the decision is not lost");
    assert.equal(released?.claimToken, undefined);
    down = false;
    assert.equal((await decideAs(kit, id, ALICE)).status, "DECIDED");
    assert.equal(results(await kit.coordinator.resume(paused.runId))[0]?.status, "EXECUTED");
    assert.equal(kit.host.supplier.orders.length, 1);
  }
});

test("F-3: a definite refusal (revoked) is final: VOID", async () => {
  const kit = await createBridgeKit();
  const paused = await pause(kit);
  await kit.host.revoke();
  assert.equal((await decideAs(kit, paused.approvals[0]!.approvalId, ALICE)).status, "REFUSED");
  assert.equal((await kit.store.getApproval(paused.approvals[0]!.approvalId))?.status, "VOID");
});

test("F-4: a non-grantor cannot complete or void a decision when Authority already authorizes the order; alice cannot 'reject' an authorized order either", async () => {
  const kit = await createBridgeKit();
  const paused = await pause(kit);
  const id = paused.approvals[0]!.approvalId;
  await kit.host.approve("po:ORDER-7"); // the grantor approved out of band: Authority answers AUTHORIZED
  assert.deepEqual(await decideAs(kit, id, "token-mallory", "approve"), { status: "REFUSED", reason: "NOT_AUTHORIZED_FOR_THIS_APPROVAL" });
  assert.deepEqual(await decideAs(kit, id, "token-mallory", "reject"), { status: "REFUSED", reason: "NOT_AUTHORIZED_FOR_THIS_APPROVAL" });
  assert.equal((await kit.store.getApproval(id))?.status, "PENDING");
  assert.equal((await kit.store.getApproval(id))?.decidedBy, undefined, "no non-grantor is recorded as the decider");
  assert.deepEqual(await decideAs(kit, id, ALICE, "reject"), { status: "REFUSED", reason: "ALREADY_AUTHORIZED" }, "a refusal would not revoke the existing approval, so it is not accepted");
  assert.equal((await kit.store.getApproval(id))?.status, "PENDING", "released, not voided");
  assert.deepEqual(await decideAs(kit, id, ALICE, "approve"), { status: "DECIDED", decision: "approve" });
  assert.equal((await kit.store.getApproval(id))?.decidedBy, "alice");
  assert.equal(results(await kit.coordinator.resume(paused.runId))[0]?.status, "EXECUTED");
});

test("F-5: any decision other than the exact strings 'approve' and 'reject' is refused before anything is claimed or written", async () => {
  const kit = await createBridgeKit();
  const paused = await pause(kit);
  const id = paused.approvals[0]!.approvalId;
  for (const decision of ["yes", "", "APPROVE", "approve ", "Reject", undefined, null, 1, true, {}, ["approve"]]) {
    assert.deepEqual(await kit.coordinator.decide({ approvalId: id, decision: decision as never, credential: ALICE }), { status: "REFUSED", reason: "INVALID_DECISION" }, String(JSON.stringify(decision)));
  }
  const record = await kit.store.getApproval(id);
  assert.equal(record?.status, "PENDING");
  assert.equal(record?.claimToken, undefined);
  assert.deepEqual(await eventTypes(kit), ["DELEGATION_CREATED", "ACTION_REQUESTED"], "nothing was written to Authority");
});

test("F-6: an unauthenticated caller gets the same answer for a real and an unknown approval id; an authenticated one does not learn ids it could not guess", async () => {
  const kit = await createBridgeKit();
  const paused = await pause(kit);
  const real = paused.approvals[0]!.approvalId;
  const answers = await Promise.all([real, "appr-999", "", "appr-unknown"].map((id) => decideAs(kit, id, undefined)));
  for (const answer of answers) assert.deepEqual(answer, { status: "REFUSED", reason: "NOT_AUTHENTICATED" });
  assert.deepEqual(await kit.coordinator.decide({ approvalId: { not: "a string" } as never, decision: "approve", credential: ALICE }), { status: "REFUSED", reason: "UNKNOWN_APPROVAL" });
  const randomKit = await createBridgeKit({ randomIds: true });
  const a = await pause(randomKit);
  assert.match(a.approvals[0]!.approvalId, /^appr-[0-9a-f-]{36}$/, "default ids are unguessable");
});

test("F-7: a run stuck in RESUMING is never resumed by guesswork: the operator marks it FAILED, the retry goes through guard() and nothing assumes that the effect did not run", async () => {
  const kit = await createBridgeKit();
  const paused = await pause(kit);
  await decideAs(kit, paused.approvals[0]!.approvalId, ALICE);
  kit.restart((data) => {
    for (const run of data.runs) {
      run.status = "RESUMING";
      (run as { resumeToken?: string }).resumeToken = "a-process-that-died";
    }
  });
  assert.deepEqual(await kit.coordinator.resume(paused.runId), { status: "REFUSED", reason: "NOT_RESUMABLE" });
  assert.deepEqual(await kit.coordinator.retryResume(paused.runId), { status: "REFUSED", reason: "NOT_RESUMABLE" });
  assert.deepEqual((await kit.coordinator.listStuckRuns()).map((r) => r.runId), [paused.runId]);
  assert.deepEqual(await kit.coordinator.recoverStuckRun(paused.runId), { status: "RECOVERED" });
  assert.deepEqual(await kit.coordinator.recoverStuckRun(paused.runId), { status: "NOT_STUCK" }, "only a stuck run can be recovered");
  assert.equal(results(await kit.coordinator.retryResume(paused.runId))[0]?.status, "EXECUTED");
  assert.equal(kit.host.supplier.orders.length, 1);
});

test("F-7: a slow resume that an operator recovered meanwhile cannot finish the run: the effect ran once, the retry is refused by guard()", async () => {
  const kit = await createBridgeKit();
  const paused = await pause(kit);
  await decideAs(kit, paused.approvals[0]!.approvalId, ALICE);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const realPlace = kit.host.supplier.place.bind(kit.host.supplier);
  kit.host.supplier.place = async (o) => {
    await gate; // the effect is slow: the resume is "stuck"
    return realPlace(o);
  };
  const slowResume = kit.coordinator.resume(paused.runId);
  await tick();
  assert.equal((await kit.store.getRun(paused.runId))?.status, "RESUMING");
  assert.deepEqual(await kit.coordinator.recoverStuckRun(paused.runId), { status: "RECOVERED" });
  release();
  assert.deepEqual(await slowResume, { status: "FAILED", runId: paused.runId, errorName: "ResumeSuperseded" }, "the original resume can no longer finish the run");
  assert.equal(kit.host.supplier.orders.length, 1, "the effect DID run: recovery never assumed that it had not");
  const retried = await kit.coordinator.retryResume(paused.runId);
  assert.equal(retried.status, "DONE");
  assert.match(JSON.stringify(results(retried)), /already processed by an earlier attempt/);
  assert.equal(kit.host.supplier.orders.length, 1);
});

test("F-7: the resume token fences by OWNER, not only by status: with a retry already in flight, the original resume still cannot finish the run", async () => {
  const kit = await createBridgeKit();
  const paused = await pause(kit);
  await decideAs(kit, paused.approvals[0]!.approvalId, ALICE);
  let releaseEffect!: () => void;
  const effectGate = new Promise<void>((resolve) => (releaseEffect = resolve));
  const realPlace = kit.host.supplier.place.bind(kit.host.supplier);
  kit.host.supplier.place = async (o) => {
    await effectGate;
    return realPlace(o);
  };
  const original = kit.coordinator.resume(paused.runId);
  await tick();
  assert.deepEqual(await kit.coordinator.recoverStuckRun(paused.runId), { status: "RECOVERED" });
  // The retry starts and is held in flight (its registry lookup is blocked), so the run is RESUMING again, under a NEW token.
  let releaseRetry!: () => void;
  const retryGate = new Promise<void>((resolve) => (releaseRetry = resolve));
  const realLookup = kit.registry.lookup.bind(kit.registry);
  kit.registry.lookup = async (ref) => {
    await retryGate;
    return realLookup(ref);
  };
  const retry = kit.coordinator.retryResume(paused.runId);
  await tick();
  assert.equal((await kit.store.getRun(paused.runId))?.status, "RESUMING");
  releaseEffect(); // the original finishes its effect while the retry owns the run
  assert.deepEqual(await original, { status: "FAILED", runId: paused.runId, errorName: "ResumeSuperseded" });
  assert.equal((await kit.store.getRun(paused.runId))?.status, "RESUMING", "the original did not mark the run FINISHED");
  releaseRetry();
  const retried = await retry;
  assert.equal(retried.status, "DONE");
  assert.equal(kit.host.supplier.orders.length, 1, "one effect in total");
  assert.equal((await kit.store.getRun(paused.runId))?.status, "FINISHED");
});

test("F-1: a completion never overrides a NEWER decision for the same action that was recorded since the claim", async () => {
  for (const intent of ["approve", "reject"] as const) {
    const kit = await createBridgeKit();
    const paused = await pause(kit);
    const id = paused.approvals[0]!.approvalId;
    const real = kit.host.recorder[intent === "approve" ? "approve" : "deny"].bind(kit.host.recorder);
    kit.host.recorder[intent === "approve" ? "approve" : "deny"] = async () => {
      throw new Error("write lost"); // the first decision never reached the journal: held DECIDING
    };
    assert.deepEqual(await decideAs(kit, id, ALICE, intent), { status: "REFUSED", reason: "DECISION_UNCERTAIN" });
    // The grantor then records the OPPOSITE decision out of band.
    if (intent === "approve") await kit.host.recorder.deny("po:ORDER-7", "alice");
    else await kit.host.approve("po:ORDER-7");
    kit.host.recorder[intent === "approve" ? "approve" : "deny"] = real;
    assert.deepEqual(await kit.coordinator.completeStuckDecision(id), { status: "REFUSED", reason: "NO_LONGER_WAITING", detail: "SUPERSEDED" }, intent);
    assert.equal((await kit.store.getApproval(id))?.status, "VOID");
    const authorize = await kit.host.authority.authorize((await kit.store.getApproval(id))!.call);
    assert.equal(authorize.status, intent === "approve" ? "REQUIRES_APPROVAL" : "AUTHORIZED", "Authority keeps the NEWER decision");
  }
});
