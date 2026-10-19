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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { toDraft } from "../../src/domain/events.js";
import { PostgresEventStore } from "../../src/storage/postgresEventStore.js";
import { AGENT_A, AGENT_B, MALLORY, PURCHASE_ORDER_CREATE, THEO, rootDelegation, sequentialClock } from "../fixtures/scenarios.js";

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
const SCHEMA_SQL = read("schema.sql");
const ROLES_SQL = read("roles.sql");
const CHECK_SQL = read("append_only_check.sql");

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
  const owner = new Pool({ connectionString: TEST_DATABASE_URL });
  const app = new Pool({ connectionString: loginUrl() });
  const violations = async (role: string): Promise<string[]> => (await owner.query<{ violation: string }>(CHECK_SQL, [role])).rows.map((r) => r.violation);
  const expectDenied = (promise: Promise<unknown>): Promise<void> => expect(promise).rejects.toMatchObject({ code: "42501" });

  // Roles are cluster-global: remember whether this run created authority_app,
  // so teardown removes exactly what the test added and nothing a deployment owns.
  let createdAuthorityApp = false;

  beforeAll(async () => {
    createdAuthorityApp = (await owner.query("SELECT 1 FROM pg_roles WHERE rolname = 'authority_app'")).rowCount === 0;
    await owner.query(SCHEMA_SQL);
    await owner.query(ROLES_SQL);
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
        await owner.end();
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
