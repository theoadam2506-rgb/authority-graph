/**
 * Authority SDK in one file (experimental). One delegation, one guarded tool
 * call, then two attempts that must be refused: a replay of the same action and
 * a call whose amount was changed. No database, no network, no API key.
 *
 * The delegation is built with the typed event builders. Run with: npm run sdk:example
 */
import { createAuthority, createEventBuilders, memoryBackend, systemClock } from "../src/sdk/index.js";

const authority = createAuthority({
  backend: memoryBackend(),
  clock: systemClock, // explicit: you choose the time source, and trust it
  enforcementPointId: "purchase-gateway",
});
const events = createEventBuilders({ clock: systemClock });

const recorded = await authority.record([
  events.delegation({
    delegationId: "d-owner-agent",
    grantor: "human-owner",
    grantee: "agent-a",
    capabilities: [{ resource: "purchase_order", action: "create" }],
    canDelegate: false,
    expiresAt: null, // an explicit "no expiry"
    thresholds: { automaticMax: { value: 2000, currency: "EUR" }, approvalMax: { value: 2000, currency: "EUR" } },
  }),
]);
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
