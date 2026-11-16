/**
 * The journal hash and the attestations are the same whether the events come
 * from memory or from PostgreSQL: a journal written to PostgreSQL and read back
 * (JSONB key order, TIMESTAMPTZ, numbers) has the same head, and an attestation
 * built from it is byte-identical. Skipped without a database; mandatory in CI.
 */
import { describe, expect, it } from "vitest";
import { canonicalizeToolArguments } from "../../src/domain/canonicalJson.js";
import { attestIssuance, attestRedemption } from "../../src/proof/attestation.js";
import { journalHead } from "../../src/proof/journalHash.js";
import { verifyAttestation } from "../../src/proof/verify.js";
import { PostgresEventStore, insertEvent } from "../../src/storage/postgresEventStore.js";
import { EP, buildFixture, testKeys, testSigner } from "../proof/fixture.js";
import { databaseAvailable } from "../redemption/pgHarness.js";
import { isolatedSchema } from "./pgTestSchema.js";

const available = await databaseAvailable();
const URL = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/authority_graph_test";

describe.skipIf(!available)("journal hash and attestations over PostgreSQL", () => {
  it("a journal written to PostgreSQL and read back has the same events (as JCS), the same head and byte-identical attestations", async () => {
    const f = await buildFixture();
    const iso = isolatedSchema(URL, "journalhash");
    await iso.create();
    try {
      const client = await iso.pool.connect();
      try {
        for (const e of f.events) await insertEvent(client, e); // exact values, including recorded_at
      } finally {
        client.release();
      }
      const back = await new PostgresEventStore(iso.pool, { authorityTime: () => f.events[0]!.authority_time }).getEvents();
      expect(back).toHaveLength(f.events.length);
      for (const [i, e] of back.entries()) expect(canonicalizeToolArguments(e), `event ${i + 1}`).toBe(canonicalizeToolArguments(f.events[i]!));
      expect(journalHead(back)).toEqual(journalHead(f.events));

      const memory = JSON.stringify(await attestRedemption(f.events, f.capabilityId, testSigner()));
      const postgres = JSON.stringify(await attestRedemption(back, f.capabilityId, testSigner()));
      expect(postgres).toBe(memory);
      expect(JSON.stringify(await attestIssuance(back, f.capabilityId, testSigner()))).toBe(JSON.stringify(await attestIssuance(f.events, f.capabilityId, testSigner())));
      expect(verifyAttestation(postgres, { keys: testKeys(), expected: { enforcement_point_id: EP, journal_head_hash: journalHead(f.events).head_hash } }).result).toBe("CONSISTENT_L2");
    } finally {
      await iso.drop();
    }
  });
});
