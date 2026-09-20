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
import type { CapabilityId, ClientIdempotencyKey, EventId, SequenceNumber } from "../domain/types.js";
import type { AuthenticatedPrincipal } from "../domain/authenticatedPrincipal.js";
import type { IssueCapabilityCommand } from "../domain/capabilityCommand.js";
import { issueCapability, type IssueCapabilityDependencies, type IssueCapabilityResult } from "../engine/issueCapability.js";
import { commandsEqual } from "../engine/issueCapabilityIdempotency.js";
import { advanceTrustedTime, processDraft, type IngestionClock } from "../engine/ingest.js";
import { buildCapabilityIssuedDraft, type CapabilityIssuanceOutcome, type CapabilityIssuanceTransaction } from "./capabilityIssuanceTransaction.js";
import { insertEvent, lockAuthorityEventsTable, readFreshIngestionState } from "./postgresEventStore.js";

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
export class PostgresCapabilityIssuanceTransaction implements CapabilityIssuanceTransaction {
  private readonly pool: Pool;
  private readonly clock: IngestionClock;
  private readonly readInfrastructureClock: () => string;

  constructor(pool: Pool, clock: IngestionClock, readInfrastructureClock: () => string = () => new Date().toISOString()) {
    this.pool = pool;
    this.clock = clock;
    this.readInfrastructureClock = readInfrastructureClock;
  }

  async issue(
    authenticatedPrincipal: AuthenticatedPrincipal,
    clientIdempotencyKey: ClientIdempotencyKey,
    command: IssueCapabilityCommand,
    dependencies: IssueCapabilityDependencies,
  ): Promise<CapabilityIssuanceOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Same lock domain as PostgresEventStore.append() — see this
      // module's own docstring and postgresEventStore.ts's.
      await lockAuthorityEventsTable(client);

      // A. lookup idempotence, under the lock.
      const existingRow = await lookupIdempotencyRow(client, authenticatedPrincipal, clientIdempotencyKey);
      if (existingRow !== undefined) {
        const persistedCommand = parseStoredCommand(existingRow.command);
        if (commandsEqual(persistedCommand, command)) {
          // REPLAYED: nothing mutated, no second decision, no new
          // capability_id, no new event — the persisted result IS the
          // answer.
          await client.query("COMMIT");
          return { outcome: "REPLAYED", result: parseStoredResult(existingRow.result) };
        }
        // IDEMPOTENCY_CONFLICT: same scope, different command. Nothing
        // written, nothing changed — COMMIT here only releases the lock
        // cleanly on a read-only transaction.
        await client.query("COMMIT");
        return { outcome: "IDEMPOTENCY_CONFLICT" };
      }

      // B. fresh canonical snapshot, read AFTER the lock is held — the
      // same snapshot the decision below is made against and the same
      // one the eventual INSERT's sequence is derived from. No writer
      // (this class or PostgresEventStore.append()) can mutate
      // authority_events between this read and this transaction's own
      // COMMIT, because both acquire the exact same advisory lock first.
      const state = await readFreshIngestionState(client);
      const snapshot = state.canonicalStore;

      // C. the pure decision — issueCapability never touches Postgres,
      // never authenticates, never reads a live clock.
      const decision = issueCapability(snapshot, authenticatedPrincipal, command, dependencies);

      if (!decision.ok) {
        // A normal business rejection (REQUESTER_MISMATCH, NOT_AUTHORIZED,
        // CAPACITY_EXCEEDED, ...) is itself idempotent: persist it under
        // this scope so a retry REPLAYs the same rejection rather than
        // re-deciding against a possibly-different future snapshot.
        await insertIdempotencyRow(client, authenticatedPrincipal, clientIdempotencyKey, command, decision, undefined, undefined, undefined, this.readInfrastructureClock());
        await client.query("COMMIT");
        return { outcome: "EXECUTED", result: decision };
      }

      // D. ok:true — build the draft and run it through the EXACT SAME
      // deterministic ingestion rules (processDraft) every other event
      // type already goes through. `advanceTrustedTime(undefined, ...)`
      // mirrors append()'s own per-batch-of-one usage: this transaction
      // only ever ingests a single draft, so there is no "previous draft
      // in this batch" to clamp against.
      const draft = buildCapabilityIssuedDraft(authenticatedPrincipal, snapshot, decision.capability);
      const advanced = advanceTrustedTime(undefined, this.clock.authorityTime(draft, 0));
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
        await client.query("COMMIT");
        return { outcome: "EXECUTED", result: decision };
      }

      if (admission.outcome.reasonCode === "BUSINESS_ID_COLLISION") {
        // The one deterministic, modeled rejection this transaction can
        // itself produce at admission time: the generator handed out a
        // capability_id that ingest.ts's businessIdOf already protects.
        // Fail-closed, never an infrastructure exception — this is a
        // business outcome, and it is idempotent exactly like any other.
        const failureResult: IssueCapabilityResult = { ok: false, reason: "CAPABILITY_ID_COLLISION", capability_id: decision.capability.capability_id };
        await insertIdempotencyRow(client, authenticatedPrincipal, clientIdempotencyKey, command, failureResult, undefined, undefined, undefined, this.readInfrastructureClock());
        await client.query("COMMIT");
        return { outcome: "EXECUTED", result: failureResult };
      }

      // Any other admission rejection (e.g. UNKNOWN_SCHEMA_VERSION from
      // I11's email-shaped-principal_id check) is not a path this
      // command's design ever modeled — a freshly-built draft rejected
      // for a reason that isn't the one deterministic case above is an
      // infrastructure anomaly, not a business outcome to fabricate a
      // result for. Let it roll back and surface.
      throw new Error(`unexpected admission rejection for a freshly-constructed CAPABILITY_ISSUED draft: ${admission.outcome.reasonCode}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
