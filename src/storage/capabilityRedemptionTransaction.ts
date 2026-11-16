/**
 * V1 — the transactional boundary for redemption, in memory only (no
 * PostgreSQL here: that is a separate, later change). It orchestrates the
 * pure `redeemCapability` kernel and the existing `InMemoryEventStore`; it
 * adds no authority decision of its own.
 *
 * Guarantees, and their exact scope:
 *  - Calls made through ONE instance of this class are serialized by a
 *    promise-chain mutex (same idiom as `InMemoryCapabilityIssuanceTransaction`):
 *    two concurrent `redeem()` of the same ticket cannot both succeed; the
 *    second sees the first's CAPABILITY_REDEEMED and gets ALREADY_REDEEMED.
 *  - Independently of that mutex, ingestion refuses a second
 *    CAPABILITY_REDEEMED for a capability_id (business-id collision, I28), so
 *    two instances wrapping the same store still cannot both redeem.
 *  - Any OTHER writer (a revocation, an issuance, another transaction)
 *    appending between this call's snapshot and its own append is detected:
 *    the event this call wrote would not be at `decision_sequence + 1`. The
 *    call then reports CONCURRENT_WRITE_DETECTED and never REDEEMED. The
 *    ticket is consumed (append-only: the event exists) but nothing is
 *    authorized; the caller must authorize again. Fail-closed on purpose.
 *
 * Not provided: anything about the external effect (at-most-once effect is
 * the target's job), crash atomicity (in-memory model), and protection
 * against a writer that forges an Authority-generated event straight into the
 * store (THREAT_MODEL A31 applies to CAPABILITY_REDEEMED too: such an event
 * can burn a ticket, it can never grant authority).
 */
import type { AuthenticatedPrincipal } from "../domain/authenticatedPrincipal.js";
import type { RedeemCapabilityCommand } from "../domain/capabilityCommand.js";
import type { CapabilityRedeemedPayload, DraftAuthorityEvent } from "../domain/events.js";
import { CURRENT_SCHEMA_VERSION, eventId, type Iso8601 } from "../domain/types.js";
import { redeemCapability, type RedeemCapabilityResult, type RedeemedCapabilityData } from "../engine/redeemCapability.js";
import type { InMemoryEventStore } from "./eventStore.js";

export interface CapabilityRedemptionTransaction {
  /** `authorityTime` is the caller-supplied trusted instant (never read from a clock here). */
  redeem(authenticatedPrincipal: AuthenticatedPrincipal, command: RedeemCapabilityCommand, authorityTime: Iso8601): Promise<RedeemCapabilityResult>;
}

/**
 * Every redemption ATTEMPT gets its own event_id. This is load-bearing: if the
 * id depended only on the capability, two racing attempts decided on the same
 * snapshot would build byte-identical drafts, ingestion (I8) would treat the
 * second as an idempotent duplicate of the first and ACCEPT it, and both
 * callers would be told "redeemed": a double effect. With distinct ids the
 * second attempt is refused by the business-id rule (I28). The counter is
 * module-wide so it is unique across transaction instances in one process; it
 * is deterministic (call order), not random.
 */
let attemptCounter = 0;
const nextAttemptId = (): number => ++attemptCounter;

export function buildCapabilityRedeemedDraft(
  authenticatedPrincipal: AuthenticatedPrincipal,
  authorityTime: Iso8601,
  data: RedeemedCapabilityData,
  attemptId: number = nextAttemptId(),
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

export class InMemoryCapabilityRedemptionTransaction implements CapabilityRedemptionTransaction {
  private readonly store: InMemoryEventStore;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(store: InMemoryEventStore) {
    this.store = store;
  }

  redeem(authenticatedPrincipal: AuthenticatedPrincipal, command: RedeemCapabilityCommand, authorityTime: Iso8601): Promise<RedeemCapabilityResult> {
    const run = this.queue.then(() => this.criticalSection(authenticatedPrincipal, command, authorityTime));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async criticalSection(authenticatedPrincipal: AuthenticatedPrincipal, command: RedeemCapabilityCommand, authorityTime: Iso8601): Promise<RedeemCapabilityResult> {
    const snapshot = await this.store.getEvents();
    const decision = redeemCapability(snapshot, authenticatedPrincipal, command, authorityTime);
    if (!decision.ok) {
      return decision;
    }

    const draft = buildCapabilityRedeemedDraft(authenticatedPrincipal, authorityTime, decision.redemption);
    const appended = await this.store.append([draft], authorityTime);
    const outcome = appended.outcomes[0];

    if (outcome === undefined || !outcome.accepted) {
      return {
        ok: false,
        reason: outcome !== undefined && outcome.reasonCode === "STALE_AUTHORITY_TIME" ? "STALE_AUTHORITY_TIME" : "REDEMPTION_COLLISION",
      };
    }
    if (Number(outcome.sequence) !== Number(decision.redemption.decision_sequence) + 1) {
      return { ok: false, reason: "CONCURRENT_WRITE_DETECTED" };
    }
    return decision;
  }
}
