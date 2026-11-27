/**
 * D1 prototype (AUTHORITY_AUTHORIZE_SNAPSHOT=single) on PostgreSQL 16, against the sequential protocol:
 *   1. same results and same journals on scenario sequences (refusals, approvals, budgets, reuse of an action id, retries);
 *   2. a crash injected at EVERY statement of a call, before and after it (so also "committed, acknowledgement lost"), then a recovery by retrying:
 *      what each protocol leaves behind, and that the final state is always one request + at most one ticket;
 *   3. freshness and coherence: a writer that commits before the call takes the lock is seen; a writer that arrives during the call waits for it;
 *   4. concurrent callers keep the invariants.
 * Skipped (with a warning) when TEST_DATABASE_URL is not reachable.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createAuthority, createEventBuilders, postgresBackend, type Authority, type ToolCall } from "../../src/sdk/index.js";
import { databaseAvailable, TEST_DATABASE_URL } from "../redemption/pgHarness.js";
import { isolatedSchema, type IsolatedSchema } from "../storage/pgTestSchema.js";

const available = await databaseAvailable();
if (!available) console.warn("[d1SingleSnapshot.test.ts] TEST_DATABASE_URL is not reachable: skipping the PostgreSQL D1 tests.");
const d = available ? describe : describe.skip;
const open: IsolatedSchema[] = [];
afterAll(async () => { for (const i of open) await i.drop().catch(() => undefined); });
/** Foreign lock holders opened by a test: a failed assertion must never leave one open (it would block every later test and every mutation run on the database-wide advisory lock). */
const heldClients: { client: any; done: boolean }[] = [];
async function hold(pool: Pool): Promise<any> {
  const client = await pool.connect();
  heldClients.push({ client, done: false });
  return client;
}
/** A pool hands the same client object out again after a release: close the NEWEST open entry for it. */
function finished(client: any): void { const h = [...heldClients].reverse().find((x) => x.client === client && !x.done); if (h) h.done = true; client.release(); }
afterEach(async () => {
  delete process.env.AUTHORITY_AUTHORIZE_SNAPSHOT;
  for (const h of heldClients.splice(0)) if (!h.done) { await h.client.query("ROLLBACK").catch(() => undefined); h.client.release(); }
});

type Mode = "sequential" | "single";
const setMode = (m: Mode) => { if (m === "single") process.env.AUTHORITY_AUTHORIZE_SNAPSHOT = "single"; else delete process.env.AUTHORITY_AUTHORIZE_SNAPSHOT; };
const clock = { now: () => "2026-06-01T09:00:00.000Z" };
const CAP = { resource: "r", action: "x" };
const call = (id: string, v = 3, extra: Partial<ToolCall> = {}): ToolCall => ({ actionId: id, agentId: "agent", delegationId: "d", capability: CAP, amount: { value: v, currency: "EUR" }, ...extra });

async function fresh(label: string, budget = 10): Promise<{ iso: IsolatedSchema; pool: Pool }> {
  const iso = isolatedSchema(TEST_DATABASE_URL, label);
  open.push(iso);
  await iso.create();
  iso.pool.on("error", () => undefined);
  const ev = createEventBuilders({ clock });
  const a = createAuthority({ backend: postgresBackend(iso.pool), clock, enforcementPointId: "ep" });
  await a.record([ev.delegation({ delegationId: "d", grantor: "alice", grantee: "agent", capabilities: [CAP], canDelegate: false, expiresAt: null, totalBudget: { value: budget, currency: "EUR" }, thresholds: { automaticMax: { value: 5, currency: "EUR" }, approvalMax: { value: 9, currency: "EUR" } } })]);
  return { iso, pool: iso.pool };
}
async function drop(iso: IsolatedSchema) { await iso.drop().catch(() => undefined); open.splice(open.indexOf(iso), 1); }

/** A pool whose clients throw before or after the n-th statement (counted across every connection of the call). */
function faultyPool(pool: Pool, fault: { at: number; when: "before" | "after" } | undefined, log: string[]): Pool {
  let n = 0;
  const wrapClient = (client: any) => new Proxy(client, {
    get(target, prop, receiver) {
      if (prop !== "query") { const v = Reflect.get(target, prop, receiver); return typeof v === "function" ? v.bind(target) : v; }
      return async (...args: any[]) => {
        const text = String(typeof args[0] === "string" ? args[0] : args[0]?.text).replace(/\s+/g, " ").trim().slice(0, 60);
        const index = ++n;
        log.push(`${index}:${text}`);
        if (fault && fault.at === index && fault.when === "before") throw new Error(`injected failure before statement ${index}`);
        const result = await target.query(...args);
        if (fault && fault.at === index && fault.when === "after") throw new Error(`injected failure after statement ${index}`);
        return result;
      };
    },
  });
  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === "connect") return async () => wrapClient(await target.connect());
      if (prop === "query") return async (...args: any[]) => wrapClient(target).query(...args);
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as Pool;
}

const types = (events: readonly any[]) => events.map((e) => `${e.event_type}`);
const norm = (v: string) => v.replace(/(cap|evt)-[0-9a-f-]{36}/g, "$1-*").replace(/:attempt-.*$/, ":attempt-*");
const strip = (events: readonly any[]) => events.map((e) => { const { recorded_at: _r, ...rest } = e; return { ...rest, event_id: norm(String(rest.event_id)), payload: JSON.parse(JSON.stringify(rest.payload, (_k, v) => (typeof v === "string" ? norm(v) : v))) }; });
const idemRows = async (pool: Pool) => Number((await pool.query("SELECT count(*)::int c FROM capability_issuance_idempotency")).rows[0].c);

d("D1 single snapshot on PostgreSQL 16", () => {
  it("same results and same journals as the sequential protocol on scenario sequences", { timeout: 600_000 }, async () => {
    const scenarios: { name: string; steps: ((a: Authority, pool: Pool) => Promise<unknown>)[] }[] = [
      { name: "plain", steps: [(a) => a.authorize(call("a1")), (a) => a.authorize(call("a1")), (a) => a.authorize(call("a2"))] },
      { name: "budget exhausted", steps: [(a) => a.authorize(call("b1", 4)), (a) => a.authorize(call("b2", 4)), (a) => a.authorize(call("b3", 4)), (a) => a.authorize(call("b3", 4))] },
      { name: "approval band", steps: [(a) => a.authorize(call("c1", 7)), (a) => a.authorize(call("c1", 7))] },
      { name: "action id reused with another call", steps: [(a) => a.authorize(call("e1", 3)), (a) => a.authorize(call("e1", 4)), (a) => a.authorize(call("e1", 3, { agentId: "someone" }))] },
      { name: "unknown delegation", steps: [(a) => a.authorize(call("f1", 3, { delegationId: "nope" })), (a) => a.authorize(call("f1", 3, { delegationId: "nope" }))] },
      { name: "wrong capability", steps: [(a) => a.authorize(call("g1", 3, { capability: { resource: "r", action: "y" } }))] },
      { name: "over the approval ceiling", steps: [(a) => a.authorize(call("h1", 50))] },
      { name: "guard flow", steps: [async (a) => a.guard(call("i1"), async () => "effect"), async (a) => a.guard(call("i1"), async () => "effect")] },
    ];
    const seen = { journals: 0, events: 0 };
    for (const sc of scenarios) {
      const out: Record<Mode, { results: unknown[]; journal: unknown[]; idem: number }> = {} as any;
      for (const mode of ["sequential", "single"] as Mode[]) {
        const { iso, pool } = await fresh(`d1eq-${mode}`);
        setMode(mode);
        let n = 0;
        const a = createAuthority({ backend: postgresBackend(pool), clock, enforcementPointId: "ep", newId: () => `cap-00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` });
        const results: unknown[] = [];
        for (const step of sc.steps) results.push(JSON.parse(JSON.stringify(await step(a, pool), (_k, v) => (typeof v === "string" ? v.replace(/diag-[0-9a-f-]{36}/, "diag-*") : v))));
        out[mode] = { results, journal: strip(await a.events()), idem: await idemRows(pool) };
        await drop(iso);
      }
      expect(out.single.results, sc.name).toEqual(out.sequential.results);
      expect(out.single.journal, sc.name).toEqual(out.sequential.journal);
      expect(out.single.idem, sc.name).toBe(out.sequential.idem);
      seen.journals++; seen.events += out.single.journal.length;
    }
    console.info(`[D1] scenario parity: scenarios=${seen.journals} events=${seen.events} divergences=0`);
  });

  it("crash at every statement of a call, before and after it, then recovery by retry: what each protocol leaves behind", { timeout: 900_000 }, async () => {
    const run = async (mode: Mode, fault: { at: number; when: "before" | "after" } | undefined) => {
      const { iso, pool } = await fresh(`d1cr-${mode}`);
      setMode(mode);
      const log: string[] = [];
      const faulty = createAuthority({ backend: postgresBackend(faultyPool(pool, fault, log)), clock, enforcementPointId: "ep" });
      const healthy = createAuthority({ backend: postgresBackend(pool), clock, enforcementPointId: "ep" });
      const first: any = await faulty.authorize(call("x1"));
      const afterFault = types(await healthy.events());
      const second: any = await healthy.authorize(call("x1"));
      const finalJournal = (await healthy.events()) as any[];
      const out = { statements: log, first: first.status, afterFault, second: second.status, final: types(finalJournal), ticket: second.ticket?.capabilityId as string | undefined, issuedIds: finalJournal.filter((e) => e.event_type === "CAPABILITY_ISSUED").map((e) => e.payload.capability_id), idem: await idemRows(pool) };
      await drop(iso);
      return out;
    };
    const rows: string[] = [];
    const finals: Record<string, string> = {};
    for (const mode of ["sequential", "single"] as Mode[]) {
      const baseline = await run(mode, undefined);
      expect(baseline.first).toBe("AUTHORIZED");
      const K = baseline.statements.length;
      expect(K).toBeGreaterThan(3);
      const preState = ["DELEGATION_CREATED"];
      let partial = 0, lost = 0, clean = 0;
      for (let k = 1; k <= K; k++) {
        for (const when of ["before", "after"] as const) {
          const r = await run(mode, { at: k, when });
          const stmt = baseline.statements[k - 1]!.replace(/^\d+:/, "");
          // invariants of recovery, both protocols
          expect(r.second, `${mode} ${when} #${k} ${stmt}`).toBe("AUTHORIZED");
          expect(r.final.filter((t) => t === "ACTION_REQUESTED"), `${mode} ${when} #${k}`).toHaveLength(1);
          expect(r.final.filter((t) => t === "CAPABILITY_ISSUED"), `${mode} ${when} #${k}`).toHaveLength(1);
          expect(r.issuedIds, `${mode} ${when} #${k}`).toHaveLength(1);
          expect(r.idem, `${mode} ${when} #${k}`).toBe(1);
          if (r.first === "AUTHORIZED") { /* the fault landed after the work that matters (e.g. release of the connection) */ }
          const isPre = JSON.stringify(r.afterFault) === JSON.stringify(preState);
          const isFull = r.afterFault.includes("CAPABILITY_ISSUED");
          if (mode === "single") {
            // all or nothing: the call either left the journal as it was or committed everything
            expect(isPre || isFull, `single ${when} #${k} ${stmt} left ${r.afterFault.join(",")}`).toBe(true);
          }
          finals[`${mode}/${when}/${k}`] = r.final.join(",");
          if (!isPre && !isFull) partial++;
          if (isFull && r.first !== "AUTHORIZED") lost++;
          if (isPre) clean++;
          rows.push(`${mode.padEnd(10)} ${when.padEnd(6)} stmt#${String(k).padStart(2)} ${stmt.padEnd(60)} first=${r.first.padEnd(11)} left=[${r.afterFault.join(",")}] retry=${r.second}`);
        }
      }
      console.info(`[D1] ${mode}: statements/call=${K} cases=${2 * K} nothing-written=${clean} request-without-ticket=${partial} committed-but-acknowledgement-lost=${lost}`);
      if (mode === "single") expect(partial).toBe(0);
      else expect(partial).toBeGreaterThan(0); // the sequential protocol does leave a request without ticket
    }
    // after recovery by retry, both protocols converge on the same journal shape for the matching fault (statement numbering differs, so compare the set)
    expect(new Set(Object.entries(finals).filter(([k]) => k.startsWith("single/")).map(([, v]) => v))).toEqual(new Set(Object.entries(finals).filter(([k]) => k.startsWith("sequential/")).map(([, v]) => v)));
    console.info("[D1] crash matrix\n" + rows.join("\n"));
  });

  it("refusals that depend on the store itself behave identically: a rejected request append and a missing I32 index", { timeout: 120_000 }, async () => {
    const outcomes: Record<Mode, { rejected: unknown; schema: unknown; journalAfterSchema: string[]; securityLog: number }> = {} as any;
    for (const mode of ["sequential", "single"] as Mode[]) {
      setMode(mode);
      // (1) the request's event_id is already taken by another event: ingestion refuses it (I8), the call is DENIED, nothing is issued
      const f1 = await fresh(`d1rej-${mode}`);
      const a1 = createAuthority({ backend: postgresBackend(f1.pool), clock, enforcementPointId: "ep" });
      const ev = createEventBuilders({ clock });
      const taken: any = await a1.record([ev.revocation({ delegationId: "ghost", revokedBy: "alice", reasonCode: "R", eventId: "sdk-request.q1" })]);
      expect(taken.status).toBe("RECORDED");
      const rejected: any = await a1.authorize(call("q1"));
      const securityLog = Number((await f1.pool.query("SELECT count(*)::int c FROM security_log")).rows[0].c);
      await drop(f1.iso);
      // (2) the one-ticket-per-action index is missing: nothing is written, the call is UNAVAILABLE (the I32 backstop is not in force)
      const f2 = await fresh(`d1idx-${mode}`);
      await f2.pool.query("DROP INDEX authority_events_ticketed_action_id_uidx");
      const a2 = createAuthority({ backend: postgresBackend(f2.pool), clock, enforcementPointId: "ep" });
      const schema: any = await a2.authorize(call("q2"));
      const journalAfterSchema = types(await a2.events());
      await drop(f2.iso);
      outcomes[mode] = { rejected: { status: rejected.status, reason: rejected.reason }, schema: { status: schema.status, code: schema.code }, journalAfterSchema, securityLog };
    }
    expect(outcomes.single.rejected).toEqual(outcomes.sequential.rejected);
    expect(outcomes.single.securityLog).toBe(outcomes.sequential.securityLog);
    expect(outcomes.single.schema).toEqual(outcomes.sequential.schema);
    // the documented difference: the sequential protocol appends the request BEFORE the issuance notices the missing index; D1 checks first and writes nothing
    expect(outcomes.sequential.journalAfterSchema).toEqual(["DELEGATION_CREATED", "ACTION_REQUESTED"]);
    expect(outcomes.single.rejected).toEqual({ status: "DENIED", reason: "ACTION_REQUEST_REJECTED:EVENT_ID_CONFLICT" });
    expect((outcomes.single.schema as any).status).toBe("UNAVAILABLE");
    expect(outcomes.single.journalAfterSchema).toEqual(["DELEGATION_CREATED"]);
  });

  it("freshness and coherence: a writer committed before the lock is seen; a writer arriving during the call waits for it", { timeout: 120_000 }, async () => {
    setMode("single");
    const { iso, pool } = await fresh("d1fresh", 10);
    const ev = createEventBuilders({ clock });
    const a = createAuthority({ backend: postgresBackend(pool), clock, enforcementPointId: "ep" });
    const other = createAuthority({ backend: postgresBackend(pool), clock, enforcementPointId: "ep2" });
    // (1) hold the advisory lock in a foreign transaction, start the call, let the foreign writer revoke the delegation, release: the call must see the revocation
    const holder = await hold(pool);
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtext('authority_events'))");
    let settled = false;
    const pending = a.authorize(call("k1")).then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 300));
    expect(settled, "the call must wait for the lock").toBe(false);
    await holder.query("COMMIT");
    const blockedResult = await pending;
    finished(holder);
    expect(blockedResult.status).toBe("AUTHORIZED"); // nothing was written by the holder: same result as without the wait
    // (2) a revocation committed BEFORE the call takes the lock is always seen
    const recorded: any = await other.record([ev.revocation({ delegationId: "d", revokedBy: "alice", reasonCode: "R" })]);
    expect(recorded.status).toBe("RECORDED");
    const afterRevocation = await a.authorize(call("k2"));
    const journal = (await a.events()) as any[];
    expect(journal.some((e) => e.event_type === "DELEGATION_REVOKED")).toBe(true);
    expect(afterRevocation.status).toBe("DENIED"); // the revocation committed before this call took the lock is part of its snapshot
    // (3) a foreign writer that arrives while the call holds the lock waits until it has committed
    const probe = await hold(pool);
    const order: string[] = [];
    await probe.query("BEGIN");
    await probe.query("SELECT pg_advisory_xact_lock(hashtext('authority_events'))");
    const inFlight = a.authorize(call("k3")).then(() => order.push("call-done"));
    await new Promise((r) => setTimeout(r, 200));
    order.push("foreign-releases");
    await probe.query("COMMIT");
    finished(probe);
    await inFlight;
    expect(order).toEqual(["foreign-releases", "call-done"]);
    await drop(iso);
  });

  it("concurrent callers: one request and at most one ticket per action, the budget holds, every call gets one answer", { timeout: 600_000 }, async () => {
    for (let round = 0; round < Number(process.env.D1_ROUNDS ?? 6); round++) {
      setMode("single");
      const { iso, pool } = await fresh(`d1con${round}`, 10);
      const a = createAuthority({ backend: postgresBackend(pool), clock, enforcementPointId: "ep" });
      const batch = [...Array.from({ length: 6 }, () => call("same")), ...Array.from({ length: 3 }, (_, i) => call("clash", 1 + i)), ...Array.from({ length: 8 }, (_, i) => call(`other-${i}`))];
      const results: any[] = await Promise.all(batch.map((c) => a.authorize(c)));
      expect(results.every((r) => ["AUTHORIZED", "DENIED"].includes(r.status)), JSON.stringify(results.map((r) => r.status))).toBe(true);
      const journal = (await a.events()) as any[];
      const requests = journal.filter((e) => e.event_type === "ACTION_REQUESTED");
      const issued = journal.filter((e) => e.event_type === "CAPABILITY_ISSUED");
      expect(new Set(requests.map((e) => e.payload.action_id)).size).toBe(requests.length);
      expect(new Set(issued.map((e) => e.payload.action_id)).size).toBe(issued.length);
      const spent = issued.reduce((sum, e) => sum + Number(batch.find((c) => c.actionId === e.payload.action_id)!.amount?.value ?? 0), 0);
      expect(spent).toBeLessThanOrEqual(10 + 2); // clash may be any of 1..3
      const sameTickets = new Set(results.filter((r, i) => batch[i]!.actionId === "same" && r.status === "AUTHORIZED").map((r) => r.ticket.capabilityId));
      expect(sameTickets.size).toBeLessThanOrEqual(1);
      await drop(iso);
    }
  });

  // ------------------------------------------------------------------------------------------------ contention and unbounded waits (documented differences 7-9)
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Runs `body` while a foreign protocol-following transaction holds the advisory lock; releases it afterwards. */
  async function withHolder<T>(pool: Pool, body: (release: () => Promise<void>) => Promise<T>): Promise<T> {
    const holder = await hold(pool);
    let released = false;
    const release = async () => { if (!released) { released = true; await holder.query("COMMIT"); finished(holder); } };
    await holder.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await holder.query("SELECT pg_advisory_xact_lock(hashtext('authority_events'))");
    try { return await body(release); } finally { if (!released) { released = true; await holder.query("ROLLBACK").catch(() => undefined); finished(holder); } }
  }

  it("a refusal that needed no write used to be answered WITHOUT the lock; with D1 it waits for it (documented difference)", { timeout: 60_000 }, async () => {
    const out: Record<Mode, { answeredWhileLockHeld: boolean; status: string }> = {} as any;
    for (const mode of ["sequential", "single"] as Mode[]) {
      const { iso, pool } = await fresh(`d1ref-${mode}`);
      setMode(mode);
      const a = createAuthority({ backend: postgresBackend(pool), clock, enforcementPointId: "ep" });
      expect((await a.authorize(call("f1", 3)) as any).status).toBe("AUTHORIZED");
      let settled = false;
      const r = await withHolder(pool, async (release) => {
        const pending = a.authorize(call("f1", 4)).then((x) => { settled = true; return x; }); // the action id is reused with another call: a pure refusal
        await sleep(400);
        const answeredWhileLockHeld = settled;
        await release();
        return { answeredWhileLockHeld, status: ((await pending) as any).reason as string };
      });
      out[mode] = r;
      await drop(iso);
    }
    expect(out.sequential).toEqual({ answeredWhileLockHeld: true, status: "ACTION_ID_REUSED_WITH_DIFFERENT_CALL" });
    expect(out.single).toEqual({ answeredWhileLockHeld: false, status: "ACTION_ID_REUSED_WITH_DIFFERENT_CALL" });
  });

  it("a stuck lock holder: D1 waits for as long as it holds the lock; with a lock_timeout on the session the call fails fast as UNAVAILABLE, writes nothing, and the pool serves the next call", { timeout: 60_000 }, async () => {
    const { iso } = await fresh("d1stuck");
    const bounded = new Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${iso.schema} -c lock_timeout=600` });
    bounded.on("error", () => undefined);
    setMode("single");
    const a = createAuthority({ backend: postgresBackend(bounded), clock, enforcementPointId: "ep" });
    const before = (await iso.pool.query("SELECT count(*)::int c FROM authority_events")).rows[0].c;
    const t0 = Date.now();
    const result = await withHolder(iso.pool, async () => a.authorize(call("s1", 3)) as Promise<any>);
    const waited = Date.now() - t0;
    expect(result.status).toBe("UNAVAILABLE");
    expect(waited).toBeGreaterThanOrEqual(500);
    expect(waited).toBeLessThan(5_000); // bounded by lock_timeout, not by the holder
    expect((await iso.pool.query("SELECT count(*)::int c FROM authority_events")).rows[0].c).toBe(before); // nothing written, not even the request
    expect(((await a.authorize(call("s1", 3))) as any).status).toBe("AUTHORIZED"); // the pool is healthy once the holder is gone
    await bounded.end();
    await drop(iso);
  });

  it("pool exhaustion: callers waiting for the lock hold their connection, so a pool of 2 with 4 waiting calls starves every other user of the pool until the lock is released; all four then complete", { timeout: 60_000 }, async () => {
    const { iso } = await fresh("d1pool");
    const small = new Pool({ connectionString: TEST_DATABASE_URL, max: 2, options: `-c search_path=${iso.schema}` });
    small.on("error", () => undefined);
    setMode("single");
    const a = createAuthority({ backend: postgresBackend(small), clock, enforcementPointId: "ep" });
    const waits = await withHolder(iso.pool, async (release) => {
      const calls = [1, 2, 3, 4].map((i) => a.authorize(call(`p${i}`, 1)) as Promise<any>);
      await sleep(300);
      let readDone = false;
      const read = a.events().then((e) => { readDone = true; return e; }); // a plain read needs a connection of the same pool
      await sleep(300);
      const readStarvedWhileLockHeld = !readDone;
      await release();
      const results = await Promise.all(calls);
      await read;
      return { readStarvedWhileLockHeld, statuses: results.map((r) => r.status) };
    });
    expect(waits.readStarvedWhileLockHeld).toBe(true);
    expect(waits.statuses).toEqual(["AUTHORIZED", "AUTHORIZED", "AUTHORIZED", "AUTHORIZED"]);
    await small.end();
    await drop(iso);
  });

  it("the injected clock runs under the advisory lock: how many clock reads happen between the lock and the COMMIT, per protocol", { timeout: 60_000 }, async () => {
    const counts: Record<Mode, number> = {} as any;
    for (const mode of ["sequential", "single"] as Mode[]) {
      const { iso, pool } = await fresh(`d1clock-${mode}`);
      setMode(mode);
      const log: string[] = [];
      const logged = new Proxy(pool, { get(t, p, r) { if (p === "connect") return async () => { const c: any = await t.connect(); return new Proxy(c, { get(ct, cp, cr) { if (cp !== "query") { const v = Reflect.get(ct, cp, cr); return typeof v === "function" ? v.bind(ct) : v; } return async (...a: any[]) => { const text = String(typeof a[0] === "string" ? a[0] : a[0]?.text); if (/advisory_xact_lock/.test(text)) log.push("LOCK"); const res = await ct.query(...a); if (/^(COMMIT|ROLLBACK)/.test(text)) log.push("END"); return res; }; } }); }; const v = Reflect.get(t, p, r); return typeof v === "function" ? v.bind(t) : v; } }) as Pool;
      const spyClock = { now: () => { log.push("CLOCK"); return clock.now(); } };
      const a = createAuthority({ backend: postgresBackend(logged), clock: spyClock, enforcementPointId: "ep" });
      log.length = 0;
      expect(((await a.authorize(call("k1", 3))) as any).status).toBe("AUTHORIZED");
      let held = false, n = 0;
      for (const e of log) { if (e === "LOCK") held = true; else if (e === "END") held = false; else if (e === "CLOCK" && held) n++; }
      counts[mode] = n;
      await drop(iso);
    }
    console.info(`[D1] clock reads under the advisory lock for one new authorised action: sequential=${counts.sequential} single=${counts.single}`);
    expect(counts.sequential).toBeGreaterThan(0); // the ingestion clock is already read inside append()
    expect(counts.single).toBeGreaterThanOrEqual(counts.sequential);
    expect(counts.single).toBeLessThanOrEqual(counts.sequential + 3);
  });

  // ------------------------------------------------------------------------------------------------ the same isolation checks as PR #47, on the single-snapshot path
  /** A pool whose sessions default to REPEATABLE READ: a bare BEGIN would take its snapshot at the lock statement, before the wait ends. */
  async function repeatableReadFixture(label: string) {
    const f = await fresh(label, 50);
    const rr = new Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${f.iso.schema} -c default_transaction_isolation=repeatable\\ read` });
    rr.on("error", () => undefined);
    return { ...f, rr };
  }
  const insertHeld = (holder: any, n: { v: number }) => async (type: string, who: string, payload: object) => {
    const max = Number((await holder.query("SELECT max(sequence)::int m FROM authority_events")).rows[0].m);
    n.v += 1;
    await holder.query(`INSERT INTO authority_events (sequence, event_id, event_type, principal_id, schema_version, occurred_at, authority_time, recorded_at, assurance_level, payload) VALUES ($1,$2,$3,$4,1,'2026-06-01T09:00:00Z','2026-06-01T09:00:00Z',now(),'ASSERTED_UNVERIFIED',$5)`, [max + 1, `evt-held-${type}-${n.v}`, type, who, JSON.stringify(payload)]);
  };

  it("on a pool defaulting to REPEATABLE READ the single-snapshot transaction is READ COMMITTED, and an approval committed while the call waits for the lock is seen (REQUIRES_APPROVAL -> AUTHORIZED)", { timeout: 60_000 }, async () => {
    const { iso, pool, rr } = await repeatableReadFixture("d1rrappr");
    setMode("single");
    const levels: string[] = []; let begins = 0;
    const spied = new Proxy(rr, { get(t, p, r) { if (p === "connect") return async () => { const c: any = await t.connect(); return new Proxy(c, { get(ct, cp, cr) { if (cp !== "query") { const v = Reflect.get(ct, cp, cr); return typeof v === "function" ? v.bind(ct) : v; } return async (...a: any[]) => { const text = String(typeof a[0] === "string" ? a[0] : a[0]?.text); const res = await ct.query(...a); if (/^BEGIN/.test(text)) { begins++; levels.push((await ct.query("SHOW transaction_isolation")).rows[0].transaction_isolation); expect(text).toBe("BEGIN ISOLATION LEVEL READ COMMITTED"); } return res; }; } }); }; const v = Reflect.get(t, p, r); return typeof v === "function" ? v.bind(t) : v; } }) as Pool;
    const a = createAuthority({ backend: postgresBackend(spied), clock, enforcementPointId: "ep" });
    expect(((await a.authorize(call("ap1", 7))) as any).status).toBe("REQUIRES_APPROVAL");
    const holder = await hold(pool);
    await holder.query("BEGIN ISOLATION LEVEL READ COMMITTED"); await holder.query("SELECT pg_advisory_xact_lock(hashtext('authority_events'))");
    let settled = false; const pending = a.authorize(call("ap1", 7)).then((r) => { settled = true; return r; });
    await sleep(350); expect(settled).toBe(false);
    const ins = insertHeld(holder, { v: 0 });
    await ins("APPROVAL_REQUESTED", "agent", { approval_id: "ap-ap1", action_id: "ap1", requested_from_principal_id: "alice", policy_reason_code: "R" });
    await ins("APPROVAL_GRANTED", "alice", { approval_id: "ap-ap1", action_id: "ap1", approving_principal_id: "alice" });
    await holder.query("COMMIT"); finished(holder);
    expect(((await pending) as any).status).toBe("AUTHORIZED"); // on a stale snapshot: REQUIRES_APPROVAL, with no error
    expect(begins).toBeGreaterThan(0);
    expect(new Set(levels)).toEqual(new Set(["read committed"]));
    await rr.end(); await drop(iso);
  });

  it("on a pool defaulting to REPEATABLE READ a revocation committed while the single-snapshot call waits is seen (DENIED, not a stale decision or an UNAVAILABLE)", { timeout: 60_000 }, async () => {
    const { iso, pool, rr } = await repeatableReadFixture("d1rrrev");
    setMode("single");
    const a = createAuthority({ backend: postgresBackend(rr), clock, enforcementPointId: "ep" });
    const holder = await hold(pool);
    await holder.query("BEGIN ISOLATION LEVEL READ COMMITTED"); await holder.query("SELECT pg_advisory_xact_lock(hashtext('authority_events'))");
    const pending = a.authorize(call("rv1", 3));
    await sleep(350);
    await insertHeld(holder, { v: 0 })("DELEGATION_REVOKED", "alice", { delegation_id: "d", revoked_by_principal_id: "alice", reason_code: "R" });
    await holder.query("COMMIT"); finished(holder);
    const r: any = await pending;
    expect({ status: r.status, reason: r.reason }).toEqual({ status: "DENIED", reason: "C12_DELEGATION_REVOKED" });
    await rr.end(); await drop(iso);
  });

  it("a connection lost inside the single-snapshot transaction is not an uncaught exception, rolls everything back, and a one-connection pool recovers", { timeout: 60_000 }, async () => {
    const { iso, pool } = await fresh("d1lost", 50);
    const one = new Pool({ connectionString: TEST_DATABASE_URL, max: 1, options: `-c search_path=${iso.schema}` });
    one.on("error", () => undefined);
    const uncaught: unknown[] = []; const onUncaught = (e: unknown) => { uncaught.push(e); };
    process.on("uncaughtException", onUncaught);
    setMode("single");
    let armed = true;
    const dying = new Proxy(one, { get(t, p, r) { if (p === "connect") return async () => { const c: any = await t.connect(); return new Proxy(c, { get(ct, cp, cr) { if (cp !== "query") { const v = Reflect.get(ct, cp, cr); return typeof v === "function" ? v.bind(ct) : v; } return async (...a: any[]) => { const text = String(typeof a[0] === "string" ? a[0] : a[0]?.text); const res = await ct.query(...a); if (armed && /INSERT INTO capability_issuance_idempotency/.test(text)) { armed = false; const pid = Number((await ct.query("SELECT pg_backend_pid() AS pid")).rows[0].pid); await pool.query("SELECT pg_terminate_backend($1)", [pid]); await sleep(50); } return res; }; } }); }; const v = Reflect.get(t, p, r); return typeof v === "function" ? v.bind(t) : v; } }) as Pool;
    const r: any = await createAuthority({ backend: postgresBackend(dying), clock, enforcementPointId: "ep" }).authorize(call("lost1", 3));
    expect(r.status).toBe("UNAVAILABLE");
    expect((await pool.query("SELECT count(*)::int c FROM authority_events")).rows[0].c).toBe(1); // only the delegation: request and ticket rolled back together
    expect(((await createAuthority({ backend: postgresBackend(one), clock, enforcementPointId: "ep" }).authorize(call("lost1", 3))) as any).status).toBe("AUTHORIZED");
    await sleep(300);
    process.off("uncaughtException", onUncaught);
    expect(uncaught).toHaveLength(0);
    await one.end(); await drop(iso);
  });
});
