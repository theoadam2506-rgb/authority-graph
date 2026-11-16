/**
 * V1 — compile-time proof that CAPABILITY_REDEEMED is Authority-generated:
 * `submitExternalEvents` must not accept a hand-built one, exactly like
 * CAPABILITY_ISSUED (tests/domain/eventClassification.type-guards.ts).
 * Checked by `tsc --noEmit` only (no `.test.ts` suffix).
 */
import type { DraftAuthorityEvent } from "../../src/domain/events.js";
import type { AuthorityGeneratedDraftEvent, ExternalDraftAuthorityEvent } from "../../src/domain/eventClassification.js";
import { actionId, capabilityId, enforcementPointId, iso8601, schemaVersion, sequenceNumber } from "../../src/domain/types.js";
import { InMemoryEventStore } from "../../src/storage/eventStore.js";
import { submitExternalEvents } from "../../src/storage/writeSurfaces.js";
import { THEO } from "../fixtures/scenarios.js";
import { evt } from "../fixtures/ids.js";

const redeemedDraft: DraftAuthorityEvent = {
  event_id: evt("r-1"),
  schema_version: schemaVersion(1),
  occurred_at: iso8601("2025-01-01T00:00:00.000Z"),
  principal_id: THEO,
  event_type: "CAPABILITY_REDEEMED",
  payload: {
    capability_id: capabilityId("cap-1"),
    action_id: actionId("act-1"),
    action_fingerprint: "0".repeat(64) as never,
    decision_sequence: sequenceNumber(1),
    enforcement_point_id: enforcementPointId("ep-1"),
  },
};

// @ts-expect-error a CAPABILITY_REDEEMED draft must not be assignable to ExternalDraftAuthorityEvent
const asExternal: ExternalDraftAuthorityEvent = redeemedDraft;
const asGenerated: AuthorityGeneratedDraftEvent = redeemedDraft;

const store = new InMemoryEventStore({ authorityTime: () => iso8601("2025-01-01T00:00:00.000Z") });
// @ts-expect-error submitExternalEvents must not accept an Authority-generated CAPABILITY_REDEEMED
void submitExternalEvents(store, [redeemedDraft]);

void [asExternal, asGenerated];
