/**
 * Compile-time-only proof (test F) that a raw CAPABILITY_ISSUED event
 * cannot be handed to `remainingCapacity` in place of a `ValidatedGrant`.
 * Checked exclusively by `tsc --noEmit` — this file deliberately does not
 * end in `.test.ts` so vitest's `tests/**\/*.test.ts` include pattern never
 * tries to execute it (mirrors tests/domain/capability-ids.type-guards.ts).
 *
 * This does NOT prove `ValidatedGrant` cannot be forged — `Branded<>` is a
 * compile-time discipline against accidental misuse, identical in kind to
 * every other branded type in this codebase (see capacity.ts's own
 * docstring on `ValidatedGrant`). It proves only that the ordinary,
 * unremarkable way of using this API — passing an event where a
 * `ValidatedGrant` is expected — fails to compile, which is the property
 * test F asks for: making the mistake hard to make BY ACCIDENT.
 */
import { computeActionFingerprint } from "../../src/domain/events.js";
import { actionId, capabilityId, enforcementPointId, iso8601, monetaryParameters, schemaVersion, sequenceNumber } from "../../src/domain/types.js";
import { remainingCapacity, type CapabilityIssuedEvent, type ValidatedGrant } from "../../src/engine/capacity.js";
import { evt, delegation } from "../fixtures/ids.js";
import { EUR, PURCHASE_ORDER_CREATE, THEO } from "../fixtures/scenarios.js";

/** TEST-ONLY cast — see the identical helper and its docstring in capacity.test.ts. No production factory exists to do this. */
function testOnlyValidatedGrant(event: CapabilityIssuedEvent): ValidatedGrant {
  return { event } as ValidatedGrant;
}

const rawEvent: CapabilityIssuedEvent = {
  event_id: evt("capability-issued-type-guard"),
  schema_version: schemaVersion(1),
  occurred_at: iso8601("2025-01-01T00:00:00.000Z"),
  principal_id: THEO,
  sequence: sequenceNumber(1),
  authority_time: iso8601("2025-01-01T00:00:00.000Z"),
  recorded_at: iso8601("2025-01-01T00:00:00.000Z"),
  assurance_level: "ASSERTED_UNVERIFIED",
  event_type: "CAPABILITY_ISSUED",
  payload: {
    capability_id: capabilityId("cap-1"),
    action_id: actionId("act-1"),
    action_fingerprint: computeActionFingerprint(PURCHASE_ORDER_CREATE, monetaryParameters(EUR(700))),
    decision_sequence: sequenceNumber(1),
    granted_chain_ref: [{ kind: "delegation", delegation_id: delegation("d-1") }],
    enforcement_point_id: enforcementPointId("ep-1"),
    expires_at: iso8601("2025-01-01T00:05:00.000Z"),
  },
};

// @ts-expect-error a raw CapabilityIssuedEvent must not be assignable to ValidatedGrant
const forgedGrant: ValidatedGrant = rawEvent;

// @ts-expect-error remainingCapacity must not accept a bare event where ValidatedGrant[] is expected
remainingCapacity(delegation("d-1"), EUR(1000), [rawEvent], []);

// The test-only local cast compiles cleanly — it is a plain `as`, not a
// production-exported shortcut.
const realGrant: ValidatedGrant = testOnlyValidatedGrant(rawEvent);
remainingCapacity(delegation("d-1"), EUR(1000), [realGrant], []);

void [forgedGrant, realGrant];
