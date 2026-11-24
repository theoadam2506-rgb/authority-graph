/** The architecture B demo prints exactly `expected-output-b.txt`, deterministically, and says what it does not show. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { formatBridgeScenarios, runBridgeScenarios } from "../src/bridgeScenarios.js";

const scenarios = await runBridgeScenarios();

test("the architecture B demo prints exactly expected-output-b.txt, twice in a row", async () => {
  const expected = readFileSync(new URL("../expected-output-b.txt", import.meta.url), "utf8").trimEnd();
  assert.equal(formatBridgeScenarios(scenarios), expected);
  assert.equal(formatBridgeScenarios(await runBridgeScenarios()), expected);
});

test("the demo covers every scenario and states its limits", () => {
  assert.deepEqual(scenarios.map((s) => s.id), ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9"]);
  const text = formatBridgeScenarios(scenarios);
  for (const needle of ["SIMULATED", "atomic only inside one event loop", "Neither is authentication", "the target must deduplicate", "would not survive a real restart", "guard(), never by the SDK's pause or approval"]) {
    assert.ok(text.includes(needle), needle);
  }
});

test("nothing the demo prints carries a raw error, a host detail, a random id or a credential value", () => {
  const text = formatBridgeScenarios(scenarios);
  for (const forbidden of ["model unavailable", "journal write failed\"", "store unavailable", "diag-", "diagnosticId", "cap-", "token-alice", "token-mallory"]) {
    assert.ok(!text.includes(forbidden), forbidden);
  }
});
