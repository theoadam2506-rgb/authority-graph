/**
 * PR4B-3B — real Postgres integration tests for
 * `PostgresCapabilityIssuanceTransaction`. These exercise T1-T9 against an
 * ACTUAL Postgres instance (real connections, a real `pg_advisory_xact_lock`,
 * real `BEGIN`/`COMMIT`/`ROLLBACK`) — not a mock, and not a re-run of the
 * InMemory version's own promise-queue mutex under a different name.
 *
 * GATING: this whole file requires a reachable Postgres database. It never
 * assumes one exists — `databaseAvailable` is a real, awaited connection
 * probe, resolved once at module load (top-level `await`, supported by
 * vitest's ESM test files) before any `describe` block is registered. If
 * unreachable, every test in this file is skipped, not faked, and a
 * warning names exactly what to set. Point `TEST_DATABASE_URL` at an
 * isolated database — every test truncates the three tables this schema
 * defines between runs; never point this at a database holding data you
 * care about.
 *
 * WHAT THIS FILE CANNOT HONESTLY DEMONSTRATE: this test process is a
 * single Node runtime driving multiple `pg` connections against one
 * server — real concurrency at the connection/lock level, but not a true
 * multi-process crash (killing the OS process mid-transaction). Crash
 * points A/B/C (design report §12) are instead demonstrated the other
 * honest way available: a manually-managed second connection that performs
 * some of the same writes and is deliberately never committed, proving
 * Postgres itself — not this code — makes the partial state unobservable.
 */
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresEventStore } from "../../src/storage/postgresEventStore.js";
import { PostgresCapabilityIssuanceTransaction } from "../../src/storage/postgresCapabilityIssuanceTransaction.js";
import type { IssueCapabilityDependencies } from "../../src/engine/issueCapability.js";
import type { AuthenticatedPrincipal } from "../../src/domain/authenticatedPrincipal.js";
import { isEventType, toDraft } from "../../src/domain/events.js";
import { capabilityId, clientIdempotencyKey, enforcementPointId, expiresAt, iso8601, monetaryParameters, nonMonetaryParameters, thresholds, type PrincipalId } from "../../src/domain/types.js";
import type { IssueCapabilityCommand } from "../../src/domain/capabilityCommand.js";
import { principal } from "../fixtures/ids.js";
import { EUR, PURCHASE_ORDER_CREATE, THEO, actionRequest, rootDelegation, sequentialClock, subDelegation } from "../fixtures/scenarios.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/authority_graph_test";

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
  console.warn(
    `[postgresCapabilityIssuanceTransaction.test.ts] TEST_DATABASE_URL (${TEST_DATABASE_URL}) is not reachable — skipping all real-Postgres T1-T9 integration tests in this file. Set TEST_DATABASE_URL to an isolated Postgres database to run them.`,
  );
}

const AGENT = principal("pg-t-agent");
const AGENT_A = principal("pg-t-agent-a");
const AGENT_B = principal("pg-t-agent-b");
const EP = enforcementPointId("ep-pg-t");

/**
 * PR4B-5 — the explicit prospective authorityTime every transactional call
 * in this file now passes. None of T1-T9's delegations declare a finite
 * `expires_at` (they default to `noExpiry`), so its exact value is
 * inconsequential to those tests' outcomes — the dedicated expiration
 * scenario (T10 below) builds its own delegation with a finite expires_at.
 */
const AUTHORITY_TIME = iso8601("2025-01-01T00:20:00.000Z");

function authenticated(id: PrincipalId): AuthenticatedPrincipal {
  return { principalId: id };
}

function makeDependencies(startId = 1): IssueCapabilityDependencies {
  let counter = startId;
  return {
    nextCapabilityId: () => capabilityId(`pg-t-cap-${counter++}`),
    expiresAt: (snapshotAuthorityTime) => iso8601(new Date(Date.parse(snapshotAuthorityTime) + 5 * 60_000).toISOString()),
  };
}

function isExecutedOk(o: { readonly outcome: string; readonly result?: { readonly ok: boolean } }): boolean {
  return o.outcome === "EXECUTED" && o.result?.ok === true;
}

describe.skipIf(!databaseAvailable)("PostgresCapabilityIssuanceTransaction — real Postgres integration", () => {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });

  beforeAll(async () => {
    const schemaPath = fileURLToPath(new URL("../../src/storage/schema.sql", import.meta.url));
    const schemaSql = readFileSync(schemaPath, "utf8");
    await pool.query(schemaSql);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE authority_events, security_log, capability_issuance_idempotency");
  });

  afterAll(async () => {
    await pool.end();
  });

  async function seed(drafts: readonly ReturnType<typeof toDraft>[]): Promise<void> {
    const legacyStore = new PostgresEventStore(pool, sequentialClock);
    const result = await legacyStore.append(drafts);
    for (const outcome of result.outcomes) {
      if (!outcome.accepted) {
        throw new Error(`seed fixture rejected: ${outcome.reasonCode}`);
      }
    }
  }

  it("T1 — same requester + same idempotency key + same command, concurrent: exactly one EXECUTED and one REPLAYED with an identical result", async () => {
    const root = rootDelegation({ sequence: 1, id: "d-t1", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, amountThresholds: thresholds(100000, 100000) });
    const request = actionRequest({ sequence: 2, id: "act-t1", requester: AGENT, delegationId: "d-t1", parameters: monetaryParameters(EUR(100)) });
    if (!isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    await seed([toDraft(root), toDraft(request)]);

    const transaction = new PostgresCapabilityIssuanceTransaction(pool);
    const command: IssueCapabilityCommand = { action_id: request.payload.action_id, enforcement_point_id: EP };
    const key = clientIdempotencyKey("pg-t1-key");
    const deps = makeDependencies();

    const [resultA, resultB] = await Promise.all([
      transaction.issue(authenticated(AGENT), key, command, deps, AUTHORITY_TIME),
      transaction.issue(authenticated(AGENT), key, command, deps, AUTHORITY_TIME),
    ]);

    const outcomes = [resultA.outcome, resultB.outcome];
    expect(outcomes.filter((o) => o === "EXECUTED")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "REPLAYED")).toHaveLength(1);

    const executed = resultA.outcome === "EXECUTED" ? resultA : resultB;
    const replayed = resultA.outcome === "REPLAYED" ? resultA : resultB;
    if (executed.outcome !== "EXECUTED" || replayed.outcome !== "REPLAYED") {
      throw new Error("expected one EXECUTED and one REPLAYED");
    }
    expect(replayed.result).toEqual(executed.result);

    const { rows } = await pool.query("SELECT count(*) FROM authority_events WHERE event_type = 'CAPABILITY_ISSUED'");
    expect(Number(rows[0].count)).toBe(1);
  });

  it("T2 — same requester + same idempotency key + different commands, concurrent: one canonical + one IDEMPOTENCY_CONFLICT", async () => {
    const root = rootDelegation({ sequence: 1, id: "d-t2", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, amountThresholds: thresholds(100000, 100000) });
    const request1 = actionRequest({ sequence: 2, id: "act-t2-1", requester: AGENT, delegationId: "d-t2", parameters: monetaryParameters(EUR(100)) });
    const request2 = actionRequest({ sequence: 3, id: "act-t2-2", requester: AGENT, delegationId: "d-t2", parameters: monetaryParameters(EUR(100)) });
    if (!isEventType(request1, "ACTION_REQUESTED") || !isEventType(request2, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    await seed([toDraft(root), toDraft(request1), toDraft(request2)]);

    const transaction = new PostgresCapabilityIssuanceTransaction(pool);
    const key = clientIdempotencyKey("pg-t2-key");
    const deps = makeDependencies();

    const [resultA, resultB] = await Promise.all([
      transaction.issue(authenticated(AGENT), key, { action_id: request1.payload.action_id, enforcement_point_id: EP }, deps, AUTHORITY_TIME),
      transaction.issue(authenticated(AGENT), key, { action_id: request2.payload.action_id, enforcement_point_id: EP }, deps, AUTHORITY_TIME),
    ]);

    const outcomes = [resultA.outcome, resultB.outcome];
    expect(outcomes.filter((o) => o === "EXECUTED")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "IDEMPOTENCY_CONFLICT")).toHaveLength(1);

    const { rows } = await pool.query("SELECT count(*) FROM authority_events WHERE event_type = 'CAPABILITY_ISSUED'");
    expect(Number(rows[0].count)).toBe(1);
  });

  it("T3 — different idempotency keys, shared capacity: remainingCapacity(D)=300, two concurrent 200 EUR reservations, exactly one succeeds", async () => {
    const root = rootDelegation({ sequence: 1, id: "d-t3", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, totalBudget: EUR(300), amountThresholds: thresholds(100000, 100000) });
    const requestA = actionRequest({ sequence: 2, id: "act-t3-a", requester: AGENT, delegationId: "d-t3", parameters: monetaryParameters(EUR(200)) });
    const requestB = actionRequest({ sequence: 3, id: "act-t3-b", requester: AGENT, delegationId: "d-t3", parameters: monetaryParameters(EUR(200)) });
    if (!isEventType(requestA, "ACTION_REQUESTED") || !isEventType(requestB, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    await seed([toDraft(root), toDraft(requestA), toDraft(requestB)]);

    const transaction = new PostgresCapabilityIssuanceTransaction(pool);
    const deps = makeDependencies();

    const [resultA, resultB] = await Promise.all([
      transaction.issue(authenticated(AGENT), clientIdempotencyKey("pg-t3-key-a"), { action_id: requestA.payload.action_id, enforcement_point_id: EP }, deps, AUTHORITY_TIME),
      transaction.issue(authenticated(AGENT), clientIdempotencyKey("pg-t3-key-b"), { action_id: requestB.payload.action_id, enforcement_point_id: EP }, deps, AUTHORITY_TIME),
    ]);

    expect([resultA, resultB].filter(isExecutedOk)).toHaveLength(1);
  });

  it("T4 — two terminal delegations sharing one bounded ancestor: the shared ancestor's capacity is never over-reserved", async () => {
    const d1 = rootDelegation({ sequence: 1, id: "d1-t4", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT_A, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: true, totalBudget: EUR(300), amountThresholds: thresholds(100000, 100000) });
    const d2a = subDelegation({ sequence: 2, id: "d2a-t4", parentId: "d1-t4", grantor: AGENT_A, grantee: AGENT_A, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, totalBudget: EUR(300), amountThresholds: thresholds(100000, 100000) });
    const d2b = subDelegation({ sequence: 3, id: "d2b-t4", parentId: "d1-t4", grantor: AGENT_A, grantee: AGENT_B, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, totalBudget: EUR(300), amountThresholds: thresholds(100000, 100000) });
    const requestA = actionRequest({ sequence: 4, id: "act-t4-a", requester: AGENT_A, delegationId: "d2a-t4", parameters: monetaryParameters(EUR(200)) });
    const requestB = actionRequest({ sequence: 5, id: "act-t4-b", requester: AGENT_B, delegationId: "d2b-t4", parameters: monetaryParameters(EUR(200)) });
    if (!isEventType(requestA, "ACTION_REQUESTED") || !isEventType(requestB, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    await seed([toDraft(d1), toDraft(d2a), toDraft(d2b), toDraft(requestA), toDraft(requestB)]);

    const transaction = new PostgresCapabilityIssuanceTransaction(pool);
    const deps = makeDependencies();

    const [resultA, resultB] = await Promise.all([
      transaction.issue(authenticated(AGENT_A), clientIdempotencyKey("pg-t4-key-a"), { action_id: requestA.payload.action_id, enforcement_point_id: EP }, deps, AUTHORITY_TIME),
      transaction.issue(authenticated(AGENT_B), clientIdempotencyKey("pg-t4-key-b"), { action_id: requestB.payload.action_id, enforcement_point_id: EP }, deps, AUTHORITY_TIME),
    ]);

    expect([resultA, resultB].filter(isExecutedOk)).toHaveLength(1);
  });

  it("T5 — N-way concurrency: capacity=300, five concurrent 100 EUR requests, exactly 3 succeed", async () => {
    const root = rootDelegation({ sequence: 1, id: "d-t5", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, totalBudget: EUR(300), amountThresholds: thresholds(100000, 100000) });
    const requests = [1, 2, 3, 4, 5].map((n) => actionRequest({ sequence: 1 + n, id: `act-t5-${n}`, requester: AGENT, delegationId: "d-t5", parameters: monetaryParameters(EUR(100)) }));
    for (const request of requests) {
      if (!isEventType(request, "ACTION_REQUESTED")) {
        throw new Error("fixture returned an unexpected event_type");
      }
    }
    await seed([toDraft(root), ...requests.map((r) => toDraft(r))]);

    const transaction = new PostgresCapabilityIssuanceTransaction(pool);
    const deps = makeDependencies();

    const results = await Promise.all(
      requests.map((request, index) => {
        if (!isEventType(request, "ACTION_REQUESTED")) {
          throw new Error("fixture returned an unexpected event_type");
        }
        return transaction.issue(authenticated(AGENT), clientIdempotencyKey(`pg-t5-key-${index}`), { action_id: request.payload.action_id, enforcement_point_id: EP }, deps, AUTHORITY_TIME);
      }),
    );

    expect(results.filter(isExecutedOk)).toHaveLength(3);
  });

  it("T6 — retry after a committed response is lost: REPLAYs the exact same result, never a second emission", async () => {
    const root = rootDelegation({ sequence: 1, id: "d-t6", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, amountThresholds: thresholds(100000, 100000) });
    const request = actionRequest({ sequence: 2, id: "act-t6", requester: AGENT, delegationId: "d-t6", parameters: monetaryParameters(EUR(100)) });
    if (!isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    await seed([toDraft(root), toDraft(request)]);

    const transaction = new PostgresCapabilityIssuanceTransaction(pool);
    const command: IssueCapabilityCommand = { action_id: request.payload.action_id, enforcement_point_id: EP };
    const key = clientIdempotencyKey("pg-t6-key");
    const deps = makeDependencies();

    const first = await transaction.issue(authenticated(AGENT), key, command, deps, AUTHORITY_TIME);
    if (!isExecutedOk(first) || first.outcome !== "EXECUTED" || !first.result.ok) {
      throw new Error("expected the first attempt to execute and succeed");
    }

    // A brand-new transaction object (a fresh pool client under the hood)
    // simulates the caller retrying without any in-process state of its
    // own to rely on — durability here comes only from the database.
    const retryTransaction = new PostgresCapabilityIssuanceTransaction(pool);
    const retry = await retryTransaction.issue(authenticated(AGENT), key, command, deps, AUTHORITY_TIME);
    expect(retry.outcome).toBe("REPLAYED");
    if (retry.outcome !== "REPLAYED" || !retry.result.ok) {
      throw new Error("expected a successful REPLAYED result");
    }
    expect(retry.result.capability.capability_id).toBe(first.result.capability.capability_id);
    expect(retry.result.capability.decision_sequence).toBe(first.result.capability.decision_sequence);

    const { rows } = await pool.query("SELECT count(*) FROM authority_events WHERE event_type = 'CAPABILITY_ISSUED'");
    expect(Number(rows[0].count)).toBe(1);
  });

  it("T7 — atomicity of the event write and the idempotency record: never one without the other, checked directly against the database", async () => {
    const root = rootDelegation({ sequence: 1, id: "d-t7", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, amountThresholds: thresholds(100000, 100000) });
    const request = actionRequest({ sequence: 2, id: "act-t7", requester: AGENT, delegationId: "d-t7", parameters: monetaryParameters(EUR(100)) });
    if (!isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    await seed([toDraft(root), toDraft(request)]);

    const transaction = new PostgresCapabilityIssuanceTransaction(pool);
    const result = await transaction.issue(authenticated(AGENT), clientIdempotencyKey("pg-t7-key"), { action_id: request.payload.action_id, enforcement_point_id: EP }, makeDependencies(), AUTHORITY_TIME);
    if (!isExecutedOk(result) || result.outcome !== "EXECUTED" || !result.result.ok) {
      throw new Error("expected this emission to succeed");
    }

    const idempotencyRows = await pool.query("SELECT capability_id, event_id FROM capability_issuance_idempotency");
    const eventRows = await pool.query("SELECT payload ->> 'capability_id' AS capability_id, event_id FROM authority_events WHERE event_type = 'CAPABILITY_ISSUED'");
    expect(idempotencyRows.rows).toHaveLength(1);
    expect(eventRows.rows).toHaveLength(1);
    expect(idempotencyRows.rows[0].capability_id).toBe(eventRows.rows[0].capability_id);
    expect(idempotencyRows.rows[0].event_id).toBe(eventRows.rows[0].event_id);
  });

  it("T8 — forced capability_id collision: exactly one canonical event, fail-closed rejection for the other, retry REPLAYs the same refusal", async () => {
    const root = rootDelegation({ sequence: 1, id: "d-t8", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, amountThresholds: thresholds(100000, 100000) });
    const requestA = actionRequest({ sequence: 2, id: "act-t8-a", requester: AGENT, delegationId: "d-t8", parameters: monetaryParameters(EUR(50)) });
    const requestB = actionRequest({ sequence: 3, id: "act-t8-b", requester: AGENT, delegationId: "d-t8", parameters: monetaryParameters(EUR(50)) });
    if (!isEventType(requestA, "ACTION_REQUESTED") || !isEventType(requestB, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    await seed([toDraft(root), toDraft(requestA), toDraft(requestB)]);

    const transaction = new PostgresCapabilityIssuanceTransaction(pool);
    const collidingId = capabilityId("pg-t8-forced-collision");
    const deps: IssueCapabilityDependencies = {
      nextCapabilityId: () => collidingId,
      expiresAt: (snapshotAuthorityTime) => iso8601(new Date(Date.parse(snapshotAuthorityTime) + 5 * 60_000).toISOString()),
    };

    const first = await transaction.issue(authenticated(AGENT), clientIdempotencyKey("pg-t8-key-a"), { action_id: requestA.payload.action_id, enforcement_point_id: EP }, deps, AUTHORITY_TIME);
    if (!isExecutedOk(first) || first.outcome !== "EXECUTED" || !first.result.ok) {
      throw new Error("expected the first emission to succeed");
    }

    const secondKey = clientIdempotencyKey("pg-t8-key-b");
    const secondCommand: IssueCapabilityCommand = { action_id: requestB.payload.action_id, enforcement_point_id: EP };
    const second = await transaction.issue(authenticated(AGENT), secondKey, secondCommand, deps, AUTHORITY_TIME);
    expect(second.outcome).toBe("EXECUTED");
    if (second.outcome !== "EXECUTED") {
      throw new Error("expected EXECUTED (a rejection, different scope from the first)");
    }
    expect(second.result).toEqual({ ok: false, reason: "CAPABILITY_ID_COLLISION", capability_id: collidingId });

    const retry = await transaction.issue(authenticated(AGENT), secondKey, secondCommand, deps, AUTHORITY_TIME);
    expect(retry.outcome).toBe("REPLAYED");
    if (retry.outcome !== "REPLAYED") {
      throw new Error("expected REPLAYED");
    }
    expect(retry.result).toEqual({ ok: false, reason: "CAPABILITY_ID_COLLISION", capability_id: collidingId });

    const { rows } = await pool.query("SELECT count(*) FROM authority_events WHERE event_type = 'CAPABILITY_ISSUED' AND payload ->> 'capability_id' = $1", [collidingId]);
    expect(Number(rows[0].count)).toBe(1);
  });

  it("T9 — snapshot/sequence adjacency: event.sequence === decision_sequence + 1", async () => {
    const root = rootDelegation({ sequence: 1, id: "d-t9", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, amountThresholds: thresholds(100000, 100000) });
    const request = actionRequest({ sequence: 2, id: "act-t9", requester: AGENT, delegationId: "d-t9", parameters: monetaryParameters(EUR(100)) });
    if (!isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    await seed([toDraft(root), toDraft(request)]);

    const transaction = new PostgresCapabilityIssuanceTransaction(pool);
    const result = await transaction.issue(authenticated(AGENT), clientIdempotencyKey("pg-t9-key"), { action_id: request.payload.action_id, enforcement_point_id: EP }, makeDependencies(), AUTHORITY_TIME);
    if (!isExecutedOk(result) || result.outcome !== "EXECUTED" || !result.result.ok) {
      throw new Error("expected ok:true");
    }

    const { rows } = await pool.query("SELECT sequence FROM authority_events WHERE event_type = 'CAPABILITY_ISSUED'");
    expect(Number(rows[0].sequence)).toBe(Number(result.result.capability.decision_sequence) + 1);
  });

  it("T10 — PR4B-5: rejects issuance past expires_at even with zero events between the log's last authority_time and the explicit evaluation instant; retry REPLAYs the same refusal; no partial mutation", async () => {
    const T1 = iso8601("2030-01-01T10:00:00.000Z");
    const T2 = "2030-01-01T11:00:00.000Z"; // expires_at
    const T3 = iso8601("2030-01-01T12:00:00.000Z"); // T1 < T2 < T3, first attempt
    const T4 = iso8601("2030-01-01T13:00:00.000Z"); // T3 < T4, retry

    const root = rootDelegation({
      sequence: 1,
      id: "d-t10",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(100000, 100000),
      expires: expiresAt(iso8601(T2)),
    });
    const request = actionRequest({ sequence: 2, id: "act-t10", requester: AGENT, delegationId: "d-t10", parameters: nonMonetaryParameters() });
    if (!isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    // Seed with a store whose clock always returns T1 — the journal's last
    // authority_time is pinned to T1, and no event carrying a later
    // authority_time is ever ingested. No new event is added between T1
    // and T3.
    const seededAtStore = new PostgresEventStore(pool, { authorityTime: () => T1 });
    const seedResult = await seededAtStore.append([toDraft(root), toDraft(request)]);
    for (const outcome of seedResult.outcomes) {
      if (!outcome.accepted) {
        throw new Error(`seed fixture rejected: ${outcome.reasonCode}`);
      }
    }

    const preRows = await pool.query("SELECT authority_time FROM authority_events ORDER BY sequence");
    expect(preRows.rows).toHaveLength(2);
    for (const row of preRows.rows) {
      expect(new Date(row.authority_time).toISOString()).toBe(T1);
    }

    const transaction = new PostgresCapabilityIssuanceTransaction(pool);
    const command: IssueCapabilityCommand = { action_id: request.payload.action_id, enforcement_point_id: EP };
    const key = clientIdempotencyKey("pg-t10-key");
    const deps = makeDependencies();

    const first = await transaction.issue(authenticated(AGENT), key, command, deps, T3);
    expect(first.outcome).toBe("EXECUTED");
    if (first.outcome !== "EXECUTED") {
      throw new Error("expected EXECUTED");
    }
    expect(first.result.ok).toBe(false);
    if (first.result.ok) {
      throw new Error("expected ok:false — the delegation must be treated as expired at T3");
    }
    expect(first.result.reason).toBe("NOT_AUTHORIZED");

    const afterFirst = await pool.query("SELECT count(*) FROM authority_events WHERE event_type = 'CAPABILITY_ISSUED'");
    expect(Number(afterFirst.rows[0].count)).toBe(0);
    const idempotencyAfterFirst = await pool.query("SELECT result FROM capability_issuance_idempotency WHERE client_idempotency_key = $1", [key]);
    expect(idempotencyAfterFirst.rows).toHaveLength(1);
    expect(idempotencyAfterFirst.rows[0].result).toEqual(first.result);

    // Retry, same scope, later real instant T4 — REPLAYED, never
    // re-evaluated at T4, no new event, no second idempotency row.
    const retryTransaction = new PostgresCapabilityIssuanceTransaction(pool);
    const retry = await retryTransaction.issue(authenticated(AGENT), key, command, deps, T4);
    expect(retry.outcome).toBe("REPLAYED");
    if (retry.outcome !== "REPLAYED") {
      throw new Error("expected REPLAYED");
    }
    expect(retry.result).toEqual(first.result);

    const finalEventCount = await pool.query("SELECT count(*) FROM authority_events WHERE event_type = 'CAPABILITY_ISSUED'");
    expect(Number(finalEventCount.rows[0].count)).toBe(0);
    const finalIdempotencyCount = await pool.query("SELECT count(*) FROM capability_issuance_idempotency WHERE client_idempotency_key = $1", [key]);
    expect(Number(finalIdempotencyCount.rows[0].count)).toBe(1);
  });

  it("T10b — the same scenario, evaluated strictly before expires_at, is accepted; authority_time/decision_sequence on the produced row are exact", async () => {
    const T1 = iso8601("2030-01-01T10:00:00.000Z");
    const T2 = "2030-01-01T11:00:00.000Z"; // expires_at
    const T3_BEFORE = iso8601("2030-01-01T10:30:00.000Z"); // T1 < T3_BEFORE < T2

    const root = rootDelegation({
      sequence: 1,
      id: "d-t10b",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(100000, 100000),
      expires: expiresAt(iso8601(T2)),
    });
    const request = actionRequest({ sequence: 2, id: "act-t10b", requester: AGENT, delegationId: "d-t10b", parameters: nonMonetaryParameters() });
    if (!isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const seededAtStore = new PostgresEventStore(pool, { authorityTime: () => T1 });
    const seedResult = await seededAtStore.append([toDraft(root), toDraft(request)]);
    for (const outcome of seedResult.outcomes) {
      if (!outcome.accepted) {
        throw new Error(`seed fixture rejected: ${outcome.reasonCode}`);
      }
    }

    const transaction = new PostgresCapabilityIssuanceTransaction(pool);
    const result = await transaction.issue(authenticated(AGENT), clientIdempotencyKey("pg-t10b-key"), { action_id: request.payload.action_id, enforcement_point_id: EP }, makeDependencies(), T3_BEFORE);
    if (!isExecutedOk(result) || result.outcome !== "EXECUTED" || !result.result.ok) {
      throw new Error("expected the issuance to succeed before expiration");
    }
    expect(result.result.capability.decision_sequence).toBe(2);

    const { rows } = await pool.query("SELECT authority_time, payload ->> 'decision_sequence' AS decision_sequence FROM authority_events WHERE event_type = 'CAPABILITY_ISSUED'");
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].authority_time).toISOString()).toBe(T3_BEFORE);
    expect(Number(rows[0].decision_sequence)).toBe(2);
  });

  it("T11 — PR4B-5A: authorityTime older than the canonical maximum ALREADY IN THE DATABASE must be refused with STALE_AUTHORITY_TIME, never silently accepted, never a partial mutation", async () => {
    const T1 = iso8601("2030-01-01T10:00:00.000Z");
    const T3 = iso8601("2030-01-01T11:00:00.000Z"); // T1 < T3 < T4
    const T4 = iso8601("2030-01-01T12:00:00.000Z"); // already canonical, in the DB, before this issue() call

    const root = rootDelegation({
      sequence: 1,
      id: "d-t11",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(100000, 100000),
      // no expires_at — the agent's own authority remains perfectly valid
      // at T3; only the evaluation instant itself is incoherent with what
      // the database already canonically knows.
    });
    const request = actionRequest({ sequence: 2, id: "act-t11", requester: AGENT, delegationId: "d-t11", parameters: nonMonetaryParameters() });
    if (!isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }

    // The delegation is seeded at T1; the ACTION_REQUESTED is itself the
    // LATER, already-canonical, genuinely ACCEPTED event — seeded at T4.
    // This does not invalidate the delegation (no expires_at) and consumes
    // no capacity (no totalBudget declared) — it is ordinary history a
    // real deployment would have.
    const rootStore = new PostgresEventStore(pool, { authorityTime: () => T1 });
    const rootSeed = await rootStore.append([toDraft(root)]);
    for (const outcome of rootSeed.outcomes) {
      if (!outcome.accepted) {
        throw new Error(`seed fixture rejected: ${outcome.reasonCode}`);
      }
    }
    const requestStore = new PostgresEventStore(pool, { authorityTime: () => T4 });
    const requestSeed = await requestStore.append([toDraft(request)]);
    for (const outcome of requestSeed.outcomes) {
      if (!outcome.accepted) {
        throw new Error(`seed fixture rejected: ${outcome.reasonCode}`);
      }
    }

    const preRows = await pool.query("SELECT authority_time FROM authority_events ORDER BY sequence");
    expect(preRows.rows).toHaveLength(2);
    expect(new Date(preRows.rows[0].authority_time).toISOString()).toBe(T1);
    expect(new Date(preRows.rows[1].authority_time).toISOString()).toBe(T4);

    const transaction = new PostgresCapabilityIssuanceTransaction(pool);
    const command: IssueCapabilityCommand = { action_id: request.payload.action_id, enforcement_point_id: EP };
    const key = clientIdempotencyKey("pg-t11-key");

    const result = await transaction.issue(authenticated(AGENT), key, command, makeDependencies(), T3);

    // SECURE, EXPECTED behavior once fixed: EXECUTED carrying an explicit
    // temporal-consistency refusal, never NOT_AUTHORIZED (the agent's
    // authority is not the problem), never a row silently written with
    // authority_time = T3 (which the current, unfixed code does — Postgres
    // never clamps at all, see the PR4B-5A audit). This is the SECURE
    // expectation; it is expected to fail until PR4B-5A's fix lands.
    expect(result.outcome).toBe("EXECUTED");
    if (result.outcome !== "EXECUTED") {
      throw new Error("expected EXECUTED");
    }
    expect(result.result.ok).toBe(false);
    expect(result.result).toEqual({ ok: false, reason: "STALE_AUTHORITY_TIME" });

    const eventRows = await pool.query("SELECT count(*) FROM authority_events WHERE event_type = 'CAPABILITY_ISSUED'");
    expect(Number(eventRows.rows[0].count)).toBe(0);
    const idempotencyRows = await pool.query("SELECT result FROM capability_issuance_idempotency WHERE client_idempotency_key = $1", [key]);
    expect(idempotencyRows.rows).toHaveLength(1);
    expect(idempotencyRows.rows[0].result).toEqual(result.result);
    // No partial mutation: still exactly the two seeded rows, unchanged.
    const allRows = await pool.query("SELECT count(*) FROM authority_events");
    expect(Number(allRows.rows[0].count)).toBe(2);
  });

  it("T12 — PR4B-5A: idempotence of a STALE_AUTHORITY_TIME refusal against real Postgres — retry REPLAYs, a new key gets a fresh decision", async () => {
    const T1 = iso8601("2030-01-01T10:00:00.000Z");
    const T3 = iso8601("2030-01-01T11:00:00.000Z"); // stale first attempt
    const T4 = iso8601("2030-01-01T12:00:00.000Z"); // already canonical
    const T5 = iso8601("2030-01-01T13:00:00.000Z"); // T5 > T4 — individually coherent

    const root = rootDelegation({ sequence: 1, id: "d-t12pg", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, amountThresholds: thresholds(100000, 100000) });
    const request = actionRequest({ sequence: 2, id: "act-t12pg", requester: AGENT, delegationId: "d-t12pg", parameters: nonMonetaryParameters() });
    if (!isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }

    const rootStore = new PostgresEventStore(pool, { authorityTime: () => T1 });
    await rootStore.append([toDraft(root)]);
    const requestStore = new PostgresEventStore(pool, { authorityTime: () => T4 });
    await requestStore.append([toDraft(request)]);

    const transaction = new PostgresCapabilityIssuanceTransaction(pool);
    const command: IssueCapabilityCommand = { action_id: request.payload.action_id, enforcement_point_id: EP };
    const key = clientIdempotencyKey("pg-t12-key");
    const deps = makeDependencies();

    const first = await transaction.issue(authenticated(AGENT), key, command, deps, T3);
    if (first.outcome !== "EXECUTED") {
      throw new Error("expected EXECUTED (a stale refusal)");
    }
    expect(first.result).toEqual({ ok: false, reason: "STALE_AUTHORITY_TIME" });

    // Retry: same key, same command, individually-coherent T5 (> T4).
    // Must REPLAY the exact original refusal — never re-evaluate.
    const retryTransaction = new PostgresCapabilityIssuanceTransaction(pool);
    const retry = await retryTransaction.issue(authenticated(AGENT), key, command, deps, T5);
    expect(retry.outcome).toBe("REPLAYED");
    if (retry.outcome !== "REPLAYED") {
      throw new Error("expected REPLAYED");
    }
    expect(retry.result).toEqual(first.result);

    const afterRetryEvents = await pool.query("SELECT count(*) FROM authority_events WHERE event_type = 'CAPABILITY_ISSUED'");
    expect(Number(afterRetryEvents.rows[0].count)).toBe(0);
    const afterRetryIdempotency = await pool.query("SELECT count(*) FROM capability_issuance_idempotency WHERE client_idempotency_key = $1", [key]);
    expect(Number(afterRetryIdempotency.rows[0].count)).toBe(1);

    // A NEW clientIdempotencyKey at that same coherent T5 gets a genuine,
    // fresh decision.
    const key2 = clientIdempotencyKey("pg-t12-key-2");
    const secondTransaction = new PostgresCapabilityIssuanceTransaction(pool);
    const second = await secondTransaction.issue(authenticated(AGENT), key2, command, deps, T5);
    expect(second.outcome).toBe("EXECUTED");
    if (second.outcome !== "EXECUTED") {
      throw new Error("expected EXECUTED");
    }
    expect(second.result.ok).toBe(true);

    const finalEvents = await pool.query("SELECT count(*) FROM authority_events WHERE event_type = 'CAPABILITY_ISSUED'");
    expect(Number(finalEvents.rows[0].count)).toBe(1);
  });

  it("crash consistency — an uncommitted concurrent write is never observable: a second connection's INSERT, left uncommitted, does not appear once its client disconnects", async () => {
    const root = rootDelegation({ sequence: 1, id: "d-crash", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, amountThresholds: thresholds(100000, 100000) });
    await seed([toDraft(root)]);

    const strandedClient = await pool.connect();
    try {
      await strandedClient.query("BEGIN");
      await strandedClient.query(
        `INSERT INTO capability_issuance_idempotency (authenticated_requester_id, operation, client_idempotency_key, command, result, created_at)
         VALUES ($1, 'ISSUE_CAPABILITY', 'crash-key', '{}', '{}', now())`,
        [AGENT],
      );
      // Deliberately never COMMIT — simulating a crash between an INSERT
      // and the transaction that would have made it durable.
    } finally {
      // Releasing (here, actually destroying) the client without a COMMIT
      // is exactly what a crashed process does from Postgres's point of
      // view: the server rolls the open transaction back.
      strandedClient.release(true);
    }

    const { rows } = await pool.query("SELECT count(*) FROM capability_issuance_idempotency WHERE client_idempotency_key = 'crash-key'");
    expect(Number(rows[0].count)).toBe(0);
  });
});
