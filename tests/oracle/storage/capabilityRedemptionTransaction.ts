/**
 * V1 — the transactional boundary for redemption, in memory only (no
 * PostgreSQL here: that is a separate, later change). It orchestrates the
 * pure `redeemCapability` kernel and the existing `InMemoryEventStore`; it
 * adds no authority decision of its own.
 *
 * Guarantees, and their exact scope (three independent layers):
 *  1. PER-STORE MUTEX. Every redemption over the same `InMemoryEventStore`
 *     object, through ANY number of transaction instances, is serialized by
 *     one promise-chain mutex keyed on the store (a WeakMap). A second
 *     redemption therefore takes its snapshot only after the first finished
 *     and sees its CAPABILITY_REDEEMED (ALREADY_REDEEMED). This layer does not
 *     depend on any identifier being unique.
 *  2. INGESTION. A second CAPABILITY_REDEEMED for a capability_id is refused as
 *     a business-id collision (I28), whatever its event_id, so even a writer
 *     that bypasses the mutex cannot create two.
 *  3. SUCCESS MEANS "OUR EVENT, RIGHT AFTER OUR SNAPSHOT". `REDEEMED` is
 *     returned only if the appended event landed at `decision_sequence + 1`.
 *     Any other writer appending in between yields CONCURRENT_WRITE_DETECTED,
 *     never REDEEMED. The ticket is then consumed (append-only: the event
 *     exists) but NOTHING is authorized; the caller must authorize again. The
 *     event is recognisable afterwards: its sequence is not
 *     `decision_sequence + 1` (see `validateRedemptionEvent`).
 *
 * Scope of the attempt-id counter (read before reusing anything here): each
 * attempt's event_id embeds an attempt id from an injectable generator whose
 * default is a PROCESS-WIDE COUNTER. That counter is unique only within one
 * process and one lifetime: it restarts at 1 after a restart and is
 * independent across processes. It is therefore NOT an exclusion mechanism and
 * is private to this module (not exported); layers 1 to 3 above are. A
 * persistent implementation must not reuse it: it has to rely on the
 * database's own atomicity (SPEC I28, "persistent stores").
 *
 * Not provided: anything about the external effect (at-most-once effect is
 * the target's job), crash atomicity (in-memory model), and protection
 * against a writer that forges an Authority-generated event straight into the
 * store (THREAT_MODEL A31/A37: such an event can burn a ticket, it can never
 * grant authority).
 */
import type { AuthenticatedPrincipal } from "../../../src/domain/authenticatedPrincipal.js";
import type { RedeemCapabilityCommand } from "../../../src/domain/capabilityCommand.js";
import type { CapabilityRedeemedPayload, DraftAuthorityEvent } from "../../../src/domain/events.js";
import { CURRENT_SCHEMA_VERSION, eventId, type Iso8601 } from "../../../src/domain/types.js";
import { redeemCapability, type RedeemCapabilityResult, type RedeemedCapabilityData } from "../../../src/engine/redeemCapability.js";
import type { InMemoryEventStore } from "./eventStore.js";

export interface CapabilityRedemptionTransaction {
  /** `authorityTime` is the caller-supplied trusted instant (never read from a clock here). */
  redeem(authenticatedPrincipal: AuthenticatedPrincipal, command: RedeemCapabilityCommand, authorityTime: Iso8601): Promise<RedeemCapabilityResult>;
}

/**
 * Builds the draft for one redemption ATTEMPT. `attemptId` is required (no
 * default on purpose): the event_id must differ per attempt, otherwise two
 * attempts decided on the same snapshot would build byte-identical drafts,
 * ingestion (I8) would accept the second as an idempotent duplicate, and both
 * callers could be told "redeemed". Distinct ids make the second a
 * business-id collision instead. Uniqueness of the id is the CALLER's
 * responsibility and is only a second line of defence (see the module doc).
 */
export function buildCapabilityRedeemedDraft(
  authenticatedPrincipal: AuthenticatedPrincipal,
  authorityTime: Iso8601,
  data: RedeemedCapabilityData,
  attemptId: number | string,
): DraftAuthorityEvent {
  const payload: CapabilityRedeemedPayload = {
    capability_id: data.capability_id,
    action_id: data.action_id,
    action_fingerprint: data.action_fingerprint,
    decision_sequence: data.decision_sequence,
    enforcement_point_id: data.enforcement_point_id,
  };
  return {
    event_id: eventId(`capability-redeemed:${data.capability_id}:attempt-${attemptId}`),
    schema_version: CURRENT_SCHEMA_VERSION,
    occurred_at: authorityTime,
    principal_id: authenticatedPrincipal.principalId,
    event_type: "CAPABILITY_REDEEMED",
    payload,
  };
}

// Private: unique within one process lifetime only. See the module doc.
let processAttemptCounter = 0;
const defaultNextAttemptId = (): number => ++processAttemptCounter;

/** One mutex per store OBJECT, shared by every transaction instance wrapping it. */
const storeQueues = new WeakMap<InMemoryEventStore, Promise<unknown>>();

export interface InMemoryRedemptionOptions {
  /** Attempt id source. Default: a process-wide counter (not an exclusion mechanism). */
  readonly nextAttemptId?: () => number | string;
}

export class InMemoryCapabilityRedemptionTransaction implements CapabilityRedemptionTransaction {
  private readonly store: InMemoryEventStore;
  private readonly nextAttemptId: () => number | string;

  constructor(store: InMemoryEventStore, options: InMemoryRedemptionOptions = {}) {
    this.store = store;
    this.nextAttemptId = options.nextAttemptId ?? defaultNextAttemptId;
  }

  redeem(authenticatedPrincipal: AuthenticatedPrincipal, command: RedeemCapabilityCommand, authorityTime: Iso8601): Promise<RedeemCapabilityResult> {
    const previous = storeQueues.get(this.store) ?? Promise.resolve();
    const run = previous.then(() => this.criticalSection(authenticatedPrincipal, command, authorityTime));
    storeQueues.set(
      this.store,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async criticalSection(authenticatedPrincipal: AuthenticatedPrincipal, command: RedeemCapabilityCommand, authorityTime: Iso8601): Promise<RedeemCapabilityResult> {
    const snapshot = await this.store.getEvents();
    const decision = redeemCapability(snapshot, authenticatedPrincipal, command, authorityTime);
    if (!decision.ok) {
      return decision;
    }

    const draft = buildCapabilityRedeemedDraft(authenticatedPrincipal, authorityTime, decision.redemption, this.nextAttemptId());
    const appended = await this.store.append([draft], authorityTime);
    const outcome = appended.outcomes[0];

    if (outcome === undefined || !outcome.accepted) {
      return {
        ok: false,
        reason: outcome !== undefined && outcome.reasonCode === "STALE_AUTHORITY_TIME" ? "STALE_AUTHORITY_TIME" : "REDEMPTION_COLLISION",
      };
    }
    if (Number(outcome.sequence) !== Number(decision.redemption.decision_sequence) + 1) {
      // The event IS in the log (append-only): the ticket is consumed, nothing is authorized.
      return { ok: false, reason: "CONCURRENT_WRITE_DETECTED", detail: { ticketConsumed: true, redemptionSequence: outcome.sequence } };
    }
    return decision;
  }
}
