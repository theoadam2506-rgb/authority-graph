/**
 * EventSource — the real ingestion path (PROMPT 4), replacing `ingestAll`
 * for anything that isn't a one-shot test batch. Honors the contract already
 * documented in src/engine/ingest.ts's docstring:
 *
 *   - owns the next-sequence counter, continuous across appends (a store
 *     that has accepted 1..50 numbers the next append 51..80, never
 *     restarting at 1);
 *   - `recorded_at` comes from its own infrastructure clock read — that is
 *     I/O, and it happens here and nowhere else in this codebase;
 *   - `authority_time` comes from the same `IngestionClock` dependency
 *     shape `ingestAll` already uses, applied across the store's whole
 *     lifetime rather than one batch;
 *   - event_id and business-id uniqueness are checked against the store's
 *     *complete* history, not just the current append's batch;
 *   - the caller never supplies `sequence`.
 *
 * Exactly three operations, never more: `append`, `getEvents`,
 * `getBySequence`. No `update`, no `delete` — not even internally, not even
 * to "fix" something: SPEC.md I3 (append-only) is a promise about the whole
 * architecture, and this is where it would first be betrayed if it were
 * going to be. Every event this module returns is a plain, structurally
 * frozen (`readonly`) value; nothing here ever hands out a mutable
 * reference into its own storage.
 *
 * Two implementations behind `EventSource`: `InMemoryEventStore` (tests) and
 * `PostgresEventStore` (src/storage/postgresEventStore.ts). Postgres is a
 * journal, never a decision-maker: no authority logic in SQL, no triggers,
 * no views computing a permission — every accept/reject decision is made in
 * this module's `processDraft` (imported, not reimplemented) before a single
 * row is written.
 */
import type { AuthorityEvent, AuthorityEventType, CanonicalStore, DraftAuthorityEvent } from "../domain/events.js";
import type { IngestOutcome, PrincipalId, SecurityLogEntry, SequenceNumber } from "../domain/types.js";
import { advanceTrustedTime, processDraft, type IngestionClock, type IngestionState } from "../engine/ingest.js";

export interface EventFilter {
  readonly eventType?: AuthorityEventType;
  readonly principalId?: PrincipalId;
}

export interface SequenceRange {
  readonly from?: SequenceNumber; // inclusive; default: the earliest event
  readonly to?: SequenceNumber; // inclusive; default: the latest event
}

export interface AppendResult {
  /** One outcome per draft, in the order given to `append`. */
  readonly outcomes: readonly IngestOutcome[];
}

/**
 * The storage-agnostic contract. Every method is async because one
 * implementation (Postgres) genuinely performs I/O; `InMemoryEventStore`
 * simply resolves immediately, so callers can treat both uniformly.
 */
export interface EventSource {
  append(drafts: readonly DraftAuthorityEvent[]): Promise<AppendResult>;
  getEvents(filter?: EventFilter): Promise<CanonicalStore>;
  getBySequence(range: SequenceRange): Promise<CanonicalStore>;
}

export function matchesFilter(event: AuthorityEvent, filter: EventFilter | undefined): boolean {
  if (filter === undefined) {
    return true;
  }
  if (filter.eventType !== undefined && event.event_type !== filter.eventType) {
    return false;
  }
  if (filter.principalId !== undefined && event.principal_id !== filter.principalId) {
    return false;
  }
  return true;
}

export function matchesSequenceRange(event: AuthorityEvent, range: SequenceRange): boolean {
  if (range.from !== undefined && event.sequence < range.from) {
    return false;
  }
  if (range.to !== undefined && event.sequence > range.to) {
    return false;
  }
  return true;
}

/**
 * In-memory `EventSource`, for tests and local experimentation. Keeps one
 * `IngestionState` alive across every `append()` call — that persistence
 * (within the lifetime of one instance) is exactly what gives event_id and
 * business-id uniqueness, and sequence continuity, their "whole history"
 * scope instead of `ingestAll`'s "one batch" scope.
 */
export class InMemoryEventStore implements EventSource {
  private state: IngestionState;
  private readonly clock: IngestionClock;
  private lastTrustedTimeMs: number | undefined;
  /** Infrastructure clock read for `recorded_at` — I/O, isolated to this one call site. */
  private readonly readInfrastructureClock: () => string;
  /**
   * SPEC.md/EVENT_MODEL.md, "Séparation store canonique / journal de
   * sécurité": every rejected draft's entry, append-only, in arrival order.
   * Deliberately NOT part of `EventSource` (still exactly three operations
   * there) — this is a separate, additional read capability every concrete
   * store offers for operational/audit introspection, not a fourth store
   * primitive. No corresponding write/delete method exists; entries are only
   * ever pushed by `append()` itself.
   */
  private readonly securityLog: SecurityLogEntry[] = [];

  constructor(clock: IngestionClock, initialState?: IngestionState, readInfrastructureClock?: () => string) {
    this.clock = clock;
    this.state = initialState ?? { canonicalStore: [], seenByEventId: new Map(), seenBusinessIds: new Set() };
    this.readInfrastructureClock = readInfrastructureClock ?? (() => new Date().toISOString());
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async append(drafts: readonly DraftAuthorityEvent[]): Promise<AppendResult> {
    const outcomes: IngestOutcome[] = [];
    for (const [index, draft] of drafts.entries()) {
      const advanced = advanceTrustedTime(this.lastTrustedTimeMs, this.clock.authorityTime(draft, index));
      this.lastTrustedTimeMs = advanced.ms;
      // recorded_at is infrastructure I/O, read here and only here.
      const recordedAtIso = this.readInfrastructureClock();

      const result = processDraft(this.state, draft, advanced.iso, recordedAtIso);
      outcomes.push(result.outcome);
      if (result.securityLogEntry !== undefined) {
        this.securityLog.push(result.securityLogEntry);
      }
      this.state = result.nextState;
    }
    return { outcomes };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getEvents(filter?: EventFilter): Promise<CanonicalStore> {
    return this.state.canonicalStore.filter((event) => matchesFilter(event, filter));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getBySequence(range: SequenceRange): Promise<CanonicalStore> {
    return this.state.canonicalStore.filter((event) => matchesSequenceRange(event, range));
  }

  /** Not part of `EventSource` — see the field docstring above. */
  // eslint-disable-next-line @typescript-eslint/require-await
  async getSecurityLog(): Promise<readonly SecurityLogEntry[]> {
    return [...this.securityLog];
  }
}
