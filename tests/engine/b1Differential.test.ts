/**
 * B1 — differential tests, one-pass dispatcher vs the FROZEN oracle, on >= 100,000 well-formed random journals and
 * >= 100,000 malformed ones (structural damage by `mutate`), plus SDK-generated journals. Results AND errors are compared.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateAndSelectGrant as oracleValidate } from "../oracle/engine/grantValidation.js";
import { collectValidatedGrantsOnePass, onePassGuard } from "../../src/engine/onePassGrants.js";
import { collectValidatedGrants, configureGrantEvaluation, resetGrantEvaluation } from "../../src/engine/grantEvaluation.js";
import { genJournal, mutate, observe, rng } from "./helpers/o1.js";
import { coherentJournal, randomJournal } from "./helpers/b1.js";

const oracleCollectIds = (store: any[]): string[] => {
  const out: string[] = [];
  for (const e of store) if (e.event_type === "CAPABILITY_ISSUED") { const r = oracleValidate(store as any, e); if (r.ok) out.push(e.event_id); }
  return out;
};
const ids = (g: readonly any[]) => g.map((x) => x.event.event_id);

const N = Number(process.env.B1_JOURNALS ?? 100_000);
const SCALE = N / 100_000;
beforeAll(() => configureGrantEvaluation({ mode: "one-pass" }));
afterAll(() => resetGrantEvaluation());

interface Tally { journals: number; guardAccepted: number; guardRefused: Record<string, number>; withGrants: number; withRejected: number; bothThrew: number; grants: number }
function run(journals: Iterable<any[]>, label: string): Tally {
  const t: Tally = { journals: 0, guardAccepted: 0, guardRefused: {}, withGrants: 0, withRejected: 0, bothThrew: 0, grants: 0 };
  for (const j of journals) {
    t.journals++;
    const oracle = observe(() => oracleCollectIds(j));
    const dispatched = observe(() => ids(collectValidatedGrants(j as any)));
    if (JSON.stringify(oracle) !== JSON.stringify(dispatched)) throw new Error(`${label}: DIVERGENCE\n oracle=${JSON.stringify(oracle)}\n new=${JSON.stringify(dispatched)}\n journal=${JSON.stringify(j).slice(0, 4000)}`);
    if (!oracle.ok) { t.bothThrew++; continue; }
    const g = onePassGuard(j as any);
    if (g.ok) {
      t.guardAccepted++;
      const direct = observe(() => ids(collectValidatedGrantsOnePass(j as any, g)!));
      if (JSON.stringify(direct) !== JSON.stringify(oracle)) throw new Error(`${label}: DIRECT DIVERGENCE ${JSON.stringify(direct)} vs ${JSON.stringify(oracle)}\n${JSON.stringify(j).slice(0, 4000)}`);
    } else t.guardRefused[g.reason] = (t.guardRefused[g.reason] ?? 0) + 1;
    const granted = JSON.parse(oracle.value).length, issued = j.filter((e: any) => e?.event_type === "CAPABILITY_ISSUED").length;
    t.grants += granted;
    if (granted > 0) t.withGrants++;
    if (issued > granted) t.withRejected++;
  }
  console.log(label, JSON.stringify(t));
  return t;
}

function* wellFormed(n: number, seed0: number): Generator<any[]> {
  for (let i = 0; i < n; i++) yield i % 4 === 0 ? randomJournal(seed0 + i, 3 + (i % 22)) : coherentJournal(seed0 + i, 5 + (i % 40));
}
function* malformed(n: number, seed0: number): Generator<any[]> {
  for (let i = 0; i < n; i++) { const r = rng(seed0 + i * 7919); yield mutate(i % 4 === 0 ? randomJournal(seed0 + i, 3 + (i % 22)) : coherentJournal(seed0 + i, 5 + (i % 40)), r); }
}

describe("B1 differential (one-pass dispatcher vs frozen oracle)", () => {
  it("100,000 random well-formed journals", () => {
    const t = run(wellFormed(N, 1), "wellformed");
    expect(t.journals).toBe(N);
    expect(t.withGrants).toBeGreaterThan(Math.floor(5_000 * SCALE * 0.5));
    expect(t.withRejected).toBeGreaterThan(Math.floor(5_000 * SCALE * 0.5));
    expect(t.guardAccepted).toBeGreaterThan(Math.floor(50_000 * SCALE));
  }, 1_800_000);
  it("100,000 random malformed journals (shape damage, wrong types, dropped / duplicated / nulled events)", () => {
    const t = run(malformed(N, 5_000_000), "malformed");
    expect(t.journals).toBe(N);
    expect(Object.values(t.guardRefused).reduce((a, b) => a + b, 0) + t.bothThrew).toBeGreaterThan(Math.floor(5_000 * SCALE * 0.5));
  }, 1_800_000);
  it("2,000 SDK-generated journals (real ingestion, budgets, sub-delegations, approvals, revocations)", async () => {
    const out: any[][] = [];
    for (let i = 0; i < 2_000; i++) out.push(await genJournal(900_000 + i, 6 + (i % 30), { budgetBias: 0.7, deterministicIds: true }));
    const t = run(out, "sdk");
    expect(t.guardAccepted).toBeGreaterThan(1_000);
  }, 1_800_000);
});
