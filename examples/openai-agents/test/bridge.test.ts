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

test("an authenticated reviewer who is not the grantor is refused BY AUTHORITY, and the approval stays pending for alice", async () => {
  const kit = await createBridgeKit();
  const paused = await pause(kit);
  const id = paused.approvals[0]!.approvalId;
  for (const token of ["token-mallory", "token-agent"]) {
    assert.deepEqual(await decideAs(kit, id, token), { status: "REFUSED", reason: "NOT_ACCEPTED_BY_AUTHORITY", detail: "UNAUTHORIZED_APPROVAL_DECISION" });
  }
  assert.ok(!(await kit.host.journal()).includes("APPROVAL_GRANTED"));
  assert.equal((await kit.store.getApproval(id))?.status, "PENDING");
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
  const coordinator = new ApprovalCoordinator({
    authority: kit.host.authority,
    recorder: kit.host.recorder,
    describeInterruption: kit.host.describeInterruption,
    store: new InMemoryApprovalStore(),
    authenticator: new SimulatedTokenAuthenticator({}),
    agentFactory: () => strayAgent([FINAL]),
  });
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
test("window 1: Authority wrote the approval, the coordinator could not persist it: nothing resumes, recovery lets the decision complete, one execution", async () => {
  const kit = await createBridgeKit();
  const paused = await pause(kit);
  const id = paused.approvals[0]!.approvalId;
  kit.store.failTransitionTo = ["APPROVED"];
  assert.deepEqual(await decideAs(kit, id, ALICE), { status: "REFUSED", reason: "PERSISTENCE_FAILED" });
  assert.ok((await kit.host.journal()).includes("APPROVAL_GRANTED"), "Authority holds the approval");
  assert.equal((await kit.store.getApproval(id))?.status, "DECIDING");
  assert.deepEqual(await kit.coordinator.resume(paused.runId), { status: "REFUSED", reason: "DECISIONS_PENDING" });
  assert.equal(kit.host.supplier.orders.length, 0, "nothing runs from a decision that was not persisted");
  assert.deepEqual(await decideAs(kit, id, ALICE), { status: "REFUSED", reason: "ALREADY_DECIDED" });
  assert.equal(await kit.coordinator.recoverStuckDecisions(), 1);
  assert.deepEqual(await decideAs(kit, id, ALICE), { status: "DECIDED", decision: "approve" });
  assert.equal(results(await kit.coordinator.resume(paused.runId))[0]?.status, "EXECUTED");
  assert.equal(kit.host.supplier.orders.length, 1);
  assert.equal((await kit.host.journal()).filter((e) => e === "APPROVAL_GRANTED").length, 1, "the decision was not written twice");
});

test("window 1b: Authority could not take the approval (unavailable): the claim is released and a retry works", async () => {
  const faults: HostFaults = { failToRecordApproval: true };
  const kit = await createBridgeKit({ faults });
  const paused = await pause(kit);
  const id = paused.approvals[0]!.approvalId;
  assert.deepEqual(await decideAs(kit, id, ALICE), { status: "REFUSED", reason: "UNAVAILABLE" });
  assert.equal((await kit.store.getApproval(id))?.status, "PENDING");
  faults.failToRecordApproval = false;
  assert.equal((await decideAs(kit, id, ALICE)).status, "DECIDED");
  assert.equal(results(await kit.coordinator.resume(paused.runId))[0]?.status, "EXECUTED");
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
