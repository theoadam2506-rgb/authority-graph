/** The adapter on its own: the mapping of every Authority result, the identity, the idempotency key, the operator/model split. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GuardResult } from "authority-graph-sdk";
import { toModelResult } from "../src/authorityTool.js";
import { createHost } from "../src/host.js";
import { askModel } from "../src/scripted.js";

const order = (orderRef: string, extra: Record<string, unknown> = {}) => ({ orderRef, sku: "A-100", qty: 7, amountEur: 1800, supplier: "vendor-1", ...extra });
const REPORTED = { status: "REPORTED", sequence: 5 } as const;

test("toModelResult: every GuardResult has one answer, and only a returned effect is EXECUTED", () => {
  const cases: [GuardResult<unknown>, string, string | undefined][] = [
    [{ status: "EXECUTED", value: { ok: true }, report: REPORTED }, "EXECUTED", undefined],
    [{ status: "EXECUTED", value: undefined, report: { status: "UNAVAILABLE", code: "BACKEND_ERROR", diagnosticId: "diag-x" } }, "EXECUTED", undefined],
    [{ status: "EFFECT_FAILED", code: "EFFECT_THREW", diagnosticId: "diag-x", ticketConsumed: true, report: REPORTED }, "OUTCOME_UNKNOWN", undefined],
    [{ status: "BLOCKED", stage: "authorize", result: { status: "REQUIRES_APPROVAL", viaDelegation: "d-1" } }, "APPROVAL_REQUIRED", undefined],
    [{ status: "BLOCKED", stage: "authorize", result: { status: "DENIED", reason: "C12_DELEGATION_REVOKED" } }, "NOT_EXECUTED", "C12_DELEGATION_REVOKED"],
    [{ status: "BLOCKED", stage: "authorize", result: { status: "UNKNOWN", reason: "BROKEN_CHAIN" } }, "NOT_EXECUTED", "UNKNOWN:BROKEN_CHAIN"],
    [{ status: "BLOCKED", stage: "authorize", result: { status: "UNAVAILABLE", code: "BACKEND_UNREACHABLE", diagnosticId: "diag-x" } }, "NOT_EXECUTED", "BACKEND_UNREACHABLE"],
    [{ status: "BLOCKED", stage: "redeem", result: { status: "REFUSED", reason: "ALREADY_REDEEMED", ticketConsumed: false } }, "NOT_EXECUTED", "ALREADY_REDEEMED"],
    [{ status: "BLOCKED", stage: "redeem", result: { status: "UNKNOWN_OUTCOME", code: "OUTCOME_UNCERTAIN", diagnosticId: "diag-x" } }, "NOT_EXECUTED", "OUTCOME_UNCERTAIN"],
    [{ status: "BLOCKED", stage: "redeem", result: { status: "UNAVAILABLE", code: "CLOCK_INVALID", diagnosticId: "diag-x" } }, "NOT_EXECUTED", "CLOCK_INVALID"],
  ];
  for (const [input, status, reason] of cases) {
    const out = toModelResult(input);
    assert.equal(out.status, status);
    if (reason !== undefined) assert.equal((out as { reason: string }).reason, reason);
    assert.ok(!JSON.stringify(out).includes("diag-"), "no diagnostic id reaches the model");
  }
});

test("the effect receives the ticket id as its idempotency key; a new order reference gets another", async () => {
  const host = await createHost();
  await askModel(host, [order("ORDER-1"), order("ORDER-1-AGAIN")]);
  const issued = ((await host.authority.events()) as unknown as { event_type: string; payload: { capability_id: string } }[])
    .filter((e) => e.event_type === "CAPABILITY_ISSUED")
    .map((e) => e.payload.capability_id);
  assert.equal(issued.length, 2);
  assert.deepEqual(host.supplier.orders.map((o) => o.idempotencyKey), issued);
  assert.notEqual(issued[0], issued[1]);
});

test("identity and delegation come from the host: keys the model adds to its arguments are dropped", async () => {
  const host = await createHost();
  const { toolOutputs } = await askModel(host, [order("ORDER-1", { agentId: "someone-else", delegationId: "another-delegation", requesting_principal_id: "root" })]);
  assert.equal(toolOutputs[0]?.status, "EXECUTED");
  const requested = ((await host.authority.events()) as unknown as { event_type: string; payload: { requesting_principal_id: string; delegation_id: string } }[]).find((e) => e.event_type === "ACTION_REQUESTED");
  assert.equal(requested?.payload.requesting_principal_id, "procurement-agent");
  assert.equal(requested?.payload.delegation_id, "d-1");
});

test("arguments the schema rejects stop in the Agents SDK: Authority is not asked and the supplier is not called", async () => {
  const host = await createHost();
  const { toolOutputs } = await askModel(host, [order("ORDER-1", { amountEur: 1800.5 }), order("", {}), { orderRef: "ORDER-2" }]);
  assert.deepEqual(toolOutputs.map((o) => o.status), ["SDK_TOOL_ERROR", "SDK_TOOL_ERROR", "SDK_TOOL_ERROR"]);
  assert.equal(host.supplier.orders.length, 0);
  assert.ok(!(await host.journal()).includes("ACTION_REQUESTED"));
});

test("the raw error goes to the operator, never to the model", async () => {
  const host = await createHost();
  host.supplier.behaviour = "completes-then-loses-reply";
  const { toolOutputs } = await askModel(host, [order("ORDER-1")]);
  assert.equal(toolOutputs[0]?.status, "OUTCOME_UNKNOWN");
  assert.ok(!JSON.stringify(toolOutputs).includes("timeout"));
  const diagnostic = host.diagnostics.find((d) => d.operation === "guard.effect");
  assert.ok(diagnostic, "the operator got a diagnostic");
  assert.match(String((diagnostic.cause as Error).message), /timeout while waiting for the supplier's reply/);
});

test("the effect is run at most once per ticket: asking twice in one run calls the supplier once", async () => {
  const host = await createHost();
  const { toolOutputs, modelCalls } = await askModel(host, [order("ORDER-1"), order("ORDER-1")]);
  assert.deepEqual(toolOutputs.map((o) => o.status), ["EXECUTED", "NOT_EXECUTED"]);
  assert.equal(modelCalls, 3, "two tool calls and a final answer, no pause for approval");
  assert.equal(host.supplier.orders.length, 1);
});

test("the order reference is a MODEL argument: its format is checked, its legitimacy is not (the example does not register orders)", async () => {
  const host = await createHost();
  // A reference that no order ever had, invented by the (scripted) model: accepted, because the delegation allows it.
  const invented = await askModel(host, [order("NEVER-REGISTERED-42")]);
  assert.equal(invented.toolOutputs[0]?.status, "EXECUTED");
  // A second invented reference for the same purchase is a different action: nothing links the two.
  const again = await askModel(host, [order("A-DIFFERENT-REFERENCE")]);
  assert.equal(again.toolOutputs[0]?.status, "EXECUTED");
  assert.equal(host.supplier.orders.length, 2);
  // Only the format is validated by zod.
  const badFormat = await askModel(host, [order("x".repeat(65))]);
  assert.equal(badFormat.toolOutputs[0]?.status, "SDK_TOOL_ERROR");
});
