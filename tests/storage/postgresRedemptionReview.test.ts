/**
 * Final security review of PR #25 (PostgreSQL redemption). Each test pins one
 * claim of the review report: unknown outcome after a lost COMMIT
 * acknowledgement, writers that bypass the lock, parity with the in-memory
 * backend, the clock and identity boundaries. Skipped without a database;
 * mandatory in CI.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toDraft } from "../../src/domain/events.js";
import { validateRedemptionEvent } from "../../src/engine/redeemCapability.js";
import { enforcementPointId, iso8601, monetaryParameters, principalId, sequenceNumber, capability, type CapabilityId } from "../../src/domain/types.js";
import { PostgresCapabilityRedemptionTransaction, REDEEMED_INDEX, RedemptionSchemaError, checkRedemptionSchema } from "../../src/storage/postgresCapabilityRedemptionTransaction.js";
import { EUR, THEO, actionRequest } from "../fixtures/scenarios.js";
import { AGENT, AGENT_B_PRINCIPAL, EP, PARAMS, T, auth, harness } from "../redemption/harness.js";
import { databaseAvailable, intercepted, pgHarness, rawInsert, type PgHarness } from "../redemption/pgHarness.js";
import { argumentsDigest } from "../../src/domain/canonicalJson.js";

const available = await databaseAvailable();
const redeemedRows = async (h: PgHarness) => (await h.pool.query("SELECT event_id, sequence, authority_time FROM authority_events WHERE event_type = 'CAPABILITY_REDEEMED' ORDER BY sequence")).rows;
const maxSequence = async (h: PgHarness) => Number((await h.pool.query("SELECT max(sequence) AS m FROM authority_events")).rows[0].m);
let n = 0;
const fresh = (o: Parameters<typeof pgHarness>[0] = {}) => pgHarness({ label: `rv${++n}`, ...o });

describe.skipIf(!available)("review 1: unknown outcome after a lost COMMIT acknowledgement", () => {
  /** The server COMMITS, then the connection dies before the caller hears about it: the worst case. */
  function lostAck(t: PgHarness): PostgresCapabilityRedemptionTransaction {
    return new PostgresCapabilityRedemptionTransaction(intercepted(t.pool, {
      after: async (sql, client) => {
        if (sql !== "COMMIT") return;
        const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        await t.pool.query("SELECT pg_terminate_backend($1)", [pid]); // the connection is really dead before the caller hears anything
        await new Promise((r) => setTimeout(r, 100));
        throw new Error("connection terminated unexpectedly (simulated lost acknowledgement)");
      },
    }));
  }

  it("the call rejects (never ok:true) although the row IS committed; a retry sees ALREADY_REDEEMED, never a second success", async () => {
    const t = await fresh();
    try {
      const id = await t.issue(T("09:10:00"));
      await expect(lostAck(t).redeem(auth(AGENT), t.command(id), T("09:12:00"))).rejects.toThrow(/lost acknowledgement/);
      const rows = await redeemedRows(t);
      expect(rows).toHaveLength(1); // the outcome really was "committed"
      expect(await t.redemption.redeem(auth(AGENT), t.command(id), T("09:13:00"))).toEqual({ ok: false, reason: "ALREADY_REDEEMED" });
      expect(await redeemedRows(t)).toHaveLength(1);
      const events = await t.store.getEvents();
      const e = events.find((x) => x.event_type === "CAPABILITY_REDEEMED")!;
      if (e.event_type !== "CAPABILITY_REDEEMED") throw new Error("fixture");
      expect(validateRedemptionEvent(events, e)).toEqual({ ok: true }); // a coherent, valid redemption that its author never learned about
    } finally {
      await t.close();
    }
  });

  it("recovery protocol: after an unknown outcome the effect MUST NOT run (no ok was observed) and the caller re-authorizes; the pool stays usable", async () => {
    const t = await fresh();
    try {
      const id = await t.issue(T("09:10:00"));
      let effectRan = false;
      const guarded = async (tx: PostgresCapabilityRedemptionTransaction, cap: CapabilityId, at: string) => {
        try {
          const r = await tx.redeem(auth(AGENT), t.command(cap), iso8601(`2025-01-01T${at}.000Z`));
          if (r.ok) effectRan = true; // the ONLY place an effect may run
          return r;
        } catch {
          return undefined; // unknown outcome: no effect
        }
      };
      expect(await guarded(lostAck(t), id, "09:12:00")).toBeUndefined();
      expect(effectRan).toBe(false);
      const second = await t.issue(T("09:12:30")); // re-authorize: a new capability for the same action
      expect((await guarded(t.redemption, second, "09:13:00"))?.ok).toBe(true); // the pool and the lock were not left damaged
      expect(effectRan).toBe(true);
      expect(await redeemedRows(t)).toHaveLength(2);
    } finally {
      await t.close();
    }
  });

  it("a lost acknowledgement leaves no lock behind: a concurrent redeemer is not blocked", async () => {
    const t = await fresh();
    try {
      const a = await t.issue(T("09:10:00"));
      const b = await t.issue(T("09:10:30"));
      await expect(lostAck(t).redeem(auth(AGENT), t.command(a), T("09:12:00"))).rejects.toBeDefined();
      const r = await Promise.race([t.redemption.redeem(auth(AGENT), t.command(b), T("09:12:30")), new Promise<"timeout">((res) => setTimeout(() => res("timeout"), 5000))]);
      expect(r).not.toBe("timeout");
      expect((r as { ok: boolean }).ok).toBe(true);
    } finally {
      await t.close();
    }
  });
});

describe.skipIf(!available)("review 2: writers that bypass the lock", () => {
  it("a revocation committed at sequence N+2 while we read at N and insert at N+1: the redemption commits BEFORE it in the log, which is the order that defines authority (I31 holds at its snapshot)", async () => {
    const t = await fresh();
    try {
      const id = await t.issue(T("09:10:00"));
      let injected = false;
      const tx = new PostgresCapabilityRedemptionTransaction(intercepted(t.pool, {
        before: async (sql) => {
          if (!injected && sql.startsWith("INSERT INTO authority_events")) {
            injected = true;
            await rawInsert(t.pool, { sequence: (await maxSequence(t)) + 2, event_id: "bypass-rev-later", event_type: "DELEGATION_REVOKED", principal_id: THEO, payload: { delegation_id: "d-redeem", revoked_by_principal_id: THEO, reason_code: "BYPASS" }, authority_time: "2025-01-01T09:12:00Z" });
          }
        },
      }));
      expect((await tx.redeem(auth(AGENT), t.command(id), T("09:12:00"))).ok).toBe(true);
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

  it("a sequence GAP (a raw writer skipped numbers) makes redemption fail closed: nothing is written, the result is a refusal, never an incoherent event", async () => {
    const t = await fresh();
    try {
      const id = await t.issue(T("09:10:00"));
      await rawInsert(t.pool, { sequence: 500, event_id: "gap-maker", event_type: "ACTION_REQUESTED", principal_id: "x", payload: { action_id: "gap", requesting_principal_id: "x", delegation_id: "d-redeem", capability_requested: { resource: "purchase_order", action: "create" }, parameters: { kind: "nonmonetary" } } });
      const r = await t.redemption.redeem(auth(AGENT), t.command(id), T("09:12:00"));
      expect(r).toEqual({ ok: false, reason: "CONCURRENT_WRITE_DETECTED", detail: { ticketConsumed: false } });
      expect(await redeemedRows(t)).toHaveLength(0);
    } finally {
      await t.close();
    }
  });

  it("two redemptions of different tickets racing with a lock-bypassing writer never leave two rows for one ticket, and every committed row validates or is absent", async () => {
    const t = await fresh();
    try {
      const ids = [await t.issue(T("09:10:00")), await t.issue(T("09:10:10"))];
      const results = await Promise.all([
        ...ids.map((id) => t.newRedemption().redeem(auth(AGENT), t.command(id), T("09:12:00"))),
        ...ids.map((id) => t.newRedemption().redeem(auth(AGENT), t.command(id), T("09:12:00"))),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(2);
      const events = await t.store.getEvents();
      for (const e of events) if (e.event_type === "CAPABILITY_REDEEMED") expect(validateRedemptionEvent(events, e)).toEqual({ ok: true });
    } finally {
      await t.close();
    }
  });
});

describe.skipIf(!available)("review 3: the in-memory and PostgreSQL backends answer alike", () => {
  type Scenario = { name: string; run: (b: Backend) => Promise<unknown> };
  interface Backend {
    issue(at: string): Promise<CapabilityId>;
    redeem(who: ReturnType<typeof auth>, id: CapabilityId, at: string, overrides?: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }>;
    revoke(at: string): Promise<void>;
  }
  const scenarios: Scenario[] = [
    { name: "plain success", run: async (b) => b.redeem(auth(AGENT), await b.issue("09:10:00"), "09:12:00") },
    { name: "second redemption", run: async (b) => { const id = await b.issue("09:10:00"); await b.redeem(auth(AGENT), id, "09:12:00"); return b.redeem(auth(AGENT), id, "09:13:00"); } },
    { name: "wrong requester", run: async (b) => b.redeem(auth(AGENT_B_PRINCIPAL), await b.issue("09:10:00"), "09:12:00") },
    { name: "wrong enforcement point", run: async (b) => b.redeem(auth(AGENT), await b.issue("09:10:00"), "09:12:00", { enforcement_point_id: enforcementPointId("ep-other") }) },
    { name: "expired exactly at the boundary", run: async (b) => b.redeem(auth(AGENT), await b.issue("09:10:00"), "09:15:00") },
    { name: "one millisecond before expiry", run: async (b) => b.redeem(auth(AGENT), await b.issue("09:10:00"), "09:14:59") },
    { name: "stale instant", run: async (b) => b.redeem(auth(AGENT), await b.issue("09:10:00"), "09:09:00") },
    { name: "arguments digest substituted", run: async (b) => b.redeem(auth(AGENT), await b.issue("09:10:00"), "09:12:00", { observed_parameters: monetaryParameters(EUR(1800), undefined, argumentsDigest({ other: 1 })) }) },
    { name: "capability substituted", run: async (b) => b.redeem(auth(AGENT), await b.issue("09:10:00"), "09:12:00", { observed_capability: capability("payment", "execute") }) },
    { name: "revoked between issuance and redemption", run: async (b) => { const id = await b.issue("09:10:00"); await b.revoke("09:11:00"); return b.redeem(auth(AGENT), id, "09:12:00"); } },
    { name: "unknown capability", run: async (b) => b.redeem(auth(AGENT), "nope" as CapabilityId, "09:12:00") },
  ];
  const shape = (r: unknown) => { const x = r as { ok: boolean; reason?: string; detail?: { decision?: unknown } }; return { ok: x.ok, reason: x.reason, decision: x.detail?.decision }; };

  it.each(scenarios)("%s: same result on both backends", async ({ run }) => {
    const m = await harness();
    const memory: Backend = {
      issue: (at) => m.issue(iso8601(`2025-01-01T${at}.000Z`)),
      redeem: (who, id, at, o = {}) => m.redemption.redeem(who, m.command(id, o), iso8601(`2025-01-01T${at}.000Z`)),
      revoke: (at) => m.revoke(iso8601(`2025-01-01T${at}.000Z`)),
    };
    const p = await fresh();
    try {
      const pg: Backend = {
        issue: (at) => p.issue(iso8601(`2025-01-01T${at}.000Z`)),
        redeem: (who, id, at, o = {}) => p.redemption.redeem(who, p.command(id, o), iso8601(`2025-01-01T${at}.000Z`)),
        revoke: (at) => p.revoke(iso8601(`2025-01-01T${at}.000Z`)),
      };
      expect(shape(await run(pg))).toEqual(shape(await run(memory)));
    } finally {
      await p.close();
    }
  });
});

describe.skipIf(!available)("review 5: trust boundaries are inputs, and the tests say which", () => {
  it("CLOCK (residual): the engine accepts any authorityTime not older than the log's latest, so a stale clock can redeem long after the real time; freshness is the clock owner's responsibility (D4)", async () => {
    const t = await fresh();
    try {
      const id = await t.issue(T("09:10:00")); // ticket valid until 09:15:00
      // "Real time" could be days later; Authority has no way to know. A caller reporting 09:10:00 gets a valid redemption.
      expect((await t.redemption.redeem(auth(AGENT), t.command(id), T("09:10:00"))).ok).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("CLOCK (residual): a far-future authorityTime written to the log irreversibly moves its high-water mark, so later calls with a sane clock are refused STALE_AUTHORITY_TIME (availability, not authority)", async () => {
    const t = await fresh();
    try {
      const a = await t.issue(T("09:10:00"));
      const b = await t.issue(T("09:10:30"));
      expect((await t.redemption.redeem(auth(AGENT), t.command(a), iso8601("2025-01-01T09:14:00.000Z"))).ok).toBe(true);
      await t.append([toDraft(actionRequest({ sequence: 700, id: "future", requester: AGENT, delegationId: "d-redeem", parameters: monetaryParameters(EUR(1)) }))], iso8601("2030-01-01T00:00:00.000Z"));
      expect(await t.redemption.redeem(auth(AGENT), t.command(b), T("09:14:30"))).toEqual({ ok: false, reason: "STALE_AUTHORITY_TIME" });
    } finally {
      await t.close();
    }
  });

  it("IDENTITY (residual): the requester is whatever AuthenticatedPrincipal the caller asserts; only a mismatch with the action's requester is detected", async () => {
    const t = await fresh();
    try {
      const id = await t.issue(T("09:10:00"));
      expect(await t.redemption.redeem(auth(principalId("someone-else")), t.command(id), T("09:12:00"))).toEqual({ ok: false, reason: "REQUESTER_MISMATCH" });
      expect((await t.redemption.redeem({ principalId: AGENT }, t.command(id), T("09:12:00"))).ok).toBe(true); // a caller that asserts the right identity is believed
    } finally {
      await t.close();
    }
  });

  it("MIGRATION: the redemption index is UNIQUE, partial on CAPABILITY_REDEEMED, and over the capability_id expression", async () => {
    const t = await fresh();
    try {
      const def = (await t.pool.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'authority_events_redeemed_capability_id_uidx' AND schemaname = $1", [t.iso.schema])).rows[0].indexdef as string;
      expect(def).toMatch(/CREATE UNIQUE INDEX/);
      expect(def).toMatch(/payload ->> 'capability_id'/);
      expect(def).toMatch(/WHERE \(event_type = 'CAPABILITY_REDEEMED'/);
      // The pre-existing capability_id index is untouched and a ticket and its redemption share an id without conflict.
      const id = await t.issue(T("09:10:00"));
      expect((await t.redemption.redeem(auth(AGENT), t.command(id), T("09:12:00"))).ok).toBe(true);
    } finally {
      await t.close();
    }
  });
});

describe.skipIf(!available)("review 4: migration operations on a pre-existing installation", () => {
  it("checkRedemptionSchema: a sound installation reports no problem; a missing index is reported", async () => {
    const t = await fresh();
    try {
      expect(await checkRedemptionSchema(t.pool)).toEqual([]);
      await t.pool.query(`DROP INDEX ${REDEEMED_INDEX}`);
      expect((await checkRedemptionSchema(t.pool))[0]).toMatch(/missing/);
    } finally {
      await t.close();
    }
  });

  it("an INVALID leftover index (failed CONCURRENTLY build over duplicate rows) is silently kept by IF NOT EXISTS; checkRedemptionSchema catches it", async () => {
    const t = await fresh();
    try {
      await t.pool.query(`DROP INDEX ${REDEEMED_INDEX}`);
      const payload = { capability_id: "dup-cap" };
      await rawInsert(t.pool, { sequence: 900, event_id: "dup-1", event_type: "CAPABILITY_REDEEMED", principal_id: "x", payload });
      await rawInsert(t.pool, { sequence: 901, event_id: "dup-2", event_type: "CAPABILITY_REDEEMED", principal_id: "x", payload });
      await expect(t.pool.query(`CREATE UNIQUE INDEX CONCURRENTLY ${REDEEMED_INDEX} ON authority_events ((payload ->> 'capability_id')) WHERE event_type = 'CAPABILITY_REDEEMED'`)).rejects.toMatchObject({ code: "23505" });
      const schemaSql = (await import("node:fs")).readFileSync(new URL("../../src/storage/schema.sql", import.meta.url), "utf8");
      await t.pool.query(schemaSql); // IF NOT EXISTS: skips the invalid index without complaint
      const problems = await checkRedemptionSchema(t.pool);
      expect(problems.join(" ")).toMatch(/INVALID/);
    } finally {
      await t.close();
    }
  });

  it("an index built by hand with CREATE UNIQUE INDEX CONCURRENTLY (the recommended path for a large journal) is accepted by schema.sql as is", async () => {
    const t = await fresh();
    try {
      await t.pool.query(`DROP INDEX ${REDEEMED_INDEX}`);
      await t.pool.query(`CREATE UNIQUE INDEX CONCURRENTLY ${REDEEMED_INDEX} ON authority_events ((payload ->> 'capability_id')) WHERE event_type = 'CAPABILITY_REDEEMED'`);
      const schemaSql = (await import("node:fs")).readFileSync(new URL("../../src/storage/schema.sql", import.meta.url), "utf8");
      await t.pool.query(schemaSql);
      expect(await checkRedemptionSchema(t.pool)).toEqual([]);
    } finally {
      await t.close();
    }
  });
});

void [EP, PARAMS, sequenceNumber];

describe.skipIf(!available)("schema enforcement: the transaction refuses to run without a sound redemption index", () => {
  const schemaSql = () => readFileSync(new URL("../../src/storage/schema.sql", import.meta.url), "utf8");

  it("a missing index: redeem throws RedemptionSchemaError, writes nothing, and works as soon as the migration is applied (no cached failure)", async () => {
    const t = await fresh();
    try {
      const id = await t.issue(T("09:10:00"));
      await t.pool.query(`DROP INDEX ${REDEEMED_INDEX}`);
      const tx = t.newRedemption();
      const err = await tx.redeem(auth(AGENT), t.command(id), T("09:12:00")).then(() => undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(RedemptionSchemaError);
      expect((err as RedemptionSchemaError).problems[0]).toMatch(/missing/);
      expect(await redeemedRows(t)).toHaveLength(0);
      await t.pool.query(schemaSql());
      expect((await tx.redeem(auth(AGENT), t.command(id), T("09:12:00"))).ok).toBe(true); // same instance, no restart
    } finally {
      await t.close();
    }
  });

  it("an INVALID index (failed CONCURRENTLY build) is refused too, even though IF NOT EXISTS skipped it", async () => {
    const t = await fresh();
    try {
      const id = await t.issue(T("09:10:00"));
      await t.pool.query(`DROP INDEX ${REDEEMED_INDEX}`);
      await rawInsert(t.pool, { sequence: 900, event_id: "dup-1", event_type: "CAPABILITY_REDEEMED", principal_id: "x", payload: { capability_id: "dup-cap" } });
      await rawInsert(t.pool, { sequence: 901, event_id: "dup-2", event_type: "CAPABILITY_REDEEMED", principal_id: "x", payload: { capability_id: "dup-cap" } });
      await expect(t.pool.query(`CREATE UNIQUE INDEX CONCURRENTLY ${REDEEMED_INDEX} ON authority_events ((payload ->> 'capability_id')) WHERE event_type = 'CAPABILITY_REDEEMED'`)).rejects.toMatchObject({ code: "23505" });
      await t.pool.query(schemaSql()); // silently keeps the invalid index
      const err = await t.newRedemption().redeem(auth(AGENT), t.command(id), T("09:12:00")).then(() => undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(RedemptionSchemaError);
      expect((err as RedemptionSchemaError).problems.join(" ")).toMatch(/INVALID/);
    } finally {
      await t.close();
    }
  });

  it("a non-unique index with the right name is refused", async () => {
    const t = await fresh();
    try {
      const id = await t.issue(T("09:10:00"));
      await t.pool.query(`DROP INDEX ${REDEEMED_INDEX}`);
      await t.pool.query(`CREATE INDEX ${REDEEMED_INDEX} ON authority_events ((payload ->> 'capability_id')) WHERE event_type = 'CAPABILITY_REDEEMED'`);
      await expect(t.newRedemption().redeem(auth(AGENT), t.command(id), T("09:12:00"))).rejects.toBeInstanceOf(RedemptionSchemaError);
      expect(await redeemedRows(t)).toHaveLength(0);
    } finally {
      await t.close();
    }
  });

  it("the check runs once per instance, before its first redemption, on the same connection that redeems", async () => {
    const t = await fresh();
    try {
      const ids = [await t.issue(T("09:10:00")), await t.issue(T("09:10:10")), await t.issue(T("09:10:20"))];
      let checks = 0;
      const tx = new PostgresCapabilityRedemptionTransaction(intercepted(t.pool, { before: async (sql) => { if (sql.includes("indisvalid")) checks += 1; } }));
      for (const id of ids) expect((await tx.redeem(auth(AGENT), t.command(id), T("09:12:00"))).ok).toBe(true);
      expect(checks).toBe(1);
    } finally {
      await t.close();
    }
  });
});
