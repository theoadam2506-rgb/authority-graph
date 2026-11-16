#!/usr/bin/env node
/**
 * Authority Conformance Lab V0 command line.
 *
 *   npm run conformance -- --target simulated:compliant
 *   npm run conformance -- --target opa --opa-bin /path/to/opa --out report.json
 *
 * Exit codes: 0 all PASS, 1 at least one FAIL, 2 no FAIL but at least one
 * INCONCLUSIVE, 64 usage or scenario error.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseScenarioJson } from "./scenario.js";
import { connectOpa, DEFAULT_POLICY_PATH, spawnOpa, type RunningOpa } from "./opaTarget.js";
import { runConformance, sha256, type LoadedScenario } from "./runner.js";
import { SIMULATED_MODES, startSimulatedTarget, type RunningSimulatedTarget, type SimulatedMode } from "./simulatedTarget.js";
import { stableStringify } from "./stableJson.js";
import { createHash } from "node:crypto";

const USAGE = `Usage: conformance --target <simulated:compliant|simulated:faulty-revocation|simulated:faulty-delegation|opa>
                   [--opa-bin <path-to-opa> | --opa-url <http://host:port>] [--policy <file.rego>]
                   [--scenarios <dir>] [--out <report.json>]`;

function parse(argv: readonly string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === undefined || !k.startsWith("--") || v === undefined) throw new Error(`bad arguments near ${JSON.stringify(k)}\n${USAGE}`);
    m.set(k.slice(2), v);
  }
  return m;
}

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2));
  const target = args.get("target");
  if (target === undefined) throw new Error(USAGE);
  const dir = args.get("scenarios") ?? "conformance/scenarios";
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) throw new Error(`no scenario files in ${dir}`);
  const loaded: LoadedScenario[] = [];
  for (const f of files) {
    const text = await readFile(join(dir, f), "utf8");
    loaded.push({ scenario: parseScenarioJson(text, f), sha256: sha256(text) });
  }

  let running: RunningSimulatedTarget | RunningOpa;
  if (target.startsWith("simulated:")) {
    const mode = target.slice("simulated:".length);
    if (!(SIMULATED_MODES as readonly string[]).includes(mode)) throw new Error(`unknown simulated mode ${mode}\n${USAGE}`);
    running = await startSimulatedTarget(mode as SimulatedMode);
  } else if (target === "opa") {
    const policy = args.get("policy") ?? DEFAULT_POLICY_PATH;
    const bin = args.get("opa-bin");
    const url = args.get("opa-url");
    if ((bin === undefined) === (url === undefined)) throw new Error(`opa target needs exactly one of --opa-bin or --opa-url\n${USAGE}`);
    if (bin !== undefined) running = await spawnOpa(bin, policy);
    else running = connectOpa(url as string, policy, createHash("sha256").update(await readFile(policy)).digest("hex"));
  } else {
    throw new Error(`unknown target ${target}\n${USAGE}`);
  }

  try {
    const report = await runConformance(loaded, running.adapter);
    const text = stableStringify(report);
    const out = args.get("out");
    if (out !== undefined) await writeFile(out, text);
    const summary = report.summary as { result: string; probes: Record<string, number> };
    for (const s of report.scenarios as { scenario_id: string; result: string; probes: { probe_id: string; result: string; diff: string | null }[] }[]) {
      console.log(`${s.result.padEnd(12)} ${s.scenario_id}`);
      for (const p of s.probes) console.log(`  ${p.result.padEnd(12)} ${p.probe_id}${p.diff ? `  (${p.diff})` : ""}`);
    }
    console.log(`\nTarget: ${(report.target as { kind: string; name: string }).kind} / ${(report.target as { name: string }).name}`);
    console.log(`Overall: ${summary.result}  (PASS ${summary.probes.PASS}, FAIL ${summary.probes.FAIL}, INCONCLUSIVE ${summary.probes.INCONCLUSIVE})`);
    if (out === undefined) console.log("(no --out given: report not written)");
    return summary.result === "PASS" ? 0 : summary.result === "FAIL" ? 1 : 2;
  } finally {
    await running.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => { console.error((err as Error).message); process.exit(64); },
);
