/**
 * PR4B-1 — compile-time-only proof of the write-boundary type split.
 * Checked exclusively by `tsc --noEmit` (this file deliberately does not
 * end in `.test.ts`, so vitest's `tests/**\/*.test.ts` include pattern
 * never tries to execute it — same convention as every other
 * `*.type-guards.ts` file in this repo).
 */
import { computeActionFingerprint, type DraftAuthorityEvent } from "../../src/domain/events.js";
import type { AuthorityGeneratedDraftEvent, ExternalDraftAuthorityEvent } from "../../src/domain/eventClassification.js";
import { capabilityId, enforcementPointId, iso8601, monetaryParameters, schemaVersion, sequenceNumber } from "../../src/domain/types.js";
import { actionId } from "../../src/domain/types.js";
import { PURCHASE_ORDER_CREATE, THEO } from "../fixtures/scenarios.js";
import { evt, delegation, principal } from "../fixtures/ids.js";
import { submitExternalEvents } from "../../src/storage/writeSurfaces.js";
import { InMemoryEventStore } from "../../src/storage/eventStore.js";

const fiveHundred = monetaryParameters({ value: 500, currency: "EUR" });

const capabilityDraft: DraftAuthorityEvent = {
  event_id: evt("cap-1"),
  schema_version: schemaVersion(1),
  occurred_at: iso8601("2025-01-01T00:00:00.000Z"),
  principal_id: THEO,
  event_type: "CAPABILITY_ISSUED",
  payload: {
    capability_id: capabilityId("cap-1"),
    action_id: actionId("act-1"),
    action_fingerprint: computeActionFingerprint(PURCHASE_ORDER_CREATE, fiveHundred),
    decision_sequence: sequenceNumber(1),
    granted_chain_ref: [{ kind: "delegation", delegation_id: delegation("d-1") }],
    enforcement_point_id: enforcementPointId("ep-1"),
    expires_at: iso8601("2025-01-01T00:05:00.000Z"),
  },
};

const delegationDraft: DraftAuthorityEvent = {
  event_id: evt("d-1"),
  schema_version: schemaVersion(1),
  occurred_at: iso8601("2025-01-01T00:00:00.000Z"),
  principal_id: THEO,
  event_type: "DELEGATION_CREATED",
  payload: {
    delegation_id: delegation("d-1"),
    grantor_principal_id: THEO,
    grantor_type: "HUMAN_ROOT",
    grantee_principal_id: principal("agent"),
    capabilities: [PURCHASE_ORDER_CREATE],
    can_delegate: false,
    expires_at: { kind: "no_expiry" },
    parent_delegation_id: null,
  },
};

const actionRequestDraft: DraftAuthorityEvent = {
  event_id: evt("act-1"),
  schema_version: schemaVersion(1),
  occurred_at: iso8601("2025-01-01T00:00:00.000Z"),
  principal_id: principal("agent"),
  event_type: "ACTION_REQUESTED",
  payload: {
    action_id: actionId("act-1"),
    requesting_principal_id: principal("agent"),
    delegation_id: delegation("d-1"),
    capability_requested: PURCHASE_ORDER_CREATE,
    parameters: fiveHundred,
  },
};

// 1. CAPABILITY_ISSUED is not assignable to ExternalDraftAuthorityEvent.
// @ts-expect-error a raw CAPABILITY_ISSUED draft must not be assignable to ExternalDraftAuthorityEvent
const asExternal: ExternalDraftAuthorityEvent = capabilityDraft;

// 2. ACTION_REQUESTED remains assignable to ExternalDraftAuthorityEvent.
const actionAsExternal: ExternalDraftAuthorityEvent = actionRequestDraft;

// 3. DELEGATION_CREATED remains assignable to ExternalDraftAuthorityEvent.
const delegationAsExternal: ExternalDraftAuthorityEvent = delegationDraft;

// CAPABILITY_ISSUED is, symmetrically, assignable to AuthorityGeneratedDraftEvent.
const capabilityAsGenerated: AuthorityGeneratedDraftEvent = capabilityDraft;
// @ts-expect-error ACTION_REQUESTED must not be assignable to AuthorityGeneratedDraftEvent
const actionAsGenerated: AuthorityGeneratedDraftEvent = actionRequestDraft;

// 4. The narrow public command surface rejects a CAPABILITY_ISSUED draft...
const store = new InMemoryEventStore({ authorityTime: () => iso8601("2025-01-01T00:00:00.000Z") });
// @ts-expect-error submitExternalEvents must not accept an AuthorityGeneratedDraftEvent
void submitExternalEvents(store, [capabilityDraft]);
// ...but accepts an ordinary external draft without complaint.
void submitExternalEvents(store, [delegationDraft, actionRequestDraft]);

// 5. The underlying, unrestricted primitive (EventSource.append, via
// ingestAll/toDraft as every existing PR2/PR3/PR4A test already relies on)
// still fully accepts a CAPABILITY_ISSUED draft — this is not a regression,
// it is the documented, deliberate scope of "internal persistence
// primitive" (see writeSurfaces.ts's module docstring).
void store.append([capabilityDraft]);

void [asExternal, actionAsExternal, delegationAsExternal, capabilityAsGenerated, actionAsGenerated];
