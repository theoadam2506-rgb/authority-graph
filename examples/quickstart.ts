/**
 * authority-graph — a minimal, honest quickstart.
 *
 * Every function and type used below is real, public production API
 * (src/domain/types.ts, src/domain/events.ts, src/engine/authority.ts) —
 * nothing here is a test-only fixture helper (those live under tests/ and
 * are not part of this project's public surface). Building an event by
 * hand, field by field, is exactly what an integrator does today; this
 * file does not pretend there is a shorter path that doesn't exist yet.
 *
 * The story:
 *   HUMAN_OWNER delegates purchase_order.create to AGENT_A, capped at
 *   2000 EUR. AGENT_A tries 1800 EUR (within the cap) and 4800 EUR (over
 *   it). Then a historical explanation is requested for the 1800 EUR
 *   action that actually ran.
 *
 * No database, no network, no API key, no Date.now() — the evaluation
 * instant (`authorityTime`) is always an explicit value you provide, not
 * a hidden call to the system clock. Run with: npm run quickstart
 */
import {
  computeActionFingerprint,
  type ChainLink,
  type DraftAuthorityEvent,
} from "../src/domain/events.js";
import {
  actionId,
  capability,
  delegationId,
  eventId,
  executionResultCode,
  monetaryParameters,
  money,
  noExpiry,
  principalId,
  sequenceNumber,
  thresholds,
  CURRENT_SCHEMA_VERSION,
  iso8601,
} from "../src/domain/types.js";
import { authorityAt, explain, ingestAll, type IngestionClock } from "../src/engine/authority.js";

// ---------------------------------------------------------------------------
// Identities and the one capability this story cares about. No personal
// data: these are generic role names, the same convention this repo's own
// test fixtures already use for anything meant to be read publicly.
// ---------------------------------------------------------------------------

const HUMAN_OWNER = principalId("human-owner");
const AGENT_A = principalId("agent-a");
const PURCHASE_ORDER_CREATE = capability("purchase_order", "create");

// authority_time is never derived from a live clock inside the engine —
// it is always a value the caller supplies. Here, a single fixed instant
// for the whole story is enough; a real deployment would read its own
// trusted clock once per ingested batch.
const EVALUATION_INSTANT = iso8601("2024-01-01T00:00:00.000Z");
const clock: IngestionClock = { authorityTime: () => EVALUATION_INSTANT };

// ---------------------------------------------------------------------------
// 1. HUMAN_OWNER delegates purchase_order.create to AGENT_A, capped at
//    2000 EUR (automatic and approval ceilings equal, so anything over the
//    cap is denied outright rather than requiring an approval step — kept
//    that way to keep this story to exactly two outcomes: AUTHORIZED and
//    DENIED).
// ---------------------------------------------------------------------------

const delegationId1 = delegationId("d-owner-agentA");

const delegationCreated: DraftAuthorityEvent = {
  event_id: eventId("evt-delegation-1"),
  schema_version: CURRENT_SCHEMA_VERSION,
  occurred_at: EVALUATION_INSTANT,
  principal_id: HUMAN_OWNER,
  event_type: "DELEGATION_CREATED",
  payload: {
    delegation_id: delegationId1,
    grantor_principal_id: HUMAN_OWNER,
    grantor_type: "HUMAN_ROOT",
    grantee_principal_id: AGENT_A,
    capabilities: [PURCHASE_ORDER_CREATE],
    can_delegate: false,
    expires_at: noExpiry,
    thresholds: thresholds(2000, 2000),
    parent_delegation_id: null,
  },
};

const afterDelegation = ingestAll([delegationCreated], clock);
const eventsAfterDelegation = afterDelegation.canonicalStore;

// ---------------------------------------------------------------------------
// 2. AGENT_A tries 1800 EUR — within the 2000 EUR cap.
//
// authorityAt is prospective: it never requires an ACTION_REQUESTED to
// exist. Evaluating it right after the delegation (atSequence: 1), before
// any action has even been requested, is the whole point.
// ---------------------------------------------------------------------------

const withinCap = authorityAt(
  eventsAfterDelegation,
  {
    agentId: AGENT_A,
    principalId: HUMAN_OWNER,
    capability: PURCHASE_ORDER_CREATE,
    parameters: monetaryParameters(money(1800, "EUR")),
  },
  { atSequence: sequenceNumber(1), authorityTime: EVALUATION_INSTANT },
);

if (withinCap.outcome !== "AUTHORIZED") {
  throw new Error(`expected AUTHORIZED for 1800 EUR, got ${withinCap.outcome}`);
}

// ---------------------------------------------------------------------------
// 3. AGENT_A tries 4800 EUR — over the 2000 EUR cap.
// ---------------------------------------------------------------------------

const overCap = authorityAt(
  eventsAfterDelegation,
  {
    agentId: AGENT_A,
    principalId: HUMAN_OWNER,
    capability: PURCHASE_ORDER_CREATE,
    parameters: monetaryParameters(money(4800, "EUR")),
  },
  { atSequence: sequenceNumber(1), authorityTime: EVALUATION_INSTANT },
);

if (overCap.outcome !== "DENIED") {
  throw new Error(`expected DENIED for 4800 EUR, got ${overCap.outcome}`);
}

// ---------------------------------------------------------------------------
// 4. AGENT_A actually requests and executes the 1800 EUR action, then we
//    ask explainAction (via explain, its formatted counterpart) what
//    happened — a historical question, distinct from authorityAt above:
//    it needs this specific action's own recorded history (its own
//    ACTION_REQUESTED/ACTION_EXECUTED), not just "the current state of
//    authority".
// ---------------------------------------------------------------------------

const requestedAction = actionId("act-1800");
const requestParameters = monetaryParameters(money(1800, "EUR"));

const actionRequested: DraftAuthorityEvent = {
  event_id: eventId("evt-action-requested-1"),
  schema_version: CURRENT_SCHEMA_VERSION,
  occurred_at: EVALUATION_INSTANT,
  principal_id: AGENT_A,
  event_type: "ACTION_REQUESTED",
  payload: {
    action_id: requestedAction,
    requesting_principal_id: AGENT_A,
    delegation_id: delegationId1,
    capability_requested: PURCHASE_ORDER_CREATE,
    parameters: requestParameters,
  },
};

const authorityChainRef: readonly ChainLink[] = [{ kind: "delegation", delegation_id: delegationId1 }];

const actionExecuted: DraftAuthorityEvent = {
  event_id: eventId("evt-action-executed-1"),
  schema_version: CURRENT_SCHEMA_VERSION,
  occurred_at: EVALUATION_INSTANT,
  principal_id: AGENT_A,
  event_type: "ACTION_EXECUTED",
  payload: {
    action_id: requestedAction,
    executed_by_principal_id: AGENT_A,
    action_fingerprint: computeActionFingerprint(PURCHASE_ORDER_CREATE, requestParameters),
    decision_sequence: sequenceNumber(1), // the delegation's own sequence: the last canonical state visible when this ran
    authority_chain_ref: authorityChainRef,
    execution_result: executionResultCode("SUCCESS"),
  },
};

const afterExecution = ingestAll([delegationCreated, actionRequested, actionExecuted], clock);

const explanation = explain(afterExecution.canonicalStore, { actionId: requestedAction }, { atSequence: sequenceNumber(3), authorityTime: EVALUATION_INSTANT });

if (explanation.execution?.authorityAtDecision.outcome !== "AUTHORIZED") {
  throw new Error("expected the 1800 EUR action to have been authorized at the moment it ran");
}
if (explanation.currentAuthority.outcome !== "AUTHORIZED") {
  throw new Error("expected the 1800 EUR action to still be covered by currently valid authority");
}

// ---------------------------------------------------------------------------
// All properties held — print a short human summary.
// ---------------------------------------------------------------------------

console.log("authority-graph quickstart");
console.log("===========================");
console.log(`1800 EUR request -> ${withinCap.outcome}`);
console.log(`4800 EUR request -> ${overCap.outcome} (reason: ${overCap.outcome === "DENIED" ? overCap.reasonCode : "n/a"})`);
console.log(`explain(${requestedAction}) -> authorized when it ran: ${explanation.execution.authorityAtDecision.outcome}, still authorized today: ${explanation.currentAuthority.outcome}`);
console.log("All properties held.");
