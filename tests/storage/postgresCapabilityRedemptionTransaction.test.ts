/**
 * V1 PR 2 — real-PostgreSQL tests of the redemption transaction (SPEC I26 to
 * I31). Each planned property of the former checklist is an executable test
 * here or in tests/redemption/redemptionContract.postgres.test.ts (the shared
 * contract: independent redeemers, colliding attempt ids, restart, raw
 * duplicate writes). One schema per file (tests/storage/pgTestSchema.ts).
 * Skipped when no database is reachable; mandatory in CI (report guard).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient, QueryResult } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toDraft, type CanonicalStore, type DraftAuthorityEvent } from "../../src/domain/events.js";
import { authorityAt } from "../../src/engine/authority.js";
import { validateRedemptionEvent } from "../../src/engine/redeemCapability.js";
import { actionId, capabilityId, clientIdempotencyKey, iso8601, sequenceNumber } from "../../src/domain/types.js";
import { REDEEMED_INDEX, PostgresCapabilityRedemptionTransaction } from "../../src/storage/postgresCapabilityRedemptionTransaction.js";
import { buildCapabilityRedeemedDraft } from "../../src/storage/capabilityRedemptionTransaction.js";
import { EUR, PURCHASE_ORDER_CREATE, THEO, actionRequest } from "../fixtures/scenarios.js";
import { monetaryParameters } from "../../src/domain/types.js";
import { AGENT, EP, PARAMS, T, auth } from "../redemption/harness.js";
import { databaseAvailable, pgHarness, type PgHarness } from "../redemption/pgHarness.js";

const available = await databaseAvailable();
if (!available) {
  // eslint-disable-next-line no-console
  console.warn("[postgresCapabilityRedemptionTransaction.test.ts] TEST_DATABASE_URL is not reachable: skipping the PostgreSQL redemption tests.");
}

type Interceptor = {
  /** Runs before a statement is sent. */
  before?: (sql: string, client: PoolClient) => Promise<void>;
  /** May replace a statement's result. */
  override?: (sql: string) => QueryResult | undefined;
};

/** A Pool whose connections run `before`/`override` around each statement: the only way to act BETWEEN two statements of one transaction. */
function intercepted(real: Pool, hooks: Interceptor): Pool {
  return {
    async connect() {
      const client = await real.connect();
      return new Proxy(client, {
        get(target, prop) {
          if (prop === "query") {
            return async (...args: unknown[]) => {
              const first = args[0];
              const sql = typeof first === "string" ? first : (first as { text?: string }).text ?? "";
              await hooks.before?.(sql, target);
              const replaced = hooks.override?.(sql);
              if (replaced !== undefined) return replaced;
              return (target.query as (...a: unknown[]) => unknown)(...args);
            };
          }
          const value = (target as unknown as Record<string | symbol, unknown>)[prop];
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
    },
  } as unknown as Pool;
}

async function rawInsert(pool: Pool, row: { sequence: number; event_id: string; event_type: string; principal_id: string; payload: unknown }): Promise<void> {
  await pool.query(
    `INSERT INTO authority_events (sequence, event_id, event_type, principal_id, schema_version, occurred_at, authority_time, recorded_at, assurance_level, payload)
     VALUES ($1, $2, $3, $4, 1, '2025-01-01T09:11:00Z', '2025-01-01T09:11:00Z', now(), 'ASSERTED_UNVERIFIED', $5)`,
    [row.sequence, row.event_id, row.event_type, row.principal_id, JSON.stringify(row.payload)],
  );
}

const redeemedRows = async (h: PgHarness) => (await h.pool.query("SELECT event_id, sequence FROM authority_events WHERE event_type = 'CAPABILITY_REDEEMED' ORDER BY sequence")).rows;
const maxSequence = async (h: PgHarness) => Number((await h.pool.query("SELECT max(sequence) AS m FROM authority_events")).rows[0].m);

describe.skipIf(!available)("PostgresCapabilityRedemptionTransaction (real PostgreSQL)", () => {
  let h: PgHarness;
  beforeAll(async () => {
    h = await pgHarness({ label: "redeem_pg" });
  });
  afterAll(async () => {
    await h.close();
  });

  /** A fresh ticket on a fresh action, so tests do not share state. */
  let n = 0;
  async function freshHarness(options: Parameters<typeof pgHarness>[0] = {}): Promise<PgHarness> {
    return pgHarness({ label: `r${++n}`, ...options });
  }

  it("happy path: one row at decision_sequence + 1, at the explicit instant, and the event validates (I31)", async () => {
    const t = await freshHarness();
    try {
      const id = await t.issue(T("09:10:00"));
      const r = await t.redemption.redeem(auth(AGENT), t.command(id), T("09:12:00"));
      expect(r.ok).toBe(true);
      const events = await t.store.getEvents();
      const e = events.filter((x) => x.event_type === "CAPABILITY_REDEEMED");
      expect(e).toHaveLength(1);
      const ev = e[0]!;
      if (ev.event_type !== "CAPABILITY_REDEEMED") throw new Error("fixture");
      expect(Number(ev.sequence)).toBe(Number(ev.payload.decision_sequence) + 1);
      expect(ev.authority_time).toBe(T("09:12:00"));
      expect(validateRedemptionEvent(events, ev)).toEqual({ ok: true });
    } finally {
      await t.close();
    }
  });

  it("50 concurrent redemptions from 5 independent pools: exactly one ok:true and one CAPABILITY_REDEEMED row", async () => {
    const t = await freshHarness();
    try {
      const id = await t.issue(T("09:10:00"));
      const redeemers = Array.from({ length: 5 }, () => t.newRedemption());
      const results = await Promise.all(Array.from({ length: 50 }, (_v, i) => redeemers[i % 5]!.redeem(auth(AGENT), t.command(id), T("09:12:00"))));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok && r.reason === "ALREADY_REDEEMED")).toHaveLength(49);
      expect(await redeemedRows(t)).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it("a raw INSERT of a second CAPABILITY_REDEEMED row for the same capability (other event_id, other sequence) is a unique violation on the redemption index", async () => {
    const t = await freshHarness();
    try {
      const id = await t.issue(T("09:10:00"));
      expect((await t.redemption.redeem(auth(AGENT), t.command(id), T("09:12:00"))).ok).toBe(true);
      const err = await rawInsert(t.pool, { sequence: 999, event_id: "raw-second", event_type: "CAPABILITY_REDEEMED", principal_id: "agent-a", payload: { capability_id: id } }).then(() => undefined, (e: unknown) => e);
      expect(err).toMatchObject({ code: "23505", constraint: REDEEMED_INDEX });
      expect(await redeemedRows(t)).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it("a competing redemption row committed by a lock-bypassing writer between our read and our INSERT: unique violation, rollback, REDEMPTION_COLLISION, no partial row", async () => {
    const t = await freshHarness();
    try {
      const id = await t.issue(T("09:10:00"));
      let injected = false;
      const tx = new PostgresCapabilityRedemptionTransaction(intercepted(t.pool, {
        before: async (sql) => {
          if (!injected && sql.startsWith("INSERT INTO authority_events")) {
            injected = true;
            await rawInsert(t.pool, { sequence: 500, event_id: "bypass-competitor", event_type: "CAPABILITY_REDEEMED", principal_id: "agent-a", payload: { capability_id: id } });
          }
        },
      }));
      const r = await tx.redeem(auth(AGENT), t.command(id), T("09:12:00"));
      expect(r).toEqual({ ok: false, reason: "REDEMPTION_COLLISION" });
      const rows = await redeemedRows(t);
      expect(rows).toEqual([{ event_id: "bypass-competitor", sequence: "500" }]); // only the competitor's row; ours left nothing
      // The transaction was rolled back: its sequence was not consumed.
      expect((await t.pool.query("SELECT count(*) AS c FROM authority_events WHERE event_id LIKE 'capability-redeemed:%'")).rows[0].c).toBe("0");
    } finally {
      await t.close();
    }
  });

  it("a REVOCATION committed by a lock-bypassing writer at our sequence: primary-key violation, rollback, CONCURRENT_WRITE_DETECTED with ticketConsumed false; the ticket is then refused only because authority is gone", async () => {
    const t = await freshHarness();
    try {
      const id = await t.issue(T("09:10:00"));
      let injected = false;
      const tx = new PostgresCapabilityRedemptionTransaction(intercepted(t.pool, {
        before: async (sql) => {
          if (!injected && sql.startsWith("INSERT INTO authority_events")) {
            injected = true;
            const next = (await maxSequence(t)) + 1;
            await rawInsert(t.pool, { sequence: next, event_id: "bypass-revocation", event_type: "DELEGATION_REVOKED", principal_id: THEO, payload: { delegation_id: "d-redeem", revoked_by_principal_id: THEO, reason_code: "BYPASS" } });
          }
        },
      }));
      const r = await tx.redeem(auth(AGENT), t.command(id), T("09:12:00"));
      expect(r).toEqual({ ok: false, reason: "CONCURRENT_WRITE_DETECTED", detail: { ticketConsumed: false } });
      expect(await redeemedRows(t)).toHaveLength(0); // nothing consumed
      const retry = await t.redemption.redeem(auth(AGENT), t.command(id), T("09:13:00"));
      expect(retry).toMatchObject({ ok: false, reason: "AUTHORITY_NO_LONGER_VALID", detail: { decision: { reasonCode: "C12_DELEGATION_REVOKED" } } });
    } finally {
      await t.close();
    }
  });

  describe("success requires the read-back: a row that is not provably ours, alone and right after the snapshot, is never a success", () => {
    const variants: [string, (expectedSequence: number) => { event_id: string; sequence: string }[]][] = [
      ["another event_id at the right sequence", (seq) => [{ event_id: "someone-elses", sequence: String(seq) }]],
      ["right event_id family but the wrong sequence", (seq) => [{ event_id: "ours-placeholder", sequence: String(seq + 3) }]],
      ["two redemption rows for the capability", (seq) => [{ event_id: "a", sequence: String(seq) }, { event_id: "b", sequence: String(seq + 1) }]],
      ["no row at all", () => []],
    ];
    it.each(variants)("%s: nothing is committed and the ticket is untouched", async (_label, rowsFor) => {
      const t = await freshHarness();
      try {
        const id = await t.issue(T("09:10:00"));
        const expectedSequence = (await maxSequence(t)) + 1;
        const tx = new PostgresCapabilityRedemptionTransaction(intercepted(t.pool, {
          override: (sql) => (sql.includes("event_type = 'CAPABILITY_REDEEMED' AND payload ->> 'capability_id'") ? ({ rows: rowsFor(expectedSequence), rowCount: rowsFor(expectedSequence).length } as unknown as QueryResult) : undefined),
        }));
        expect(await tx.redeem(auth(AGENT), t.command(id), T("09:12:00"))).toEqual({ ok: false, reason: "REDEMPTION_COLLISION" });
        expect(await redeemedRows(t)).toHaveLength(0); // rolled back
        expect((await t.redemption.redeem(auth(AGENT), t.command(id), T("09:12:30"))).ok).toBe(true); // ticket untouched
      } finally {
        await t.close();
      }
    });
  });

  it("an identical duplicate of an existing redemption row is a no-op through the store and the ticket stays consumed", async () => {
    const t = await freshHarness();
    try {
      const id = await t.issue(T("09:10:00"));
      expect((await t.redemption.redeem(auth(AGENT), t.command(id), T("09:12:00"))).ok).toBe(true);
      const events = await t.store.getEvents();
      const existing = events.find((e) => e.event_type === "CAPABILITY_REDEEMED")!;
      if (existing.event_type !== "CAPABILITY_REDEEMED") throw new Error("fixture");
      const before = await maxSequence(t);
      const dup: DraftAuthorityEvent = { ...toDraft(existing) } as DraftAuthorityEvent;
      const out = await t.append([dup], T("09:12:00"));
      expect(out.outcomes[0]?.accepted).toBe(true); // ingestion: idempotent duplicate...
      expect(await maxSequence(t)).toBe(before); // ...but nothing inserted
      expect(await redeemedRows(t)).toHaveLength(1);
      expect(await t.redemption.redeem(auth(AGENT), t.command(id), T("09:13:00"))).toEqual({ ok: false, reason: "ALREADY_REDEEMED" });
    } finally {
      await t.close();
    }
  });

  it("event_id reuse with different content is refused (EVENT_ID_CONFLICT) and logged in security_log", async () => {
    const t = await freshHarness();
    try {
      const id = await t.issue(T("09:10:00"));
      expect((await t.redemption.redeem(auth(AGENT), t.command(id), T("09:12:00"))).ok).toBe(true);
      const events = await t.store.getEvents();
      const existing = events.find((e) => e.event_type === "CAPABILITY_REDEEMED")!;
      if (existing.event_type !== "CAPABILITY_REDEEMED") throw new Error("fixture");
      const clash = { ...toDraft(existing), payload: { ...existing.payload, decision_sequence: sequenceNumber(7) } } as DraftAuthorityEvent;
      expect((await t.append([clash], T("09:13:00"))).outcomes[0]).toEqual({ accepted: false, reasonCode: "EVENT_ID_CONFLICT" });
      expect((await t.store.getSecurityLog()).some((e) => e.reasonCode === "EVENT_ID_CONFLICT")).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("a connection killed (pg_terminate_backend) just before COMMIT: the call rejects, no row exists, and the ticket then redeems exactly once", async () => {
    const t = await freshHarness();
    try {
      const id = await t.issue(T("09:10:00"));
      const tx = new PostgresCapabilityRedemptionTransaction(intercepted(t.pool, {
        before: async (sql, client) => {
          if (sql === "COMMIT") {
            const pid = (await t.pool.query("SELECT pid FROM pg_stat_activity WHERE state = 'idle in transaction' AND query LIKE 'SELECT event_id, sequence%'")).rows[0]?.pid;
            expect(pid).toBeDefined();
            await t.pool.query("SELECT pg_terminate_backend($1)", [pid]);
            void client;
          }
        },
      }));
      await expect(tx.redeem(auth(AGENT), t.command(id), T("09:12:00"))).rejects.toBeDefined(); // fail-closed: an exception, never a success
      expect(await redeemedRows(t)).toHaveLength(0);
      expect((await t.redemption.redeem(auth(AGENT), t.command(id), T("09:12:30"))).ok).toBe(true);
      expect(await redeemedRows(t)).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it("a connection killed before the INSERT leaves no row, never a half-written state", async () => {
    const t = await freshHarness();
    try {
      const id = await t.issue(T("09:10:00"));
      let killed = false;
      const tx = new PostgresCapabilityRedemptionTransaction(intercepted(t.pool, {
        before: async (sql) => {
          if (!killed && sql.startsWith("INSERT INTO authority_events")) {
            killed = true;
            const pid = (await t.pool.query("SELECT pid FROM pg_stat_activity WHERE state = 'idle in transaction' AND query LIKE 'SELECT * FROM authority_events%'")).rows[0]?.pid;
            await t.pool.query("SELECT pg_terminate_backend($1)", [pid]);
          }
        },
      }));
      await expect(tx.redeem(auth(AGENT), t.command(id), T("09:12:00"))).rejects.toBeDefined();
      expect(await redeemedRows(t)).toHaveLength(0);
      expect((await t.redemption.redeem(auth(AGENT), t.command(id), T("09:12:30"))).ok).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("a revocation queued behind the writer lock lands AFTER the redemption it waited for: the redemption is valid at its own snapshot, the revocation follows it in the log", async () => {
    const t = await freshHarness();
    try {
      const id = await t.issue(T("09:10:00"));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let held = false;
      const tx = new PostgresCapabilityRedemptionTransaction(intercepted(t.pool, {
        before: async (sql) => {
          if (!held && sql.startsWith("SELECT * FROM authority_events")) { // the lock is already held when the fresh read starts
            held = true;
            await gate;
          }
        },
      }));
      const redemption = tx.redeem(auth(AGENT), t.command(id), T("09:12:00"));
      await new Promise((r) => setTimeout(r, 150));
      let revokeSettled = false;
      const revocation = t.revoke(T("09:12:00")).then(() => { revokeSettled = true; });
      await new Promise((r) => setTimeout(r, 300));
      expect(revokeSettled).toBe(false); // blocked on the same advisory lock
      release();
      expect((await redemption).ok).toBe(true);
      await revocation;
      const events = await t.store.getEvents();
      const red = events.find((e) => e.event_type === "CAPABILITY_REDEEMED")!;
      const rev = events.find((e) => e.event_type === "DELEGATION_REVOKED")!;
      expect(Number(rev.sequence)).toBeGreaterThan(Number(red.sequence));
      if (red.event_type !== "CAPABILITY_REDEEMED") throw new Error("fixture");
      expect(validateRedemptionEvent(events, red)).toEqual({ ok: true });
    } finally {
      await t.close();
    }
  });

  it("a revocation committed BEFORE the redemption takes the lock denies it, with the engine's own decision", async () => {
    const t = await freshHarness();
    try {
      const id = await t.issue(T("09:10:00"));
      await t.revoke(T("09:12:00"));
      expect(await t.redemption.redeem(auth(AGENT), t.command(id), T("09:12:00"))).toMatchObject({ ok: false, reason: "AUTHORITY_NO_LONGER_VALID", detail: { decision: { reasonCode: "C12_DELEGATION_REVOKED" } } });
      expect(await redeemedRows(t)).toHaveLength(0);
    } finally {
      await t.close();
    }
  });

  it("every committed redemption has decision_sequence == sequence - 1 and validates (5 tickets, interleaved with unrelated writes)", async () => {
    const t = await freshHarness();
    try {
      const ids = [];
      for (let i = 0; i < 5; i += 1) ids.push(await t.issue(T("09:10:00")));
      for (const [i, id] of ids.entries()) {
        await t.append([toDraft(actionRequest({ sequence: 300 + i, id: `noise-${i}`, requester: AGENT, delegationId: "d-redeem", parameters: monetaryParameters(EUR(1)) }))], T("09:11:00"));
        expect((await t.redemption.redeem(auth(AGENT), t.command(id), T("09:12:00"))).ok).toBe(true);
      }
      const events: CanonicalStore = await t.store.getEvents();
      const rows = events.filter((e) => e.event_type === "CAPABILITY_REDEEMED");
      expect(rows).toHaveLength(5);
      for (const e of rows) {
        if (e.event_type !== "CAPABILITY_REDEEMED") continue;
        expect(Number(e.sequence)).toBe(Number(e.payload.decision_sequence) + 1);
        expect(validateRedemptionEvent(events, e)).toEqual({ ok: true });
      }
    } finally {
      await t.close();
    }
  });

  it("capacity (I29, D12): a redeemed ticket stays engaged, so a second ticket against a 2000 EUR budget is still CAPACITY_EXCEEDED", async () => {
    const t = await freshHarness({ totalBudget: EUR(2000) });
    try {
      const id = await t.issue(T("09:10:00"));
      expect((await t.redemption.redeem(auth(AGENT), t.command(id), T("09:12:00"))).ok).toBe(true);
      await t.append([toDraft(actionRequest({ sequence: 400, id: "act-second", requester: AGENT, delegationId: "d-redeem", parameters: monetaryParameters(EUR(300)) }))], T("09:12:30"));
      const second = await t.issuance.issue(auth(AGENT), clientIdempotencyKey("k-second"), { action_id: actionId("act-second"), enforcement_point_id: EP }, { nextCapabilityId: () => capabilityId("cap-second"), expiresAt: (x) => iso8601(new Date(Date.parse(x) + 300_000).toISOString()) }, T("09:13:00"));
      expect(second).toMatchObject({ outcome: "EXECUTED", result: { ok: false, reason: "CAPACITY_EXCEEDED" } });
    } finally {
      await t.close();
    }
  });

  it("the existing decisions are unchanged by a redemption row (authorityAt before and after)", async () => {
    const t = await freshHarness();
    try {
      const id = await t.issue(T("09:10:00"));
      const q = { agentId: AGENT, principalId: THEO, capability: PURCHASE_ORDER_CREATE, parameters: PARAMS };
      const pre = await t.store.getEvents();
      const at = { atSequence: sequenceNumber(pre.length), authorityTime: T("09:20:00") };
      const before = authorityAt(pre, q, at);
      expect((await t.redemption.redeem(auth(AGENT), t.command(id), T("09:12:00"))).ok).toBe(true);
      expect(authorityAt(await t.store.getEvents(), q, at)).toEqual(before);
    } finally {
      await t.close();
    }
  });

  it("failures are fail-closed: an unreachable database rejects and writes nothing; a held writer lock delays but never lets two through", async () => {
    const t = await freshHarness();
    try {
      const id = await t.issue(T("09:10:00"));
      const { Pool } = await import("pg");
      const dead = new Pool({ host: "127.0.0.1", port: 1, user: "x", connectionTimeoutMillis: 500 });
      await expect(new PostgresCapabilityRedemptionTransaction(dead).redeem(auth(AGENT), t.command(id), T("09:12:00"))).rejects.toBeDefined();
      await dead.end();
      expect(await redeemedRows(t)).toHaveLength(0);

      const holder = await t.pool.connect();
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtext('authority_events'))");
      const a = t.newRedemption().redeem(auth(AGENT), t.command(id), T("09:12:00"));
      const b = t.newRedemption().redeem(auth(AGENT), t.command(id), T("09:12:00"));
      await new Promise((r) => setTimeout(r, 300));
      expect(await redeemedRows(t)).toHaveLength(0); // both waiting
      await holder.query("ROLLBACK");
      holder.release();
      const results = await Promise.all([a, b]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(await redeemedRows(t)).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  describe("migration (schema.sql is the migration; it is idempotent)", () => {
    const schemaSql = readFileSync(fileURLToPath(new URL("../../src/storage/schema.sql", import.meta.url)), "utf8");
    const indexCount = async (t: PgHarness) => Number((await t.pool.query("SELECT count(*) AS c FROM pg_indexes WHERE indexname = $1 AND schemaname = $2", [REDEEMED_INDEX, t.iso.schema])).rows[0].c);

    it("applying it twice changes nothing and keeps exactly one redemption index", async () => {
      const t = await freshHarness();
      try {
        expect(await indexCount(t)).toBe(1);
        await t.pool.query(schemaSql);
        await t.pool.query(schemaSql);
        expect(await indexCount(t)).toBe(1);
      } finally {
        await t.close();
      }
    });

    it("applies to an installation that already holds CAPABILITY_ISSUED rows (and no redemption index): rows untouched, index created, redemption works", async () => {
      const t = await freshHarness();
      try {
        const id = await t.issue(T("09:10:00"));
        await t.pool.query(`DROP INDEX ${REDEEMED_INDEX}`); // an installation from before V1
        const before = (await t.pool.query("SELECT * FROM authority_events ORDER BY sequence")).rows;
        expect(await indexCount(t)).toBe(0);
        await t.pool.query(schemaSql);
        expect(await indexCount(t)).toBe(1);
        expect((await t.pool.query("SELECT * FROM authority_events ORDER BY sequence")).rows).toEqual(before);
        expect((await t.redemption.redeem(auth(AGENT), t.command(id), T("09:12:00"))).ok).toBe(true);
      } finally {
        await t.close();
      }
    });
  });
});
