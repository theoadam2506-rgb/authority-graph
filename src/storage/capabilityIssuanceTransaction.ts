/**
 * PR4B-3A — the transactional boundary the PR4B-3 design report called for,
 * InMemory only (no Postgres, no SQL, no `pg_advisory_xact_lock` here — see
 * `PostgresEventStore`, entirely unmodified). This module orchestrates the
 * already-existing PURE functions (`issueCapability`,
 * `issueCapabilityIdempotently`) and the already-existing storage primitive
 * (`InMemoryEventStore`); it introduces no new business/authority decision
 * of its own. Both of those stay exactly as pure and Postgres-ignorant as
 * they already were — nothing here reaches into their internals or asks
 * them to change how they decide anything.
 *
 * WHAT "TRANSACTIONAL" MEANS HERE: a real, explicit critical section — not
 * an accident of `InMemoryEventStore.append()` happening to contain no
 * `await`. `InMemoryCapabilityIssuanceTransaction.issue()` chains every
 * call onto a private promise queue: call N+1's critical section does not
 * begin until call N's has fully settled, REGARDLESS of how many `await`s
 * live inside it. This is the same explicit-mutex idiom as any promise-
 * chain mutex; it does not depend on, and would keep working even if,
 * `InMemoryEventStore`'s own internals grew an `await` tomorrow.
 *
 * WHAT THIS QUEUE DOES NOT PROVIDE (audited, PR4B-3A.5 — read before
 * trusting either guarantee beyond what is stated):
 *   - SCOPE OF THE MUTEX: the queue is a field of ONE
 *     `InMemoryCapabilityIssuanceTransaction` instance. It serializes
 *     `issue()` calls made through THAT instance, and nothing else. A
 *     second instance wrapping the same `InMemoryEventStore`, or any other
 *     code holding a direct reference to that same store and calling its
 *     public `append()`/`getEvents()` methods, is not serialized against
 *     it at all — `decision_sequence + 1 === event.sequence` is guaranteed
 *     only for writes that go through THIS transactional boundary, never
 *     against a writer that bypasses it and touches the underlying
 *     `EventSource` directly. The correct operating assumption is: once a
 *     store is wrapped in a `CapabilityIssuanceTransaction`, nothing else
 *     may write `CAPABILITY_ISSUED` events into it directly.
 *   - CRASH ATOMICITY: the queue provides serialization/isolation between
 *     `issue()` calls — it does NOT provide all-or-nothing atomicity
 *     within one call. `runCriticalSection` below performs `store.append()`
 *     and then updates `this.idempotencyState` as two separate JS
 *     statements, with no rollback or copy-on-write behind either. In
 *     this in-memory model a "crash" between them is not an independently
 *     observable failure mode (the whole process, and thus both pieces of
 *     state, vanish together) — but this is a property of the model, not
 *     a guarantee this code enforces by construction. A real Postgres
 *     transaction (PR4B-3B) closes this gap for real, via an actual
 *     COMMIT/ROLLBACK boundary this InMemory model has no equivalent of.
 *     No InMemory rollback or copy-on-write is added here to simulate one.
 *
 * OBSERVABLE SEMANTICS a future Postgres implementation must reproduce —
 * each qualified by the two limits above:
 *   - exactly one canonical CAPABILITY_ISSUED per (requester, operation,
 *     idempotency key) — a second call with the same scope and the same
 *     command is REPLAYED, never re-executed;
 *   - a second call with the same scope and a DIFFERENT command is
 *     IDEMPOTENCY_CONFLICT;
 *   - the canonical event's `sequence` is always exactly
 *     `decision_sequence + 1` for every write that goes through this
 *     transactional boundary — the snapshot the decision was made against
 *     and the store the event is written into are the same store, read and
 *     written inside one uninterrupted turn of the SAME instance;
 *   - a success idempotency record and its matching canonical event always
 *     become visible together, or neither does, at every point BETWEEN two
 *     `issue()` calls on the same instance (not necessarily mid-call, in
 *     the face of a fault — see CRASH ATOMICITY above);
 *   - `capability_id` is a protected business id (ingest.ts) — a collision
 *     (e.g. a broken/forced generator) is rejected fail-closed, and no
 *     success record is ever kept for a rejected emission.
 */
import type { AuthorityEvent, CapabilityIssuedPayload, DraftAuthorityEvent } from "../domain/events.js";
import { CURRENT_SCHEMA_VERSION, eventId, type ClientIdempotencyKey } from "../domain/types.js";
import type { AuthenticatedPrincipal } from "../domain/authenticatedPrincipal.js";
import type { IssueCapabilityCommand } from "../domain/capabilityCommand.js";
import type { IssueCapabilityDependencies, IssueCapabilityResult, IssuedCapabilityData } from "../engine/issueCapability.js";
import {
  EMPTY_IDEMPOTENCY_STATE,
  issueCapabilityIdempotently,
  replaceExecutedIdempotencyResult,
  type IdempotencyState,
} from "../engine/issueCapabilityIdempotency.js";
import { reconstructAuthorityTimeAt } from "../engine/grantValidation.js";
import { InMemoryEventStore } from "./eventStore.js";

export type CapabilityIssuanceOutcome =
  | { readonly outcome: "EXECUTED"; readonly result: IssueCapabilityResult }
  | { readonly outcome: "REPLAYED"; readonly result: IssueCapabilityResult }
  | { readonly outcome: "IDEMPOTENCY_CONFLICT" };

/**
 * The narrow, purpose-built contract PR4B-3's design report asked for — one
 * verb, dedicated to this one command. Not a generic transaction framework:
 * a future redemption command (Phase 6) gets its own interface if and when
 * it needs one, rather than this one growing options for a command it does
 * not yet serve.
 */
export interface CapabilityIssuanceTransaction {
  issue(
    authenticatedPrincipal: AuthenticatedPrincipal,
    clientIdempotencyKey: ClientIdempotencyKey,
    command: IssueCapabilityCommand,
    dependencies: IssueCapabilityDependencies,
  ): Promise<CapabilityIssuanceOutcome>;
}

/**
 * Builds the draft for a successful decision's canonical event. `event_id`
 * is deliberately derived from `capability_id` AND `action_id` together,
 * not `capability_id` alone: if it depended only on `capability_id`, a
 * forced/broken-generator collision (T8) would be caught by I8's existing
 * event_id dedup before the dedicated capability_id business-id check
 * (ingest.ts) ever ran, masking whether that check actually works. Two
 * different `action_id`s forced to share one `capability_id` still produce
 * two different `event_id`s, so the capability_id check is the one that
 * actually fires.
 *
 * `occurred_at` reuses `reconstructAuthorityTimeAt` — the same already-pure,
 * already-exported helper `issueCapability` itself uses to compute
 * `expires_at` — rather than any live clock read. `principal_id` is set to
 * the authenticated requester: still the documented vestige PR4B-1 already
 * established (CapabilityIssuedPayload's own docstring — no graph
 * participant "performs" this act), just a less arbitrary placeholder than
 * a magic constant borrowed from test fixtures.
 */
/** Exported (PR4B-3B) so `postgresCapabilityIssuanceTransaction.ts` builds the exact same draft shape — nothing about this construction is InMemory-specific. */
export function buildCapabilityIssuedDraft(
  authenticatedPrincipal: AuthenticatedPrincipal,
  snapshot: readonly AuthorityEvent[],
  data: IssuedCapabilityData,
): DraftAuthorityEvent {
  const payload: CapabilityIssuedPayload = {
    capability_id: data.capability_id,
    action_id: data.action_id,
    action_fingerprint: data.action_fingerprint,
    decision_sequence: data.decision_sequence,
    granted_chain_ref: data.granted_chain_ref,
    enforcement_point_id: data.enforcement_point_id,
    expires_at: data.expires_at,
  };
  return {
    event_id: eventId(`capability-issued:${data.capability_id}:${data.action_id}`),
    schema_version: CURRENT_SCHEMA_VERSION,
    occurred_at: reconstructAuthorityTimeAt(snapshot, data.decision_sequence),
    principal_id: authenticatedPrincipal.principalId,
    event_type: "CAPABILITY_ISSUED",
    payload,
  };
}

/**
 * InMemory implementation. Wraps an already-constructed `InMemoryEventStore`
 * (composition, not inheritance — the store keeps owning ingestion/sequence/
 * authority_time exactly as it already does for every other event type)
 * plus its own idempotency state, which — unlike PR4B-2's
 * `issueCapabilityIdempotently` — this object owns across calls, rather
 * than handing back to the caller to thread manually. That is precisely
 * why `issueCapabilityIdempotently` is still used AS-IS here (see its own
 * call below): nothing about its own REPLAYED/CONFLICT/EXECUTED decision
 * or its `commandsEqual`/scope-key rules needed to move or be duplicated —
 * only *who holds the state between calls* changed.
 */
export class InMemoryCapabilityIssuanceTransaction implements CapabilityIssuanceTransaction {
  private readonly store: InMemoryEventStore;
  private idempotencyState: IdempotencyState;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(store: InMemoryEventStore, initialIdempotencyState: IdempotencyState = EMPTY_IDEMPOTENCY_STATE) {
    this.store = store;
    this.idempotencyState = initialIdempotencyState;
  }

  issue(
    authenticatedPrincipal: AuthenticatedPrincipal,
    clientIdempotencyKey: ClientIdempotencyKey,
    command: IssueCapabilityCommand,
    dependencies: IssueCapabilityDependencies,
  ): Promise<CapabilityIssuanceOutcome> {
    // The mutex: THIS call's critical section is chained onto the queue —
    // it cannot start until every previously-queued call's critical
    // section (including all of its own internal awaits) has settled.
    const runThisCall = this.queue.then(() =>
      this.runCriticalSection(authenticatedPrincipal, clientIdempotencyKey, command, dependencies),
    );
    // Advance the queue regardless of this call's own success/failure, so
    // a rejected call never leaves the mutex permanently stuck.
    this.queue = runThisCall.then(
      () => undefined,
      () => undefined,
    );
    return runThisCall;
  }

  /** Read-only introspection for tests/audit — not part of the interface above, mirrors InMemoryEventStore.getSecurityLog()'s own convention. */
  snapshotIdempotencyState(): IdempotencyState {
    return this.idempotencyState;
  }

  private async runCriticalSection(
    authenticatedPrincipal: AuthenticatedPrincipal,
    clientIdempotencyKey: ClientIdempotencyKey,
    command: IssueCapabilityCommand,
    dependencies: IssueCapabilityDependencies,
  ): Promise<CapabilityIssuanceOutcome> {
    // The snapshot this whole turn decides against and writes into — read
    // once, at the top of this exclusive turn. Nothing else can mutate
    // `this.store` until this function returns (the queue guarantees it),
    // so this snapshot and the sequence the eventual write receives are
    // never separated by any concurrent write.
    const snapshot = await this.store.getEvents();

    const idempotent = issueCapabilityIdempotently(this.idempotencyState, snapshot, authenticatedPrincipal, clientIdempotencyKey, command, dependencies);

    if (idempotent.outcome === "IDEMPOTENCY_CONFLICT") {
      this.idempotencyState = idempotent.nextState;
      return { outcome: "IDEMPOTENCY_CONFLICT" };
    }

    if (idempotent.outcome === "REPLAYED") {
      this.idempotencyState = idempotent.nextState;
      return { outcome: "REPLAYED", result: idempotent.result };
    }

    // EXECUTED. If the pure decision itself rejected (REQUESTER_MISMATCH,
    // CAPACITY_EXCEEDED, ...), there is nothing to ingest — the recorded
    // failure is already correct.
    if (!idempotent.result.ok) {
      this.idempotencyState = idempotent.nextState;
      return { outcome: "EXECUTED", result: idempotent.result };
    }

    // ok:true — attempt to make it canonical. `issueCapabilityIdempotently`
    // has ALREADY recorded this ok:true result into `idempotent.nextState`
    // under this scope's key — that record is only correct if ingestion
    // below actually succeeds. If it does not (capability_id collision),
    // it is corrected below before ever being committed to
    // `this.idempotencyState` — a success record is never observable
    // without its matching canonical event (T7).
    const draft = buildCapabilityIssuedDraft(authenticatedPrincipal, snapshot, idempotent.result.capability);
    const appended = await this.store.append([draft]);
    const outcome = appended.outcomes[0];

    if (outcome !== undefined && outcome.accepted) {
      this.idempotencyState = idempotent.nextState;
      return { outcome: "EXECUTED", result: idempotent.result };
    }

    // Ingestion rejected the draft — fail-closed. Never mask this as the
    // ok:true success `issueCapabilityIdempotently` optimistically
    // recorded; correct that one scope's entry to the true outcome before
    // committing. This module never touches the idempotency state's
    // internal key representation or record shape itself —
    // `replaceExecutedIdempotencyResult` owns both, and fails closed on
    // its own if the record it expects to correct is not the one it
    // finds (see its own docstring).
    const failureResult: IssueCapabilityResult = {
      ok: false,
      reason: "CAPABILITY_ID_COLLISION",
      capability_id: idempotent.result.capability.capability_id,
    };
    this.idempotencyState = replaceExecutedIdempotencyResult(idempotent.nextState, authenticatedPrincipal, clientIdempotencyKey, command, failureResult);
    return { outcome: "EXECUTED", result: failureResult };
  }
}
