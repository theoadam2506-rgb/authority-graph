/**
 * I32 (D36) on a real PostgreSQL: at most one CAPABILITY_ISSUED per action.
 * Exclusion comes from the database, not from a process: concurrent pools, real
 * OS processes, a writer that bypasses the lock, the backstop index, and the
 * migration over a journal that already holds several tickets for one action.
 * Skipped without a database; mandatory in CI through the report guard.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toDraft } from "../../src/domain/events.js";
import { actionId, capabilityId, clientIdempotencyKey, iso8601 } from "../../src/domain/types.js";
import { PostgresCapabilityIssuanceTransaction, IssuanceSchemaError, TICKETED_ACTION_INDEX, checkTicketPerActionSchema } from "../../src/storage/postgresCapabilityIssuanceTransaction.js";
import { PostgresEventStore } from "../../src/storage/postgresEventStore.js";
import { buildCapabilityIssuedDraft } from "../../src/storage/capabilityIssuanceTransaction.js";
import { actionRequest } from "../fixtures/scenarios.js";
import { AGENT, EP, PARAMS, T, auth } from "../redemption/harness.js";
import { TEST_DATABASE_URL, databaseAvailable, intercepted, pgHarness, rawInsert, type PgHarness } from "../redemption/pgHarness.js";

const available = await databaseAvailable();
const WORKER = fileURLToPath(new URL("./support/issueWorker.ts", import.meta.url));
const schemaSql = () => readFileSync(new URL("../../src/storage/schema.sql", import.meta.url), "utf8");

let n = 0;
const deps = () => ({
  nextCapabilityId: () => capabilityId(`cap-pg-i32-${++n}-${Math.random().toString(36).slice(2, 8)}`),
  expiresAt: (t: string) => iso8601(new Date(Date.parse(t) + 5 * 60_000).toISOString()),
});
const issueFor = (tx: PostgresCapabilityIssuanceTransaction, key: string, action = "act-redeem") =>
  tx.issue(auth(AGENT), clientIdempotencyKey(key), { action_id: actionId(action), enforcement_point_id: EP }, deps(), T("09:10:00"));
const ticketRows = async (t: PgHarness, action = "act-redeem") =>
  (await t.pool.query(`SELECT event_id FROM authority_events WHERE event_type = 'CAPABILITY_ISSUED' AND payload ->> 'action_id' = $1`, [action])).rows;
const ok = (o: Awaited<ReturnType<typeof issueFor>>) => o.outcome === "EXECUTED" && o.result.ok;

describe.skipIf(!available)("I32 on PostgreSQL: one ticket per action", () => {
  it("60 callers over 6 independent pools, 60 distinct idempotency keys, one action: exactly one ticket, the others ACTION_ALREADY_TICKETED", async () => {
    const t = await pgHarness({ label: "i32_pools" });
    try {
      const txs = Array.from({ length: 6 }, () => new PostgresCapabilityIssuanceTransaction(t.newPool()));
      const results = await Promise.all(Array.from({ length: 60 }, (_, i) => issueFor(txs[i % 6]!, `p-${i}`)));
      expect(results.filter(ok)).toHaveLength(1);
      for (const r of results) if (!ok(r)) expect(r).toMatchObject({ outcome: "EXECUTED", result: { ok: false, reason: "ACTION_ALREADY_TICKETED" } });
      expect(await ticketRows(t)).toHaveLength(1);
    } finally {
      await t.close();
    }
  }, 60_000);

  it("6 real OS processes released at once, 6 distinct keys, one action: exactly one ticket", async () => {
    const t = await pgHarness({ label: "i32_procs" });
    try {
      const workers = Array.from({ length: 6 }, (_, i) => start(t.iso.schema, "act-redeem", String(i)));
      await Promise.all(workers.map((w) => w.waitFor("READY")));
      for (const w of workers) w.child.stdin.write("go\n");
      const results = (await Promise.all(workers.map((w) => w.waitFor("RESULT")))).map((l) => JSON.parse(l.slice("RESULT ".length)) as { outcome: string; result: { ok: boolean; reason?: string } });
      await Promise.all(workers.map((w) => w.exited));
      expect(results.filter((r) => r.outcome === "EXECUTED" && r.result.ok)).toHaveLength(1);
      for (const r of results) if (!r.result.ok) expect(r.result.reason).toBe("ACTION_ALREADY_TICKETED");
      expect(await ticketRows(t)).toHaveLength(1);
    } finally {
      await t.close();
    }
  }, 60_000);

  it("the PostgreSQL store refuses a second ticket for the action written through append() (ingestion, rebuilt from the rows)", async () => {
    const t = await pgHarness({ label: "i32_store" });
    try {
      const first = await issueFor(t.issuance, "k1");
      expect(ok(first)).toBe(true);
      const issued = first.outcome === "EXECUTED" && first.result.ok ? first.result.capability : undefined;
      const store = new PostgresEventStore(t.pool, { authorityTime: () => T("09:30:00") });
      const out = await store.append([buildCapabilityIssuedDraft(auth(AGENT), T("09:11:00"), { ...issued!, capability_id: capabilityId("cap-by-hand") })]);
      expect(out.outcomes[0]).toEqual({ accepted: false, reasonCode: "BUSINESS_ID_COLLISION" });
      expect(await ticketRows(t)).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it("a writer that bypasses the lock AND ingestion (a raw INSERT) hits the unique index: no second row", async () => {
    const t = await pgHarness({ label: "i32_raw" });
    try {
      expect(ok(await issueFor(t.issuance, "k1"))).toBe(true);
      const err = await rawInsert(t.pool, { sequence: 900, event_id: "raw-second-ticket", event_type: "CAPABILITY_ISSUED", principal_id: AGENT, payload: { capability_id: "cap-raw", action_id: "act-redeem" } }).then(() => undefined, (e: unknown) => e);
      expect(err).toMatchObject({ code: "23505", constraint: TICKETED_ACTION_INDEX });
      expect(await ticketRows(t)).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it("a lock-bypassing writer that tickets the action between the transaction's snapshot and its INSERT: the unique index stops the transaction, nothing is cached, the retry is refused cleanly", async () => {
    const t = await pgHarness({ label: "i32_interleave" });
    try {
      let injected = false;
      const racing = new PostgresCapabilityIssuanceTransaction(
        intercepted(t.pool, {
          before: async (sql) => {
            if (!injected && /^\s*INSERT INTO authority_events/i.test(sql)) {
              injected = true;
              await rawInsert(t.pool, { sequence: 950, event_id: "raw-in-between", event_type: "CAPABILITY_ISSUED", principal_id: AGENT, payload: { capability_id: "cap-in-between", action_id: "act-redeem" } });
            }
          },
        }),
      );
      const err = await issueFor(racing, "k-race").then(() => undefined, (e: unknown) => e);
      expect(err).toMatchObject({ code: "23505", constraint: TICKETED_ACTION_INDEX });
      expect(await ticketRows(t)).toHaveLength(1); // the raw writer's row only
      expect((await t.pool.query(`SELECT count(*)::int AS c FROM capability_issuance_idempotency WHERE client_idempotency_key = 'k-race'`)).rows[0].c).toBe(0); // rolled back: no cached outcome
      // (at a later instant: the raw row carries authority_time 09:11, and a stale instant keeps its priority)
      expect(await t.issuance.issue(auth(AGENT), clientIdempotencyKey("k-race"), { action_id: actionId("act-redeem"), enforcement_point_id: EP }, deps(), T("09:20:00"))).toMatchObject({ outcome: "EXECUTED", result: { ok: false, reason: "ACTION_ALREADY_TICKETED" } });
    } finally {
      await t.close();
    }
  });

  it("an expired ticket does not free the action: a later issuance is refused, a new action works", async () => {
    const t = await pgHarness({ label: "i32_expired" });
    try {
      expect(ok(await issueFor(t.issuance, "k1"))).toBe(true);
      const later = await t.issuance.issue(auth(AGENT), clientIdempotencyKey("k2"), { action_id: actionId("act-redeem"), enforcement_point_id: EP }, deps(), T("11:00:00"));
      expect(later).toMatchObject({ result: { ok: false, reason: "ACTION_ALREADY_TICKETED" } });
      await t.append([toDraft(actionRequest({ sequence: 800, id: "act-new", requester: AGENT, delegationId: "d-redeem", parameters: PARAMS }))], T("11:00:00"));
      expect(ok(await t.issuance.issue(auth(AGENT), clientIdempotencyKey("k3"), { action_id: actionId("act-new"), enforcement_point_id: EP }, deps(), T("11:00:00")))).toBe(true);
    } finally {
      await t.close();
    }
  });
});

describe.skipIf(!available)("I32 schema: the backstop index is required, and the migration refuses an ambiguous journal", () => {
  it("a missing index: issue throws IssuanceSchemaError, writes nothing, works once the migration is applied (no cached failure)", async () => {
    const t = await pgHarness({ label: "i32_missing" });
    try {
      await t.pool.query(`DROP INDEX ${TICKETED_ACTION_INDEX}`);
      const tx = new PostgresCapabilityIssuanceTransaction(t.pool);
      const err = await issueFor(tx, "k1").then(() => undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(IssuanceSchemaError);
      expect((err as IssuanceSchemaError).problems[0]).toMatch(/missing/);
      expect(await ticketRows(t)).toHaveLength(0);
      await t.pool.query(schemaSql());
      expect(ok(await issueFor(tx, "k1"))).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("a non-unique index with the right name, and an INVALID one, are refused", async () => {
    const t = await pgHarness({ label: "i32_bad" });
    try {
      await t.pool.query(`DROP INDEX ${TICKETED_ACTION_INDEX}`);
      await t.pool.query(`CREATE INDEX ${TICKETED_ACTION_INDEX} ON authority_events ((payload ->> 'action_id')) WHERE event_type = 'CAPABILITY_ISSUED'`);
      expect((await checkTicketPerActionSchema(t.pool)).join(" ")).toMatch(/not UNIQUE/);
      await t.pool.query(`DROP INDEX ${TICKETED_ACTION_INDEX}`);
      await rawInsert(t.pool, { sequence: 900, event_id: "dup-1", event_type: "CAPABILITY_ISSUED", principal_id: "x", payload: { capability_id: "c1", action_id: "dup-action" } });
      await rawInsert(t.pool, { sequence: 901, event_id: "dup-2", event_type: "CAPABILITY_ISSUED", principal_id: "x", payload: { capability_id: "c2", action_id: "dup-action" } });
      await expect(t.pool.query(`CREATE UNIQUE INDEX CONCURRENTLY ${TICKETED_ACTION_INDEX} ON authority_events ((payload ->> 'action_id')) WHERE event_type = 'CAPABILITY_ISSUED'`)).rejects.toMatchObject({ code: "23505" });
      // an INVALID leftover index exists now; `IF NOT EXISTS` would keep it silently, the check catches it
      expect((await checkTicketPerActionSchema(t.pool)).join(" ")).toMatch(/INVALID/);
    } finally {
      await t.close();
    }
  });

  it("MIGRATION: a journal that already holds two tickets for one action is refused with the offending action ids, nothing is rewritten, and a clean journal migrates (idempotently)", async () => {
    const t = await pgHarness({ label: "i32_migrate" });
    try {
      await t.pool.query(`DROP INDEX ${TICKETED_ACTION_INDEX}`); // an installation from before I32
      await rawInsert(t.pool, { sequence: 900, event_id: "old-1", event_type: "CAPABILITY_ISSUED", principal_id: "x", payload: { capability_id: "old-c1", action_id: "old-action" } });
      await rawInsert(t.pool, { sequence: 901, event_id: "old-2", event_type: "CAPABILITY_ISSUED", principal_id: "x", payload: { capability_id: "old-c2", action_id: "old-action" } });
      const err = await t.pool.query(schemaSql()).then(() => undefined, (e: unknown) => e as { message: string; hint?: string });
      expect(err?.message).toMatch(/I32/);
      expect(err?.message).toMatch(/old-action \(2 tickets\)/);
      expect(err?.hint).toMatch(/D36/);
      expect((await t.pool.query(`SELECT count(*)::int AS c FROM authority_events WHERE event_type = 'CAPABILITY_ISSUED' AND payload ->> 'action_id' = 'old-action'`)).rows[0].c).toBe(2); // not rewritten
      expect((await checkTicketPerActionSchema(t.pool)).join(" ")).toMatch(/missing/); // and the transaction keeps refusing to run
      // the operator resolves it (here: as the owner, removing one row), then the migration succeeds, twice
      await t.pool.query(`DELETE FROM authority_events WHERE event_id = 'old-2'`);
      await t.pool.query(schemaSql());
      await t.pool.query(schemaSql());
      expect(await checkTicketPerActionSchema(t.pool)).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("applying schema.sql to a database that already has the index, with duplicates impossible, is a no-op (the duplicate scan is skipped)", async () => {
    const t = await pgHarness({ label: "i32_noop" });
    try {
      expect(ok(await issueFor(t.issuance, "k1"))).toBe(true);
      await t.pool.query(schemaSql());
      expect(await checkTicketPerActionSchema(t.pool)).toEqual([]);
      expect(await ticketRows(t)).toHaveLength(1);
    } finally {
      await t.close();
    }
  });
});

function start(schema: string, action: string, id: string): { child: ChildProcessWithoutNullStreams; waitFor: (prefix: string) => Promise<string>; exited: Promise<void> } {
  const child = spawn(process.execPath, ["--import", "tsx", WORKER, schema, action, id], { env: { ...process.env, TEST_DATABASE_URL }, stdio: ["pipe", "pipe", "pipe"] });
  const lines: string[] = [];
  const waiters: { prefix: string; resolve: (l: string) => void }[] = [];
  let buffer = "";
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
  child.stdout.on("data", (c: Buffer) => {
    buffer += c.toString();
    let i: number;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      lines.push(line);
      for (const w of [...waiters]) if (line.startsWith(w.prefix)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(line); }
    }
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const waitFor = (prefix: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const seen = lines.find((l) => l.startsWith(prefix));
      if (seen !== undefined) return resolve(seen);
      waiters.push({ prefix, resolve });
      child.once("exit", () => reject(new Error(`worker exited before "${prefix}": ${stderr.slice(0, 500)}`)));
    });
  return { child, waitFor, exited };
}
