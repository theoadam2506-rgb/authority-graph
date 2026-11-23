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

export interface BackendParts {
  readonly store: EventSource;
  readonly issuance: CapabilityIssuanceTransaction;
  readonly redemption: CapabilityRedemptionTransaction;
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

/** The pool's lifecycle (and its `error` listener) stay with the caller, as node-postgres requires. */
export function postgresBackend(pool: Pool): Backend {
  return {
    build(ingestionClock) {
      return {
        store: new PostgresEventStore(pool, ingestionClock),
        issuance: new PostgresCapabilityIssuanceTransaction(pool),
        redemption: new PostgresCapabilityRedemptionTransaction(pool),
      };
    },
  };
}
