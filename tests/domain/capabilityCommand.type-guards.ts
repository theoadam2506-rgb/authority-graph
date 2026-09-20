/**
 * PR4B-1 — compile-time-only proof that `IssueCapabilityCommand` cannot
 * carry any of the four Authority-controlled fields, and that
 * `ClientIdempotencyKey` remains distinct from `CapabilityId` (already
 * established in PR1's tests/domain/capability-ids.type-guards.ts;
 * reconfirmed here so this PR's own test suite is self-contained). Checked
 * exclusively by `tsc --noEmit` — see the sibling `eventClassification.
 * type-guards.ts` for the shared convention this file follows.
 */
import { computeActionFingerprint } from "../../src/domain/events.js";
import { actionId, capabilityId, clientIdempotencyKey, enforcementPointId, monetaryParameters, sequenceNumber, type CapabilityId, type ClientIdempotencyKey } from "../../src/domain/types.js";
import type { IssueCapabilityCommand } from "../../src/domain/capabilityCommand.js";
import { PURCHASE_ORDER_CREATE } from "../fixtures/scenarios.js";
import { delegation } from "../fixtures/ids.js";

// 6. IssueCapabilityCommand carries none of the four Authority-controlled
// fields — excess-property checking on a direct object literal catches
// each one individually.

const withCapabilityId: IssueCapabilityCommand = {
  action_id: actionId("act-1"),
  enforcement_point_id: enforcementPointId("ep-1"),
  // @ts-expect-error IssueCapabilityCommand must not accept capability_id
  capability_id: capabilityId("cap-1"),
};

const withDecisionSequence: IssueCapabilityCommand = {
  action_id: actionId("act-1"),
  enforcement_point_id: enforcementPointId("ep-1"),
  // @ts-expect-error IssueCapabilityCommand must not accept decision_sequence
  decision_sequence: sequenceNumber(1),
};

const withGrantedChainRef: IssueCapabilityCommand = {
  action_id: actionId("act-1"),
  enforcement_point_id: enforcementPointId("ep-1"),
  // @ts-expect-error IssueCapabilityCommand must not accept granted_chain_ref
  granted_chain_ref: [{ kind: "delegation", delegation_id: delegation("d-1") }],
};

const withActionFingerprint: IssueCapabilityCommand = {
  action_id: actionId("act-1"),
  enforcement_point_id: enforcementPointId("ep-1"),
  // @ts-expect-error IssueCapabilityCommand must not accept action_fingerprint
  action_fingerprint: computeActionFingerprint(PURCHASE_ORDER_CREATE, monetaryParameters({ value: 500, currency: "EUR" })),
};

// The minimal, correct shape compiles cleanly.
const valid: IssueCapabilityCommand = {
  action_id: actionId("act-1"),
  enforcement_point_id: enforcementPointId("ep-1"),
};

// 7. ClientIdempotencyKey remains distinct from CapabilityId.
const key: ClientIdempotencyKey = clientIdempotencyKey("key-1");
// @ts-expect-error ClientIdempotencyKey must not be assignable to CapabilityId
const keyAsCapability: CapabilityId = key;
const cap: CapabilityId = capabilityId("cap-1");
// @ts-expect-error CapabilityId must not be assignable to ClientIdempotencyKey
const capAsKey: ClientIdempotencyKey = cap;

void [withCapabilityId, withDecisionSequence, withGrantedChainRef, withActionFingerprint, valid, keyAsCapability, capAsKey];
