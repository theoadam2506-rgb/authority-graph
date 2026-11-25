#!/usr/bin/env node
/**
 * Shared, portable mutation runner (plain Node: no sed -i, no GNU/BSD differences, no stray files).
 *
 * Each mutant is an exact, literal text replacement in one source file (it must match exactly the expected number of
 * times, otherwise the mutant definition itself is broken and the run FAILS). The given tests must then FAIL.
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

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @param {{ tests: string[], env?: Record<string,string>, mutants: [string,string,string,string,number][] }} spec */
export function runMutants({ tests, env = {}, mutants }) {
  const ENV = { ...process.env, ...env };
  const originals = new Map();
  for (const f of new Set(mutants.map((m) => m[1]))) originals.set(f, readFileSync(join(ROOT, f), "utf8"));
  const logDir = mkdtempSync(join(tmpdir(), "mutation-"));
  let restored = false;
  const restore = () => { if (restored) return; restored = true; for (const [f, text] of originals) writeFileSync(join(ROOT, f), text); };
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { restore(); rmSync(logDir, { recursive: true, force: true }); process.exit(130); });
  const runTests = (label) => {
    const r = spawnSync("npx", ["vitest", "run", ...tests], { cwd: ROOT, env: ENV, encoding: "utf8", shell: process.platform === "win32" });
    writeFileSync(join(logDir, `${label.replace(/[^a-z0-9]+/gi, "_")}.log`), `${r.stdout}\n${r.stderr}`);
    return r;
  };
  let problems = 0;
  try {
    const base = runTests("baseline");
    if (base.status !== 0) { console.error("BASELINE: the unmutated tests do not pass; the mutation run is meaningless.\n" + (base.stdout + base.stderr).slice(-1500)); problems++; }
    else {
      console.log("baseline: pass");
      for (const [name, file, from, to, expected] of mutants) {
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
  console.log(problems === 0 ? `all ${mutants.length} mutants killed` : `${problems} problem(s)`);
  return problems === 0 ? 0 : 1;
}
