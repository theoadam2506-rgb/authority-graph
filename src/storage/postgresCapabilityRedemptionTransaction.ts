/**
 * V1 (PR 2) — PostgreSQL redemption transaction. Same contract as
 * `InMemoryCapabilityRedemptionTransaction` (SPEC I26 to I31), obtained from
 * the DATABASE rather than from process-local state:
 *
 *  1. ONE ATOMIC SQL TRANSACTION. BEGIN; take the writer advisory lock (the very
 *     same lock domain as `PostgresEventStore.append()` and
 *     `PostgresCapabilityIssuanceTransaction.issue()`); read the whole journal
 *     FRESH, after the lock is held; run the pure `redeemCapability` kernel on
 *     that snapshot; on success INSERT the event; verify; COMMIT. Any error
 *     rolls everything back. An exception is never a success.
 *  2. UNIQUENESS BY THE DATABASE. The partial unique index
 *     `authority_events_redeemed_capability_id_uidx` (schema.sql) makes a second
 *     CAPABILITY_REDEEMED row for one capability impossible even for a writer
 *     that bypasses the lock and this class. A unique violation is reported as a
 *     refusal and rolled back.
 *  3. SUCCESS ONLY IF THIS TRANSACTION INSERTED THE ROW. `REDEEMED` is returned
 *     only after the INSERT ran in THIS transaction (an I8-style duplicate does
 *     not insert, and ingestion's "accepted duplicate" is never read as
 *     success) AND a read-back inside the same transaction shows exactly one
 *     redemption row for the capability, whose event_id is ours and whose
 *     sequence is `decision_sequence + 1`. Anything else rolls back.
 *  4. NO ATTEMPT-ID DEPENDENCE. Each attempt's event_id embeds an attempt id
 *     from an injectable generator (default: crypto.randomUUID, unguessable so a
 *     raw writer cannot squat the id). Correctness does not rest on it: the lock,
 *     the unique index and the read-back do.
 *
 * What a violation means here, which differs from the in-memory model on ONE
 * point and is stated plainly: if a writer that bypasses the lock commits a row
 * at the sequence this transaction is about to use, the INSERT hits the
 * primary key; the transaction rolls back and returns CONCURRENT_WRITE_DETECTED
 * with `ticketConsumed: false` (nothing was written by this call). In memory the
 * same race writes the event and consumes the ticket (I30). Both are fail-closed.
 *
 * Outcome unknown: if the connection is lost between COMMIT being sent and its
 * acknowledgement, this method throws. The caller MUST NOT assume either
 * outcome; a retry reads the truth (REDEEMED earlier ⇒ ALREADY_REDEEMED, or
 * still redeemable). It never returns a success it did not observe.
 *
 * SCHEMA ENFORCEMENT. Before its first redemption each instance verifies, with
 * `checkRedemptionSchema`, that the redemption index is present, VALID, UNIQUE
 * and partial on CAPABILITY_REDEEMED; otherwise `redeem` throws
 * `RedemptionSchemaError` and writes nothing. The check is not cached on
 * failure, so fixing the migration needs no restart.
 *
 * Deployment requirement (node-postgres): the Pool passed in must have an
 * `error` listener (`pool.on("error", ...)`) for idle clients whose connection
 * is lost; this class guards the client it has checked out, not the pool.
 *
 * Not provided (unchanged from I28/I30): anything about the external effect;
 * identity verification (AuthenticatedPrincipal is an assertion); protection
 * from a superuser, the table owner, or a writer that forges an
 * Authority-generated event (THREAT_MODEL A31/A37).
 */
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AuthenticatedPrincipal } from "../domain/authenticatedPrincipal.js";
import type { RedeemCapabilityCommand } from "../domain/capabilityCommand.js";
import type { AuthorityEvent } from "../domain/events.js";
import type { Iso8601 } from "../domain/types.js";
import { advanceTrustedTime, processDraft } from "../engine/ingest.js";
import { redeemCapability, type RedeemCapabilityResult } from "../engine/redeemCapability.js";
import { buildCapabilityRedeemedDraft, type CapabilityRedemptionTransaction } from "./capabilityRedemptionTransaction.js";
import { beginReadCommitted, insertEvent, lockAuthorityEventsTable, readFreshIngestionState } from "./postgresEventStore.js";

const REDEEMED_INDEX = "authority_events_redeemed_capability_id_uidx";

/**
 * Thrown by `redeem` when the redemption index is missing, INVALID, not unique
 * or mis-defined: the database-level backstop is not in force, so the
 * transaction refuses to run (fail-closed) instead of redeeming without it.
 * Apply `src/storage/schema.sql` (or rebuild the index) and retry; the refusal
 * is not cached.
 */
export class RedemptionSchemaError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`redemption schema check failed: ${problems.join("; ")}`);
    this.name = "RedemptionSchemaError";
    this.problems = problems;
  }
}

export interface PostgresRedemptionOptions {
  /** Attempt id source. Default: crypto.randomUUID(). Not an exclusion mechanism. */
  readonly nextAttemptId?: () => number | string;
  /** Infrastructure clock for `recorded_at` (diagnostic only, never decisional). */
  readonly readInfrastructureClock?: () => string;
}

function uniqueViolation(err: unknown): { readonly constraint: string } | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { code?: unknown; constraint?: unknown };
  return e.code === "23505" ? { constraint: typeof e.constraint === "string" ? e.constraint : "" } : undefined;
}

async function safeRollback(client: PoolClient): Promise<boolean> {
  try {
    await client.query("ROLLBACK");
    return true;
  } catch {
    return false; // connection is broken: the caller destroys it
  }
}

export class PostgresCapabilityRedemptionTransaction implements CapabilityRedemptionTransaction {
  private readonly pool: Pool;
  private readonly nextAttemptId: () => number | string;
  private readonly readInfrastructureClock: () => string;
  /** Set once the schema check has passed for this instance. A failure is never cached. */
  private schemaVerified = false;

  constructor(pool: Pool, options: PostgresRedemptionOptions = {}) {
    this.pool = pool;
    this.nextAttemptId = options.nextAttemptId ?? randomUUID;
    this.readInfrastructureClock = options.readInfrastructureClock ?? (() => new Date().toISOString());
  }

  async redeem(authenticatedPrincipal: AuthenticatedPrincipal, command: RedeemCapabilityCommand, authorityTime: Iso8601): Promise<RedeemCapabilityResult> {
    const client = await this.pool.connect();
    let destroy = false;
    // A checked-out client that loses its connection (server restart, pg_terminate_backend)
    // emits "error"; with no listener that is an uncaught exception that takes the process down.
    // Record it, destroy the client, and let the pending query reject (fail-closed).
    const onClientError = (): void => {
      destroy = true;
    };
    client.on("error", onClientError);
    try {
      // Enforced before the first use of this instance: no redemption runs against
      // a database whose redemption index is missing or invalid. Checked on the
      // checked-out client (so it also sees this connection's search_path) and
      // only until it has passed once; a failure throws and is retried next call.
      if (!this.schemaVerified) {
        const problems = await checkRedemptionSchema(client);
        if (problems.length > 0) throw new RedemptionSchemaError(problems);
        this.schemaVerified = true;
      }
      await beginReadCommitted(client);
      // Same lock domain as every other writer of authority_events.
      await lockAuthorityEventsTable(client);

      // Fresh read, AFTER the lock is held. No writer that takes the lock can
      // change the journal between this read and our COMMIT.
      const state = await readFreshIngestionState(client);
      const decision = redeemCapability(state.canonicalStore, authenticatedPrincipal, command, authorityTime);
      if (!decision.ok) {
        await client.query("ROLLBACK"); // read-only: nothing to keep, lock released
        return decision;
      }

      const draft = buildCapabilityRedeemedDraft(authenticatedPrincipal, authorityTime, decision.redemption, this.nextAttemptId());
      const advanced = advanceTrustedTime(undefined, authorityTime);
      const admission = processDraft(state, draft, advanced.iso, this.readInfrastructureClock());
      if (!admission.outcome.accepted) {
        // Business-id collision or event_id conflict at ingestion: the same refusal the unique index would give.
        await client.query("ROLLBACK");
        return { ok: false, reason: "REDEMPTION_COLLISION" };
      }
      const grewByOne = admission.nextState.canonicalStore.length === state.canonicalStore.length + 1;
      const newEvent: AuthorityEvent | undefined = admission.nextState.canonicalStore[admission.nextState.canonicalStore.length - 1];
      if (!grewByOne || newEvent === undefined) {
        // I8 "accepted duplicate": ingestion accepted but nothing new would be inserted. NEVER a success.
        await client.query("ROLLBACK");
        return { ok: false, reason: "REDEMPTION_COLLISION" };
      }

      if (Number(newEvent.sequence) !== Number(decision.redemption.decision_sequence) + 1) {
        // The journal is not contiguous (a writer that bypassed ingestion skipped sequence numbers): the event
        // would not sit right after the snapshot it was decided on. Fail closed, nothing written.
        await client.query("ROLLBACK");
        return { ok: false, reason: "CONCURRENT_WRITE_DETECTED", detail: { ticketConsumed: false } };
      }

      try {
        await insertEvent(client, newEvent);
      } catch (err) {
        const violation = uniqueViolation(err);
        if (violation === undefined) throw err;
        await client.query("ROLLBACK");
        // A row at our sequence appeared from a writer that bypassed the lock: nothing of ours was written.
        if (violation.constraint === "authority_events_pkey") {
          return { ok: false, reason: "CONCURRENT_WRITE_DETECTED", detail: { ticketConsumed: false } };
        }
        // The redemption index or event_id uniqueness: somebody else redeemed it.
        return { ok: false, reason: "REDEMPTION_COLLISION" };
      }

      // Explicit verification that THIS transaction inserted the event: exactly
      // one redemption row exists for the capability, it is ours, and it sits
      // right after the snapshot the decision was made on.
      const check = await client.query<{ event_id: string; sequence: string }>(
        `SELECT event_id, sequence FROM authority_events WHERE event_type = 'CAPABILITY_REDEEMED' AND payload ->> 'capability_id' = $1`,
        [command.capability_id],
      );
      const row = check.rows[0];
      if (
        check.rows.length !== 1 ||
        row === undefined ||
        row.event_id !== newEvent.event_id ||
        Number(row.sequence) !== Number(decision.redemption.decision_sequence) + 1
      ) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "REDEMPTION_COLLISION" };
      }

      await client.query("COMMIT");
      return decision;
    } catch (err) {
      destroy = !(await safeRollback(client));
      throw err; // fail-closed: an exception is never a success
    } finally {
      client.removeListener("error", onClientError);
      client.release(destroy ? true : undefined);
    }
  }
}

/**
 * Deployment check: is the redemption index really there, valid, unique and
 * partial on CAPABILITY_REDEEMED? `CREATE UNIQUE INDEX IF NOT EXISTS` treats an
 * INVALID leftover (a failed CONCURRENTLY build) as existing and silently skips
 * it, which would leave the database-level backstop unenforced. Returns the
 * list of problems (empty when sound). Run it after applying `schema.sql`.
 * The transaction's own correctness (lock, fresh read, read-back) does not
 * depend on the index; the index is the defence against writers that bypass them.
 */
export async function checkRedemptionSchema(db: Pick<Pool, "query"> | Pick<PoolClient, "query">): Promise<string[]> {
  const r = await (db as Pick<Pool, "query">).query<{ indisvalid: boolean; indisunique: boolean; def: string }>(
    `SELECT i.indisvalid, i.indisunique, pg_get_indexdef(i.indexrelid) AS def
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = $1 AND i.indrelid = to_regclass('authority_events')`,
    [REDEEMED_INDEX],
  );
  const row = r.rows[0];
  if (row === undefined) return [`index ${REDEEMED_INDEX} is missing: apply src/storage/schema.sql`];
  const problems: string[] = [];
  if (!row.indisvalid) problems.push(`index ${REDEEMED_INDEX} is INVALID (a failed CONCURRENTLY build?): drop it and rebuild; it enforces nothing`);
  if (!row.indisunique) problems.push(`index ${REDEEMED_INDEX} is not UNIQUE`);
  if (!/WHERE \(?event_type = 'CAPABILITY_REDEEMED'/.test(row.def) || !/payload ->> 'capability_id'/.test(row.def)) problems.push(`index ${REDEEMED_INDEX} does not have the expected definition: ${row.def}`);
  return problems;
}

export { REDEEMED_INDEX };
