/**
 * PR4B-3B — the real ACID transactional boundary
 * `InMemoryCapabilityIssuanceTransaction` (PR4B-3A) specified but could
 * only approximate. This is OPTION B, as decided in the PR4B-3A.5 audit:
 * this class owns its own `PoolClient`, its own `BEGIN`/`COMMIT`/`ROLLBACK`,
 * and its own advisory lock acquisition directly. It never calls
 * `PostgresEventStore.append()` — that method opens its OWN connection and
 * its OWN transaction; calling it from inside this one would not join it
 * (Postgres has no notion of a nested transaction shared across two
 * connections), and would let the canonical event commit independently of,
 * and before, the idempotency row — exactly the atomicity gap this class
 * exists to close. See the audit report for the full argument.
 *
 * LOCK DOMAIN: `lockAuthorityEventsTable` (postgresEventStore.ts) is
 * called here UNCHANGED — the exact same `pg_advisory_xact_lock` key
 * `PostgresEventStore.append()` already uses, not a second one that
 * merely resembles it. This is what guarantees a legacy `append()` call
 * and an `issue()` call here can never mutate `authority_events`
 * concurrently: PR4B-3B keeps V0's global serialization domain, no finer-
 * grained per-delegation locking is introduced.
 *
 * REUSE, NOT DUPLICATION: `rowToEvent`/`insertEvent`/`readFreshIngestionState`
 * (postgresEventStore.ts) and `buildCapabilityIssuedDraft`
 * (capabilityIssuanceTransaction.ts) are the exact same functions
 * `PostgresEventStore`/`InMemoryCapabilityIssuanceTransaction` already use.
 * `issueCapability` (the pure kernel) and `commandsEqual`
 * (issueCapabilityIdempotency.ts) are imported directly — this class does
 * NOT call `issueCapabilityIdempotently` itself, since that function's
 * signature is hard-wired to an in-memory `IdempotencyState` Map; the
 * REPLAYED/CONFLICT/EXECUTED control flow it encodes is re-expressed here
 * against SQL rows instead, exactly as the PR4B-3B design brief's own
 * pseudocode does (it calls `issueCapability(...)` directly, never
 * `issueCapabilityIdempotently`). `commandsEqual` itself is reused, not
 * reimplemented.
 */
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { AuthorityEvent } from "../domain/events.js";
import type { CapabilityId, ClientIdempotencyKey, EventId, Iso8601, SequenceNumber } from "../domain/types.js";
import type { AuthenticatedPrincipal } from "../domain/authenticatedPrincipal.js";
import type { IssueCapabilityCommand } from "../domain/capabilityCommand.js";
import { issueCapability, type IssueCapabilityDependencies, type IssueCapabilityResult } from "../engine/issueCapability.js";
import { commandsEqual } from "../engine/issueCapabilityIdempotency.js";
import { advanceTrustedTime, processDraft, type IngestionState } from "../engine/ingest.js";
import { buildCapabilityIssuedDraft, type CapabilityIssuanceOutcome, type CapabilityIssuanceTransaction } from "./capabilityIssuanceTransaction.js";
import { beginReadCommitted, insertEvent, lockAuthorityEventsTable, readFreshIngestionState, safeRollback, watchClient } from "./postgresEventStore.js";

interface IdempotencyRow extends QueryResultRow {
  readonly command: unknown;
  readonly result: unknown;
}

/**
 * `PoolClient.query` boundary casts, same category as `rowToEvent`'s own
 * (postgresEventStore.ts): nothing at the SQL layer can prove a stored
 * JSONB blob really is a well-formed `IssueCapabilityCommand`/
 * `IssueCapabilityResult` — that correlation was only ever a TypeScript-
 * level guarantee at the moment this same class wrote it.
 */
function parseStoredCommand(value: unknown): IssueCapabilityCommand {
  return value as IssueCapabilityCommand;
}

function parseStoredResult(value: unknown): IssueCapabilityResult {
  return value as IssueCapabilityResult;
}

async function lookupIdempotencyRow(
  client: PoolClient,
  authenticatedPrincipal: AuthenticatedPrincipal,
  clientIdempotencyKey: ClientIdempotencyKey,
): Promise<IdempotencyRow | undefined> {
  const result = await client.query<IdempotencyRow>(
    `SELECT command, result FROM capability_issuance_idempotency
     WHERE authenticated_requester_id = $1 AND operation = $2 AND client_idempotency_key = $3`,
    [authenticatedPrincipal.principalId, "ISSUE_CAPABILITY", clientIdempotencyKey],
  );
  return result.rows[0];
}

async function insertIdempotencyRow(
  client: PoolClient,
  authenticatedPrincipal: AuthenticatedPrincipal,
  clientIdempotencyKey: ClientIdempotencyKey,
  command: IssueCapabilityCommand,
  result: IssueCapabilityResult,
  eventIdValue: EventId | undefined,
  capabilityIdValue: CapabilityId | undefined,
  sequenceValue: SequenceNumber | undefined,
  createdAtIso: string,
): Promise<void> {
  await client.query(
    `INSERT INTO capability_issuance_idempotency
       (authenticated_requester_id, operation, client_idempotency_key, command, result, event_id, capability_id, sequence, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      authenticatedPrincipal.principalId,
      "ISSUE_CAPABILITY",
      clientIdempotencyKey,
      command,
      result,
      eventIdValue ?? null,
      capabilityIdValue ?? null,
      sequenceValue !== undefined ? Number(sequenceValue) : null,
      createdAtIso,
    ],
  );
}

/**
 * Postgres-backed `CapabilityIssuanceTransaction`. One `issue()` call =
 * one connection, one `BEGIN`...`COMMIT`/`ROLLBACK`, one advisory lock
 * acquisition, one canonical snapshot read — never more than one of any
 * of these per call, and never shared with any other call or with
 * `PostgresEventStore.append()`'s own, entirely separate transactions.
 */
const TICKETED_ACTION_INDEX = "authority_events_ticketed_action_id_uidx";

/** Thrown by `issue` when the I32 index is missing, INVALID, not unique or mis-defined: nothing was written. */
export class IssuanceSchemaError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`issuance schema check failed: ${problems.join("; ")}`);
    this.name = "IssuanceSchemaError";
    this.problems = problems;
  }
}

/** Problems with the I32 backstop index (empty when it is in force). Mirrors `checkRedemptionSchema`. */
export async function checkTicketPerActionSchema(db: Pick<Pool, "query"> | Pick<PoolClient, "query">): Promise<string[]> {
  const r = await (db as Pick<Pool, "query">).query<{ indisvalid: boolean; indisunique: boolean; def: string }>(
    `SELECT i.indisvalid, i.indisunique, pg_get_indexdef(i.indexrelid) AS def
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = $1 AND i.indrelid = to_regclass('authority_events')`,
    [TICKETED_ACTION_INDEX],
  );
  const row = r.rows[0];
  if (row === undefined) return [`index ${TICKETED_ACTION_INDEX} is missing: apply src/storage/schema.sql`];
  const problems: string[] = [];
  if (!row.indisvalid) problems.push(`index ${TICKETED_ACTION_INDEX} is INVALID (a failed CONCURRENTLY build?): drop it and rebuild; it enforces nothing`);
  if (!row.indisunique) problems.push(`index ${TICKETED_ACTION_INDEX} is not UNIQUE`);
  if (!/WHERE \(?event_type = 'CAPABILITY_ISSUED'/.test(row.def) || !/payload ->> 'action_id'/.test(row.def)) {
    problems.push(`index ${TICKETED_ACTION_INDEX} does not have the expected definition (partial on CAPABILITY_ISSUED, over payload->>'action_id'): ${row.def}`);
  }
  return problems;
}

export { TICKETED_ACTION_INDEX };

export class PostgresCapabilityIssuanceTransaction implements CapabilityIssuanceTransaction {
  private schemaVerified = false;
  private readonly pool: Pool;
  private readonly readInfrastructureClock: () => string;

  /**
   * PR4B-5 — no `IngestionClock` constructor parameter anymore: this class
   * used to consult one, ONLY to stamp the eventual CAPABILITY_ISSUED
   * event's authority_time, and only AFTER the decision (`issueCapability`)
   * had already been made against a stale, reconstructed instant — see the
   * design report. Now the decision and the event both use the same
   * explicit `authorityTime` this class's `issue()` receives; an
   * `IngestionClock` would have nothing left to do here. `IngestionClock`'s
   * role elsewhere (batch ingestion via `PostgresEventStore.append()`) is
   * unchanged.
   */
  constructor(pool: Pool, readInfrastructureClock: () => string = () => new Date().toISOString()) {
    this.pool = pool;
    this.readInfrastructureClock = readInfrastructureClock;
  }

  async issue(
    authenticatedPrincipal: AuthenticatedPrincipal,
    clientIdempotencyKey: ClientIdempotencyKey,
    command: IssueCapabilityCommand,
    dependencies: IssueCapabilityDependencies,
    authorityTime: Iso8601,
  ): Promise<CapabilityIssuanceOutcome> {
    const client = await this.pool.connect();
    const watch = watchClient(client);
    let destroy = false;
    try {
      await this.ensureSchema(client);
      await beginReadCommitted(client);
      // Same lock domain as PostgresEventStore.append() — see this
      // module's own docstring and postgresEventStore.ts's.
      await lockAuthorityEventsTable(client);
      const outcome = await this.issueWithin(client, () => readFreshIngestionState(client), authenticatedPrincipal, clientIdempotencyKey, command, dependencies, authorityTime);
      await client.query("COMMIT");
      return outcome;
    } catch (err) {
      destroy = !(await safeRollback(client));
      throw err; // fail-closed: the ORIGINAL error, even when the rollback itself fails because the connection is gone
    } finally {
      watch.stop();
      client.release(destroy || watch.broken() ? true : undefined);
    }
  }

  /**
   * I32: no issuance runs against a database whose one-ticket-per-action index is missing, INVALID or mis-defined (the database-level
   * backstop would not be in force). Checked until it has passed once; a failure throws, writes nothing and is not cached.
   */
  async ensureSchema(client: PoolClient): Promise<void> {
    if (!this.schemaVerified) {
      const problems = await checkTicketPerActionSchema(client);
      if (problems.length > 0) throw new IssuanceSchemaError(problems);
      this.schemaVerified = true;
    }
  }

  /**
   * Steps A–E of `issue()` (idempotence lookup, snapshot, decision, event + idempotency row), WITHOUT the BEGIN / lock / COMMIT / ROLLBACK: the
   * caller owns the transaction and must already hold the advisory lock. `loadState` returns the fresh canonical state read under that lock
   * (D1: the single snapshot of the whole call, already advanced by the caller's own appends). The decisions and writes are the ones `issue()` always made.
   */
  async issueWithin(
    client: PoolClient,
    loadState: () => Promise<IngestionState>,
    authenticatedPrincipal: AuthenticatedPrincipal,
    clientIdempotencyKey: ClientIdempotencyKey,
    command: IssueCapabilityCommand,
    dependencies: IssueCapabilityDependencies,
    authorityTime: Iso8601,
  ): Promise<CapabilityIssuanceOutcome> {
    {
      // A. lookup idempotence, under the lock.
      const existingRow = await lookupIdempotencyRow(client, authenticatedPrincipal, clientIdempotencyKey);
      if (existingRow !== undefined) {
        const persistedCommand = parseStoredCommand(existingRow.command);
        if (commandsEqual(persistedCommand, command)) {
          // REPLAYED: nothing mutated, no second decision, no new
          // capability_id, no new event — the persisted result IS the
          // answer.
          return { outcome: "REPLAYED", result: parseStoredResult(existingRow.result) };
        }
        // IDEMPOTENCY_CONFLICT: same scope, different command. Nothing
        // written, nothing changed — COMMIT here only releases the lock
        // cleanly on a read-only transaction.
        return { outcome: "IDEMPOTENCY_CONFLICT" };
      }

      // B. fresh canonical snapshot, read AFTER the lock is held — the
      // same snapshot the decision below is made against and the same
      // one the eventual INSERT's sequence is derived from. No writer
      // (this class or PostgresEventStore.append()) can mutate
      // authority_events between this read and this transaction's own
      // COMMIT, because both acquire the exact same advisory lock first.
      const state = await loadState();
      const snapshot = state.canonicalStore;

      // C. the pure decision — issueCapability never touches Postgres,
      // never authenticates, never reads a live clock. `authorityTime` is
      // this call's own explicit, caller-supplied instant (PR4B-5) — never
      // reconstructed from `snapshot`.
      const decision = issueCapability(snapshot, authenticatedPrincipal, command, dependencies, authorityTime);

      if (!decision.ok) {
        // A normal business rejection (REQUESTER_MISMATCH, NOT_AUTHORIZED,
        // CAPACITY_EXCEEDED, ...) is itself idempotent: persist it under
        // this scope so a retry REPLAYs the same rejection rather than
        // re-deciding against a possibly-different future snapshot.
        await insertIdempotencyRow(client, authenticatedPrincipal, clientIdempotencyKey, command, decision, undefined, undefined, undefined, this.readInfrastructureClock());
        return { outcome: "EXECUTED", result: decision };
      }

      // D. ok:true — build the draft and run it through the EXACT SAME
      // deterministic ingestion rules (processDraft) every other event
      // type already goes through. `advanceTrustedTime(undefined, ...)`
      // mirrors append()'s own per-batch-of-one usage: this transaction
      // only ever ingests a single draft, so there is no "previous draft
      // in this batch" to clamp against.
      const draft = buildCapabilityIssuedDraft(authenticatedPrincipal, authorityTime, decision.capability);
      // PR4B-5 — `authorityTime` directly, never a clock: the same explicit
      // instant already used for the decision above becomes this event's
      // trusted authority_time. `advanceTrustedTime(undefined, ...)` still
      // mirrors append()'s own per-batch-of-one usage (see the comment this
      // replaces) — no "previous draft in this batch" to clamp against.
      const advanced = advanceTrustedTime(undefined, authorityTime);
      const recordedAtIso = this.readInfrastructureClock();
      const admission = processDraft(state, draft, advanced.iso, recordedAtIso);

      if (admission.outcome.accepted) {
        const newEvent: AuthorityEvent | undefined = admission.nextState.canonicalStore[admission.nextState.canonicalStore.length - 1];
        if (newEvent === undefined) {
          throw new Error("processDraft accepted the CAPABILITY_ISSUED draft but produced no new canonical event — unreachable in practice.");
        }
        // E. event + idempotence, inserted before the SAME COMMIT —
        // never observable apart, per the design report's objective #3/#4.
        await insertEvent(client, newEvent);
        await insertIdempotencyRow(
          client,
          authenticatedPrincipal,
          clientIdempotencyKey,
          command,
          decision,
          newEvent.event_id,
          decision.capability.capability_id,
          newEvent.sequence,
          this.readInfrastructureClock(),
        );
        return { outcome: "EXECUTED", result: decision };
      }

      if (admission.outcome.reasonCode === "BUSINESS_ID_COLLISION") {
        // The one deterministic, modeled rejection this transaction can
        // itself produce at admission time: the generator handed out a
        // capability_id that ingest.ts's businessIdOf already protects.
        // Fail-closed, never an infrastructure exception — this is a
        // business outcome, and it is idempotent exactly like any other.
        // I32: a ticket for the same ACTION is refused by the kernel (ACTION_ALREADY_TICKETED) before
        // this point, under the same lock and the same fresh snapshot; a writer that bypasses the lock
        // cannot reach here either, it hits the unique index and the transaction throws. What is left
        // is the generator handing out a capability_id that is already taken.
        const failureResult: IssueCapabilityResult = { ok: false, reason: "CAPABILITY_ID_COLLISION", capability_id: decision.capability.capability_id };
        await insertIdempotencyRow(client, authenticatedPrincipal, clientIdempotencyKey, command, failureResult, undefined, undefined, undefined, this.readInfrastructureClock());
        return { outcome: "EXECUTED", result: failureResult };
      }

      // Any other admission rejection (e.g. UNKNOWN_SCHEMA_VERSION from
      // I11's email-shaped-principal_id check) is not a path this
      // command's design ever modeled — a freshly-built draft rejected
      // for a reason that isn't the one deterministic case above is an
      // infrastructure anomaly, not a business outcome to fabricate a
      // result for. Let it roll back and surface.
      throw new Error(`unexpected admission rejection for a freshly-constructed CAPABILITY_ISSUED draft: ${admission.outcome.reasonCode}`);
    }
  }
}
