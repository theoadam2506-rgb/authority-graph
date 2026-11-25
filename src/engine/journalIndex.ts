/**
 * Call-local lookup index over a journal snapshot (performance only).
 *
 * WHAT THIS IS. A throw-away `Map` built from ONE array, used for the duration of ONE engine call, then dropped.
 * It is never stored on the journal, never shared between calls, never keyed by anything that outlives the call,
 * and it makes no assumption about the storage: it is rebuilt from exactly the array the caller passes in.
 *
 * WHAT IT MUST NOT CHANGE. Each lookup returns exactly what the linear scan it replaces returns:
 *   - `findActionRequested`: the FIRST event, in array order, with `event_type === "ACTION_REQUESTED"` and
 *     `payload.action_id === id`;
 *   - `findDelegation`: the FIRST event, in array order, whose type is DELEGATION_CREATED or SUBDELEGATION_CREATED
 *     and whose `payload.delegation_id === id`.
 *
 * MALFORMED JOURNALS. The original scans can THROW on a malformed event (for instance a matching type with a
 * missing payload). To keep that behaviour byte for byte, the index is built inside a `try`; if the build meets
 * ANY anomaly (a throw, a null event, a null payload on an indexed type, a key that is not a string) the index
 * marks itself UNSAFE and every lookup delegates to the original linear scan, which then behaves exactly as before,
 * including the error it throws. The index therefore only ever answers when the original scan provably could
 * not have thrown on this array.
 */
import type { ActionId, DelegationId } from "../domain/types.js";
import type { AuthorityEvent, CanonicalStore } from "../domain/events.js";

type ActionRequestedEvent = Extract<AuthorityEvent, { readonly event_type: "ACTION_REQUESTED" }>;
type DelegationLikeEvent = Extract<AuthorityEvent, { readonly event_type: "DELEGATION_CREATED" | "SUBDELEGATION_CREATED" }>;

export class JournalLookup {
  private built = false;
  private unsafe = false;
  private readonly actions = new Map<string, ActionRequestedEvent>();
  private readonly delegations = new Map<string, DelegationLikeEvent>();

  constructor(private readonly store: CanonicalStore) {}

  private build(): void {
    this.built = true;
    try {
      for (const event of this.store) {
        const type = event.event_type;
        if (type === "ACTION_REQUESTED") {
          const key: unknown = event.payload.action_id;
          if (typeof key !== "string") continue; // a non-string id can never equal a string id under `===`
          if (!this.actions.has(key)) this.actions.set(key, event);
        } else if (type === "DELEGATION_CREATED" || type === "SUBDELEGATION_CREATED") {
          const key: unknown = event.payload.delegation_id;
          if (typeof key !== "string") continue;
          if (!this.delegations.has(key)) this.delegations.set(key, event);
        }
      }
    } catch {
      this.unsafe = true;
      this.actions.clear();
      this.delegations.clear();
    }
  }

  /** `scan` is the ORIGINAL linear lookup; it is used whenever the index cannot answer exactly. */
  actionRequested(id: ActionId, scan: (id: ActionId) => ActionRequestedEvent | undefined): ActionRequestedEvent | undefined {
    if (!this.built) this.build();
    if (this.unsafe || typeof id !== "string") return scan(id);
    return this.actions.get(id);
  }

  delegation(id: DelegationId, scan: (id: DelegationId) => DelegationLikeEvent | undefined): DelegationLikeEvent | undefined {
    if (!this.built) this.build();
    if (this.unsafe || typeof id !== "string") return scan(id);
    return this.delegations.get(id);
  }
}
