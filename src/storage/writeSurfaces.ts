/**
 * PR4B-1 — names the distinction Correction 1 of the design report asks
 * for: PUBLIC COMMAND SURFACE vs INTERNAL PERSISTENCE PRIMITIVE. Read this
 * whole docstring before calling anything here, or before assuming this
 * file is a security boundary — it is explicitly NOT one yet.
 *
 * ============================================================
 * TYPE SAFETY != SECURITY BOUNDARY
 * ============================================================
 *
 * `submitExternalEvents` below is narrower, at the TYPE level, than
 * `EventSource.append` — it cannot be called with an
 * `AuthorityGeneratedDraftEvent` (e.g. a hand-built CAPABILITY_ISSUED)
 * without a compile error. This closes exactly one class of mistake: a
 * developer, writing ordinarily-typed application code, who reaches for
 * the wrong function by accident.
 *
 * It does NOT close, and does not claim to close:
 *   - a caller who imports `EventSource`/`InMemoryEventStore`/
 *     `PostgresEventStore` directly and calls `.append()` on it — every
 *     test in this repo, and demo/run.ts, legitimately do exactly this
 *     today, and must keep doing so (see "WHY EventSource.append() ITSELF
 *     IS NOT NARROWED" below);
 *   - a caller who casts (`as AuthorityGeneratedDraftEvent`, or simply
 *     constructs the object literal by hand — nothing stops that, exactly
 *     as nothing stops `as CapabilityId` elsewhere in this codebase);
 *   - a compromised or malicious process that already holds a live
 *     reference to a store instance, or to the underlying `pg.Pool`.
 *
 * The real boundary — the one that would actually stop those — is a
 * DEPLOYMENT-level separation: the concrete store instance (and whatever
 * credentials it needs) must never be constructible or reachable by
 * ordinary application code at all, only by the future command handler
 * (PR4B-2/PR4B-3). This file does not build that. It only gives the type
 * system, and future reviewers, a name for the seam where that boundary
 * will eventually be enforced.
 *
 * ============================================================
 * WHY EventSource.append() ITSELF IS NOT NARROWED
 * ============================================================
 *
 * The obvious-looking fix — change `EventSource.append`'s parameter type
 * from `readonly DraftAuthorityEvent[]` to `readonly
 * ExternalDraftAuthorityEvent[]` — was tried conceptually and rejected: it
 * would break already-committed, legitimate test usage. `tests/domain/
 * capability-issued.test.ts`, `tests/engine/capacity.test.ts`, and
 * `tests/engine/grantValidation.test.ts` all deliberately push
 * CAPABILITY_ISSUED drafts through `ingestAll`/`EventSource.append` to
 * exercise PR2/PR3/PR4A's pure logic against a real `CanonicalStore` —
 * that is correct, necessary test usage, not a security lapse, and must
 * keep working unmodified. `EventSource`/`append`/`ingestAll`/
 * `processDraft` collectively ARE, and remain, the INTERNAL PERSISTENCE
 * PRIMITIVE: generic, unrestricted, exactly as before. `submitExternalEvents`
 * is an ADDITIONAL, narrower entry point layered next to it — never a
 * replacement, and never itself modified to reject anything.
 */
import type { AppendResult, EventSource } from "./eventStore.js";
import type { ExternalDraftAuthorityEvent } from "../domain/eventClassification.js";

/**
 * The write entry point ordinary application code — and any future
 * external consumer of this library — should be steered toward for
 * asserting ordinary facts about the world (delegations, requests,
 * approvals, executions). It delegates to the exact same
 * `EventSource.append()` that has always existed; nothing about ingestion
 * itself changes. Its only effect is a compile-time one: its parameter
 * type excludes `AuthorityGeneratedDraftEvent`.
 */
export function submitExternalEvents(store: EventSource, drafts: readonly ExternalDraftAuthorityEvent[]): Promise<AppendResult> {
  return store.append(drafts);
}
