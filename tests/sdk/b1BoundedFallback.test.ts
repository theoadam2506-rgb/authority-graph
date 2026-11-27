/** B1 — the operational limit of the historical path, seen through the SDK: explicit UNAVAILABLE with a traceable cause, never a business refusal. Off by default. */
import { afterEach, describe, expect, it } from "vitest";
import { GrantEvaluationLimitExceeded, configureGrantEvaluation, getGrantEvaluationStats, resetGrantEvaluation, resetGrantEvaluationStats } from "../../src/engine/grantEvaluation.js";
import type { Diagnostic } from "../../src/sdk/index.js";
import { call, setup } from "./harness.js";

afterEach(() => resetGrantEvaluation());

describe("B1 bounded fallback through the SDK", () => {
  it("off by default: a budgeted delegation authorizes normally", async () => {
    const s = await setup({ totalBudget: { value: 10_000, currency: "EUR" } });
    expect((await s.authority.authorize(call("a1"))).status).toBe("AUTHORIZED");
    expect((await s.authority.authorize(call("a2"))).status).toBe("AUTHORIZED");
  });

  it("a limit that trips yields UNAVAILABLE with the cause on the operator hook, never DENIED, and nothing is recorded as a refusal", async () => {
    const seen: Diagnostic[] = [];
    const s = await setup({ totalBudget: { value: 10_000, currency: "EUR" }, onDiagnostic: (d) => { seen.push(d); } });
    expect((await s.authority.authorize(call("a1"))).status).toBe("AUTHORIZED");
    const before = (await s.authority.events()).length;
    configureGrantEvaluation({ mode: "historical", limits: { maxWork: 0 } });
    const r = await s.authority.authorize(call("a2"));
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.status).not.toBe("DENIED");
    expect(seen.length).toBeGreaterThan(0);
    const cause = seen.at(-1)!.cause as GrantEvaluationLimitExceeded;
    expect(cause).toBeInstanceOf(GrantEvaluationLimitExceeded);
    expect(cause.code).toBe("GRANT_EVALUATION_WORK_LIMIT");
    expect(JSON.stringify(r)).not.toContain("GRANT_EVALUATION");
    const added = (await s.authority.events()).slice(before).map((e) => e.event_type);
    expect(added.every((t) => t === "ACTION_REQUESTED")).toBe(true); // at most the request itself: no refusal, no grant, no denial
    // lifting the limit makes the same call succeed: the unavailability was not a decision
    resetGrantEvaluation();
    expect((await s.authority.authorize(call("a2"))).status).toBe("AUTHORIZED");
  });

  it("the one-pass mode does not need the limit: the same journal authorizes with a limit that would trip the historical path", async () => {
    const s = await setup({ totalBudget: { value: 10_000, currency: "EUR" } });
    expect((await s.authority.authorize(call("a1"))).status).toBe("AUTHORIZED");
    configureGrantEvaluation({ mode: "one-pass", limits: { maxWork: 0 } });
    expect((await s.authority.authorize(call("a2"))).status).toBe("AUTHORIZED");
  });

  it("the deadline limit also yields UNAVAILABLE (never a business refusal), with the DEADLINE cause on the operator hook and after a bounded amount of work", async () => {
    const seen: Diagnostic[] = [];
    const s = await setup({ totalBudget: { value: 10_000, currency: "EUR" }, onDiagnostic: (d) => { seen.push(d); } });
    for (const id of ["a1", "a2", "a3", "a4"]) expect((await s.authority.authorize(call(id))).status).toBe("AUTHORIZED");
    let t = 0;
    resetGrantEvaluationStats();
    configureGrantEvaluation({ mode: "historical", limits: { deadlineMs: 15, now: () => (t += 10) } });
    const r = await s.authority.authorize(call("a5"));
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.status).not.toBe("DENIED");
    expect(((seen.at(-1)!.cause) as GrantEvaluationLimitExceeded).code).toBe("GRANT_EVALUATION_DEADLINE");
    expect(getGrantEvaluationStats().validationsRun).toBeLessThanOrEqual(3); // 4 grants exist: it did not do them all
    expect((await s.authority.events()).filter((e) => e.event_type === "CAPABILITY_ISSUED")).toHaveLength(4); // nothing issued by the interrupted call
    resetGrantEvaluation();
    expect((await s.authority.authorize(call("a5"))).status).toBe("AUTHORIZED");
  });

  it("a late activation injected through record() forces the historical path; with a limit the call is refused as UNAVAILABLE before any validation, and without it the same call succeeds", async () => {
    const s = await setup({ totalBudget: { value: 10_000, currency: "EUR" } });
    for (const id of ["a1", "a2", "a3"]) expect((await s.authority.authorize(call(id))).status).toBe("AUTHORIZED");
    const at = s.clock.now();
    const raw = (type: string, id: string, payload: unknown): any => ({ event_id: `evt-raw-${id}`, schema_version: 1, occurred_at: at, principal_id: "AGENT_A", event_type: type, payload });
    // an execution that PRECEDES the request and the delegation chain it will cite: the late activation the guard refuses
    const injected: any = await s.authority.record([raw("ACTION_EXECUTED", "x", { action_id: "late-1", executed_by_principal_id: "AGENT_A", action_fingerprint: "f".repeat(64), decision_sequence: 1, authority_chain_ref: [{ kind: "delegation", delegation_id: "d1" }], execution_result: "EXECUTED" })]);
    expect(injected.status).toBe("RECORDED");
    const injected2: any = await s.authority.record([raw("ACTION_REQUESTED", "r", { action_id: "late-1", requesting_principal_id: "AGENT_A", delegation_id: "d1", capability_requested: { resource: "purchase_order", action: "create" }, parameters: { kind: "monetary", amount: { value: 100, currency: "EUR" } } })]);
    expect(injected2.status).toBe("RECORDED");

    resetGrantEvaluationStats();
    configureGrantEvaluation({ mode: "one-pass", limits: { maxWork: 1 } });
    const limited = await s.authority.authorize(call("a4"));
    expect(limited.status).toBe("UNAVAILABLE");
    const stats = getGrantEvaluationStats();
    expect(stats.guardRefusals.LATE_ACTIVATION).toBeGreaterThan(0);
    expect(stats.validationsRun).toBe(0); // refused before any of the expensive work

    resetGrantEvaluation();
    configureGrantEvaluation({ mode: "one-pass" }); // no limit: the historical fallback runs and decides, exactly as before B1
    expect((await s.authority.authorize(call("a4"))).status).toBe("AUTHORIZED");
  });
});
