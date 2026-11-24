/**
 * The scenarios of the example, asserted. Each test states what architecture A really covers; the README says what
 * it does not. The "model" is scripted, so none of this shows how a language model behaves.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { formatScenarios, runScenarios, type Scenario } from "../src/scenarios.js";

const scenarios = await runScenarios();
const scenario = (id: number): Scenario => {
  const found = scenarios.find((s) => s.id === id);
  assert.ok(found, `scenario ${id}`);
  return found;
};
const told = (id: number, part = 0) => scenario(id).parts[part]!.steps.map((s) => s.told);

test("1. an order under the automatic limit is authorized, redeemed once, placed once and reported", () => {
  const p = scenario(1).parts[0]!;
  assert.deepEqual(told(1), [{ status: "EXECUTED", value: { confirmation: "CONF-1" }, recorded: true }]);
  assert.equal(p.supplier.length, 1);
  assert.deepEqual(p.journal, ["DELEGATION_CREATED", "ACTION_REQUESTED", "CAPABILITY_ISSUED", "CAPABILITY_REDEEMED", "ACTION_EXECUTED(EXECUTED)"]);
});

test("2. an order beyond the delegation is refused with a fixed reason: no ticket, the supplier is never called", () => {
  const p = scenario(2).parts[0]!;
  assert.deepEqual(told(2), [{ status: "NOT_EXECUTED", reason: "C9_TOTAL_BUDGET_EXCEEDED", message: "The order was not placed." }]);
  assert.equal(p.supplier.length, 0);
  assert.ok(!p.journal.includes("CAPABILITY_ISSUED"));
});

test("3. above the automatic limit the model is told to wait; after the host records alice's approval, the same order runs once", () => {
  const p = scenario(3).parts[0]!;
  const [first, second] = told(3);
  assert.equal(first?.status, "APPROVAL_REQUIRED");
  assert.deepEqual(second, { status: "EXECUTED", value: { confirmation: "CONF-1" }, recorded: true });
  assert.ok(p.facts.some((f) => f.includes("held 0 order(s) before the approval")));
  assert.ok(p.journal.indexOf("APPROVAL_GRANTED") < p.journal.indexOf("CAPABILITY_ISSUED"), "the ticket comes after the approval");
  assert.equal(p.supplier.length, 1);
});

test("4. after an approval, the same order reference with another amount, sku or supplier is refused; the honest request still runs", () => {
  const p = scenario(4).parts[0]!;
  const outputs = told(4);
  assert.equal(outputs[0]?.status, "APPROVAL_REQUIRED");
  for (const refused of outputs.slice(1, 4)) assert.deepEqual(refused, { status: "NOT_EXECUTED", reason: "ACTION_ID_REUSED_WITH_DIFFERENT_CALL", message: "The order was not placed." });
  assert.deepEqual(outputs[4], { status: "EXECUTED", value: { confirmation: "CONF-1" }, recorded: true });
  assert.equal(p.supplier.length, 1);
  assert.equal(p.supplier[0]?.amountEur, 3500, "the supplier received the approved amount, not the changed one");
});

test("5. a revocation after the approval, before the model asks again, refuses the order and every new one", () => {
  const p = scenario(5).parts[0]!;
  const outputs = told(5);
  assert.equal(outputs[0]?.status, "APPROVAL_REQUIRED");
  assert.deepEqual(outputs.slice(1), [
    { status: "NOT_EXECUTED", reason: "C12_DELEGATION_REVOKED", message: "The order was not placed." },
    { status: "NOT_EXECUTED", reason: "C12_DELEGATION_REVOKED", message: "The order was not placed." },
  ]);
  assert.equal(p.supplier.length, 0);
  assert.ok(!p.journal.includes("CAPABILITY_ISSUED"));
  assert.match(scenario(5).notShown ?? "", /between authorization and redemption is NOT covered/);
});

test("6. asking for the same order again never reruns the effect", () => {
  const [placedTwice, approvedTwice, journalFails] = scenario(6).parts;
  assert.equal(told(6, 0)[1]?.status, "NOT_EXECUTED");
  assert.equal((told(6, 0)[1] as { reason: string }).reason, "ALREADY_REDEEMED");
  assert.equal(placedTwice?.supplier.length, 1);
  assert.equal((told(6, 1)[2] as { reason: string }).reason, "C7_APPROVAL_ALREADY_CONSUMED");
  assert.equal(approvedTwice?.supplier.length, 1);
  // The journal write after the effect failed: the model is told so, and the ticket is still consumed.
  assert.equal((told(6, 2)[0] as { recorded: boolean }).recorded, false);
  assert.equal((told(6, 2)[1] as { reason: string }).reason, "ALREADY_REDEEMED");
  assert.equal(journalFails?.supplier.length, 1);
  assert.ok(!journalFails?.journal.some((e) => e.startsWith("ACTION_EXECUTED")));
});

test("7a. a lost reply is OUTCOME_UNKNOWN, journaled EFFECT_FAILED; the effect was received once and is never rerun", () => {
  const p = scenario(7).parts[0]!;
  assert.equal(told(7, 0)[0]?.status, "OUTCOME_UNKNOWN");
  assert.equal((told(7, 0)[1] as { reason: string }).reason, "ALREADY_REDEEMED");
  assert.equal(p.supplier.length, 1, "the supplier DID record the order");
  assert.ok(p.journal.includes("ACTION_EXECUTED(EFFECT_FAILED)"));
  assert.ok(!p.journal.includes("ACTION_EXECUTED(EXECUTED)"));
});

test("7b. a retry under another order reference is a new action with a new key: the supplier is called twice for one purchase", () => {
  const p = scenario(7).parts[1]!;
  assert.equal(told(7, 1)[0]?.status, "OUTCOME_UNKNOWN");
  assert.equal(told(7, 1)[1]?.status, "EXECUTED");
  assert.equal(p.supplier.length, 2, "Authority did not, and cannot, prevent the duplicate");
  assert.notEqual(p.supplier[0]?.idempotencyKey, p.supplier[1]?.idempotencyKey);
  assert.deepEqual(p.supplier.map((o) => o.orderRef), ["ORDER-3", "ORDER-3-RETRY"]);
});

test("7c. a supplier that REFUSED the order and a supplier that completed it with a lost reply look the same to the model", () => {
  const lost = scenario(7).parts[0]!;
  const refused = scenario(7).parts[2]!;
  assert.deepEqual(refused.steps[0]?.told, lost.steps[0]?.told);
  assert.equal(lost.supplier.length, 1);
  assert.equal(refused.supplier.length, 0);
});

test("7d. a lost redemption acknowledgement: the supplier is never called, the ticket is consumed, a retry is ALREADY_REDEEMED", () => {
  const p = scenario(7).parts[3]!;
  assert.equal((told(7, 3)[0] as { reason: string }).reason, "OUTCOME_UNCERTAIN");
  assert.equal((told(7, 3)[1] as { reason: string }).reason, "ALREADY_REDEEMED");
  assert.equal(p.supplier.length, 0);
  assert.equal(p.journal.filter((e) => e === "CAPABILITY_REDEEMED").length, 1);
});

test("nothing the model is told carries a raw error, a host detail or a diagnostic id", () => {
  const everything = JSON.stringify(scenarios.flatMap((s) => s.parts.flatMap((p) => p.steps.map((st) => st.told))));
  for (const forbidden of ["timeout while waiting", "supplier refused the order", "connection reset", "journal write failed", "diag-", "diagnosticId", "cap-"]) {
    assert.ok(!everything.includes(forbidden), forbidden);
  }
});

test("the demo prints exactly expected-output.txt, twice in a row", async () => {
  const expected = readFileSync(new URL("../expected-output.txt", import.meta.url), "utf8").trimEnd();
  assert.equal(formatScenarios(scenarios), expected);
  assert.equal(formatScenarios(await runScenarios()), expected);
});
