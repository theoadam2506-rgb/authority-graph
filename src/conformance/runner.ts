/**
 * Runs scenarios against a target, compares expected vs observed, and builds
 * the stable JSON report. The report contains no timestamps, hostnames or
 * random ids: the same inputs and the same target answers give the same bytes.
 */
import { createHash } from "node:crypto";
import type { AuthorityDecision } from "../domain/types.js";
import { buildTargetRequest, mapEngineDecision, type BinaryDecision, type Observation, type TargetAdapter } from "./adapter.js";
import { computeExpected } from "./expected.js";
import type { Scenario } from "./scenario.js";

export const REPORT_VERSION = "authority-conformance-report/v0";
export type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE";

export interface LoadedScenario {
  readonly scenario: Scenario;
  /** sha256 of the scenario file's bytes, for provenance. */
  readonly sha256: string;
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export const GLOBAL_LIMITS: readonly string[] = [
  "Expected decisions come from the Authority engine (authorityAt) on a scenario written by this project; they are the reference, not an independent ground truth.",
  "Only the decisions on the listed probes are compared. A PASS says nothing about inputs that were not probed.",
  "Authority's REQUIRES_APPROVAL and UNKNOWN outcomes cannot be compared with a binary allow/deny and are reported INCONCLUSIVE.",
  "The target receives a neutral log prefix and re-derives the decision itself; how it would ingest the same facts through its own production APIs is not tested.",
  "A policy or target modeled by this project (the Rego policy, the simulated targets) shows agreement or disagreement with the engine on these probes only; it is not a security assessment of the underlying product.",
  "All events are asserted and unauthenticated (assurance level ASSERTED_UNVERIFIED); no cryptographic verification is involved.",
  "This is not a certification and not a claim of compliance with any standard (including WIMSE).",
];

function compare(
  expectedBinary: BinaryDecision | undefined,
  engine: AuthorityDecision,
  obs: Observation,
): { result: Verdict; diff: string | null } {
  if (expectedBinary === undefined) {
    return { result: "INCONCLUSIVE", diff: `engine outcome ${engine.outcome} has no allow/deny equivalent` };
  }
  if (obs.status === "error") return { result: "INCONCLUSIVE", diff: `no usable observation: ${obs.error}` };
  if (obs.decision === expectedBinary) return { result: "PASS", diff: null };
  return { result: "FAIL", diff: `expected ${expectedBinary} but target answered ${obs.decision}` };
}

function rollup(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.includes("FAIL")) return "FAIL";
  if (verdicts.includes("INCONCLUSIVE")) return "INCONCLUSIVE";
  return "PASS";
}

export async function runConformance(loaded: readonly LoadedScenario[], target: TargetAdapter): Promise<Record<string, unknown>> {
  const scenarios: Record<string, unknown>[] = [];
  const scenarioVerdicts: Verdict[] = [];
  const counts: Record<Verdict, number> = { PASS: 0, FAIL: 0, INCONCLUSIVE: 0 };

  for (const { scenario, sha256: scenarioSha } of loaded) {
    const expected = computeExpected(scenario);
    const probes: Record<string, unknown>[] = [];
    const verdicts: Verdict[] = [];
    for (const probe of scenario.probes) {
      const engine = (expected.get(probe.probe_id) as { engine_decision: AuthorityDecision }).engine_decision;
      const expectedBinary = mapEngineDecision(engine);
      const request = buildTargetRequest(scenario, probe);
      const obs = await target.evaluate(request);
      const { result, diff } = compare(expectedBinary, engine, obs);
      verdicts.push(result);
      counts[result]++;
      probes.push({
        probe_id: probe.probe_id,
        description: probe.description,
        question: { agent: probe.agent, capability: probe.capability, amount: probe.amount, after_event: probe.after_event, at: probe.at },
        expected: {
          decision: expectedBinary ?? null,
          source: "authority-engine:authorityAt",
          engine_decision: engine,
        },
        observed:
          obs.status === "ok"
            ? { status: "ok", decision: obs.decision, target_reason: obs.target_reason }
            : { status: "error", error: obs.error },
        result,
        diff,
        evidence: {
          request_sent: obs.exchange.sent_body,
          http_status: obs.exchange.http_status,
          response_body_raw: obs.exchange.response_body,
        },
      });
    }
    const verdict = rollup(verdicts);
    scenarioVerdicts.push(verdict);
    scenarios.push({
      scenario_id: scenario.scenario_id,
      title: scenario.title,
      description: scenario.description,
      scenario_sha256: scenarioSha,
      config: { human_root: scenario.human_root, events: scenario.events },
      assumptions: scenario.assumptions,
      expected_policy: scenario.expected_policy,
      denial_conditions: scenario.denial_conditions,
      result: verdict,
      probes,
      limits: scenario.limits,
    });
  }

  return {
    report_version: REPORT_VERSION,
    reference: { engine: "authority-graph authorityAt (src/engine)", assurance_level: "ASSERTED_UNVERIFIED" },
    target: { kind: target.descriptor.kind, name: target.descriptor.name, details: target.descriptor.details },
    summary: { result: rollup(scenarioVerdicts), probes: counts, scenarios: scenarioVerdicts.length },
    scenarios,
    limits: GLOBAL_LIMITS,
  };
}
