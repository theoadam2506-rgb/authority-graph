#!/usr/bin/env node
/**
 * O1 targeted mutations (portable: plain Node, no sed -i, no GNU/BSD differences, no stray files).
 *
 * Each mutant is an exact, literal text replacement in one source file (it must match exactly the expected number of
 * times, otherwise the mutant definition itself is broken and the run FAILS). The differential tests must then FAIL.
 * The run exits non-zero if: the unmutated baseline does not pass; a mutant survives (the tests still pass);
 * a mutant definition no longer matches; or a test run ends for a reason other than ordinary test failures.
 *
 * Originals are held in memory and restored in a `finally` and on SIGINT/SIGTERM. Logs go to a temporary directory
 * that is removed at the end. The repository is left byte for byte as found (checked at the end).
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TESTS = ["tests/engine/o1Differential.test.ts", "tests/engine/o1Targeted.test.ts"];
const ENV = { ...process.env, O1_JOURNALS: process.env.O1_JOURNALS ?? "400" };

/** [name, file, from, to, expected occurrences] */
const MUTANTS = [
  ["shape check always true", "src/engine/issueCapability.ts", "const lazyGrants = isJournalShapeSound(store);", "const lazyGrants = true;", 1],
  ["shape check ignores granted_chain_ref", "src/engine/journalShape.ts", "isInt(p.decision_sequence) && isChain(p.granted_chain_ref)", "isInt(p.decision_sequence)", 1],
  ["shape check ignores expires_at of a grant", "src/engine/journalShape.ts", "isStr(p.enforcement_point_id) && isStr(p.expires_at);", "isStr(p.enforcement_point_id);", 1],
  ["shape check ignores capabilities arrays", "src/engine/journalShape.ts", "Array.isArray(p.capabilities) && p.capabilities.every(isCapability)", "true", 2],
  ["shape check ignores constraints", "src/engine/journalShape.ts", "return isConstraints(p) && ", "return ", 2],
  ["shape check ignores ACTION_REQUESTED payload", "src/engine/journalShape.ts", "isCapability(p.capability_requested) && isWellFormedActionParameters(p.parameters)", "true", 1],
  ["shape check ignores execution_result", "src/engine/journalShape.ts", " && isStr(p.execution_result);", ";", 1],
  ["grants never collected for a bounded delegation", "src/engine/issueCapability.ts", "existingGrants ??= collectValidatedGrants(store);", "existingGrants ??= [];", 1],
  ["action index returns the LAST match", "src/engine/journalIndex.ts", "if (!this.actions.has(key)) this.actions.set(key, event);", "this.actions.set(key, event);", 1],
  ["delegation index returns the LAST match", "src/engine/journalIndex.ts", "if (!this.delegations.has(key)) this.delegations.set(key, event);", "this.delegations.set(key, event);", 1],
  ["index never falls back (swallows anomalies)", "src/engine/journalIndex.ts", "this.unsafe = true;", "this.unsafe = false;", 1],
  ["index ignores SUBDELEGATION_CREATED", "src/engine/journalIndex.ts", 'type === "DELEGATION_CREATED" || type === "SUBDELEGATION_CREATED"', 'type === "DELEGATION_CREATED"', 1],
  ["capacity lookup bypassed", "src/engine/capacity.ts", "lookup.actionRequested(grant.event.payload.action_id, (id) => findActionRequested(id, visibleStore))", "undefined", 1],
];

const originals = new Map();
const touched = [...new Set(MUTANTS.map((m) => m[1]))];
for (const f of touched) originals.set(f, readFileSync(join(ROOT, f), "utf8"));
const logDir = mkdtempSync(join(tmpdir(), "o1-mutation-"));
let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  for (const [f, text] of originals) writeFileSync(join(ROOT, f), text);
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { restore(); rmSync(logDir, { recursive: true, force: true }); process.exit(130); });

function runTests(label) {
  const r = spawnSync("npx", ["vitest", "run", ...TESTS], { cwd: ROOT, env: ENV, encoding: "utf8", shell: process.platform === "win32" });
  writeFileSync(join(logDir, `${label.replace(/[^a-z0-9]+/gi, "_")}.log`), `${r.stdout}\n${r.stderr}`);
  return r;
}

let problems = 0;
try {
  const base = runTests("baseline");
  if (base.status !== 0) { console.error("BASELINE: the unmutated tests do not pass; the mutation run is meaningless.\n" + (base.stdout + base.stderr).slice(-1500)); problems++; }
  else {
    console.log("baseline: pass");
    for (const [name, file, from, to, expected] of MUTANTS) {
      const original = originals.get(file);
      const count = original.split(from).length - 1;
      if (count !== expected) { console.error(`MUTANT ${name}: BROKEN DEFINITION (found ${count} occurrence(s) of the text, expected ${expected})`); problems++; continue; }
      writeFileSync(join(ROOT, file), original.split(from).join(to));
      const r = runTests(name);
      writeFileSync(join(ROOT, file), original);
      if (r.error || r.status === null) { console.error(`MUTANT ${name}: the test run did not complete (${r.error ?? r.signal})`); problems++; }
      else if (r.status === 0) { console.error(`MUTANT ${name}: SURVIVED (the tests still pass)  <-- gap`); problems++; }
      else if (r.status !== 1) { console.error(`MUTANT ${name}: unexpected exit status ${r.status} (not an ordinary test failure)`); problems++; }
      else console.log(`MUTANT ${name}: killed`);
    }
  }
} finally {
  restore();
  rmSync(logDir, { recursive: true, force: true });
}
for (const [f, text] of originals) if (readFileSync(join(ROOT, f), "utf8") !== text) { console.error(`FATAL: ${f} was not restored`); problems++; }
console.log(problems === 0 ? `all ${MUTANTS.length} mutants killed` : `${problems} problem(s)`);
process.exit(problems === 0 ? 0 : 1);
