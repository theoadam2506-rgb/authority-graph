/**
 * D1 (PROTOTYPE, not enabled by default) — one transaction, one advisory lock, ONE journal read per authorize() call.
 *
 * Today a new action costs four full journal reads: a lock-free read to find the request, the locked read inside `append()`, a lock-free read
 * for the read-only pre-check, and the locked read inside `issue()`. Here the same logic runs in ONE critical section: the lock is taken, the
 * journal is read once, and the request append, the pre-check and the issuance all work on that state (advanced in memory by the call's own
 * append). Nothing else may commit between them because every protocol-following writer needs the same lock.
 *
 * Differences with the sequential protocol are documented in docs/v1/D1_SINGLE_SNAPSHOT.md (the main one: a failure after the request was
 * appended now rolls the request back too).
 */
import type { CanonicalStore, DraftAuthorityEvent } from "../domain/events.js";
import type { AuthenticatedPrincipal } from "../domain/authenticatedPrincipal.js";
import type { IssueCapabilityCommand } from "../domain/capabilityCommand.js";
import type { ClientIdempotencyKey, Iso8601 } from "../domain/types.js";
import type { IssueCapabilityDependencies } from "../engine/issueCapability.js";
import type { IngestOutcome } from "../domain/types.js";
import type { CapabilityIssuanceOutcome } from "./capabilityIssuanceTransaction.js";

/** What the body of a single-snapshot call may do. `journal()` is the state read under the lock, advanced by this call's own appends. */
export interface LockedSnapshot {
  journal(): CanonicalStore;
  append(draft: DraftAuthorityEvent): Promise<IngestOutcome>;
  issue(principal: AuthenticatedPrincipal, key: ClientIdempotencyKey, command: IssueCapabilityCommand, dependencies: IssueCapabilityDependencies, authorityTime: Iso8601): Promise<CapabilityIssuanceOutcome>;
}

export interface SingleSnapshotTimings {
  /** ms between asking for a connection + BEGIN and holding the advisory lock. */
  readonly lockWaitMs: number;
  /** ms the advisory lock was held (lock granted → COMMIT/ROLLBACK returned). */
  readonly heldMs: number;
  /** ms of the one journal read. */
  readonly readMs: number;
  readonly events: number;
  readonly outcome: "COMMITTED" | "ROLLED_BACK";
}

export interface SingleSnapshotAuthorization {
  /** Runs `body` in one transaction under the advisory lock; COMMIT when it returns, ROLLBACK (and rethrow) when it throws. */
  run<T>(body: (snapshot: LockedSnapshot) => Promise<T>): Promise<T>;
}
