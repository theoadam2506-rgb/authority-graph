/**
 * PostgreSQL scaffold for the redemption tests: one isolated schema (issue #13),
 * a store, an issuance and a redemption transaction, one delegation + one
 * action to redeem. All times are explicit; nothing reads a clock.
 */
import { Pool } from "pg";
import { toDraft } from "../../src/domain/events.js";
import { actionId, capabilityId, clientIdempotencyKey, enforcementPointId, iso8601, thresholds, noExpiry, capability, type CapabilityId, type ExpiresAt, type Iso8601, type Money } from "../../src/domain/types.js";
import type { RedeemCapabilityCommand } from "../../src/domain/capabilityCommand.js";
import { PostgresCapabilityIssuanceTransaction } from "../../src/storage/postgresCapabilityIssuanceTransaction.js";
import { PostgresCapabilityRedemptionTransaction, type PostgresRedemptionOptions } from "../../src/storage/postgresCapabilityRedemptionTransaction.js";
import { PostgresEventStore } from "../../src/storage/postgresEventStore.js";
import { isolatedSchema, type IsolatedSchema } from "../storage/pgTestSchema.js";
import { EUR, PURCHASE_ORDER_CREATE, THEO, actionRequest, revokeDelegation, rootDelegation } from "../fixtures/scenarios.js";
import { AGENT, EP, PARAMS, T, auth } from "./harness.js";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/authority_graph_test";

export async function databaseAvailable(): Promise<boolean> {
  const probe = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 2000 });
  try {
    await probe.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await probe.end();
  }
}

export interface PgHarness {
  readonly iso: IsolatedSchema;
  readonly pool: Pool;
  readonly store: PostgresEventStore;
  readonly issuance: PostgresCapabilityIssuanceTransaction;
  readonly redemption: PostgresCapabilityRedemptionTransaction;
  /** A new pool over the same schema: another connection set, as another process would have. */
  newPool(): Pool;
  newRedemption(pool?: Pool, options?: PostgresRedemptionOptions): PostgresCapabilityRedemptionTransaction;
  issue(at: Iso8601, key?: string): Promise<CapabilityId>;
  command(id: CapabilityId, overrides?: Partial<RedeemCapabilityCommand>): RedeemCapabilityCommand;
  revoke(at: Iso8601): Promise<void>;
  append(drafts: Parameters<PostgresEventStore["append"]>[0], at: Iso8601): ReturnType<PostgresEventStore["append"]>;
  close(): Promise<void>;
}

export interface PgHarnessOptions {
  readonly delegationExpiry?: ExpiresAt;
  readonly totalBudget?: Money;
  readonly label?: string;
}

export async function pgHarness(options: PgHarnessOptions = {}): Promise<PgHarness> {
  const iso = isolatedSchema(TEST_DATABASE_URL, options.label ?? "redeem");
  await iso.create();
  const extraPools: Pool[] = [];
  const pool = iso.pool;
  // node-postgres requires a pool-level error listener for idle clients that lose their connection (the app's job).
  pool.on("error", () => undefined);
  let clockTime = T("09:00:00");
  const store = new PostgresEventStore(pool, { authorityTime: () => clockTime });
  const issuance = new PostgresCapabilityIssuanceTransaction(pool);
  const redemption = new PostgresCapabilityRedemptionTransaction(pool);
  const seed = await store.append([
    toDraft(rootDelegation({ sequence: 1, id: "d-redeem", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, expires: options.delegationExpiry ?? noExpiry, amountThresholds: thresholds(EUR(2000), EUR(2000)), ...(options.totalBudget !== undefined ? { totalBudget: options.totalBudget } : {}) })),
    toDraft(actionRequest({ sequence: 2, id: "act-redeem", requester: AGENT, delegationId: "d-redeem", parameters: PARAMS })),
  ]);
  if (!seed.outcomes.every((o) => o.accepted)) throw new Error("seed rejected");
  clockTime = T("09:05:00");

  let counter = 0;
  let ticketsIssued = 0;
  const newPool = (): Pool => {
    const p = new Pool({ connectionString: iso.connectionString, options: `-c search_path=${iso.schema}` });
    p.on("error", () => undefined);
    extraPools.push(p);
    return p;
  };
  return {
    iso, pool, store, issuance, redemption, newPool,
    newRedemption: (p = newPool(), o = {}) => new PostgresCapabilityRedemptionTransaction(p, o),
    async issue(at, key = `k-${++counter}`) {
      // I32: one ticket per action. The first ticket serves the seeded action; every further ticket
      // the tests ask for is a ticket for its own, freshly requested, identical action.
      const act = ticketsIssued++ === 0 ? "act-redeem" : `act-redeem-${ticketsIssued}`;
      if (act !== "act-redeem") {
        clockTime = at;
        const requested = await store.append([toDraft(actionRequest({ sequence: 1000 + ticketsIssued, id: act, requester: AGENT, delegationId: "d-redeem", parameters: PARAMS }))]);
        if (!requested.outcomes.every((o) => o.accepted)) throw new Error(`extra action rejected: ${JSON.stringify(requested)}`);
      }
      const out = await issuance.issue(auth(AGENT), clientIdempotencyKey(key), { action_id: actionId(act), enforcement_point_id: EP }, {
        nextCapabilityId: () => capabilityId(`cap-pg-${++counter}`),
        expiresAt: (t) => iso8601(new Date(Date.parse(t) + 5 * 60_000).toISOString()),
      }, at);
      if (out.outcome !== "EXECUTED" || !out.result.ok) throw new Error(`issuance failed: ${JSON.stringify(out)}`);
      return out.result.capability.capability_id;
    },
    command: (id, overrides = {}) => ({ capability_id: id, enforcement_point_id: EP, observed_capability: capability("purchase_order", "create"), observed_parameters: PARAMS, ...overrides }),
    async revoke(at) {
      clockTime = at;
      const r = await store.append([toDraft(revokeDelegation({ sequence: 99, targetId: "d-redeem", issuedBy: THEO }))]);
      if (!r.outcomes[0]?.accepted) throw new Error("revocation rejected");
    },
    async append(drafts, at) {
      clockTime = at;
      return store.append(drafts);
    },
    async close() {
      await Promise.allSettled(extraPools.map((p) => p.end()));
      await iso.drop();
    },
  };
}

export { enforcementPointId };

// ---------------------------------------------------------------------------
// Fault-injection helpers shared by the review tests.
// ---------------------------------------------------------------------------
import type { PoolClient, QueryResult } from "pg";

export interface Interceptor {
  /** Runs before a statement is sent. */
  before?: (sql: string, client: PoolClient) => Promise<void>;
  /** Runs after a statement succeeded on the server, before its result is returned to the caller. */
  after?: (sql: string, client: PoolClient) => Promise<void>;
  /** May replace a statement's result. */
  override?: (sql: string) => QueryResult | undefined;
}

/** A Pool whose connections run hooks around each statement: the only way to act BETWEEN two statements of one transaction. */
export function intercepted(real: Pool, hooks: Interceptor): Pool {
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
              const result = await (target.query as (...a: unknown[]) => Promise<QueryResult>)(...args);
              await hooks.after?.(sql, target);
              return result;
            };
          }
          const value = (target as unknown as Record<string | symbol, unknown>)[prop];
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
    },
  } as unknown as Pool;
}

export async function rawInsert(pool: Pool, row: { sequence: number; event_id: string; event_type: string; principal_id: string; payload: unknown; authority_time?: string }): Promise<void> {
  const at = row.authority_time ?? "2025-01-01T09:11:00Z";
  await pool.query(
    `INSERT INTO authority_events (sequence, event_id, event_type, principal_id, schema_version, occurred_at, authority_time, recorded_at, assurance_level, payload)
     VALUES ($1, $2, $3, $4, 1, $6, $6, now(), 'ASSERTED_UNVERIFIED', $5)`,
    [row.sequence, row.event_id, row.event_type, row.principal_id, JSON.stringify(row.payload), at],
  );
}
