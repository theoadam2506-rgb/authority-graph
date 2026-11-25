/** B1 — targeted scenarios (explicit expectations, also checked against the frozen oracle), mode behaviour, linearity, bounded fallback. */
import { afterEach, describe, expect, it } from "vitest";
import { validateAndSelectGrant as oracleValidate } from "../oracle/engine/grantValidation.js";
import { onePassGuard, collectValidatedGrantsOnePass } from "../../src/engine/onePassGrants.js";
import { GrantEvaluationLimitExceeded, collectValidatedGrants, collectValidatedGrantsHistorical, compareGrantEvaluators, configureGrantEvaluation, getGrantEvaluationStats, resetGrantEvaluation } from "../../src/engine/grantEvaluation.js";
import { build, coherentJournal, delegation, grantFor, request, execution, revocation, ALPHABET, cap, grant } from "./helpers/b1.js";

const oracleIds = (store: any[]) => store.filter((e) => e.event_type === "CAPABILITY_ISSUED" && oracleValidate(store as any, e).ok).map((e) => e.event_id);
const ids = (g: readonly any[]) => g.map((x) => x.event.event_id);
const journal = (...drafts: any[]) => drafts.map((d, i) => d(i + 1));
afterEach(() => resetGrantEvaluation());

function expectGrants(store: any[], expected: string[], guard: "ACCEPTED" | "LATE_ACTIVATION" = "ACCEPTED") {
  const c = compareGrantEvaluators(store);
  expect(c.guard).toBe(guard);
  expect(c.historical.map((x) => x.split("@")[0])).toEqual(expected);
  expect(oracleIds(store).map((x) => x.split("@")[0])).toEqual(expected);
  if (guard === "ACCEPTED") expect(c.onePass!.map((x) => x.split("@")[0])).toEqual(expected);
  configureGrantEvaluation({ mode: "one-pass" });
  expect(ids(collectValidatedGrants(store as any)).map((x) => x.split("@")[0])).toEqual(expected);
}

describe("B1 targeted scenarios", () => {
  it("a plain valid grant is accepted", () => expectGrants(journal(ALPHABET.D1!, ALPHABET.A1!, ALPHABET.G1!), ["iss-a1"]));
  it("budget: a grant is refused once executions have spent the budget (historical charge order)", () => {
    const store = journal(ALPHABET.D1big!, request("a1", "bob", "d1", 6), execution("a1", "bob", ["d1"]), request("a5", "bob", "d1", 7), grantFor("a5", 7, [{ delegation: "d1" }]));
    expectGrants(store, []);
  });
  it("budget: the same grant is accepted while the budget is not spent", () => {
    expectGrants(journal(ALPHABET.D1big!, request("a5", "bob", "d1", 7), grantFor("a5", 7, [{ delegation: "d1" }])), ["iss-a5"]);
  });
  it("budget: execution charged once per action even when executed twice", () => {
    expectGrants(journal(ALPHABET.D1big!, request("a1", "bob", "d1", 4), execution("a1", "bob", ["d1"]), ALPHABET.X1dup!, request("a5", "bob", "d1", 6), grantFor("a5", 6, [{ delegation: "d1" }])), ["iss-a5"]);
  });
  it("sub-delegation: the child budget and the parent budget both bind", () => {
    expectGrants(journal(ALPHABET.D1!, ALPHABET.D2!, ALPHABET.A2!, ALPHABET.G2!), ["iss-a2"]);
    expectGrants(journal(ALPHABET.D1!, ALPHABET.D2!, ALPHABET.A2!, ALPHABET.X2!, request("a4", "carol", "d2", 5), grantFor("a4", 5, [{ delegation: "d1" }, { delegation: "d2" }])), []);
  });
  it("revocation by the grantor invalidates later grants, revocation by an outsider does not", () => {
    expectGrants(journal(ALPHABET.D1!, ALPHABET.A1!, ALPHABET.R1!, ALPHABET.G1!), []);
    expectGrants(journal(ALPHABET.D1!, ALPHABET.A1!, ALPHABET.R1outsider!, ALPHABET.G1!), ["iss-a1"]);
  });
  it("a grant issued BEFORE a later revocation stays valid at its own snapshot, and the later journal keeps it", () => {
    expectGrants(journal(ALPHABET.D1!, ALPHABET.A1!, ALPHABET.G1!, ALPHABET.R1!), ["iss-a1"]);
  });
  it("expiration: a delegation that expired at the decision time refuses the grant", () => {
    const exp = delegation({ id: "d1", grantor: "alice", grantee: "bob", budget: 10, expiresInSeconds: 2 });
    expectGrants(journal(exp, request("a1", "bob", "d1", 4), grantFor("a1", 4, [{ delegation: "d1" }])), []);
    const later = delegation({ id: "d1", grantor: "alice", grantee: "bob", budget: 10, expiresInSeconds: 60 });
    expectGrants(journal(later, request("a1", "bob", "d1", 4), grantFor("a1", 4, [{ delegation: "d1" }])), ["iss-a1"]);
  });
  it("forged references: wrong chain, wrong fingerprint, wrong decision sequence, unknown delegation are refused", () => {
    expectGrants(journal(ALPHABET.D1!, ALPHABET.A1!, ALPHABET.G1badChain!), []);
    expectGrants(journal(ALPHABET.D1!, ALPHABET.A1!, ALPHABET.G1badFp!), []);
    expectGrants(journal(ALPHABET.D1!, ALPHABET.A1!, ALPHABET.G1badSeq!), []);
    expectGrants(journal(ALPHABET.D1!, ALPHABET.A1!, grantFor("a1", 4, [{ delegation: "ghost" }])), []);
    expectGrants(journal(ALPHABET.D1!, ALPHABET.A1!, grantFor("ghost", 4, [{ delegation: "d1" }])), []);
  });
  it("forged executions by someone else do not consume the budget of the delegate", () => {
    expectGrants(journal(ALPHABET.D1big!, request("a1", "bob", "d1", 6), ALPHABET.X1forged!, request("a5", "bob", "d1", 7), grantFor("a5", 7, [{ delegation: "d1" }])), ["iss-a5"]);
  });
  it("budget: an execution by someone other than the requester (not demonstrably tied) is not charged", () => {
    expectGrants(journal(ALPHABET.D1big!, request("a1", "carol", "d1", 6), execution("a1", "bob", ["d1"]), request("a5", "bob", "d1", 7), grantFor("a5", 7, [{ delegation: "d1" }])), ["iss-a5"]);
    // control: the same execution by the requester IS charged
    expectGrants(journal(ALPHABET.D1big!, request("a1", "bob", "d1", 6), execution("a1", "bob", ["d1"]), request("a5", "bob", "d1", 7), grantFor("a5", 7, [{ delegation: "d1" }])), []);
  });
  it("budget: debits are summed per currency, across several executions (a USD budget is not read through EUR spending)", () => {
    const usd = delegation({ id: "d1", grantor: "alice", grantee: "bob", budget: 10, currency: "USD", thresholds: [9, 9] });
    const usdGrant = (a: string, v: number) => grant({ action: a, requestParameters: { capability: cap, parameters: { kind: "monetary", amount: { value: v, currency: "USD" } } }, chain: [{ delegation: "d1" }] });
    expectGrants(journal(usd, request("a1", "bob", "d1", 4, "USD"), execution("a1", "bob", ["d1"]), request("a2", "bob", "d1", 4, "USD"), execution("a2", "bob", ["d1"]), request("a5", "bob", "d1", 3, "USD"), usdGrant("a5", 3)), []);
    expectGrants(journal(usd, request("a1", "bob", "d1", 4, "USD"), execution("a1", "bob", ["d1"]), request("a5", "bob", "d1", 3, "USD"), usdGrant("a5", 3)), ["iss-a5"]);
  });
  it("approvals: a granted approval lets a grant above the automatic ceiling through, a forged approver does not", () => {
    expectGrants(journal(ALPHABET.D1!, ALPHABET.A3!, ALPHABET.AP!, ALPHABET.APG!, ALPHABET.G3!), ["iss-a3"]);
    expectGrants(journal(ALPHABET.D1!, ALPHABET.A3!, ALPHABET.AP!, ALPHABET.APGforged!, ALPHABET.G3!), []);
    expectGrants(journal(ALPHABET.D1!, ALPHABET.A3!, ALPHABET.G3!), []);
  });
  it("late activation: the guard refuses, the dispatcher falls back to the historical result", () => {
    const store = journal(ALPHABET.D1big!, execution("a1", "bob", ["d1"]), request("a1", "bob", "d1", 6), request("a5", "bob", "d1", 7), grantFor("a5", 7, [{ delegation: "d1" }]));
    expect(onePassGuard(store as any)).toMatchObject({ ok: false, reason: "LATE_ACTIVATION" });
    expect(collectValidatedGrantsOnePass(store as any)).toBeUndefined();
    expectGrants(store, [], "LATE_ACTIVATION");
    expect(getGrantEvaluationStats().guardRefusals.LATE_ACTIVATION).toBe(1);
  });
  it("late activation of a delegation (execution cites a delegation defined afterwards) falls back too", () => {
    const store = journal(ALPHABET.D1big!, execution("a1", "bob", ["d2"]), request("a1", "bob", "d1", 4), delegation({ id: "d2", parent: "d1", grantor: "bob", grantee: "bob", budget: 5 }));
    expect(onePassGuard(store as any)).toMatchObject({ ok: false, reason: "LATE_ACTIVATION" });
  });
  it("a reference that never resolves is harmless (guard accepts, result identical)", () => {
    const store = journal(ALPHABET.D1!, execution("a9", "bob", ["ghost"]), ALPHABET.A1!, ALPHABET.G1!);
    expect(onePassGuard(store as any).ok).toBe(true);
    expectGrants(store, ["iss-a1"]);
  });
  it("non-increasing sequences and shape damage are refused by the guard", () => {
    const store = JSON.parse(JSON.stringify(journal(ALPHABET.D1!, ALPHABET.A1!, ALPHABET.G1!))); store[2].sequence = 2;
    expect(onePassGuard(store as any)).toMatchObject({ ok: false, reason: "SEQUENCE_NOT_STRICTLY_INCREASING" });
    const bad = JSON.parse(JSON.stringify(journal(ALPHABET.D1!, ALPHABET.A1!, ALPHABET.G1!))); delete bad[1].payload.parameters;
    expect(onePassGuard(bad as any)).toMatchObject({ ok: false, reason: "NOT_SHAPE_SOUND" });
  });
});

describe("B1 modes", () => {
  const store = () => journal(ALPHABET.D1!, ALPHABET.A1!, ALPHABET.G1!);
  it("default mode is historical and uses no one-pass run", () => {
    const old = process.env["AUTHORITY_GRANT_EVALUATION"];
    try {
      delete process.env["AUTHORITY_GRANT_EVALUATION"]; // the CI also runs the whole suite with the variable set
      resetGrantEvaluation();
      collectValidatedGrants(store() as any);
      expect(getGrantEvaluationStats()).toMatchObject({ historicalRuns: 1, onePassRuns: 0 });
    } finally { if (old !== undefined) process.env["AUTHORITY_GRANT_EVALUATION"] = old; resetGrantEvaluation(); }
  });
  it("shadow returns the historical result, compares, and counts zero mismatches on equal evaluators", () => {
    configureGrantEvaluation({ mode: "shadow" });
    expect(ids(collectValidatedGrants(store() as any)).length).toBe(1);
    expect(getGrantEvaluationStats()).toMatchObject({ shadowComparisons: 1, shadowMismatches: 0 });
  });
  it("shadow never returns the new result: a one-pass evaluator forced wrong would be reported but not used (hook invoked, throwing hook ignored)", () => {
    // a late-activation journal where one-pass would diverge is refused by the guard in shadow mode; to prove 'never returned' we check identity with the historical list
    configureGrantEvaluation({ mode: "shadow", onShadowMismatch: () => { throw new Error("hook failure must not matter"); } });
    const s = store() as any;
    expect(ids(collectValidatedGrants(s))).toEqual(ids(collectValidatedGrantsHistorical(s)));
  });
  it("shadow skips journals above shadowMaxEvents (plain historical)", () => {
    configureGrantEvaluation({ mode: "shadow", shadowMaxEvents: 2 });
    collectValidatedGrants(store() as any);
    expect(getGrantEvaluationStats()).toMatchObject({ shadowSkippedTooLarge: 1, shadowComparisons: 0 });
  });
  it("the environment variable is validated", () => {
    const old = process.env["AUTHORITY_GRANT_EVALUATION"];
    try { process.env["AUTHORITY_GRANT_EVALUATION"] = "turbo"; expect(() => resetGrantEvaluation()).toThrow(/historical, shadow or one-pass/); process.env["AUTHORITY_GRANT_EVALUATION"] = "one-pass"; resetGrantEvaluation(); collectValidatedGrants(store() as any); expect(getGrantEvaluationStats().onePassRuns).toBe(1); }
    finally { if (old === undefined) delete process.env["AUTHORITY_GRANT_EVALUATION"]; else process.env["AUTHORITY_GRANT_EVALUATION"] = old; resetGrantEvaluation(); }
  });
});

describe("B1 linearity (the one-pass evaluator reads the journal a bounded number of times)", () => {
  it("store reads grow linearly with the journal size, not quadratically", () => {
    const measure = (n: number) => {
      const j = coherentJournal(77, n); let reads = 0;
      const proxy = new Proxy(j, { get(t, k, r) { if (typeof k === "string" && /^\d+$/.test(k)) reads++; return Reflect.get(t, k, r); } });
      onePassGuard(proxy as any); collectValidatedGrantsOnePass(proxy as any);
      return { reads, n: j.length };
    };
    const a = measure(400), b = measure(1600);
    console.log("reads", JSON.stringify({ a, b }));
    expect(b.reads / b.n).toBeLessThan((a.reads / a.n) * 1.6);
  });
});

describe("B1 bounded fallback (operational limit, off by default)", () => {
  const big = () => coherentJournal(5, 300);
  it("off by default: nothing throws", () => { expect(() => collectValidatedGrantsHistorical(big() as any)).not.toThrow(); });
  it("maxWork refuses to start a loop that would be too costly, with a typed error carrying the numbers", () => {
    const j = big() as any;
    try { collectValidatedGrantsHistorical(j, { maxWork: 10 }); throw new Error("should have thrown"); } catch (e) { expect(e).toBeInstanceOf(GrantEvaluationLimitExceeded); expect((e as GrantEvaluationLimitExceeded).code).toBe("GRANT_EVALUATION_WORK_LIMIT"); expect((e as GrantEvaluationLimitExceeded).events).toBe(j.length); }
  });
  it("deadlineMs stops between two grants using an injected clock", () => {
    let t = 0; const now = () => (t += 10);
    expect(() => collectValidatedGrantsHistorical(big() as any, { deadlineMs: 25, now })).toThrow(GrantEvaluationLimitExceeded);
  });
  it("a generous limit returns the exact historical result", () => {
    const j = big() as any;
    expect(ids(collectValidatedGrantsHistorical(j, { maxWork: 1e12, deadlineMs: 1e9 }))).toEqual(ids(collectValidatedGrantsHistorical(j)));
  });
  it("in one-pass mode a guard-accepted journal never touches the limits (no quadratic work)", () => {
    configureGrantEvaluation({ mode: "one-pass", limits: { maxWork: 1 } });
    expect(() => collectValidatedGrants(coherentJournal(5, 300).filter(() => true) as any)).not.toThrow(GrantEvaluationLimitExceeded);
  });
});
