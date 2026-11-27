/** D1 prototype: the PostgreSQL implementation of `SingleSnapshotAuthorization`. See singleSnapshot.ts. */
import type { Pool } from "pg";
import type { CanonicalStore } from "../domain/events.js";
import type { IngestionState } from "../engine/ingest.js";
import type { PostgresCapabilityIssuanceTransaction } from "./postgresCapabilityIssuanceTransaction.js";
import { beginReadCommitted, lockAuthorityEventsTable, readFreshIngestionState, safeRollback, watchClient, type PostgresEventStore } from "./postgresEventStore.js";
import type { LockedSnapshot, SingleSnapshotAuthorization, SingleSnapshotTimings } from "./singleSnapshot.js";

export class PostgresSingleSnapshotAuthorization implements SingleSnapshotAuthorization {
  constructor(
    private readonly pool: Pool,
    private readonly store: PostgresEventStore,
    private readonly issuance: PostgresCapabilityIssuanceTransaction,
    private readonly observe?: (timings: SingleSnapshotTimings) => void,
  ) {}

  async run<T>(body: (snapshot: LockedSnapshot) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const watch = watchClient(client);
    let destroy = false;
    const asked = performance.now();
    let locked = asked;
    let readMs = 0;
    let events = 0;
    let outcome: SingleSnapshotTimings["outcome"] = "ROLLED_BACK";
    try {
      await this.issuance.ensureSchema(client); // I32: the same refusal to run without the one-ticket-per-action index
      await beginReadCommitted(client); // explicit: under REPEATABLE READ the snapshot would be taken by the lock statement, before the wait ends
      await lockAuthorityEventsTable(client);
      locked = performance.now();
      const readStart = performance.now();
      let state: IngestionState = await readFreshIngestionState(client); // THE one read, after the lock
      readMs = performance.now() - readStart;
      events = state.canonicalStore.length;
      const snapshot: LockedSnapshot = {
        journal: (): CanonicalStore => state.canonicalStore,
        append: async (draft) => {
          const result = await this.store.appendWithin(client, state, [draft]);
          state = result.state;
          return result.outcomes[0] as NonNullable<(typeof result.outcomes)[number]>;
        },
        issue: (principal, key, command, dependencies, authorityTime) => this.issuance.issueWithin(client, async () => state, principal, key, command, dependencies, authorityTime),
      };
      const result = await body(snapshot);
      await client.query("COMMIT");
      outcome = "COMMITTED";
      return result;
    } catch (err) {
      destroy = !(await safeRollback(client));
      throw err;
    } finally {
      watch.stop();
      client.release(destroy || watch.broken() ? true : undefined);
      this.observe?.({ lockWaitMs: locked - asked, heldMs: performance.now() - locked, readMs, events, outcome });
    }
  }
}
