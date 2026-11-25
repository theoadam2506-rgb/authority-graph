/** B1 — the operational limit of the historical path, seen through the SDK: explicit UNAVAILABLE with a traceable cause, never a business refusal. Off by default. */
import { afterEach, describe, expect, it } from "vitest";
import { GrantEvaluationLimitExceeded, configureGrantEvaluation, resetGrantEvaluation } from "../../src/engine/grantEvaluation.js";
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
});
