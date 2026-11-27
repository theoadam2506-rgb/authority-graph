/**
 * Every transaction that decides on the journal under the advisory lock opens READ COMMITTED explicitly (postgresEventStore.ts: beginReadCommitted).
 *
 * These tests run the stores on a pool whose sessions default to REPEATABLE READ (`default_transaction_isolation`), the configuration under which a bare `BEGIN`
 * takes its snapshot at the lock statement, BEFORE the wait for the lock ends. They cover the three writers (append, issue, redemption), a revocation and an approval committed
 * while a call waits for the lock, concurrent callers, and interrupted transactions. Skipped (with a warning) without a reachable database; mandatory in the PostgreSQL CI job.
 */
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createAuthority, createEventBuilders, postgresBackend, type Authority, type ToolCall } from "../../src/sdk/index.js";
import { BEGIN_READ_COMMITTED } from "../../src/storage/postgresEventStore.js";
import { databaseAvailable, TEST_DATABASE_URL } from "../redemption/pgHarness.js";
import { isolatedSchema, type IsolatedSchema } from "./pgTestSchema.js";

const available = await databaseAvailable();
if (!available) console.warn("[postgresIsolation.test.ts] TEST_DATABASE_URL is not reachable: skipping the PostgreSQL isolation tests.");
const d = available ? describe : describe.skip;
const open: IsolatedSchema[] = [];
const extra: Pool[] = [];
afterAll(async () => { for (const p of extra) await p.end().catch(() => undefined); for (const i of open) await i.drop().catch(() => undefined); });

const clock = { now: () => "2026-06-01T09:00:00.000Z" };
const CAP = { resource: "r", action: "x" };
const call = (id: string, v = 3): ToolCall => ({ actionId: id, agentId: "agent", delegationId: "d", capability: CAP, amount: { value: v, currency: "EUR" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Fixture { readonly iso: IsolatedSchema; readonly owner: Pool; readonly rr: Pool; readonly a: Authority; readonly ev: ReturnType<typeof createEventBuilders> }
/** `rr`: every session of this pool defaults to REPEATABLE READ. `owner`: a plain pool on the same schema (to hold the lock and to read). */
async function fixture(label: string, budget = 50): Promise<Fixture> {
  const iso = isolatedSchema(TEST_DATABASE_URL, label);
  open.push(iso);
  await iso.create();
  iso.pool.on("error", () => undefined);
  const rr = new Pool({ connectionString: TEST_DATABASE_URL, max: 4, options: `-c search_path=${iso.schema} -c default_transaction_isolation=repeatable\\ read -c application_name=${iso.schema}` });
  rr.on("error", () => undefined);
  extra.push(rr);
  const ev = createEventBuilders({ clock });
  const a = createAuthority({ backend: postgresBackend(rr), clock, enforcementPointId: "ep" });
  const seeded: any = await a.record([ev.delegation({ delegationId: "d", grantor: "alice", grantee: "agent", capabilities: [CAP], canDelegate: false, expiresAt: null, totalBudget: { value: budget, currency: "EUR" }, thresholds: { automaticMax: { value: 5, currency: "EUR" }, approvalMax: { value: 9, currency: "EUR" } } })]);
  expect(seeded.status).toBe("RECORDED");
  return { iso, owner: iso.pool, rr, a, ev };
}
const types = async (f: Fixture) => (await f.owner.query("SELECT event_type FROM authority_events ORDER BY sequence")).rows.map((r) => r.event_type as string);
const sequences = async (f: Fixture) => (await f.owner.query("SELECT sequence::int s FROM authority_events ORDER BY sequence")).rows.map((r) => r.s as number);

/** Holds the advisory lock in a foreign, protocol-following transaction, runs `during` while it is held, commits, and returns the outcome of `call` started meanwhile. */
async function whileLockHeld<T>(f: Fixture, start: () => Promise<T>, during: (insert: (type: string, who: string, payload: object) => Promise<void>) => Promise<void>): Promise<{ result: T; waited: boolean }> {
  const holder = await f.owner.connect();
  let released = false;
  try {
    await holder.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await holder.query("SELECT pg_advisory_xact_lock(hashtext('authority_events'))");
    let settled = false;
    const pending = start().then((r) => { settled = true; return r; });
    await sleep(350);
    const waited = !settled;
    let n = 0;
    await during(async (type, who, payload) => {
      const max = Number((await holder.query("SELECT max(sequence)::int m FROM authority_events")).rows[0].m);
      n += 1;
      await holder.query(`INSERT INTO authority_events (sequence, event_id, event_type, principal_id, schema_version, occurred_at, authority_time, recorded_at, assurance_level, payload) VALUES ($1,$2,$3,$4,1,'2026-06-01T09:00:00Z','2026-06-01T09:00:00Z',now(),'ASSERTED_UNVERIFIED',$5)`, [max + 1, `evt-held-${type}-${n}`, type, who, JSON.stringify(payload)]);
    });
    await holder.query("COMMIT");
    released = true;
    return { result: await pending, waited };
  } finally {
    if (!released) await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
  }
}

/** Terminates the backend of THIS client only (the test files run in parallel on one database: never touch another file's sessions). */
async function killBackendOf(f: Fixture, client: any): Promise<void> {
  const pid = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
  await f.owner.query("SELECT pg_terminate_backend($1)", [pid]);
  await sleep(50);
}

/** A pool wrapper that reports every statement and can act after one. */
function spyPool(pool: Pool, after: (text: string, client: any) => Promise<void>, log: string[]): Pool {
  const wrap = (client: any) => new Proxy(client, {
    get(t, p, r) {
      if (p !== "query") { const v = Reflect.get(t, p, r); return typeof v === "function" ? v.bind(t) : v; }
      return async (...args: any[]) => { const text = String(typeof args[0] === "string" ? args[0] : args[0]?.text).replace(/\s+/g, " ").trim(); log.push(text); const res = await t.query(...args); await after(text, t); return res; };
    },
  });
  return new Proxy(pool, { get(t, p, r) { if (p === "connect") return async () => wrap(await t.connect()); if (p === "query") return (...a: any[]) => (wrap(t) as any).query(...a); const v = Reflect.get(t, p, r); return typeof v === "function" ? v.bind(t) : v; } }) as Pool;
}

d("explicit READ COMMITTED on a pool that defaults to REPEATABLE READ", () => {
  it("the harness really forces REPEATABLE READ for a bare BEGIN, and an explicit level overrides it", async () => {
    const f = await fixture("isoharness");
    const c = await f.rr.connect();
    try {
      await c.query("BEGIN"); const bare = (await c.query("SHOW transaction_isolation")).rows[0].transaction_isolation; await c.query("ROLLBACK");
      await c.query(BEGIN_READ_COMMITTED); const explicit = (await c.query("SHOW transaction_isolation")).rows[0].transaction_isolation; await c.query("ROLLBACK");
      expect({ bare, explicit }).toEqual({ bare: "repeatable read", explicit: "read committed" });
    } finally { c.release(); }
  });

  it("every transaction the stores open (append, issue, redemption) is READ COMMITTED, whatever the session default", async () => {
    const f = await fixture("isostmts");
    const log: string[] = [];
    const levels: string[] = [];
    const spy = spyPool(f.rr, async (text, client) => { if (/^BEGIN/.test(text)) levels.push((await client.query("SHOW transaction_isolation")).rows[0].transaction_isolation); }, log);
    const a = createAuthority({ backend: postgresBackend(spy), clock, enforcementPointId: "ep" });
    expect((await a.record([f.ev.revocation({ delegationId: "nope", revokedBy: "alice", reasonCode: "R" })]) as any).status).toBe("RECORDED"); // append
    const auth: any = await a.authorize(call("i1")); // append (request) + issue
    expect(auth.status).toBe("AUTHORIZED");
    expect((await a.redeem(auth.ticket, call("i1")) as any).status).toBe("REDEEMED"); // redemption
    const begins = log.filter((t) => /^BEGIN/.test(t));
    expect(begins.length).toBeGreaterThanOrEqual(4);
    expect(new Set(begins)).toEqual(new Set([BEGIN_READ_COMMITTED]));
    expect(new Set(levels)).toEqual(new Set(["read committed"]));
  });

  it("append: a writer that waits for the lock does not decide on a snapshot older than the lock (an approval request committed meanwhile is part of its state)", async () => {
    const f = await fixture("isoappend");
    expect((await f.a.authorize(call("s1", 7)) as any).status).toBe("REQUIRES_APPROVAL");
    const { result, waited } = await whileLockHeld(f, () => f.a.record([f.ev.approvalGranted({ approvalId: "ap1", actionId: "s1", approver: "alice" })]) as Promise<any>, async (insert) => {
      await insert("APPROVAL_REQUESTED", "agent", { approval_id: "ap1", action_id: "s1", requested_from_principal_id: "alice", policy_reason_code: "R" });
    });
    expect(waited).toBe(true);
    expect(result.status).toBe("RECORDED");
    expect(result.outcomes[0].accepted, JSON.stringify(result)).toBe(true); // the grant is causally after the request the other writer committed
    const sequencesNow = await sequences(f);
    expect(sequencesNow).toEqual(sequencesNow.map((_, i) => i + 1)); // contiguous
    expect((await f.a.authorize(call("s1", 7)) as any).status).toBe("AUTHORIZED"); // end to end: the approval is honoured
  });

  it("append: a writer waiting behind another writer gets the next sequence, not a collision", async () => {
    const f = await fixture("isoappend2");
    const { result } = await whileLockHeld(f, () => f.a.record([f.ev.revocation({ delegationId: "ghost", revokedBy: "alice", reasonCode: "R" })]) as Promise<any>, async (insert) => {
      await insert("DELEGATION_REVOKED", "alice", { delegation_id: "other", revoked_by_principal_id: "alice", reason_code: "R" });
    });
    expect(result.status).toBe("RECORDED");
    expect(await sequences(f)).toEqual([1, 2, 3]);
  });

  it("issue: a revocation committed while the call waits for the lock is seen (DENIED), not turned into a stale decision or an UNAVAILABLE", async () => {
    const f = await fixture("isoissue");
    // leave the request of w2 in the journal without a ticket: an issuance interrupted by a lost connection (the sequential protocol keeps the request)
    let armed = true;
    const dying = spyPool(f.rr, async (text, client) => { if (armed && /INSERT INTO capability_issuance_idempotency/.test(text)) { armed = false; await killBackendOf(f, client); } }, []);
    expect((await createAuthority({ backend: postgresBackend(dying), clock, enforcementPointId: "ep" }).authorize(call("w2", 3)) as any).status).toBe("UNAVAILABLE");
    expect((await types(f)).filter((t) => t === "ACTION_REQUESTED")).toHaveLength(1); // w2's; the call below finds its request: it goes straight to the lock-free pre-check and then to the issuance transaction
    const { result, waited } = await whileLockHeld(f, () => f.a.authorize(call("w2", 3)) as Promise<any>, async (insert) => {
      await insert("DELEGATION_REVOKED", "alice", { delegation_id: "d", revoked_by_principal_id: "alice", reason_code: "R" });
    });
    expect(waited).toBe(true);
    expect(result.status).toBe("DENIED");
    expect(result.reason).toBe("C12_DELEGATION_REVOKED");
    expect((await types(f)).filter((t) => t === "CAPABILITY_ISSUED")).toHaveLength(0); // nothing issued
  });

  it("issue + append: a new action whose caller waits for the lock while a revocation is committed is DENIED (C12)", async () => {
    const f = await fixture("isoissue2");
    const { result } = await whileLockHeld(f, () => f.a.authorize(call("n1", 3)) as Promise<any>, async (insert) => {
      await insert("DELEGATION_REVOKED", "alice", { delegation_id: "d", revoked_by_principal_id: "alice", reason_code: "R" });
    });
    expect(result.status).toBe("DENIED");
    expect(result.reason).toBe("C12_DELEGATION_REVOKED");
  });

  it("redemption: concurrent redemptions of one ticket give exactly one REDEEMED and clean refusals for the others", async () => {
    const f = await fixture("isoredeem");
    const auth: any = await f.a.authorize(call("r1", 3)); expect(auth.status).toBe("AUTHORIZED");
    const rs: any[] = await Promise.all([1, 2, 3, 4].map(() => f.a.redeem(auth.ticket, call("r1", 3))));
    expect(rs.filter((r) => r.status === "REDEEMED")).toHaveLength(1);
    expect(rs.filter((r) => r.status !== "REDEEMED").every((r) => r.status === "REFUSED" && r.reason === "ALREADY_REDEEMED"), JSON.stringify(rs.map((r) => [r.status, r.reason]))).toBe(true);
    expect((await types(f)).filter((t) => t === "CAPABILITY_REDEEMED")).toHaveLength(1);
  });

  it("redemption: a revocation committed while the redemption waits for the lock is seen", async () => {
    const f = await fixture("isoredeem2");
    const auth: any = await f.a.authorize(call("r2", 3)); expect(auth.status).toBe("AUTHORIZED");
    const { result } = await whileLockHeld(f, () => f.a.redeem(auth.ticket, call("r2", 3)) as Promise<any>, async (insert) => {
      await insert("DELEGATION_REVOKED", "alice", { delegation_id: "d", revoked_by_principal_id: "alice", reason_code: "R" });
    });
    expect(result.status, JSON.stringify(result)).toBe("REFUSED");
    expect(result.reason).toBe("AUTHORITY_NO_LONGER_VALID"); // the revocation committed during the wait is in the snapshot (on a stale one: CONCURRENT_WRITE_DETECTED)
    expect((await types(f)).filter((t) => t === "CAPABILITY_REDEEMED")).toHaveLength(0);
  });

  it("concurrent callers (authorize, record, redeem mixed): every call gets a definite answer, none is UNAVAILABLE, the journal stays contiguous", { timeout: 120_000 }, async () => {
    for (let round = 0; round < 3; round++) {
      const f = await fixture(`isocon${round}`, 200);
      const first: any = await f.a.authorize(call("t0", 3));
      const jobs: Promise<any>[] = [
        ...Array.from({ length: 10 }, (_, i) => f.a.authorize(call(`c${i}`, 3))),
        ...Array.from({ length: 4 }, (_, i) => f.a.record([f.ev.revocation({ delegationId: `x${i}`, revokedBy: "alice", reasonCode: "R" })])),
        ...Array.from({ length: 3 }, () => f.a.redeem(first.ticket, call("t0", 3))),
      ];
      const rs = await Promise.all(jobs);
      expect(rs.filter((r) => r.status === "UNAVAILABLE"), JSON.stringify(rs.map((r) => r.status))).toHaveLength(0);
      expect(rs.slice(0, 10).every((r) => r.status === "AUTHORIZED")).toBe(true);
      expect(rs.slice(10, 14).every((r) => r.status === "RECORDED")).toBe(true);
      expect(rs.slice(14).filter((r) => r.status === "REDEEMED")).toHaveLength(1);
      const s = await sequences(f);
      expect(s).toEqual(s.map((_, i) => i + 1));
      const issued = (await types(f)).filter((t) => t === "CAPABILITY_ISSUED").length;
      expect(issued).toBe(11);
    }
  });

  it("interrupted transactions: a backend terminated just before COMMIT (append, issue, redemption) is UNAVAILABLE/UNKNOWN, writes nothing partial under its transaction, releases the lock, and the next call works", { timeout: 120_000 }, async () => {
    const f = await fixture("isointr");
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => { uncaught.push(e); };
    process.on("uncaughtException", onUncaught);
    const kill = (client: any) => killBackendOf(f, client);
    const causes: string[] = [];
    const attempt = async (match: RegExp, run: (a: Authority) => Promise<any>) => {
      let armed = true;
      const spy = spyPool(f.rr, async (text, client) => { if (armed && match.test(text)) { armed = false; await kill(client); } }, []);
      return run(createAuthority({ backend: postgresBackend(spy), clock, enforcementPointId: "ep", onDiagnostic: (d) => { causes.push(String((d.cause as any)?.message ?? d.cause)); } }));
    };
    const before = (await types(f)).length;
    const rec = await attempt(/INSERT INTO authority_events/, (a) => a.record([f.ev.revocation({ delegationId: "zz", revokedBy: "alice", reasonCode: "R" })]));
    expect(rec.status).toBe("UNAVAILABLE");
    expect(causes.length).toBeGreaterThan(0); // the cause reaches the operator hook (its text is the driver's: "Client has encountered a connection error")
    expect((await types(f)).length).toBe(before); // append is one transaction: rolled back
    const iss = await attempt(/INSERT INTO capability_issuance_idempotency/, (a) => a.authorize(call("k1", 3)));
    expect(iss.status).toBe("UNAVAILABLE");
    expect((await types(f)).filter((t) => t === "CAPABILITY_ISSUED")).toHaveLength(0); // the ticket and its idempotency row are one transaction
    // the lock is free and the pool is healthy: a normal call completes promptly
    const t0 = Date.now();
    const ok: any = await f.a.authorize(call("k1", 3));
    expect(ok.status).toBe("AUTHORIZED");
    expect(Date.now() - t0).toBeLessThan(5_000);
    const red = await attempt(/INSERT INTO authority_events/, async (a) => a.redeem(ok.ticket, call("k1", 3)));
    expect(["UNKNOWN_OUTCOME", "UNAVAILABLE"]).toContain(red.status);
    expect((await types(f)).filter((t) => t === "CAPABILITY_REDEEMED")).toHaveLength(0);
    const again: any = await f.a.redeem(ok.ticket, call("k1", 3));
    expect(again.status).toBe("REDEEMED"); // the interrupted attempt consumed nothing
    await sleep(300);
    process.off("uncaughtException", onUncaught);
    expect(uncaught, "a connection lost inside a transaction must not surface as an uncaught exception (it would take the host process down)").toHaveLength(0);
  });

  it("a connection lost inside a transaction is destroyed, not handed out again: a ONE-connection pool recovers on its next call (append, issue)", { timeout: 60_000 }, async () => {
    const f = await fixture("isoone");
    const one = new Pool({ connectionString: TEST_DATABASE_URL, max: 1, options: `-c search_path=${f.iso.schema} -c default_transaction_isolation=repeatable\\ read` });
    one.on("error", () => undefined);
    extra.push(one);
    for (const [name, match, run] of [
      ["append", /INSERT INTO authority_events/, (a: Authority) => a.record([f.ev.revocation({ delegationId: "q", revokedBy: "alice", reasonCode: "R" })])],
      ["issue", /INSERT INTO capability_issuance_idempotency/, (a: Authority) => a.authorize(call("one1", 3))],
    ] as const) {
      let armed = true;
      const spy = spyPool(one, async (text, client) => { if (armed && match.test(text)) { armed = false; await killBackendOf(f, client); } }, []);
      const dying: any = await run(createAuthority({ backend: postgresBackend(spy), clock, enforcementPointId: "ep" }));
      expect(dying.status, name).toBe("UNAVAILABLE");
      const next: any = await createAuthority({ backend: postgresBackend(one), clock, enforcementPointId: "ep" }).authorize(call(`one-next-${name}`, 3));
      expect(next.status, `${name}: the single connection must have been replaced`).toBe("AUTHORIZED");
    }
  });

  // ------------------------------------------------------------------------------------------------ a connection lost BEFORE, DURING and AFTER the write
  type Phase = "before BEGIN" | "after BEGIN" | "after the lock" | "after the read" | "after the write" | "COMMIT sent, acknowledgement lost";
  const PHASES: Phase[] = ["before BEGIN", "after BEGIN", "after the lock", "after the read", "after the write", "COMMIT sent, acknowledgement lost"];

  /** A pool whose first transaction loses its connection at `phase`. `commitLastWrite` tells which INSERT is the last write of the operation. */
  function dyingPool(pool: Pool, f: Fixture, phase: Phase, lastWrite: RegExp, fired: { at?: string }): Pool {
    let inTx = false, locked = false, read = false;
    const wrap = (c: any) => new Proxy(c, {
      get(t, p, r) {
        if (p !== "query") { const v = Reflect.get(t, p, r); return typeof v === "function" ? v.bind(t) : v; }
        return async (...a: any[]) => {
          const text = String(typeof a[0] === "string" ? a[0] : a[0]?.text).replace(/\s+/g, " ").trim();
          const kill = async () => { const pid = Number((await t.query("SELECT pg_backend_pid() AS pid")).rows[0].pid); await f.owner.query("SELECT pg_terminate_backend($1)", [pid]); await sleep(50); fired.at = text.slice(0, 40); };
          if (fired.at === undefined && phase === "before BEGIN" && /^BEGIN/.test(text)) await kill();
          if (fired.at === undefined && phase === "COMMIT sent, acknowledgement lost" && text === "COMMIT") {
            // the COMMIT is on the wire, the socket dies before the answer: the server may or may not have committed
            const pending = t.query(...a); fired.at = "COMMIT"; (t as any).connection.stream.destroy(); return pending;
          }
          const res = await t.query(...a);
          if (/^BEGIN/.test(text)) inTx = true;
          if (/advisory_xact_lock/.test(text)) locked = true;
          if (inTx && locked && /SELECT \* FROM authority_events/.test(text)) read = true;
          if (fired.at === undefined) {
            if (phase === "after BEGIN" && /^BEGIN/.test(text)) await kill();
            else if (phase === "after the lock" && /advisory_xact_lock/.test(text)) await kill();
            else if (phase === "after the read" && read && /SELECT \* FROM authority_events/.test(text)) await kill();
            else if (phase === "after the write" && lastWrite.test(text)) await kill();
          }
          return res;
        };
      },
    });
    return new Proxy(pool, { get(t, p, r) { if (p === "connect") return async () => wrap(await t.connect()); const v = Reflect.get(t, p, r); return typeof v === "function" ? v.bind(t) : v; } }) as Pool;
  }

  /** What an interruption must never leave behind: an open transaction, a held advisory lock, an unusable pooled connection, an uncaught exception. */
  async function expectCleanAfter(f: Fixture, pool: Pool, uncaught: unknown[], label: string) {
    await sleep(150);
    const app = f.iso.schema;
    const open = Number((await f.owner.query("SELECT count(*)::int c FROM pg_stat_activity WHERE application_name = $1 AND state LIKE 'idle in transaction%'", [app])).rows[0].c);
    const locks = Number((await f.owner.query("SELECT count(*)::int c FROM pg_locks l JOIN pg_stat_activity s USING (pid) WHERE s.application_name = $1 AND l.locktype = 'advisory' AND l.granted", [app])).rows[0].c);
    expect({ openTransactions: open, advisoryLocksHeld: locks }, label).toEqual({ openTransactions: 0, advisoryLocksHeld: 0 });
    const clients = Math.max(1, pool.totalCount);
    await Promise.all(Array.from({ length: clients + 2 }, () => pool.query("SELECT 1"))); // every pooled connection, and new ones, work
    const t0 = Date.now();
    await f.a.record([f.ev.revocation({ delegationId: `probe-${label.replace(/\W+/g, "-")}`, revokedBy: "alice", reasonCode: "R" })]); // the lock is free
    expect(Date.now() - t0, `${label}: the lock must be free`).toBeLessThan(3_000);
    expect(uncaught, `${label}: no uncaught exception`).toHaveLength(0);
  }
  const countOf = async (f: Fixture, type: string, extra = "") => Number((await f.owner.query(`SELECT count(*)::int c FROM authority_events WHERE event_type = $1 ${extra}`, [type])).rows[0].c);

  for (const op of ["append (record)", "issue (authorize on an existing request)", "redemption"] as const) {
    it(`${op}: a connection lost before BEGIN, after BEGIN, the lock, the read, the write, or with the COMMIT acknowledgement lost — nothing leaks, nothing is claimed that is not known, and a retry converges`, { timeout: 180_000 }, async () => {
      const uncaught: unknown[] = [];
      const onUncaught = (e: unknown) => { uncaught.push(e); };
      process.on("uncaughtException", onUncaught);
      const outcomes: string[] = [];
      try {
        for (const phase of PHASES) {
          const f = await fixture(`isolost${op.slice(0, 3)}${PHASES.indexOf(phase)}`);
          const label = `${op} / ${phase}`;
          let operation: (a: Authority) => Promise<any>, retry: () => Promise<any>, effect: () => Promise<number>, lastWrite: RegExp, expectNothing: () => Promise<void>;
          const fired: { at?: string } = {};
          if (op === "append (record)") {
            const draft = f.ev.revocation({ delegationId: "lost", revokedBy: "alice", reasonCode: "R", eventId: "evt-lost-1" } as any);
            lastWrite = /INSERT INTO authority_events/;
            operation = (a) => a.record([draft]);
            retry = () => f.a.record([draft]);
            effect = () => countOf(f, "DELEGATION_REVOKED", "AND event_id = 'evt-lost-1'");
            expectNothing = async () => undefined;
          } else if (op === "issue (authorize on an existing request)") {
            // a request that needs an approval, then the approval: the next authorize() goes straight to the issuance transaction
            expect(((await f.a.authorize(call("L1", 7))) as any).status).toBe("REQUIRES_APPROVAL");
            expect((await f.a.record([f.ev.approvalRequest({ approvalId: "ap-L1", actionId: "L1", requestedBy: "agent", requestedFrom: "alice", reasonCode: "R" }), f.ev.approvalGranted({ approvalId: "ap-L1", actionId: "L1", approver: "alice" })]) as any).status).toBe("RECORDED");
            lastWrite = /INSERT INTO capability_issuance_idempotency/;
            operation = (a) => a.authorize(call("L1", 7));
            retry = () => f.a.authorize(call("L1", 7));
            effect = () => countOf(f, "CAPABILITY_ISSUED");
            expectNothing = async () => undefined;
          } else {
            const auth: any = await f.a.authorize(call("L2", 3));
            expect(auth.status).toBe("AUTHORIZED");
            lastWrite = /INSERT INTO authority_events/;
            operation = (a) => a.redeem(auth.ticket, call("L2", 3));
            retry = () => f.a.redeem(auth.ticket, call("L2", 3));
            effect = () => countOf(f, "CAPABILITY_REDEEMED");
            expectNothing = async () => undefined;
          }
          void expectNothing;
          const before = await effect();
          const dying = createAuthority({ backend: postgresBackend(dyingPool(f.rr, f, phase, lastWrite, fired)), clock, enforcementPointId: "ep" });
          const result: any = await operation(dying);
          expect(fired.at, `${label}: the fault must have been injected`).toBeDefined();
          // what the caller is told: never a success, never a business refusal
          expect(["UNAVAILABLE", "UNKNOWN_OUTCOME"], `${label}: ${JSON.stringify(result)}`).toContain(result.status);
          const after = await effect();
          if (phase === "COMMIT sent, acknowledgement lost") {
            // the honest statement: it MAY have been committed. Both are legal; the answer must not claim either.
            expect([before, before + 1], label).toContain(after);
            outcomes.push(`${label}: reported ${result.status}; the write ${after > before ? "WAS" : "was NOT"} committed`);
          } else {
            expect(after, `${label}: the interrupted transaction must not have written`).toBe(before);
            outcomes.push(`${label}: reported ${result.status}; nothing written`);
          }
          await expectCleanAfter(f, f.rr, uncaught, label);
          // a retry converges to exactly one effect, whatever happened to the first attempt
          const again: any = await retry();
          expect(["AUTHORIZED", "RECORDED", "REDEEMED", "REFUSED"], `${label} retry: ${JSON.stringify(again)}`).toContain(again.status);
          if (again.status === "REFUSED") expect(again.reason).toBe("ALREADY_REDEEMED");
          expect(await effect(), `${label}: exactly one effect after the retry`).toBe(before + 1);
          await sleep(100);
          await f.rr.end().catch(() => undefined); extra.splice(extra.indexOf(f.rr), 1); // 18 fixtures in a row must not exhaust the server's connections
          await f.iso.drop().catch(() => undefined); open.splice(open.indexOf(f.iso), 1);
        }
      } finally {
        process.off("uncaughtException", onUncaught);
      }
      console.info(`[isolation] ${op}\n  ` + outcomes.join("\n  "));
    });
  }
});
