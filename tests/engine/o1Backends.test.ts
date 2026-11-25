/**
 * O1 on PostgreSQL 16: (1) memory / PostgreSQL parity of the SDK on the same random scenarios with the optimized engine,
 * and the optimized-vs-reference comparison on journals READ BACK from PostgreSQL; (2) concurrent writers on one journal:
 * the final journal is validated by the REFERENCE engine and no budget is exceeded.
 * Skipped (with a warning) when TEST_DATABASE_URL is not reachable.
 *
 *   O1_PG_JOURNALS   scenarios for the parity test (default 25)
 *   O1_PG_ROUNDS     concurrent rounds (default 6)
 */
import { afterAll, describe, expect, it } from "vitest";
import { createAuthority, createEventBuilders, postgresBackend } from "../../src/sdk/index.js";
import { databaseAvailable, TEST_DATABASE_URL } from "../redemption/pgHarness.js";
import { isolatedSchema, type IsolatedSchema } from "../storage/pgTestSchema.js";
import { compareEngines, genJournal, REFERENCE } from "./helpers/o1.js";

const available = await databaseAvailable();
if (!available) console.warn("[o1Backends.test.ts] TEST_DATABASE_URL is not reachable: skipping the PostgreSQL O1 tests.");
const open: IsolatedSchema[] = [];
afterAll(async () => { for (const i of open) await i.drop().catch(() => undefined); });
const d = available ? describe : describe.skip;

const sortKeys = (v: any): any => (Array.isArray(v) ? v.map(sortKeys) : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
/** Drops the two things that legitimately differ between backends: `recorded_at` (wall clock) and the random redemption attempt suffix (a pre-existing difference, unrelated to O1). */
const strip = (events: readonly any[]) => events.map((e) => { const { recorded_at: _r, ...rest } = e; return sortKeys({ ...rest, event_id: String(rest.event_id).replace(/:attempt-.*$/, ":attempt-*") }); });

d("O1 on PostgreSQL 16", () => {
  it("memory and PostgreSQL give the same journal on the same scenarios; the engines agree on the journal read back", { timeout: 600_000 }, async () => {
    const n = Number(process.env.O1_PG_JOURNALS ?? 25);
    let events = 0;
    for (let s = 1; s <= n; s++) {
      const iso = isolatedSchema(TEST_DATABASE_URL, `o1par${s}`);
      open.push(iso);
      await iso.create();
      iso.pool.on("error", () => undefined);
      const bias = s % 2 === 0 ? 0 : 0.7;
      const mem = await genJournal(s, 50, { budgetBias: bias, deterministicIds: true });
      const pg = await genJournal(s, 50, { budgetBias: bias, deterministicIds: true, backend: postgresBackend(iso.pool) });
      expect(strip(pg)).toEqual(strip(mem));
      events += pg.length;
      const r = compareEngines(pg);
      expect(r.divergences).toEqual([]);
      await iso.drop();
      open.splice(open.indexOf(iso), 1);
    }
    console.info(`[O1] memory/PostgreSQL parity: scenarios=${n} events=${events} divergences=0`);
    expect(events).toBeGreaterThan(n * 10);
  });

  it("concurrent writers on one journal: every grant re-validates under the REFERENCE engine and no budget is exceeded", { timeout: 600_000 }, async () => {
    const rounds = Number(process.env.O1_PG_ROUNDS ?? 6);
    for (let round = 0; round < rounds; round++) {
      const iso = isolatedSchema(TEST_DATABASE_URL, `o1con${round}`);
      open.push(iso);
      await iso.create();
      iso.pool.on("error", () => undefined);
      const clock = { now: () => "2026-06-01T09:00:00.000Z" };
      const ev = createEventBuilders({ clock });
      const a = createAuthority({ backend: postgresBackend(iso.pool), clock, enforcementPointId: "ep" });
      const BUDGET = 10, AMOUNT = 3; // at most 3 tickets can ever be issued
      await a.record([ev.delegation({ delegationId: "d", grantor: "alice", grantee: "agent", capabilities: [{ resource: "r", action: "x" }], canDelegate: false, expiresAt: null, totalBudget: { value: BUDGET, currency: "EUR" }, thresholds: { automaticMax: { value: 5, currency: "EUR" }, approvalMax: { value: 9, currency: "EUR" } } })]);
      const calls = Array.from({ length: 12 }, (_, i) => ({ actionId: `c${round}-${i}`, agentId: "agent", delegationId: "d", capability: { resource: "r", action: "x" }, amount: { value: AMOUNT, currency: "EUR" } }));
      const results = await Promise.all(calls.map((c) => a.authorize(c)));
      const authorized = results.filter((r) => r.status === "AUTHORIZED").length;
      expect(authorized).toBeLessThanOrEqual(Math.floor(BUDGET / AMOUNT));
      expect(authorized).toBeGreaterThan(0);
      const journal = (await a.events()) as any[];
      const issued = journal.filter((e) => e.event_type === "CAPABILITY_ISSUED");
      expect(issued.length).toBe(authorized);
      for (const g of issued) expect((REFERENCE.validateAndSelectGrant(journal as any, g) as any).ok).toBe(true);
      const delegation = journal.find((e) => e.event_type === "DELEGATION_CREATED");
      const validated = issued.map((g) => (REFERENCE.validateAndSelectGrant(journal as any, g) as any).grant);
      expect(REFERENCE.remainingCapacity("d" as any, { value: BUDGET, currency: "EUR" } as any, validated, journal as any)).toBeGreaterThanOrEqual(0);
      expect(delegation).toBeDefined();
      expect(compareEngines(journal).divergences).toEqual([]);
      await iso.drop();
      open.splice(open.indexOf(iso), 1);
    }
  });
});
