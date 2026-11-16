/**
 * The backend-agnostic redemption contract (redemptionContract.ts) run against
 * the PostgreSQL transaction, on a real PostgreSQL. `spawn()` is a second pool
 * (a second connection set, as another process would have); `restart()` ends
 * every pool and reopens new ones over the same schema (nothing in process
 * survives). Skipped, and reported as skipped, when no database is reachable;
 * mandatory in CI through the report guard.
 */
import { Pool } from "pg";
import { describe } from "vitest";
import { capability, type CapabilityId } from "../../src/domain/types.js";
import { PostgresCapabilityRedemptionTransaction } from "../../src/storage/postgresCapabilityRedemptionTransaction.js";
import { PostgresEventStore } from "../../src/storage/postgresEventStore.js";
import { buildCapabilityRedeemedDraft } from "../../src/storage/capabilityRedemptionTransaction.js";
import { AGENT, EP, PARAMS, T, auth } from "./harness.js";
import { databaseAvailable, pgHarness, type PgHarness } from "./pgHarness.js";
import { describeRedemptionContract, type ContractEnv } from "./redemptionContract.js";

const available = await databaseAvailable();
if (!available) {
  // eslint-disable-next-line no-console
  console.warn("[redemptionContract.postgres.test.ts] TEST_DATABASE_URL is not reachable: skipping the PostgreSQL redemption contract.");
}

if (available) {
  describeRedemptionContract("postgresql", async ({ collidingAttemptIds }): Promise<ContractEnv> => {
    const h: PgHarness = await pgHarness({ label: "contract" });
    const attemptIds = (): (() => number | string) | undefined => (collidingAttemptIds ? () => 1 : undefined);
    let clockTime = T("09:20:00");
    // The env owns its pool, never the harness's (which seeds and issues): restart ends and replaces it.
    let pool: Pool = h.newPool();
    let store: PostgresEventStore = new PostgresEventStore(pool, { authorityTime: () => clockTime });
    let redemption = new PostgresCapabilityRedemptionTransaction(pool, { ...(attemptIds() ? { nextAttemptId: attemptIds()! } : {}) });
    const reopen = () => {
      pool = h.newPool();
      store = new PostgresEventStore(pool, { authorityTime: () => clockTime });
      redemption = new PostgresCapabilityRedemptionTransaction(pool, { ...(attemptIds() ? { nextAttemptId: attemptIds()! } : {}) });
    };

    const env: ContractEnv = {
      events: () => store.getEvents(),
      issue: (at) => h.issue(at),
      command: (id: CapabilityId) => h.command(id),
      redeem: (who, command, at) => redemption.redeem(who, command, at),
      async spawn() {
        const other = new PostgresCapabilityRedemptionTransaction(h.newPool(), { ...(attemptIds() ? { nextAttemptId: attemptIds()! } : {}) });
        return { redeem: (who, command, at) => other.redeem(who, command, at) };
      },
      async restart() {
        await pool.end(); // every connection of the previous incarnation is closed
        reopen();
      },
      async rawAppend(draft, at) {
        clockTime = at;
        return (await store.append([draft])).outcomes[0]!;
      },
      async redeemedDraft(id, eventIdValue, overrides) {
        const events = await store.getEvents();
        const issued = events.find((e) => e.event_type === "CAPABILITY_ISSUED" && e.payload.capability_id === id);
        if (issued === undefined || issued.event_type !== "CAPABILITY_ISSUED") throw new Error("no such capability");
        const d = buildCapabilityRedeemedDraft(auth(AGENT), T("09:13:00"), {
          capability_id: id, action_id: issued.payload.action_id, action_fingerprint: issued.payload.action_fingerprint,
          decision_sequence: (overrides?.decisionSequence ?? events.length) as never, enforcement_point_id: issued.payload.enforcement_point_id,
        }, "contract");
        return { ...d, event_id: eventIdValue as never };
      },
      close: () => h.close(),
    };
    void EP; void PARAMS; void capability;
    return env;
  });
} else {
  describe.skip("redemption contract [postgresql] (no database reachable)", () => {});
}
