#!/usr/bin/env node
/** O2 (T1 lookup) targeted mutations: see scripts/mutation-runner.mjs for the rules (every mutant must be killed; non-zero exit otherwise). */
import { runMutants } from "./mutation-runner.mjs";

/** [name, file, from, to, expected occurrences] */
const LOOKUP = 'const existing = findRequest(await store.getEvents({ eventType: "ACTION_REQUESTED" }), call.actionId);';
const MUTANTS = [
  ["the lookup reads the whole journal again (optimization removed)", "src/sdk/authority.ts", 'store.getEvents({ eventType: "ACTION_REQUESTED" })', "store.getEvents()", 1],
  ["the lookup filters on the wrong event type", "src/sdk/authority.ts", 'store.getEvents({ eventType: "ACTION_REQUESTED" })', 'store.getEvents({ eventType: "CAPABILITY_ISSUED" })', 1],
  ["the pre-check decides on the filtered rows instead of the whole journal", "src/sdk/authority.ts", "const at = readClock(clock);\n      const snapshot = await store.getEvents();", 'const at = readClock(clock);\n      const snapshot = await store.getEvents({ eventType: "ACTION_REQUESTED" });', 1],
  ["the lookup takes the LAST matching request instead of the first", "src/sdk/authority.ts", "function findRequest(store: CanonicalStore, id: ActionId) {\n  for (const event of store) {", "function findRequest(store: CanonicalStore, id: ActionId) {\n  for (const event of [...store].reverse()) {", 1],
  ["an error thrown by a malformed row during the lookup is swallowed", "src/sdk/authority.ts", LOOKUP, 'const rows = await store.getEvents({ eventType: "ACTION_REQUESTED" });\n    const existing = (() => { try { return findRequest(rows, call.actionId); } catch { return undefined; } })();', 1],
  ["a different call under an existing action id is no longer refused", "src/sdk/authority.ts", "return matches(existing) ? undefined : { status: \"DENIED\", reason: \"ACTION_ID_REUSED_WITH_DIFFERENT_CALL\" };", "return undefined;", 1],
];

process.exit(runMutants({
  tests: ["tests/sdk/o2Differential.test.ts"],
  env: { O2_SCENARIOS: process.env.O2_SCENARIOS ?? "120" },
  mutants: MUTANTS.filter((m) => m[4] > 0),
}));
