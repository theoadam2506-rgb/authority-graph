#!/usr/bin/env node
/** O2-1 targeted mutations: see scripts/mutation-runner.mjs for the rules (every mutant must be killed; non-zero exit otherwise). */
import { runMutants } from "./mutation-runner.mjs";

/** [name, file, from, to, expected occurrences] */
const MUTANTS = [
  ["optimization removed (the second read is back)", "src/sdk/authority.ts", "const snapshot = requested.snapshot ?? (await store.getEvents());", "const snapshot = await store.getEvents();", 1],
  ["a request this call just appended: the stale snapshot is reused", "src/sdk/authority.ts", "if (outcome !== undefined && outcome.accepted) return { snapshot: undefined };", "if (outcome !== undefined && outcome.accepted) return { snapshot: journal };", 1],
  ["a request appended by a racing identical call: the stale snapshot is reused", "src/sdk/authority.ts", "if (raced !== undefined && matches(raced)) return { snapshot: undefined };", "if (raced !== undefined && matches(raced)) return { snapshot: journal };", 1],
  ["a different call under an existing action id is no longer refused", "src/sdk/authority.ts", "return matches(existing) ? { snapshot: journal } : { refusal:", "return true ? { snapshot: journal } : { refusal:", 1],
];

process.exit(runMutants({
  tests: ["tests/sdk/o2Differential.test.ts"],
  env: { O2_SCENARIOS: process.env.O2_SCENARIOS ?? "120" },
  mutants: MUTANTS.filter((m) => m[4] > 0),
}));
