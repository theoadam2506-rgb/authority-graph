/**
 * Authority SDK in one file (experimental). One delegation, one guarded tool
 * call, then two attempts that must be refused: a replay of the same action and
 * a call whose amount was changed. No database, no network, no API key.
 *
 * `record()` takes events built by hand here; event builders arrive with the
 * packaging pull request (5b). Run with: npm run sdk:example
 */
import type { DraftAuthorityEvent } from "../src/domain/events.js";
import { CURRENT_SCHEMA_VERSION, capability, delegationId, eventId, iso8601, money, noExpiry, principalId, thresholds } from "../src/domain/types.js";
import { createAuthority, memoryBackend, systemClock } from "../src/sdk/index.js";

const OWNER = principalId("human-owner");
const AGENT = principalId("agent-a");

const authority = createAuthority({
  backend: memoryBackend(),
  clock: systemClock, // explicit: you choose the time source, and trust it
  enforcementPointId: "purchase-gateway",
});

const delegation: DraftAuthorityEvent = {
  event_id: eventId("evt-delegation-1"),
  schema_version: CURRENT_SCHEMA_VERSION,
  occurred_at: iso8601(new Date().toISOString()),
  principal_id: OWNER,
  event_type: "DELEGATION_CREATED",
  payload: {
    delegation_id: delegationId("d-owner-agent"),
    grantor_principal_id: OWNER,
    grantor_type: "HUMAN_ROOT",
    grantee_principal_id: AGENT,
    capabilities: [capability("purchase_order", "create")],
    can_delegate: false,
    expires_at: noExpiry,
    thresholds: thresholds(money(2000, "EUR"), money(2000, "EUR")),
    parent_delegation_id: null,
  },
};
const recorded = await authority.record([delegation]);
if (recorded.status !== "RECORDED" || !recorded.outcomes.every((o) => o.accepted)) throw new Error("delegation refused");

const order = {
  actionId: "po-1",
  agentId: "agent-a",
  delegationId: "d-owner-agent",
  capability: { resource: "purchase_order", action: "create" },
  amount: { value: 1800, currency: "EUR" },
  recipient: "vendor-1",
  args: { sku: "A-100", qty: 3 },
} as const;

let effects = 0;
const placeOrder = async ({ idempotencyKey }: { idempotencyKey: string }) => {
  effects++; // the real call goes here; pass idempotencyKey to the target system
  return `order placed (idempotency key ${idempotencyKey.slice(0, 12)}...)`;
};

const first = await authority.guard(order, placeOrder);
console.log("1800 EUR, first attempt :", first.status);

const replay = await authority.guard(order, placeOrder);
console.log("same action, replayed   :", replay.status, replay.status === "BLOCKED" && replay.stage === "redeem" ? `(${replay.result.status})` : "");

const widened = await authority.guard({ ...order, actionId: "po-2", amount: { value: 2500, currency: "EUR" } }, placeOrder);
console.log("2500 EUR, over the limit:", widened.status, widened.status === "BLOCKED" && widened.stage === "authorize" ? `(${widened.result.status})` : "");

const ticket = await authority.authorize({ ...order, actionId: "po-3" });
if (ticket.status !== "AUTHORIZED") throw new Error("expected a ticket");
const tampered = await authority.redeem(ticket.ticket, { ...order, actionId: "po-3", amount: { value: 1900, currency: "EUR" } });
console.log("amount changed at redeem:", tampered.status, tampered.status === "REFUSED" ? `(${tampered.reason})` : "");

console.log(`effects that ran: ${effects} (expected 1)`);
if (effects !== 1 || first.status !== "EXECUTED" || replay.status !== "BLOCKED" || widened.status !== "BLOCKED" || tampered.status !== "REFUSED") {
  throw new Error("unexpected outcome");
}
