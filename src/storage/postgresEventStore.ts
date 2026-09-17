/**
 * Postgres-backed `EventSource` (PROMPT 4, point 3). Postgres is a journal
 * here, never a decision-maker: every accept/reject decision is made by
 * `processDraft` (src/engine/ingest.ts), imported and reused exactly as
 * `InMemoryEventStore` reuses it — nothing in this file re-implements or
 * approximates I5/I9/I10/I12/I13/I14 in SQL. The schema
 * (src/storage/schema.sql) has no trigger, no view, and no computed column
 * that touches authority; grep it if in doubt.
 *
 * CONCURRENCY (disclosed limitation — see the "under-specified" list handed
 * back to the user): `append()` takes a Postgres advisory lock
 * (`pg_advisory_xact_lock`) for the duration of one call, serializing writers
 * against each other. This is a mutex, not an authority check, but it does
 * mean V0 assumes a single logical writer (or writers willing to queue) — a
 * proper multi-writer design (e.g. a `SERIAL sequence` column plus a retry
 * loop) is out of scope here. Every `append()` call re-reads the *entire*
 * table to rebuild `IngestionState` before deciding on the new drafts; this
 * is correct but not remotely optimized for a large history — acceptable for
 * V0's "journal, not a scalability project" scope.
 */
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { AuthorityEvent, AuthorityEventType, CanonicalStore, DraftAuthorityEvent } from "../domain/events.js";
import {
  eventId,
  iso8601,
  principalId,
  schemaVersion,
  sequenceNumber,
  type AssuranceLevel,
  type IngestOutcome,
  type IngestRejectionCode,
  type SecurityLogEntry,
} from "../domain/types.js";
import { advanceTrustedTime, processDraft, rebuildIngestionState, type IngestionClock } from "../engine/ingest.js";
import type { AppendResult, EventFilter, EventSource, SequenceRange } from "./eventStore.js";

interface EventRow extends QueryResultRow {
  readonly sequence: string; // BIGINT arrives as a string from node-postgres by default
  readonly event_id: string;
  readonly event_type: string;
  readonly principal_id: string;
  readonly schema_version: number;
  readonly occurred_at: Date;
  readonly authority_time: Date;
  readonly recorded_at: Date;
  readonly assurance_level: string;
  readonly payload: unknown;
}

interface SecurityLogRow extends QueryResultRow {
  readonly event_id: string;
  readonly payload_hash: string;
  readonly reason_code: string;
  readonly recorded_at: Date;
}

function assertAssuranceLevel(value: string): AssuranceLevel {
  if (value !== "ASSERTED_UNVERIFIED") {
    throw new Error(`Unknown assurance_level read from storage: ${value}`);
  }
  return value;
}

/** Reconstructs an `AuthorityEvent` from a stored row. A boundary cast at the end is unavoidable: nothing at the SQL layer can prove event_type/payload correlate, since that correlation was only ever a TypeScript-level guarantee at write time. */
function rowToEvent(row: EventRow): AuthorityEvent {
  return {
    event_id: eventId(row.event_id),
    schema_version: schemaVersion(row.schema_version),
    occurred_at: iso8601(row.occurred_at.toISOString()),
    principal_id: principalId(row.principal_id),
    sequence: sequenceNumber(Number(row.sequence)),
    authority_time: iso8601(row.authority_time.toISOString()),
    recorded_at: iso8601(row.recorded_at.toISOString()),
    assurance_level: assertAssuranceLevel(row.assurance_level),
    event_type: row.event_type as AuthorityEventType,
    payload: row.payload,
  } as AuthorityEvent;
}

async function insertEvent(client: PoolClient, event: AuthorityEvent): Promise<void> {
  await client.query(
    `INSERT INTO authority_events
       (sequence, event_id, event_type, principal_id, schema_version, occurred_at, authority_time, recorded_at, assurance_level, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      event.sequence,
      event.event_id,
      event.event_type,
      event.principal_id,
      event.schema_version,
      event.occurred_at,
      event.authority_time,
      event.recorded_at,
      event.assurance_level,
      event.payload,
    ],
  );
}

async function insertSecurityLogEntry(client: PoolClient, entry: SecurityLogEntry): Promise<void> {
  await client.query(
    `INSERT INTO security_log (event_id, payload_hash, reason_code, recorded_at) VALUES ($1, $2, $3, $4)`,
    [entry.eventId, entry.payloadHash, entry.reasonCode, entry.recordedAt],
  );
}

function buildWhere(conditions: readonly { readonly clause: string; readonly value: unknown }[]): {
  readonly where: string;
  readonly params: unknown[];
} {
  if (conditions.length === 0) {
    return { where: "", params: [] };
  }
  const params = conditions.map((c) => c.value);
  const clauses = conditions.map((c, i) => `${c.clause} $${i + 1}`);
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

/**
 * `EventSource` backed by Postgres. Exactly the three operations the
 * interface allows — see the module docstring for why `append()` looks the
 * way it does.
 */
export class PostgresEventStore implements EventSource {
  private readonly pool: Pool;
  private readonly clock: IngestionClock;
  private lastTrustedTimeMs: number | undefined;
  /** Infrastructure clock read for `recorded_at` — I/O, isolated to this one call site. */
  private readonly readInfrastructureClock: () => string;

  constructor(pool: Pool, clock: IngestionClock, readInfrastructureClock: () => string = () => new Date().toISOString()) {
    this.pool = pool;
    this.clock = clock;
    this.readInfrastructureClock = readInfrastructureClock;
  }

  async append(drafts: readonly DraftAuthorityEvent[]): Promise<AppendResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // A mutex over writers, not an authority decision (see module docstring).
      await client.query("SELECT pg_advisory_xact_lock(hashtext('authority_events'))");

      const historyResult = await client.query<EventRow>("SELECT * FROM authority_events ORDER BY sequence ASC");
      let state = rebuildIngestionState(historyResult.rows.map(rowToEvent));

      const outcomes: IngestOutcome[] = [];
      for (const [index, draft] of drafts.entries()) {
        const advanced = advanceTrustedTime(this.lastTrustedTimeMs, this.clock.authorityTime(draft, index));
        this.lastTrustedTimeMs = advanced.ms;
        const recordedAtIso = this.readInfrastructureClock();

        const result = processDraft(state, draft, advanced.iso, recordedAtIso);
        outcomes.push(result.outcome);

        const grewByOne = result.nextState.canonicalStore.length === state.canonicalStore.length + 1;
        if (result.outcome.accepted && grewByOne) {
          const newEvent = result.nextState.canonicalStore[result.nextState.canonicalStore.length - 1];
          if (newEvent !== undefined) {
            await insertEvent(client, newEvent);
          }
        } else if (!result.outcome.accepted && result.securityLogEntry !== undefined) {
          await insertSecurityLogEntry(client, result.securityLogEntry);
        }

        state = result.nextState;
      }

      await client.query("COMMIT");
      return { outcomes };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async getEvents(filter?: EventFilter): Promise<CanonicalStore> {
    const conditions: { readonly clause: string; readonly value: unknown }[] = [];
    if (filter?.eventType !== undefined) {
      conditions.push({ clause: "event_type =", value: filter.eventType });
    }
    if (filter?.principalId !== undefined) {
      conditions.push({ clause: "principal_id =", value: filter.principalId });
    }
    const { where, params } = buildWhere(conditions);
    const result = await this.pool.query<EventRow>(`SELECT * FROM authority_events ${where} ORDER BY sequence ASC`, params);
    return result.rows.map(rowToEvent);
  }

  async getBySequence(range: SequenceRange): Promise<CanonicalStore> {
    const conditions: { readonly clause: string; readonly value: unknown }[] = [];
    if (range.from !== undefined) {
      conditions.push({ clause: "sequence >=", value: range.from });
    }
    if (range.to !== undefined) {
      conditions.push({ clause: "sequence <=", value: range.to });
    }
    const { where, params } = buildWhere(conditions);
    const result = await this.pool.query<EventRow>(`SELECT * FROM authority_events ${where} ORDER BY sequence ASC`, params);
    return result.rows.map(rowToEvent);
  }

  /**
   * Not part of `EventSource` (still exactly append/getEvents/getBySequence
   * there) — a separate, additional read capability mirroring
   * `InMemoryEventStore.getSecurityLog()`: the `security_log` table is
   * itself append-only (no UPDATE/DELETE statement against it exists
   * anywhere in this codebase), this just reads it back in arrival order.
   */
  async getSecurityLog(): Promise<readonly SecurityLogEntry[]> {
    const result = await this.pool.query<SecurityLogRow>("SELECT * FROM security_log ORDER BY id ASC");
    return result.rows.map((row) => ({
      eventId: eventId(row.event_id),
      payloadHash: row.payload_hash,
      reasonCode: row.reason_code as IngestRejectionCode,
      recordedAt: iso8601(row.recorded_at.toISOString()),
    }));
  }
}
