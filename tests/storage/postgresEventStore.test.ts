/**
 * PR4B-3B — real Postgres tests for `PostgresEventStore`, added alongside
 * the `postgresEventStore.ts` refactor (inline lock/history-read code
 * factored into `lockAuthorityEventsTable`/`readFreshIngestionState`, now
 * shared with `PostgresCapabilityIssuanceTransaction`). No such test
 * existed before this round — this repository had never run this class
 * against a real database. These mirror `tests/storage/eventStore.test.ts`
 * (the InMemory contract tests) as closely as the two backends allow, to
 * prove the refactor changed nothing observable.
 *
 * Gated exactly like postgresCapabilityIssuanceTransaction.test.ts — see
 * that file's own docstring for the gating rationale.
 */
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { toDraft } from "../../src/domain/events.js";
import { sequenceNumber } from "../../src/domain/types.js";
import { PostgresEventStore } from "../../src/storage/postgresEventStore.js";
import { AGENT_A, AGENT_B, MALLORY, PURCHASE_ORDER_CREATE, THEO, actionRequest, rootDelegation, sequentialClock, subDelegation } from "../fixtures/scenarios.js";

const seq = sequenceNumber;

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
  console.warn(`[postgresEventStore.test.ts] TEST_DATABASE_URL (${TEST_DATABASE_URL}) is not reachable — skipping. Set TEST_DATABASE_URL to run these.`);
}

describe.skipIf(!databaseAvailable)("PostgresEventStore — real Postgres, sequence continuity and uniqueness (mirrors InMemoryEventStore's own contract tests)", () => {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });

  beforeAll(async () => {
    const schemaPath = fileURLToPath(new URL("../../src/storage/schema.sql", import.meta.url));
    await pool.query(readFileSync(schemaPath, "utf8"));
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE authority_events, security_log, capability_issuance_idempotency");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("numbers a second append() batch continuing from the first, never restarting at 1", async () => {
    const store = new PostgresEventStore(pool, sequentialClock);

    const first = await store.append([
      toDraft(rootDelegation({ sequence: 1, id: "d-root-cont-pg", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT_A, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: true })),
      toDraft(subDelegation({ sequence: 2, id: "d-sub-cont-pg", parentId: "d-root-cont-pg", grantor: AGENT_A, grantee: AGENT_B, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false })),
    ]);
    expect(first.outcomes).toEqual([
      { accepted: true, sequence: seq(1) },
      { accepted: true, sequence: seq(2) },
    ]);

    const second = await store.append([
      toDraft(actionRequest({ sequence: 3, id: "a-cont-pg-1", requester: AGENT_B, delegationId: "d-sub-cont-pg" })),
      toDraft(actionRequest({ sequence: 4, id: "a-cont-pg-2", requester: AGENT_B, delegationId: "d-sub-cont-pg" })),
    ]);
    expect(second.outcomes).toEqual([
      { accepted: true, sequence: seq(3) },
      { accepted: true, sequence: seq(4) },
    ]);

    const all = await store.getEvents();
    expect(all.map((e) => e.sequence)).toEqual([seq(1), seq(2), seq(3), seq(4)]);
  });

  it("rejects a business-id collision introduced in a later, separate append() call — unchanged after the lockAuthorityEventsTable/readFreshIngestionState extraction", async () => {
    const store = new PostgresEventStore(pool, sequentialClock);
    await store.append([
      toDraft(rootDelegation({ sequence: 1, id: "d-dup-across-batches-pg", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT_A, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false })),
    ]);

    const second = await store.append([
      toDraft(
        rootDelegation({
          sequence: 2,
          id: "d-dup-across-batches-pg",
          grantor: MALLORY,
          grantorType: "AGENT",
          grantee: AGENT_B,
          capabilities: [PURCHASE_ORDER_CREATE],
          canDelegate: false,
        }),
      ),
    ]);
    expect(second.outcomes).toEqual([{ accepted: false, reasonCode: "BUSINESS_ID_COLLISION" }]);

    const all = await store.getEvents();
    expect(all).toHaveLength(1);
  });

  /**
   * PR4B-4 — FIXED (originally reported as a PR4B-3B discovery, then a red
   * spec test in the PR4B-4 audit round; now green). `processDraft`'s I8
   * dedup (ingest.ts's `hashDraft`) now canonicalizes an object's keys
   * (recursively sorted) before `JSON.stringify`, before comparing against
   * the stored draft `rebuildIngestionState` reconstructs. For
   * `InMemoryEventStore` the reconstructed draft was always the exact same
   * JS object shape the original had, so this backend's own equivalent
   * test (tests/storage/eventStore.test.ts) was already green before this
   * fix. For `PostgresEventStore`, the reconstructed draft's payload comes
   * back from a JSONB column, and Postgres does NOT preserve the original
   * key order when it stores and re-emits JSONB (verified directly: a
   * payload inserted with `delegation_id` first comes back with
   * `expires_at` first) — sorting both sides' keys before comparing
   * closes exactly this gap, without touching array order, `null`-vs-
   * absent, or primitive types (see tests/engine/hashDraftCanonicalization.test.ts
   * for the dedicated regression locks proving those stay exactly as
   * strict as before). SPEC.md's own wording for I8 ("contenu strictement
   * identique") was always about content equivalence, never serialization-
   * byte equivalence — this fix makes the code match that definition.
   */
  it("[PR4B-4] a client retrying with its own original draft is treated as idempotent against what Postgres actually stored, never EVENT_ID_CONFLICT", async () => {
    const store = new PostgresEventStore(pool, sequentialClock);
    const draft = toDraft(
      rootDelegation({ sequence: 1, id: "d-idempotent-pg", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT_A, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false }),
    );

    const first = await store.append([draft]);
    expect(first.outcomes).toEqual([{ accepted: true, sequence: seq(1) }]);

    // NOTE on scenario precision (found while writing this test): resubmitting
    // a draft rebuilt from `store.getEvents()` does NOT reproduce this bug —
    // two independent JSONB reads of the SAME stored row come back with the
    // SAME (reordered, but internally consistent) key order every time, so
    // they hash equal to each other regardless of the original insertion
    // order. The real gap is between the STORED representation (already
    // reordered by JSONB) and a CLIENT'S OWN, freshly-built retry — e.g. an
    // HTTP client resubmitting the same logical request body it always
    // builds the same way, or exactly `draft` here, unchanged. That
    // resubmission is compared, at ingestion, against `readFreshIngestionState`'s
    // JSONB-derived reconstruction of the already-stored event — and it is
    // THAT comparison that currently mismatches.
    const second = await store.append([draft]);
    expect(second.outcomes).toEqual([{ accepted: true, sequence: seq(1) }]);

    const all = await store.getEvents();
    expect(all).toHaveLength(1);
  });
});
