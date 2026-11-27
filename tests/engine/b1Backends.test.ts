/**
 * B1 on PostgreSQL 16, under the ONE-PASS mode: (1) memory/PostgreSQL parity of the SDK, and the dispatcher against the frozen oracle on journals READ BACK
 * from PostgreSQL; (2) concurrent writers on one journal with budgets: the final journal re-validates under the frozen oracle and no budget is exceeded,
 * in one-pass and in shadow mode (zero shadow mismatches). Skipped (with a warning) when TEST_DATABASE_URL is not reachable.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuthority, createEventBuilders, postgresBackend } from "../../src/sdk/index.js";
import { configureGrantEvaluation, getGrantEvaluationStats, resetGrantEvaluation, collectValidatedGrants } from "../../src/engine/grantEvaluation.js";
import { validateAndSelectGrant as oracleValidate } from "../oracle/engine/grantValidation.js";
import { databaseAvailable, TEST_DATABASE_URL } from "../redemption/pgHarness.js";
import { isolatedSchema, type IsolatedSchema } from "../storage/pgTestSchema.js";
import { genJournal } from "./helpers/o1.js";

const available = await databaseAvailable();
if (!available) console.warn("[b1Backends.test.ts] TEST_DATABASE_URL is not reachable: skipping the PostgreSQL B1 tests.");
const open: IsolatedSchema[] = [];
afterAll(async () => { for (const i of open) await i.drop().catch(() => undefined); });
afterEach(() => resetGrantEvaluation());
const d = available ? describe : describe.skip;

const sortKeys = (v: any): any => (Array.isArray(v) ? v.map(sortKeys) : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
const strip = (events: readonly any[]) => events.map((e) => { const { recorded_at: _r, ...rest } = e; return sortKeys({ ...rest, event_id: String(rest.event_id).replace(/:attempt-.*$/, ":attempt-*") }); });
const oracleIds = (store: any[]) => store.filter((e) => e.event_type === "CAPABILITY_ISSUED" && oracleValidate(store as any, e).ok).map((e) => e.event_id);

d("B1 on PostgreSQL 16", () => {
  beforeEach(() => configureGrantEvaluation({ mode: "one-pass" }));

  it("memory and PostgreSQL give the same journal under one-pass; the dispatcher equals the frozen oracle on the journal read back", { timeout: 600_000 }, async () => {
    const n = Number(process.env.B1_PG_JOURNALS ?? 25);
    let events = 0, grants = 0;
    for (let s = 1; s <= n; s++) {
      const iso = isolatedSchema(TEST_DATABASE_URL, `b1par${s}`);
      open.push(iso);
      await iso.create();
      iso.pool.on("error", () => undefined);
      const bias = s % 2 === 0 ? 0 : 0.7;
      const mem = await genJournal(s, 50, { budgetBias: bias, deterministicIds: true });
      const pg = await genJournal(s, 50, { budgetBias: bias, deterministicIds: true, backend: postgresBackend(iso.pool) });
      expect(strip(pg)).toEqual(strip(mem));
      expect(collectValidatedGrants(pg as any).map((g) => g.event.event_id)).toEqual(oracleIds(pg));
      grants += oracleIds(pg).length;
      events += pg.length;
      await iso.drop();
      open.splice(open.indexOf(iso), 1);
    }
    console.info(`[B1] memory/PostgreSQL parity: scenarios=${n} events=${events} grants=${grants} divergences=0 stats=${JSON.stringify(getGrantEvaluationStats())}`);
    expect(getGrantEvaluationStats().onePassRuns).toBeGreaterThan(0);
    expect(events).toBeGreaterThan(n * 10);
  });

  for (const mode of ["one-pass", "shadow"] as const) {
    it(`concurrent writers on one journal (${mode}): every grant re-validates under the frozen oracle and no budget is exceeded`, { timeout: 600_000 }, async () => {
      configureGrantEvaluation({ mode });
      const rounds = Number(process.env.B1_PG_ROUNDS ?? 6);
      for (let round = 0; round < rounds; round++) {
        const iso = isolatedSchema(TEST_DATABASE_URL, `b1con${mode.replace("-", "")}${round}`);
        open.push(iso);
        await iso.create();
        iso.pool.on("error", () => undefined);
        const clock = { now: () => "2026-06-01T09:00:00.000Z" };
        const ev = createEventBuilders({ clock });
        const a = createAuthority({ backend: postgresBackend(iso.pool), clock, enforcementPointId: "ep" });
        const BUDGET = 10, AMOUNT = 3;
        await a.record([ev.delegation({ delegationId: "d", grantor: "alice", grantee: "agent", capabilities: [{ resource: "r", action: "x" }], canDelegate: false, expiresAt: null, totalBudget: { value: BUDGET, currency: "EUR" }, thresholds: { automaticMax: { value: 5, currency: "EUR" }, approvalMax: { value: 9, currency: "EUR" } } })]);
        const calls = Array.from({ length: 12 }, (_, i) => ({ actionId: `c${round}-${i}`, agentId: "agent", delegationId: "d", capability: { resource: "r", action: "x" }, amount: { value: AMOUNT, currency: "EUR" } }));
        const results = await Promise.all(calls.map((c) => a.authorize(c)));
        const authorized = results.filter((r) => r.status === "AUTHORIZED").length;
        expect(authorized).toBeLessThanOrEqual(Math.floor(BUDGET / AMOUNT));
        expect(authorized).toBeGreaterThan(0);
        const journal = (await a.events()) as any[];
        const issued = journal.filter((e) => e.event_type === "CAPABILITY_ISSUED");
        expect(issued.length).toBe(authorized);
        expect(collectValidatedGrants(journal as any).length).toBe(authorized);
        expect(oracleIds(journal).length).toBe(authorized);
        await iso.drop();
        open.splice(open.indexOf(iso), 1);
      }
      expect(getGrantEvaluationStats().shadowMismatches).toBe(0);
      if (mode === "shadow") expect(getGrantEvaluationStats().shadowComparisons).toBeGreaterThan(0);
      else expect(getGrantEvaluationStats().onePassRuns).toBeGreaterThan(0);
    });
  }
});
