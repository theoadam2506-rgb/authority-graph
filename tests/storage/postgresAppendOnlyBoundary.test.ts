/**
 * P2A — adversarial PostgreSQL test of the append-only role boundary
 * (src/storage/roles.sql). The application connects as a login role that is
 * a member of `authority_app`; it must read and append what the stores need,
 * and nothing else. Gated like the other PostgreSQL test files: skipped
 * when TEST_DATABASE_URL is unreachable, mandatory in CI (see the report
 * guard). Needs a superuser (or CREATEROLE + ownership) to create roles.
 *
 * Out of scope on purpose: a superuser, the table owner and the database
 * owner can still modify the journal. Nothing here claims otherwise.
 */
import { Pool, type PoolClient } from "pg";
import { isolatedSchema } from "./pgTestSchema.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { toDraft } from "../../src/domain/events.js";
import { PostgresEventStore } from "../../src/storage/postgresEventStore.js";
import { PostgresCapabilityIssuanceTransaction } from "../../src/storage/postgresCapabilityIssuanceTransaction.js";
import { PostgresCapabilityRedemptionTransaction } from "../../src/storage/postgresCapabilityRedemptionTransaction.js";
import { buildCapabilityRedeemedDraft } from "../../src/storage/capabilityRedemptionTransaction.js";
import { validateRedemptionEvent } from "../../src/engine/redeemCapability.js";
import { actionId, capabilityId, clientIdempotencyKey, enforcementPointId, iso8601, monetaryParameters, money, sequenceNumber, thresholds } from "../../src/domain/types.js";
import { AGENT_A, AGENT_B, MALLORY, PURCHASE_ORDER_CREATE, THEO, actionRequest, rootDelegation, sequentialClock } from "../fixtures/scenarios.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/authority_graph_test";
const LOGIN_ROLE = "authority_login_p2a_test";
const LOGIN_PASSWORD = "p2a-test-only";
const TABLES = ["authority_events", "security_log", "capability_issuance_idempotency"] as const;

async function probeDatabase(): Promise<boolean> {
  const probePool = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 2000 });
  try {
    await probePool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await probePool.end();
  }
}

const databaseAvailable = await probeDatabase();

if (!databaseAvailable) {
  // eslint-disable-next-line no-console
  console.warn(`[postgresAppendOnlyBoundary.test.ts] TEST_DATABASE_URL (${TEST_DATABASE_URL}) is not reachable — skipping. Set TEST_DATABASE_URL to run these.`);
}

const read = (name: string): string => readFileSync(fileURLToPath(new URL(`../../src/storage/${name}`, import.meta.url)), "utf8");
const ROLES_SQL = read("roles.sql");
const CHECK_SQL = read("append_only_check.sql");

// Issue #13: this file owns one schema; every connection (owner or login role) is pinned to it.
const iso = isolatedSchema(TEST_DATABASE_URL, "boundary");
const SEARCH_PATH_OPTIONS = `-c search_path=${iso.schema}`;

function loginUrl(): string {
  const url = new URL(TEST_DATABASE_URL);
  url.username = LOGIN_ROLE;
  url.password = LOGIN_PASSWORD;
  return url.toString();
}

/** Runs `fn` inside a transaction that is always rolled back. */
async function rolledBack(owner: Pool, fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

describe.skipIf(!databaseAvailable)("P2A — PostgreSQL append-only role boundary", () => {
  const owner = iso.pool;
  const app = new Pool({ connectionString: loginUrl(), options: SEARCH_PATH_OPTIONS });
  const violations = async (role: string): Promise<string[]> => (await owner.query<{ violation: string }>(CHECK_SQL, [role])).rows.map((r) => r.violation);
  const expectDenied = (promise: Promise<unknown>): Promise<void> => expect(promise).rejects.toMatchObject({ code: "42501" });

  // Roles are cluster-global: remember whether this run created authority_app,
  // so teardown removes exactly what the test added and nothing a deployment owns.
  let createdAuthorityApp = false;

  beforeAll(async () => {
    createdAuthorityApp = (await owner.query("SELECT 1 FROM pg_roles WHERE rolname = 'authority_app'")).rowCount === 0;
    await iso.create();
    await owner.query(ROLES_SQL);
    // roles.sql grants USAGE on `public` only; this file's tables live in its own schema.
    await owner.query(`GRANT USAGE ON SCHEMA ${iso.schema} TO authority_app`);
    await owner.query(`DROP ROLE IF EXISTS ${LOGIN_ROLE}`);
    await owner.query(`CREATE ROLE ${LOGIN_ROLE} LOGIN PASSWORD '${LOGIN_PASSWORD}' IN ROLE authority_app`);
  });

  beforeEach(async () => {
    await owner.query("TRUNCATE authority_events, security_log, capability_issuance_idempotency");
  });

  afterAll(async () => {
    try {
      await app.end();
    } finally {
      try {
        await owner.query(`DROP OWNED BY ${LOGIN_ROLE}`);
        await owner.query(`DROP ROLE IF EXISTS ${LOGIN_ROLE}`);
        if (createdAuthorityApp) {
          await owner.query("DROP OWNED BY authority_app");
          await owner.query("DROP ROLE IF EXISTS authority_app");
        }
      } finally {
        await iso.drop();
      }
    }
  });

  it("the check reports no violation for the application login role, and reports each weakness on a deliberately bad role", async () => {
    expect(await violations(LOGIN_ROLE)).toEqual([]);
    expect(await violations("authority_app")).toEqual([]);
    expect(await violations("no_such_role_p2a")).toEqual(["role does not exist"]);
    // The superuser the tests connect as is the documented non-goal: the check names it.
    expect((await violations("postgres")).join("\n")).toMatch(/superuser/);
    expect((await violations("postgres")).join("\n")).toMatch(/owns, or inherits ownership of/);
  });

  it("the application role can do everything the stores need: append, read, reject into the security log, record idempotency", async () => {
    const store = new PostgresEventStore(app, sequentialClock);
    const first = await store.append([
      toDraft(rootDelegation({ sequence: 1, id: "d-p2a-1", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT_A, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false })),
    ]);
    expect(first.outcomes).toEqual([{ accepted: true, sequence: 1 }]);

    // A colliding business id is rejected into the security log (BIGSERIAL id: needs sequence USAGE).
    const second = await store.append([
      toDraft(rootDelegation({ sequence: 2, id: "d-p2a-1", grantor: MALLORY, grantorType: "AGENT", grantee: AGENT_B, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false })),
    ]);
    expect(second.outcomes).toEqual([{ accepted: false, reasonCode: "BUSINESS_ID_COLLISION" }]);

    expect(await store.getEvents()).toHaveLength(1);
    expect(await store.getSecurityLog()).toHaveLength(1);

    await app.query(
      `INSERT INTO capability_issuance_idempotency (authenticated_requester_id, operation, client_idempotency_key, command, result, created_at)
       VALUES ('r', 'ISSUE_CAPABILITY', 'k', '{}', '{}', now())`,
    );
    expect((await app.query("SELECT 1 FROM capability_issuance_idempotency")).rowCount).toBe(1);
  });

  it.each(TABLES)("the application role cannot UPDATE, DELETE, TRUNCATE or lock-for-update %s, and the rows survive", async (table) => {
    await owner.query(
      "INSERT INTO authority_events VALUES (1, 'e1', 'DELEGATION_CREATED', 'p', 1, now(), now(), now(), 'ASSERTED_UNVERIFIED', '{}')",
    );
    await owner.query("INSERT INTO security_log (event_id, payload_hash, reason_code, recorded_at) VALUES ('e', 'h', 'X', now())");
    await owner.query(
      `INSERT INTO capability_issuance_idempotency (authenticated_requester_id, operation, client_idempotency_key, command, result, created_at)
       VALUES ('r', 'o', 'k', '{}', '{}', now())`,
    );
    const before = JSON.stringify((await owner.query(`SELECT * FROM ${table}`)).rows);

    await expectDenied(app.query(`UPDATE ${table} SET event_id = 'tampered'`));
    await expectDenied(app.query(`DELETE FROM ${table}`));
    await expectDenied(app.query(`TRUNCATE ${table}`));
    await expectDenied(app.query(`SELECT * FROM ${table} FOR UPDATE`));
    await expectDenied(app.query(`ALTER TABLE ${table} DISABLE TRIGGER ALL`));
    await expectDenied(app.query(`DROP TABLE ${table}`));
    await expectDenied(app.query(`CREATE TRIGGER t_p2a BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION pg_catalog.suppress_redundant_updates_trigger()`));
    // GRANT without grant option only warns; what matters is that it changes nothing.
    await app.query(`GRANT UPDATE ON ${table} TO ${LOGIN_ROLE}`);
    expect(await violations(LOGIN_ROLE)).toEqual([]);
    await expectDenied(app.query(`UPDATE ${table} SET event_id = 'tampered'`));

    expect(JSON.stringify((await owner.query(`SELECT * FROM ${table}`)).rows)).toBe(before);
  });

  it("an upsert (INSERT ... ON CONFLICT DO UPDATE) is refused: it would overwrite an existing event", async () => {
    await owner.query(
      "INSERT INTO authority_events VALUES (1, 'e1', 'DELEGATION_CREATED', 'p', 1, now(), now(), now(), 'ASSERTED_UNVERIFIED', '{\"v\":1}')",
    );
    await expectDenied(
      app.query(
        `INSERT INTO authority_events VALUES (1, 'e1', 'DELEGATION_CREATED', 'p', 1, now(), now(), now(), 'ASSERTED_UNVERIFIED', '{"v":2}')
         ON CONFLICT (sequence) DO UPDATE SET payload = EXCLUDED.payload`,
      ),
    );
    expect((await owner.query("SELECT payload FROM authority_events")).rows).toEqual([{ payload: { v: 1 } }]);
  });

  it("the application role can REDEEM a capability (SELECT and INSERT only), and afterwards still cannot rewrite the redemption row", async () => {
    const t = (hhmmss: string) => iso8601(`2025-01-01T${hhmmss}.000Z`);
    const seedStore = new PostgresEventStore(owner, { authorityTime: () => t("09:00:00") });
    await seedStore.append([
      toDraft(rootDelegation({ sequence: 1, id: "d-app-redeem", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT_A, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, amountThresholds: thresholds(money(2000, "EUR"), money(2000, "EUR")) })),
      toDraft(actionRequest({ sequence: 2, id: "act-app-redeem", requester: AGENT_A, delegationId: "d-app-redeem", parameters: monetaryParameters(money(500, "EUR")) })),
    ]);
    const issued = await new PostgresCapabilityIssuanceTransaction(owner).issue(
      { principalId: AGENT_A }, clientIdempotencyKey("k-app"), { action_id: actionId("act-app-redeem"), enforcement_point_id: enforcementPointId("ep-app") },
      { nextCapabilityId: () => capabilityId("cap-app"), expiresAt: (x) => iso8601(new Date(Date.parse(x) + 300_000).toISOString()) }, t("09:10:00"),
    );
    expect(issued).toMatchObject({ outcome: "EXECUTED", result: { ok: true } });

    // The application role redeems: it needs SELECT (fresh read) and INSERT (the event), nothing else.
    const result = await new PostgresCapabilityRedemptionTransaction(app).redeem(
      { principalId: AGENT_A },
      { capability_id: capabilityId("cap-app"), enforcement_point_id: enforcementPointId("ep-app"), observed_capability: PURCHASE_ORDER_CREATE, observed_parameters: monetaryParameters(money(500, "EUR")) },
      t("09:12:00"),
    );
    expect(result.ok).toBe(true);
    expect((await owner.query("SELECT count(*) AS c FROM authority_events WHERE event_type = 'CAPABILITY_REDEEMED'")).rows[0].c).toBe("1");
    await expectDenied(app.query("UPDATE authority_events SET payload = '{}' WHERE event_type = 'CAPABILITY_REDEEMED'"));
    await expectDenied(app.query("DELETE FROM authority_events WHERE event_type = 'CAPABILITY_REDEEMED'"));
    expect(await violations(LOGIN_ROLE)).toEqual([]);
  });

  it("TRUST BOUNDARY: the application role cannot rewrite history but CAN assert events; a coherent forged redemption it appends validates, so INSERT is the right to assert (documented residual)", async () => {
    const t = (hhmmss: string) => iso8601(`2025-01-01T${hhmmss}.000Z`);
    const seedStore = new PostgresEventStore(owner, { authorityTime: () => t("09:00:00") });
    await seedStore.append([
      toDraft(rootDelegation({ sequence: 1, id: "d-app-forge", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT_A, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, amountThresholds: thresholds(money(2000, "EUR"), money(2000, "EUR")) })),
      toDraft(actionRequest({ sequence: 2, id: "act-app-forge", requester: AGENT_A, delegationId: "d-app-forge", parameters: monetaryParameters(money(500, "EUR")) })),
    ]);
    const issued = await new PostgresCapabilityIssuanceTransaction(owner).issue(
      { principalId: AGENT_A }, clientIdempotencyKey("k-forge"), { action_id: actionId("act-app-forge"), enforcement_point_id: enforcementPointId("ep-forge") },
      { nextCapabilityId: () => capabilityId("cap-forge"), expiresAt: (x) => iso8601(new Date(Date.parse(x) + 300_000).toISOString()) }, t("09:10:00"),
    );
    if (issued.outcome !== "EXECUTED" || !issued.result.ok) throw new Error("fixture");
    const events = await new PostgresEventStore(owner, { authorityTime: () => t("09:12:00") }).getEvents();
    const ticket = issued.result.capability;
    // A writer holding INSERT (the application role) crafts a COHERENT redemption event for a ticket it does not own.
    const forged = buildCapabilityRedeemedDraft({ principalId: AGENT_A }, t("09:12:00"), { capability_id: ticket.capability_id, action_id: ticket.action_id, action_fingerprint: ticket.action_fingerprint, decision_sequence: sequenceNumber(events.length), enforcement_point_id: ticket.enforcement_point_id }, "forged-by-app");
    const out = await new PostgresEventStore(app, { authorityTime: () => t("09:12:00") }).append([forged]);
    expect(out.outcomes[0]?.accepted).toBe(true); // the append-only boundary does not stop it: INSERT is allowed
    const after = await new PostgresEventStore(owner, { authorityTime: () => t("09:12:00") }).getEvents();
    const row = after.find((e) => e.event_type === "CAPABILITY_REDEEMED");
    if (row === undefined || row.event_type !== "CAPABILITY_REDEEMED") throw new Error("forged row missing");
    expect(validateRedemptionEvent(after, row)).toEqual({ ok: true }); // validity is coherence, not provenance
    // The legitimate holder is then refused: the forger burned (in fact took) the ticket. It cannot rewrite it:
    const legit = await new PostgresCapabilityRedemptionTransaction(owner).redeem({ principalId: AGENT_A }, { capability_id: ticket.capability_id, enforcement_point_id: enforcementPointId("ep-forge"), observed_capability: PURCHASE_ORDER_CREATE, observed_parameters: monetaryParameters(money(500, "EUR")) }, t("09:13:00"));
    expect(legit).toEqual({ ok: false, reason: "ALREADY_REDEEMED" });
    await expectDenied(app.query("UPDATE authority_events SET payload = '{}' WHERE event_type = 'CAPABILITY_REDEEMED'"));
  });

  it("the application role cannot escalate: no SET ROLE to the owner, no column-level grant, no role changes", async () => {
    await expect(app.query("SET ROLE postgres")).rejects.toMatchObject({ code: "42501" });
    await expectDenied(app.query(`ALTER ROLE ${LOGIN_ROLE} SUPERUSER`));
    await expectDenied(app.query("CREATE ROLE p2a_x"));
    await app.query("GRANT UPDATE (payload) ON authority_events TO authority_app");
    expect(await violations(LOGIN_ROLE)).toEqual([]);
  });

  it("roles.sql is idempotent and revokes what an earlier installation granted, including to PUBLIC", async () => {
    await owner.query(`GRANT ALL ON authority_events, security_log, capability_issuance_idempotency TO authority_app, PUBLIC`);
    await owner.query(`GRANT UPDATE (payload) ON authority_events TO authority_app`);
    expect((await violations(LOGIN_ROLE)).length).toBeGreaterThan(0);

    await owner.query(ROLES_SQL);
    await owner.query(ROLES_SQL);
    expect(await violations(LOGIN_ROLE)).toEqual([]);
    await expectDenied(app.query("UPDATE authority_events SET payload = '{}'"));
  });

  it("roles.sql refuses, instead of pretending, when the REVOKE cannot be a boundary", async () => {
    await rolledBack(owner, async (c) => {
      await c.query("ALTER TABLE authority_events OWNER TO authority_app");
      await expect(c.query(ROLES_SQL)).rejects.toThrow(/owns, or inherits ownership of, table authority_events/);
    });
    await rolledBack(owner, async (c) => {
      await c.query("CREATE ROLE p2a_powerful NOLOGIN");
      await c.query("GRANT UPDATE, DELETE ON authority_events TO p2a_powerful");
      await c.query("GRANT p2a_powerful TO authority_app");
      await expect(c.query(ROLES_SQL)).rejects.toThrow(/must not be a member of any other role/);
    });
    await rolledBack(owner, async (c) => {
      await c.query("ALTER ROLE authority_app SUPERUSER");
      await c.query(ROLES_SQL).then(
        async () => {
          // roles.sql resets the attribute itself; the boundary must hold afterwards.
          expect((await c.query<{ rolsuper: boolean }>("SELECT rolsuper FROM pg_roles WHERE rolname = 'authority_app'")).rows[0]?.rolsuper).toBe(false);
        },
      );
    });
    // Nothing above persisted.
    expect(await violations(LOGIN_ROLE)).toEqual([]);
  });

  it("the check detects UPDATE/DELETE inherited through another group the login role also belongs to", async () => {
    await rolledBack(owner, async (c) => {
      await c.query("CREATE ROLE p2a_other_group NOLOGIN");
      await c.query("GRANT UPDATE, DELETE ON authority_events TO p2a_other_group");
      await c.query(`GRANT p2a_other_group TO ${LOGIN_ROLE}`);

      // The bypass is real: acting as the login role, the journal can be rewritten.
      await c.query("INSERT INTO authority_events VALUES (1, 'e1', 'DELEGATION_CREATED', 'p', 1, now(), now(), now(), 'ASSERTED_UNVERIFIED', '{\"v\":1}')");
      await c.query(`SET LOCAL ROLE ${LOGIN_ROLE}`);
      await c.query("UPDATE authority_events SET payload = '{\"v\":2}'");
      await c.query("RESET ROLE");
      expect((await c.query("SELECT payload FROM authority_events")).rows).toEqual([{ payload: { v: 2 } }]);

      // ... and the check, run for the login role, reports it. authority_app itself stays clean.
      const login = await c.query<{ violation: string }>(CHECK_SQL, [LOGIN_ROLE]);
      expect(login.rows.map((r) => r.violation).sort()).toEqual([
        "role holds DELETE on authority_events",
        "role holds UPDATE on authority_events",
        "role holds a column-level UPDATE on authority_events",
      ]);
      const group = await c.query<{ violation: string }>(CHECK_SQL, ["authority_app"]);
      expect(group.rows).toEqual([]);
    });
    expect(await violations(LOGIN_ROLE)).toEqual([]);
  });

  it("the check detects privileges reachable only through SET ROLE from a NOINHERIT login role", async () => {
    const setLogin = "p2a_set_login";
    const setGroup = "p2a_set_group";
    const noInheritApp = new Pool({ connectionString: loginUrl().replace(LOGIN_ROLE, setLogin), options: SEARCH_PATH_OPTIONS });
    try {
      await owner.query(`DROP ROLE IF EXISTS ${setLogin}`);
      await owner.query(`DROP ROLE IF EXISTS ${setGroup}`);
      await owner.query(`CREATE ROLE ${setLogin} LOGIN NOINHERIT PASSWORD '${LOGIN_PASSWORD}' IN ROLE authority_app`);
      await owner.query(`CREATE ROLE ${setGroup} NOLOGIN`);
      // In `public`, USAGE reaches every role through PUBLIC. In this file's own schema it must be granted;
      // NOINHERIT inherits nothing, so without this the denial would be "relation does not exist", not a privilege error.
      await owner.query(`GRANT USAGE ON SCHEMA ${iso.schema} TO ${setLogin}, ${setGroup}`);
      await owner.query(`GRANT UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON authority_events TO ${setGroup}`);
      await owner.query(`GRANT UPDATE (payload_hash), REFERENCES (payload_hash) ON security_log TO ${setGroup}`);
      await owner.query(`GRANT ${setGroup} TO ${setLogin}`);
      await owner.query(
        "INSERT INTO authority_events VALUES (1, 'e1', 'DELEGATION_CREATED', 'p', 1, now(), now(), now(), 'ASSERTED_UNVERIFIED', '{\"v\":1}')",
      );

      // NOINHERIT: nothing is inherited, so a plain UPDATE is refused ...
      await expectDenied(noInheritApp.query("UPDATE authority_events SET payload = '{\"v\":2}'"));

      // ... but SET ROLE to the other group, on one connection, rewrites the journal: the bypass is real.
      const client = await noInheritApp.connect();
      try {
        await client.query(`SET ROLE ${setGroup}`);
        await client.query("UPDATE authority_events SET payload = '{\"v\":2}'");
        await client.query("RESET ROLE");
      } finally {
        client.release();
      }
      expect((await owner.query("SELECT payload FROM authority_events")).rows).toEqual([{ payload: { v: 2 } }]);

      // The check reports every dangerous path, column-level ones included, and nothing for the healthy roles.
      expect((await violations(setLogin)).sort()).toEqual(
        [
          ...["UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"].map((p) => `role can SET ROLE to ${setGroup}, which holds ${p} on authority_events`),
          `role can SET ROLE to ${setGroup}, which holds a column-level UPDATE on authority_events`,
          `role can SET ROLE to ${setGroup}, which holds a column-level REFERENCES on authority_events`,
          `role can SET ROLE to ${setGroup}, which holds a column-level UPDATE on security_log`,
          `role can SET ROLE to ${setGroup}, which holds a column-level REFERENCES on security_log`,
          // A NOINHERIT login role also inherits nothing from authority_app, so the required
          // read/append rights are (rightly) reported as missing for it.
          ...["authority_events", "security_log", "capability_issuance_idempotency"].flatMap((t) => [`role lacks SELECT on ${t}`, `role lacks INSERT on ${t}`]),
          "role lacks USAGE on sequence security_log_id_seq",
        ].sort(),
      );
      expect(await violations(LOGIN_ROLE)).toEqual([]);
      expect(await violations("authority_app")).toEqual([]);
    } finally {
      try {
        await noInheritApp.end();
      } finally {
        try {
          await owner.query(`DROP OWNED BY ${setGroup}`);
          await owner.query(`DROP OWNED BY ${setLogin}`);
        } finally {
          await owner.query(`DROP ROLE IF EXISTS ${setLogin}`);
          await owner.query(`DROP ROLE IF EXISTS ${setGroup}`);
        }
      }
    }
  });

  it("the check flags a login role that was granted UPDATE directly, or owns the journal", async () => {
    await rolledBack(owner, async (c) => {
      await c.query("CREATE ROLE p2a_bad NOLOGIN IN ROLE authority_app");
      await c.query("GRANT DELETE ON security_log TO p2a_bad");
      const { rows } = await c.query<{ violation: string }>(CHECK_SQL, ["p2a_bad"]);
      expect(rows.map((r) => r.violation)).toEqual(["role holds DELETE on security_log"]);
      await c.query("ALTER TABLE security_log OWNER TO p2a_bad");
      const owned = await c.query<{ violation: string }>(CHECK_SQL, ["p2a_bad"]);
      expect(owned.rows.map((r) => r.violation)).toContain("role owns, or inherits ownership of, security_log");
    });
  });
});
