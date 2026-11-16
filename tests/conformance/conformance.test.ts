import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { httpAdapter, mapEngineDecision, type TargetAdapter } from "../../src/conformance/adapter.js";
import { computeExpected } from "../../src/conformance/expected.js";
import { spawnOpa } from "../../src/conformance/opaTarget.js";
import { runConformance, sha256, type LoadedScenario } from "../../src/conformance/runner.js";
import { ScenarioError, parseScenario, parseScenarioJson } from "../../src/conformance/scenario.js";
import { SIMULATED_MODES, startSimulatedTarget, type SimulatedMode } from "../../src/conformance/simulatedTarget.js";
import { stableStringify } from "../../src/conformance/stableJson.js";

const DIR = "conformance/scenarios";

async function loadAll(): Promise<LoadedScenario[]> {
  const files = (await readdir(DIR)).filter((f) => f.endsWith(".json")).sort();
  return Promise.all(files.map(async (f) => {
    const text = await readFile(join(DIR, f), "utf8");
    return { scenario: parseScenarioJson(text, f), sha256: sha256(text) };
  }));
}

type Report = { summary: { result: string; probes: Record<string, number> }; scenarios: { scenario_id: string; result: string; probes: { probe_id: string; result: string }[] }[] };

async function runSimulated(mode: SimulatedMode): Promise<Report> {
  const t = await startSimulatedTarget(mode);
  try {
    return (await runConformance(await loadAll(), t.adapter)) as unknown as Report;
  } finally {
    await t.close();
  }
}

const verdictOf = (r: Report, id: string) => r.scenarios.find((s) => s.scenario_id === id)?.result;

describe("scenario format", () => {
  it("loads the committed scenarios", async () => {
    const all = await loadAll();
    expect(all.map((l) => l.scenario.scenario_id)).toEqual(["revocation-after-valid-grant", "excessive-delegation-escalation"]);
  });

  it("rejects unknown event types, bad schema and impossible probe times with a ScenarioError", async () => {
    const good = JSON.parse(await readFile(join(DIR, "01-revocation.json"), "utf8"));
    expect(() => parseScenario({ ...good, schema: "x" })).toThrow(ScenarioError);
    expect(() => parseScenario({ ...good, events: [{ ...good.events[0], type: "approve" }] })).toThrow(/unsupported event type/);
    expect(() => parseScenario({ ...good, probes: [{ ...good.probes[0], at: "2020-01-01T00:00:00.000Z" }] })).toThrow(/before the last event/);
    expect(() => parseScenario({ ...good, probes: [{ ...good.probes[0], after_event: 9 }] })).toThrow(/after_event/);
    expect(() => parseScenarioJson("{", "bad.json")).toThrow(/invalid JSON/);
  });

  it("contains no expected decision: expectations come only from the engine", async () => {
    const text = await readFile(join(DIR, "01-revocation.json"), "utf8");
    expect(text).not.toMatch(/"expected"\s*:/);
  });
});

describe("expected decisions come from the existing engine", () => {
  it("revocation scenario", async () => {
    const s = (await loadAll())[0]!.scenario;
    const e = computeExpected(s);
    expect(e.get("before-revocation")?.engine_decision).toEqual({ outcome: "AUTHORIZED", chain: ["d-owner-agent-a"] });
    expect(e.get("at-revocation-instant")?.engine_decision).toEqual({ outcome: "DENIED", reasonCode: "C12_DELEGATION_REVOKED" });
    expect(e.get("after-revocation")?.engine_decision).toEqual({ outcome: "DENIED", reasonCode: "C12_DELEGATION_REVOKED" });
  });

  it("excessive delegation scenario", async () => {
    const s = (await loadAll())[1]!.scenario;
    const e = computeExpected(s);
    expect(e.get("conforming-subdelegation-within-limits")?.engine_decision.outcome).toBe("AUTHORIZED");
    expect(e.get("amount-above-delegator-limit")?.engine_decision.outcome).toBe("DENIED");
    expect(e.get("capability-not-held-by-delegator")?.engine_decision.outcome).toBe("DENIED");
  });

  it("maps only AUTHORIZED and DENIED to a binary decision", () => {
    expect(mapEngineDecision({ outcome: "AUTHORIZED", chain: [] } as never)).toBe("ALLOW");
    expect(mapEngineDecision({ outcome: "DENIED", reasonCode: "C12_DELEGATION_REVOKED" })).toBe("DENY");
    expect(mapEngineDecision({ outcome: "REQUIRES_APPROVAL" } as never)).toBeUndefined();
    expect(mapEngineDecision({ outcome: "UNKNOWN", reasonCode: "C24_NO_VALID_CHAIN" })).toBeUndefined();
  });
});

describe("simulated targets (never real vulnerabilities)", () => {
  it("compliant: PASS everywhere", async () => {
    const r = await runSimulated("compliant");
    expect(r.summary.result).toBe("PASS");
    expect(r.summary.probes).toEqual({ PASS: 6, FAIL: 0, INCONCLUSIVE: 0 });
  });

  it("faulty-revocation: FAIL only on the revocation scenario", async () => {
    const r = await runSimulated("faulty-revocation");
    expect(verdictOf(r, "revocation-after-valid-grant")).toBe("FAIL");
    expect(verdictOf(r, "excessive-delegation-escalation")).toBe("PASS");
    expect(r.scenarios[0]!.probes.map((p) => p.result)).toEqual(["PASS", "FAIL", "FAIL"]);
  });

  it("faulty-delegation: FAIL only on the excessive-delegation scenario", async () => {
    const r = await runSimulated("faulty-delegation");
    expect(verdictOf(r, "revocation-after-valid-grant")).toBe("PASS");
    expect(verdictOf(r, "excessive-delegation-escalation")).toBe("FAIL");
  });

  it("covers every declared simulated mode", () => {
    expect([...SIMULATED_MODES]).toEqual(["compliant", "faulty-revocation", "faulty-delegation"]);
  });
});

describe("INCONCLUSIVE is never confused with FAIL", () => {
  const cfg = (url: string, body?: unknown): TargetAdapter =>
    httpAdapter({
      descriptor: { kind: "simulated", name: "stub", details: {} },
      url, timeoutMs: 500, buildBody: (r) => r,
      parse: (b) => { void body; const d = (b as { decision?: string }).decision; return d === "allow" ? { decision: "ALLOW", reason: null } : d === "deny" ? { decision: "DENY", reason: null } : undefined; },
    });

  it("unreachable target", async () => {
    const r = (await runConformance(await loadAll(), cfg("http://127.0.0.1:1/decide"))) as unknown as Report;
    expect(r.summary.result).toBe("INCONCLUSIVE");
    expect(r.summary.probes.FAIL).toBe(0);
  });

  it("target answers something that is not allow/deny", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((_q, res) => { res.writeHead(200); res.end(JSON.stringify({ decision: "maybe" })); });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const port = (server.address() as { port: number }).port;
    try {
      const r = (await runConformance(await loadAll(), cfg(`http://127.0.0.1:${port}/`))) as unknown as Report;
      expect(r.summary).toEqual({ result: "INCONCLUSIVE", probes: { PASS: 0, FAIL: 0, INCONCLUSIVE: 6 }, scenarios: 2 });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("report", () => {
  it("is byte-for-byte deterministic for the same target behavior", async () => {
    const a = stableStringify(await runSimulated("faulty-revocation") as unknown);
    const b = stableStringify(await runSimulated("faulty-revocation") as unknown);
    // Ports differ between runs but are not part of the report.
    expect(a).toBe(b);
  });

  it("carries scenario id, config, assumptions, expected, observed, result, evidence and limits", async () => {
    const r = (await runSimulated("compliant")) as unknown as { scenarios: Record<string, unknown>[]; limits: string[]; target: { kind: string } };
    const s = r.scenarios[0]!;
    for (const k of ["scenario_id", "config", "assumptions", "expected_policy", "denial_conditions", "result", "probes", "limits", "scenario_sha256"]) expect(s).toHaveProperty(k);
    const p = (s.probes as Record<string, unknown>[])[0]!;
    for (const k of ["expected", "observed", "result", "evidence", "diff"]) expect(p).toHaveProperty(k);
    expect(r.target.kind).toBe("simulated");
    expect(r.limits.join(" ")).toMatch(/not a certification/);
  });
});

// Real OPA: runs only when OPA_BIN points to an opa executable. Skipped (and reported as skipped) otherwise.
describe.skipIf(!process.env.OPA_BIN)("real OPA over its HTTP API", () => {
  it("OPA running the project's Rego policy agrees with the engine on every probe", async () => {
    const opa = await spawnOpa(process.env.OPA_BIN as string);
    try {
      const r = (await runConformance(await loadAll(), opa.adapter)) as unknown as Report & { target: { kind: string } };
      expect(r.target.kind).toBe("real-system");
      expect(r.summary.probes).toEqual({ PASS: 6, FAIL: 0, INCONCLUSIVE: 0 });
    } finally {
      await opa.close();
    }
  });

  it("a mutated policy (revocation rule removed) is detected as FAIL, proving the checks can fail on real OPA", async () => {
    const original = await readFile("conformance/opa/policy.rego", "utf8");
    const mutated = original.replace(/bad_link contains id if \{\n\tsome id, _ in delegations\n\trevoked\[id\]\n\}\n/, "");
    expect(mutated).not.toBe(original);
    const dir = await mkdtemp(join(tmpdir(), "conformance-mutant-"));
    const path = join(dir, "mutated.rego");
    await writeFile(path, mutated);
    const opa = await spawnOpa(process.env.OPA_BIN as string, path);
    try {
      const r = (await runConformance(await loadAll(), opa.adapter)) as unknown as Report;
      expect(verdictOf(r, "revocation-after-valid-grant")).toBe("FAIL");
      expect(verdictOf(r, "excessive-delegation-escalation")).toBe("PASS");
    } finally {
      await opa.close();
    }
  });
});
