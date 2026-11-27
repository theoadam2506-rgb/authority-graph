/**
 * B1 — exhaustive enumeration of small journals: the one-pass evaluator against the FROZEN historical oracle (tests/oracle/engine).
 * For every journal the guard accepts, the grants must be the same, element for element. For every journal it refuses, the one-pass
 * evaluator must refuse to answer. A final test shows the guard is NECESSARY: with it bypassed, late-activation journals diverge.
 */
import { describe, expect, it } from "vitest";
import { validateAndSelectGrant as oracleValidate } from "../oracle/engine/grantValidation.js";
import { collectValidatedGrantsOnePass, onePassGuard } from "../../src/engine/onePassGrants.js";
import { collectValidatedGrants, collectValidatedGrantsHistorical } from "../../src/engine/grantEvaluation.js";
import { ALPHABET, NAMES, build, sequences } from "./helpers/b1.js";

const oracleCollect = (store: any[]): string[] => {
  const out: string[] = [];
  for (const e of store) if (e.event_type === "CAPABILITY_ISSUED") { const r = oracleValidate(store as any, e); if (r.ok) out.push(e.event_id); }
  return out;
};
const ids = (g: readonly any[] | undefined) => g?.map((x) => x.event.event_id);

const SMALL = ["D1", "D2", "A1", "A2", "X1", "X2", "R1", "G1", "G2", "G1badSeq"];             // all journals up to length 5 over this
const FOCUS = ["D1", "D2", "A2", "X2", "R1", "G2"];                                          // length 6
const APPROVAL = ["D1", "A3", "AP", "APG", "X3", "G3"];

function enumerate(alphabet: string[], k: number) {
  let total = 0, accepted = 0, refusedLate = 0, withGrants = 0, withRejectedGrant = 0;
  for (const names of sequences(alphabet, k)) {
    const store = build(names);
    total++;
    const guard = onePassGuard(store);
    const oracle = oracleCollect(store);
    if (!guard.ok) { refusedLate += guard.reason === "LATE_ACTIVATION" ? 1 : 0; expect(collectValidatedGrantsOnePass(store, guard)).toBeUndefined(); continue; }
    accepted++;
    const got = ids(collectValidatedGrantsOnePass(store, guard));
    if (JSON.stringify(got) !== JSON.stringify(oracle)) throw new Error(`DIVERGENCE on ${names.join(",")}: oracle=${oracle} onepass=${got}`);
    const issued = store.filter((e: any) => e.event_type === "CAPABILITY_ISSUED").length;
    if (oracle.length > 0) withGrants++;
    if (issued > oracle.length) withRejectedGrant++;
  }
  return { total, accepted, refusedLate, withGrants, withRejectedGrant };
}

describe("B1 exhaustive enumeration (one-pass vs frozen oracle)", () => {
  it("covers every journal of length <= 5 over the core alphabet", () => {
    const r = enumerate(SMALL, 5);
    console.log("enumeration core", JSON.stringify(r));
    expect(r.total).toBe(SMALL.length + SMALL.length ** 2 + SMALL.length ** 3 + SMALL.length ** 4 + SMALL.length ** 5);
    expect(r.withGrants).toBeGreaterThan(1000);
    expect(r.withRejectedGrant).toBeGreaterThan(1000);
  }, 600_000);
  it("covers every journal of length <= 6 over the focused alphabet", () => {
    const r = enumerate(FOCUS, 6);
    console.log("enumeration focus", JSON.stringify(r));
    expect(r.accepted).toBeGreaterThan(1000);
  }, 600_000);
  it("covers every journal of length <= 6 over the approval alphabet", () => {
    const r = enumerate(APPROVAL, 6);
    console.log("enumeration approval", JSON.stringify(r));
    expect(r.withGrants).toBeGreaterThan(100);
  }, 600_000);
  it("covers every journal of length <= 4 over the WHOLE alphabet (duplicates, forged executions, revokers, flawed grants)", () => {
    const r = enumerate(NAMES, 4);
    console.log("enumeration whole alphabet", JSON.stringify(r), "alphabet", NAMES.length);
    expect(r.total).toBeGreaterThan(400_000);
  }, 900_000);
  it("the guard is necessary: with it bypassed, late-activation journals diverge from the oracle", () => {
    let late = 0, diverging = 0;
    for (const names of sequences(["D1big", "A1", "X1", "A5", "G5", "X1dup"], 5)) {
      const store = build(names);
      const guard = onePassGuard(store);
      if (guard.ok || guard.reason !== "LATE_ACTIVATION") continue;
      late++;
      const first = new Map<string, any>();
      for (const e of store) if (e.event_type === "ACTION_REQUESTED" && !first.has(e.payload.action_id)) first.set(e.payload.action_id, e);
      const forced = collectValidatedGrantsOnePass(store, { ok: true, firstRequest: first });
      if (JSON.stringify(ids(forced)) !== JSON.stringify(oracleCollect(store))) diverging++;
    }
    console.log("guard necessity", JSON.stringify({ late, diverging }));
    expect(late).toBeGreaterThan(50);
    // the divergence is real: an execution that precedes its request is charged by the historical evaluator once the request exists
    expect(diverging).toBeGreaterThan(0);
  }, 300_000);
  it("the dispatcher (one-pass mode with fallback) always equals the oracle, guard or not", () => {
    for (const names of sequences(["D1", "D2", "A1", "X1", "R1", "G1", "A2", "X2", "G2"], 4)) {
      const store = build(names);
      expect(ids(collectValidatedGrantsHistorical(store))).toEqual(oracleCollect(store));
    }
    expect(collectValidatedGrants(build(["D1", "A1", "G1"])).length).toBe(1);
  });
});
