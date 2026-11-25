/**
 * O2-1 and O2-2 (T1) on PostgreSQL 16 (skipped, with a warning, when TEST_DATABASE_URL is unreachable):
 *  - differential: current SDK vs frozen SDK + storage on the same scenarios, each on its own schema;
 *  - exact count of full-journal reads per authorize() path, before and after;
 *  - fault injection (journal read, append, issuance): the same fail-closed statuses;
 *  - concurrent callers on one journal: one request and at most one ticket per action, no budget exceeded, grants re-validated
 *    by the frozen engine.
 *
 *   O2_PG_SCENARIOS  differential scenarios (default 15)     O2_PG_ROUNDS  concurrent rounds (default 8)
 */
import { afterAll, describe, expect, it } from "vitest";
import { databaseAvailable, TEST_DATABASE_URL } from "../redemption/pgHarness.js";
import { isolatedSchema, type IsolatedSchema } from "../storage/pgTestSchema.js";
import { REFERENCE } from "../engine/helpers/o1.js";
import { IMPLS, runScenario, type Impl } from "./helpers/o2.js";

const available = await databaseAvailable();
if (!available) console.warn("[o2Backends.test.ts] TEST_DATABASE_URL is not reachable: skipping the PostgreSQL O2-1 tests.");
const open: IsolatedSchema[] = [];
afterAll(async () => { for (const i of open) await i.drop().catch(() => undefined); });
const d = available ? describe : describe.skip;

async function schema(label: string): Promise<IsolatedSchema> {
  const iso = isolatedSchema(TEST_DATABASE_URL, label);
  open.push(iso);
  await iso.create();
  iso.pool.on("error", () => undefined);
  return iso;
}
async function drop(iso: IsolatedSchema): Promise<void> { await iso.drop(); open.splice(open.indexOf(iso), 1); }

/** Counts every `SELECT * FROM authority_events` that reaches PostgreSQL (client-level, so one count per read) and whether a transaction/lock was open. */
function spyPool(iso: IsolatedSchema) {
  const counts = { reads: 0, lockedReads: 0, lockFree: 0, filtered: 0 };
  const origConnect = iso.pool.connect.bind(iso.pool) as any;
  (iso.pool as any).connect = async (...a: any[]) => {
    if (typeof a[0] === "function") return origConnect(...a);
    const c = await origConnect();
    if (!c.__spy) {
      const q = c.query.bind(c); let locked = false; c.__spy = true;
      c.query = (...x: any[]) => {
        const sql = String(typeof x[0] === "string" ? x[0] : x[0]?.text);
        if (/^BEGIN/.test(sql)) locked = false;
        if (/pg_advisory_xact_lock/.test(sql)) locked = true;
        if (/SELECT \* FROM authority_events WHERE event_type/.test(sql)) counts.filtered++;
        else if (/SELECT \* FROM authority_events/.test(sql)) { counts.reads++; if (locked) counts.lockedReads++; else counts.lockFree++; }
        if (/^(COMMIT|ROLLBACK)/.test(sql)) locked = false;
        return q(...x);
      };
    }
    return c;
  };
  return counts;
}

d("O2-1 on PostgreSQL 16", () => {
  it("differential: current SDK vs frozen SDK + storage, same scenarios, with and without budget", { timeout: 900_000 }, async () => {
    const n = Number(process.env.O2_PG_SCENARIOS ?? 15);
    let ops = 0;
    for (const bias of [0, 0.8]) {
      for (let seed = 1; seed <= n; seed++) {
        const out: Record<string, Awaited<ReturnType<typeof runScenario>>> = {};
        for (const impl of ["current", "oracle"] as Impl[]) {
          const iso = await schema(`o2d${impl[0]}${seed}`);
          out[impl] = await runScenario(seed, impl, { steps: 40, budgetBias: bias, backend: (I: any) => I.postgresBackend(iso.pool) });
          await drop(iso);
        }
        ops += out.current!.results.length;
        expect({ seed, bias, results: out.current!.results }).toEqual({ seed, bias, results: out.oracle!.results });
        expect({ seed, bias, journal: out.current!.journal }).toEqual({ seed, bias, journal: out.oracle!.journal });
      }
    }
    console.info(`[O2] PostgreSQL differential: scenarios=${2 * n} operations=${ops} divergences=0`);
    expect(ops).toBeGreaterThan(n * 60);
  });

  it("reads per authorize() path: the request lookup reads only the ACTION_REQUESTED rows; one full lock-free read fewer on every path that looks it up; the reads under the lock never change", async () => {
    const table: Record<string, Record<Impl, { lockFree: number; lockedReads: number; filtered: number }>> = {};
    for (const impl of ["current", "oracle"] as Impl[]) {
      const I = IMPLS[impl];
      const iso = await schema(`o2r${impl[0]}`);
      const spy = spyPool(iso);
      let now = Date.parse("2026-06-01T09:00:00.000Z");
      const clock = { now: () => new Date(now).toISOString() };
      const ev = I.createEventBuilders({ clock });
      const a = I.createAuthority({ backend: I.postgresBackend(iso.pool), clock, enforcementPointId: "ep" });
      await a.record([ev.delegation({ delegationId: "d", grantor: "alice", grantee: "agent", capabilities: [{ resource: "r", action: "x" }], canDelegate: false, expiresAt: null, thresholds: { automaticMax: { value: 5, currency: "EUR" }, approvalMax: { value: 50, currency: "EUR" } } })]);
      const call = (id: string, v = 3) => ({ actionId: id, agentId: "agent", delegationId: "d", capability: { resource: "r", action: "x" }, amount: { value: v, currency: "EUR" } });
      const measure = async (label: string, fn: () => Promise<any>, status: string) => {
        spy.reads = spy.lockedReads = spy.lockFree = spy.filtered = 0; now += 1000;
        const r = await fn(); expect(r.status).toBe(status);
        (table[label] ??= {} as any)[impl] = { lockFree: spy.lockFree, lockedReads: spy.lockedReads, filtered: spy.filtered };
      };
      await measure("new action, authorized", () => a.authorize(call("a1")), "AUTHORIZED");
      await measure("same action again (request exists, ticket exists)", () => a.authorize(call("a1")), "AUTHORIZED");
      await measure("new action, requires approval", () => a.authorize(call("a2", 20)), "REQUIRES_APPROVAL");
      await a.record([ev.approvalRequest({ approvalId: "ap2", actionId: "a2", requestedBy: "agent", requestedFrom: "alice", reasonCode: "R" })]);
      await a.record([ev.approvalGranted({ approvalId: "ap2", actionId: "a2", approver: "alice" })]);
      await measure("authorize after approval (request exists, issues)", () => a.authorize(call("a2", 20)), "AUTHORIZED");
      await measure("new action refused by policy", () => a.authorize(call("a3", 500)), "DENIED");
      await measure("action id reused with a different call", () => a.authorize(call("a1", 4)), "DENIED");
      await drop(iso);
    }
    console.info("[O2-T1] journal reads per call: full lock-free + filtered / full under lock, oracle -> current:\n" + Object.entries(table).map(([k, v]) => `  ${k.padEnd(58)} ${v.oracle.lockFree}+${v.oracle.filtered}/${v.oracle.lockedReads} -> ${v.current.lockFree}+${v.current.filtered}/${v.current.lockedReads}`).join("\n"));
    for (const [label, v] of Object.entries(table)) {
      expect({ label, lockedReads: v.current.lockedReads }).toEqual({ label, lockedReads: v.oracle.lockedReads }); // the reads under the lock are untouched
      expect({ label, filtered: v.oracle.filtered }).toEqual({ label, filtered: 0 });
      expect({ label, filtered: v.current.filtered }).toEqual({ label, filtered: 1 }); // exactly one filtered lookup per call
      expect({ label, lockFree: v.current.lockFree }).toEqual({ label, lockFree: v.oracle.lockFree - 1 }); // and one full lock-free read fewer
    }
  });

  describe("fault injection (journal read, append, issuance)", () => {
    /** Wraps the backend so that chosen store/issuance operations fail; `failGetEventsFrom` = the n-th call of getEvents (1-based) and the following ones fail. */
    function faulty(faults: { failGetEventsFrom?: number; failAppend?: boolean; failIssue?: boolean }) {
      let getCalls = 0;
      const wrap = (backend: any) => ({
        ...backend,
        build: (o: any) => {
          const parts = backend.build(o);
          const store = Object.create(parts.store);
          store.getEvents = (...x: any[]) => { getCalls++; if (faults.failGetEventsFrom !== undefined && getCalls >= faults.failGetEventsFrom) return Promise.reject(Object.assign(new Error("injected read failure"), { code: "ECONNREFUSED" })); return parts.store.getEvents(...x); };
          store.append = (...x: any[]) => (faults.failAppend ? Promise.reject(new Error("injected append failure")) : parts.store.append(...x));
          const issuance = Object.create(parts.issuance);
          issuance.issue = (...x: any[]) => (faults.failIssue ? Promise.reject(new Error("injected issuance failure")) : parts.issuance.issue(...x));
          return { ...parts, store, issuance };
        },
      });
      return { wrap, reset: () => { getCalls = 0; } };
    }

    async function outcome(impl: Impl, setup: "fresh" | "requested", faults: Parameters<typeof faulty>[0]) {
      const I = IMPLS[impl];
      const iso = await schema(`o2f${impl[0]}`);
      let now = Date.parse("2026-06-01T09:00:00.000Z");
      const clock = { now: () => new Date(now).toISOString() };
      const ev = I.createEventBuilders({ clock });
      const f = faulty(faults);
      const healthy = I.createAuthority({ backend: I.postgresBackend(iso.pool), clock, enforcementPointId: "ep" });
      await healthy.record([ev.delegation({ delegationId: "d", grantor: "alice", grantee: "agent", capabilities: [{ resource: "r", action: "x" }], canDelegate: false, expiresAt: null, thresholds: { automaticMax: { value: 5, currency: "EUR" }, approvalMax: { value: 50, currency: "EUR" } } })]);
      const call = { actionId: "a1", agentId: "agent", delegationId: "d", capability: { resource: "r", action: "x" }, amount: { value: 3, currency: "EUR" } };
      if (setup === "requested") {
        // the request is already in the journal, no ticket yet: a refused-by-approval first attempt leaves exactly that state
        await healthy.record([ev.approvalRequest({ approvalId: "ap0", actionId: "x0", requestedBy: "agent", requestedFrom: "alice", reasonCode: "R" })]).catch(() => undefined);
        const hungry = { ...call, actionId: "a1", amount: { value: 20, currency: "EUR" } };
        await healthy.authorize(hungry); // REQUIRES_APPROVAL: request journaled, nothing issued
        await healthy.record([ev.approvalRequest({ approvalId: "ap1", actionId: "a1", requestedBy: "agent", requestedFrom: "alice", reasonCode: "R" })]);
        await healthy.record([ev.approvalGranted({ approvalId: "ap1", actionId: "a1", approver: "alice" })]);
        (call as any).amount = hungry.amount;
      }
      now += 1000;
      const faultyAuthority = I.createAuthority({ backend: f.wrap(I.postgresBackend(iso.pool)), clock, enforcementPointId: "ep" });
      const r: any = await faultyAuthority.authorize(call);
      const journal = ((await healthy.events()) as any[]).map((e) => e.event_type);
      await drop(iso);
      return { status: r.status, code: r.code, reason: r.reason, journal };
    }

    it("a failing journal read is UNAVAILABLE and writes nothing, identically before and after", async () => {
      for (const setup of ["fresh", "requested"] as const) {
        const a = await outcome("current", setup, { failGetEventsFrom: 1 });
        const b = await outcome("oracle", setup, { failGetEventsFrom: 1 });
        expect(a).toEqual(b);
        expect(a.status).toBe("UNAVAILABLE");
      }
    });

    it("a failing append of the request is UNAVAILABLE, identically before and after", async () => {
      const a = await outcome("current", "fresh", { failAppend: true });
      const b = await outcome("oracle", "fresh", { failAppend: true });
      expect(a).toEqual(b);
      expect(a.status).toBe("UNAVAILABLE");
    });

    it("a failing issuance is UNAVAILABLE and issues nothing, identically before and after, on both paths", async () => {
      for (const setup of ["fresh", "requested"] as const) {
        const a = await outcome("current", setup, { failIssue: true });
        const b = await outcome("oracle", setup, { failIssue: true });
        expect(a).toEqual(b);
        expect(a.status).toBe("UNAVAILABLE");
        expect(a.journal.includes("CAPABILITY_ISSUED")).toBe(false);
      }
    });

    it("any later journal read failing (the pre-check read after the lookup): the same fail-closed result as before, new or existing request", async () => {
      for (const setup of ["fresh", "requested"] as const) {
        const a = await outcome("current", setup, { failGetEventsFrom: 2 });
        const b = await outcome("oracle", setup, { failGetEventsFrom: 2 });
        expect(a).toEqual(b);
        expect(a.status).toBe("UNAVAILABLE");
        expect(a.journal.includes("CAPABILITY_ISSUED")).toBe(false);
      }
    });
  });

  it("malformed and colliding rows (raw INSERTs, as a writer with INSERT could): identical results, errors and journals before and after", { timeout: 300_000 }, async () => {
    const reqPayload = (id: unknown, who = "agent") => ({ action_id: id, requesting_principal_id: who, delegation_id: "d", capability_requested: { resource: "r", action: "x" }, parameters: { kind: "monetary", amount: { value: 3, currency: "EUR" } } });
    const longId = (await import("node:crypto")).randomBytes(6000).toString("base64");
    const CASES: Record<string, { rows: [string, unknown][]; special: string }> = {
      "JSON null payload before every later request": { rows: [["ACTION_REQUESTED", null]], special: "tgt" },
      "a string payload and an array payload before": { rows: [["ACTION_REQUESTED", "oops"], ["ACTION_REQUESTED", ["tgt"]]], special: "tgt" },
      "a numeric action_id 7, then the call for the string 7": { rows: [["ACTION_REQUESTED", reqPayload(7)]], special: "7" },
      "a missing / null / object action_id before": { rows: [["ACTION_REQUESTED", { ...reqPayload("x"), action_id: undefined }], ["ACTION_REQUESTED", reqPayload(null)], ["ACTION_REQUESTED", reqPayload({ a: 1 })]], special: "tgt" },
      "a duplicate request for the target by someone else, first by sequence": { rows: [["ACTION_REQUESTED", reqPayload("tgt", "mallory")]], special: "tgt" },
      "the same action id carried by another event type": { rows: [["CAPABILITY_ISSUED", { action_id: "tgt", capability_id: "c-x" }]], special: "tgt" },
      "an 8 000-character action id": { rows: [], special: longId },
    };
    for (const [name, c] of Object.entries(CASES)) {
      const run: Record<string, unknown> = {};
      for (const impl of ["current", "oracle"] as Impl[]) {
        const I = IMPLS[impl];
        const iso = await schema(`o2m${impl[0]}`);
        let now = Date.parse("2026-06-01T09:00:00.000Z");
        const clock = { now: () => new Date(now).toISOString() };
        let n = 0;
        const ev = I.createEventBuilders({ clock, newEventId: () => `evt-${++n}` });
        const a = I.createAuthority({ backend: I.postgresBackend(iso.pool), clock, enforcementPointId: "ep", newId: () => `cap-${++n}` });
        await a.record([ev.delegation({ delegationId: "d", grantor: "alice", grantee: "agent", capabilities: [{ resource: "r", action: "x" }], canDelegate: false, expiresAt: null, thresholds: { automaticMax: { value: 5, currency: "EUR" }, approvalMax: { value: 50, currency: "EUR" } } })]);
        let seq = 2;
        for (const [type, payload] of c.rows) await iso.pool.query(`INSERT INTO authority_events (sequence,event_id,event_type,principal_id,schema_version,occurred_at,authority_time,recorded_at,assurance_level,payload) VALUES ($1,$2,$3,'agent',1,'2026-06-01T09:00:00Z','2026-06-01T09:00:00Z',now(),'ASSERTED_UNVERIFIED',$4::jsonb)`, [seq++, `raw-${seq}`, type, JSON.stringify(payload)]);
        const call = (id: string, v = 3) => ({ actionId: id, agentId: "agent", delegationId: "d", capability: { resource: "r", action: "x" }, amount: { value: v, currency: "EUR" } });
        const results: unknown[] = [];
        for (const [label, fn] of [["new", () => a.authorize(call("n1"))], ["retry", () => a.authorize(call("n1"))], ["reuse", () => a.authorize(call("n1", 4))], ["special", () => a.authorize(call(c.special))], ["special again", () => a.authorize(call(c.special))], ["special different", () => a.authorize(call(c.special, 4))]] as const) {
          now += 1000;
          try { results.push([label, JSON.parse(JSON.stringify(await fn(), (_k, v) => (typeof v === "string" ? v.replace(/diag-[0-9a-f-]{36}/g, "diag-*") : v)))]); } catch (e: any) { results.push([label, { threw: e?.name }]); }
        }
        const journal = ((await iso.pool.query("SELECT sequence, event_type, payload FROM authority_events ORDER BY sequence")).rows as any[]).map((r) => ({ s: Number(r.sequence), t: r.event_type, a: r.payload?.action_id === undefined ? null : String(r.payload.action_id).slice(0, 40) }));
        run[impl] = { results, journal };
        await drop(iso);
      }
      expect({ name, ...(run.current as object) }).toEqual({ name, ...(run.oracle as object) });
      if (name.startsWith("JSON null payload")) expect(JSON.stringify(run.oracle)).toContain("UNAVAILABLE"); // the reference really fails closed here: the error parity is exercised
    }
    console.info(`[O2-T1] PostgreSQL malformed/colliding rows: cases=${Object.keys(CASES).length} divergences=0`);
  });

  it("concurrent callers: one request and at most one ticket per action, no budget exceeded, every grant valid for the frozen engine, same status counts as before", { timeout: 600_000 }, async () => {
    const rounds = Number(process.env.O2_PG_ROUNDS ?? 8);
    for (let round = 0; round < rounds; round++) {
      const tallies: Record<string, Record<string, number>> = {};
      for (const impl of ["current", "oracle"] as Impl[]) {
        const I = IMPLS[impl];
        const iso = await schema(`o2c${impl[0]}${round}`);
        const clock = { now: () => "2026-06-01T09:00:00.000Z" };
        const ev = I.createEventBuilders({ clock });
        const a = I.createAuthority({ backend: I.postgresBackend(iso.pool), clock, enforcementPointId: "ep" });
        const BUDGET = 10, AMOUNT = 3;
        await a.record([ev.delegation({ delegationId: "d", grantor: "alice", grantee: "agent", capabilities: [{ resource: "r", action: "x" }], canDelegate: false, expiresAt: null, totalBudget: { value: BUDGET, currency: "EUR" }, thresholds: { automaticMax: { value: 5, currency: "EUR" }, approvalMax: { value: 9, currency: "EUR" } } })]);
        const call = (id: string, v = AMOUNT) => ({ actionId: id, agentId: "agent", delegationId: "d", capability: { resource: "r", action: "x" }, amount: { value: v, currency: "EUR" } });
        const batch = [
          ...Array.from({ length: 6 }, () => call("same")),                  // identical call, concurrent
          ...Array.from({ length: 3 }, (_, i) => call("clash", 1 + i)),       // same id, different calls
          ...Array.from({ length: 8 }, (_, i) => call(`other-${i}`)),         // different actions under a tight budget
        ];
        const res: any[] = await Promise.all(batch.map((c) => a.authorize(c)));
        const tally: Record<string, number> = {};
        res.forEach((r, i) => { const k = `${batch[i]!.actionId.replace(/-\d+$/, "")}:${r.status}${r.reason ? ":" + r.reason : ""}`; tally[k] = (tally[k] ?? 0) + 1; });
        tallies[impl] = tally;
        const journal = (await a.events()) as any[];
        const requests = journal.filter((e) => e.event_type === "ACTION_REQUESTED");
        const issued = journal.filter((e) => e.event_type === "CAPABILITY_ISSUED");
        expect(new Set(requests.map((e) => e.payload.action_id)).size).toBe(requests.length); // one request per action
        expect(new Set(issued.map((e) => e.payload.action_id)).size).toBe(issued.length); // I32: at most one ticket per action
        const valid = issued.map((g) => (REFERENCE.validateAndSelectGrant(journal as any, g) as any));
        for (const v of valid) expect(v.ok).toBe(true);
        expect(REFERENCE.remainingCapacity("d" as any, { value: BUDGET, currency: "EUR" } as any, valid.map((v) => v.grant), journal as any)).toBeGreaterThanOrEqual(0);
        const sameTickets = new Set(res.filter((r, i) => batch[i]!.actionId === "same" && r.status === "AUTHORIZED").map((r) => r.ticket.capabilityId));
        expect(sameTickets.size).toBeLessThanOrEqual(1); // every successful concurrent identical call returns the one ticket
        await drop(iso);
      }
      // the clash and same categories are deterministic in their counts; budget races may pick different winners but never more than the budget allows
      const pick = (t: Record<string, number>, prefix: string) => Object.fromEntries(Object.entries(t).filter(([k]) => k.startsWith(prefix)));
      const clashStatuses = (t: Record<string, number>) => Object.values(pick(t, "clash:")).reduce((x, y) => x + y, 0);
      expect(clashStatuses(tallies.current!)).toBe(clashStatuses(tallies.oracle!));
      // Which action wins the budget is a race: it may differ between the two runs. What must hold in each run: the six identical concurrent calls
      // received ONE decision (all authorized with the one ticket, or all refused for capacity), never a mixture.
      for (const impl of ["current", "oracle"] as const) {
        const keys = Object.keys(pick(tallies[impl]!, "same:"));
        expect({ impl, keys }).toEqual({ impl, keys: keys.length === 1 && /^same:(AUTHORIZED|DENIED:CAPACITY_EXCEEDED)$/.test(keys[0]!) ? keys : ["one decision"] });
      }
    }
  });
});
