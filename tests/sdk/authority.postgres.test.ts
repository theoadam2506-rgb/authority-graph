/**
 * The SDK on a real PostgreSQL: the same guarantees as the in-memory tests,
 * through `postgresBackend`. Each test gets its own schema (issue #13). Skipped,
 * and reported as skipped, when no database is reachable; mandatory in CI
 * through the report guard (scripts/check-postgres-report.mjs).
 */
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { toDraft } from "../../src/domain/events.js";
import { thresholds } from "../../src/domain/types.js";
import { createAuthority, postgresBackend, type Authority } from "../../src/sdk/index.js";
import { PostgresEventStore } from "../../src/storage/postgresEventStore.js";
import { PostgresCapabilityIssuanceTransaction } from "../../src/storage/postgresCapabilityIssuanceTransaction.js";
import { PostgresCapabilityRedemptionTransaction } from "../../src/storage/postgresCapabilityRedemptionTransaction.js";
import { databaseAvailable, TEST_DATABASE_URL } from "../redemption/pgHarness.js";
import { isolatedSchema, type IsolatedSchema } from "../storage/pgTestSchema.js";
import { AGENT_A, EUR, PURCHASE_ORDER_CREATE, THEO, approvalGrant, approvalRequest, revokeDelegation, rootDelegation } from "../fixtures/scenarios.js";
import { call, faulty, testClock } from "./harness.js";

const available = await databaseAvailable();
if (!available) {
  // eslint-disable-next-line no-console
  console.warn("[authority.postgres.test.ts] TEST_DATABASE_URL is not reachable: skipping the SDK PostgreSQL tests.");
}

if (available) {
  const open: IsolatedSchema[] = [];
  const extraPools: Pool[] = [];
  afterEach(async () => {
    await Promise.allSettled(extraPools.splice(0).map((p) => p.end()));
    await Promise.allSettled(open.splice(0).map((iso) => iso.drop()));
  });

  async function pgSetup(label: string) {
    const iso = isolatedSchema(TEST_DATABASE_URL, label);
    open.push(iso);
    await iso.create();
    iso.pool.on("error", () => undefined);
    const clock = testClock();
    const authority = createAuthority({ backend: postgresBackend(iso.pool), clock, enforcementPointId: "ep-1" });
    const newPool = () => {
      const p = new Pool({ connectionString: iso.connectionString, options: `-c search_path=${iso.schema}` });
      p.on("error", () => undefined);
      extraPools.push(p);
      return p;
    };
    const second = (): Authority => createAuthority({ backend: postgresBackend(newPool()), clock, enforcementPointId: "ep-1" });
    let n = 5000;
    const seed = await authority.record([
      toDraft(rootDelegation({ sequence: ++n, id: "d1", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT_A, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, amountThresholds: thresholds(EUR(2500), EUR(5000)) })),
    ]);
    if (seed.status !== "RECORDED" || !seed.outcomes.every((o) => o.accepted)) throw new Error(`seed rejected: ${JSON.stringify(seed)}`);
    return { iso, clock, authority, second, seq: () => ++n };
  }

  const count = async (a: Authority, type: string) => (await a.events()).filter((e) => e.event_type === type).length;
  const counter = () => {
    let runs = 0;
    return { effect: async () => ++runs, get runs() { return runs; } };
  };

  describe("SDK on PostgreSQL 16", () => {
    it("runs the full cycle once and records it", async () => {
      const s = await pgSetup("sdk_cycle");
      const c = counter();
      expect(await s.authority.guard(call("a1"), c.effect)).toMatchObject({ status: "EXECUTED", report: { status: "REPORTED" } });
      expect(await s.authority.guard(call("a1"), c.effect)).toMatchObject({ status: "BLOCKED", stage: "redeem" });
      expect(c.runs).toBe(1);
      for (const t of ["ACTION_REQUESTED", "CAPABILITY_ISSUED", "CAPABILITY_REDEEMED", "ACTION_EXECUTED"]) expect(await count(s.authority, t)).toBe(1);
    });

    it("an approval granted after a REQUIRES_APPROVAL answer is honoured on retry, and the engine's refusal cache is never hit", async () => {
      const s = await pgSetup("sdk_approval");
      const big = call("big", { amount: { value: 4800, currency: "EUR" } });
      expect((await s.authority.authorize(big)).status).toBe("REQUIRES_APPROVAL");
      await s.authority.record([
        toDraft(approvalRequest({ sequence: s.seq(), id: "ap1", actionId: "big", requestedFrom: THEO, requester: AGENT_A })),
        toDraft(approvalGrant({ sequence: s.seq(), id: "ap1", actionId: "big", approver: THEO })),
      ]);
      expect((await s.authority.authorize(big)).status).toBe("AUTHORIZED");
    });

    it("a revocation between authorize and redeem is honoured", async () => {
      const s = await pgSetup("sdk_revoke");
      const a = await s.authority.authorize(call("a1"));
      if (a.status !== "AUTHORIZED") throw new Error("not authorized");
      await s.authority.record([toDraft(revokeDelegation({ sequence: s.seq(), targetId: "d1", issuedBy: THEO }))]);
      expect(await s.authority.redeem(a.ticket, call("a1"))).toMatchObject({ status: "REFUSED", reason: "AUTHORITY_NO_LONGER_VALID" });
    });

    it("changed arguments are refused with ARGUMENTS_MISMATCH", async () => {
      const s = await pgSetup("sdk_args");
      const a = await s.authority.authorize(call("a1"));
      if (a.status !== "AUTHORIZED") throw new Error("not authorized");
      expect(await s.authority.redeem(a.ticket, call("a1", { args: { sku: "A-100", qty: 99 } }))).toMatchObject({ status: "REFUSED", reason: "ARGUMENTS_MISMATCH" });
    });

    it("30 guards across 3 independent pools run the effect exactly once", async () => {
      const s = await pgSetup("sdk_conc");
      const authorities = [s.authority, s.second(), s.second()];
      const c = counter();
      const results = await Promise.all(Array.from({ length: 30 }, (_, i) => authorities[i % 3]!.guard(call("a1"), c.effect)));
      expect(c.runs).toBe(1);
      expect(results.filter((r) => r.status === "EXECUTED")).toHaveLength(1);
      expect(await count(s.authority, "CAPABILITY_ISSUED")).toBe(1);
      expect(await count(s.authority, "CAPABILITY_REDEEMED")).toBe(1);
    });

    it("a lost COMMIT acknowledgement on redemption is UNKNOWN_OUTCOME: effect not started, ticket stays consumed", async () => {
      const iso = isolatedSchema(TEST_DATABASE_URL, "sdk_lostack");
      open.push(iso);
      await iso.create();
      iso.pool.on("error", () => undefined);
      const clock = testClock();
      let redeemCalls = 0;
      const authority = createAuthority({
        backend: {
          build: (ingestionClock) =>
            faulty(
              {
                store: new PostgresEventStore(iso.pool, ingestionClock),
                issuance: new PostgresCapabilityIssuanceTransaction(iso.pool),
                redemption: new PostgresCapabilityRedemptionTransaction(iso.pool),
              },
              { redeem: () => (redeemCalls++ === 0 ? "throw-after" : undefined) },
            ),
        },
        clock,
        enforcementPointId: "ep-1",
      });
      await authority.record([
        toDraft(rootDelegation({ sequence: 9001, id: "d1", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT_A, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, amountThresholds: thresholds(EUR(2500), EUR(5000)) })),
      ]);
      const c = counter();
      expect(await authority.guard(call("a1"), c.effect)).toMatchObject({ status: "BLOCKED", stage: "redeem", result: { status: "UNKNOWN_OUTCOME" } });
      expect(await authority.guard(call("a1"), c.effect)).toMatchObject({ status: "BLOCKED", result: { status: "REFUSED", reason: "ALREADY_REDEEMED" } });
      expect(c.runs).toBe(0);
      expect(await count(authority, "CAPABILITY_REDEEMED")).toBe(1);
    });
  });
}
