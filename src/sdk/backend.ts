/**
 * Backends assemble the EXISTING stores and transactions; they add no logic.
 * The in-memory backend is for demos and tests (state is lost with the
 * process). The PostgreSQL backend is the one meant for a pilot: apply
 * `src/storage/schema.sql` (and `roles.sql`) to the database first.
 */
import type { Pool } from "pg";
import type { IngestionClock } from "../engine/ingest.js";
import { InMemoryCapabilityIssuanceTransaction, type CapabilityIssuanceTransaction } from "../storage/capabilityIssuanceTransaction.js";
import { InMemoryCapabilityRedemptionTransaction, type CapabilityRedemptionTransaction } from "../storage/capabilityRedemptionTransaction.js";
import { InMemoryEventStore, type EventSource } from "../storage/eventStore.js";
import { PostgresCapabilityIssuanceTransaction } from "../storage/postgresCapabilityIssuanceTransaction.js";
import { PostgresCapabilityRedemptionTransaction } from "../storage/postgresCapabilityRedemptionTransaction.js";
import { PostgresEventStore } from "../storage/postgresEventStore.js";
import { PostgresSingleSnapshotAuthorization } from "../storage/postgresSingleSnapshot.js";
import type { SingleSnapshotAuthorization } from "../storage/singleSnapshot.js";

export interface BackendParts {
  readonly store: EventSource;
  readonly issuance: CapabilityIssuanceTransaction;
  readonly redemption: CapabilityRedemptionTransaction;
  /** D1 prototype: present on PostgreSQL only; used by authorize() only when AUTHORITY_AUTHORIZE_SNAPSHOT=single. Not part of the public API. */
  readonly singleSnapshot?: SingleSnapshotAuthorization;
}

export interface Backend {
  /** Called once by `createAuthority` with the SDK's trusted clock as ingestion clock. */
  build(ingestionClock: IngestionClock): BackendParts;
}

export function memoryBackend(): Backend {
  return {
    build(ingestionClock) {
      const store = new InMemoryEventStore(ingestionClock);
      return { store, issuance: new InMemoryCapabilityIssuanceTransaction(store), redemption: new InMemoryCapabilityRedemptionTransaction(store) };
    },
  };
}

/** Test/benchmark hook for the D1 prototype (timings of the critical section). Not public API. */
let singleSnapshotObserver: ((t: import("../storage/singleSnapshot.js").SingleSnapshotTimings) => void) | undefined;
export function observeSingleSnapshot(fn: typeof singleSnapshotObserver): void {
  singleSnapshotObserver = fn;
}

/** The pool's lifecycle (and its `error` listener) stay with the caller, as node-postgres requires. */
export function postgresBackend(pool: Pool): Backend {
  return {
    build(ingestionClock) {
      const store = new PostgresEventStore(pool, ingestionClock);
      const issuance = new PostgresCapabilityIssuanceTransaction(pool);
      return { store, issuance, redemption: new PostgresCapabilityRedemptionTransaction(pool), singleSnapshot: new PostgresSingleSnapshotAuthorization(pool, store, issuance, (t) => singleSnapshotObserver?.(t)) };
    },
  };
}
