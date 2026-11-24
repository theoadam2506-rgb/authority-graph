/**
 * The "host application" of the example: everything Authority deliberately leaves to the host.
 *  - The clock (a fixed one you control: Authority has no default clock).
 *  - The identity of the agent and of the human (asserted here; Authority verifies neither).
 *  - The business reference of each order, which becomes the Authority action id.
 *  - Recording the human's decision and the revocation (out of band: architecture A has no native pause).
 *  - The delegation: `alice` lets `procurement-agent` create purchase orders, up to 2,000 EUR on its own, up to
 *    5,000 EUR with a human approval, and 5,000 EUR in total.
 */
import { createAuthority, createEventBuilders, memoryBackend, type Authority, type Backend, type Diagnostic, type EventBuilders } from "authority-graph-sdk";
import { z } from "zod";
import { authorityTool, type AuthorityFunctionTool, type HostPrincipal } from "./authorityTool.js";
import { SimulatedSupplier } from "./supplier.js";

/** Asserted by the host. The model never provides, and cannot change, either field. */
export const PRINCIPAL: HostPrincipal = { agentId: "procurement-agent", delegationId: "d-1" };

/** The arguments the model may provide. `orderRef` is the business reference: the host's stable identifier of the order. */
export const orderParameters = z.object({
  orderRef: z.string().min(1).max(64),
  sku: z.string().min(1).max(64),
  qty: z.number().int().positive(),
  amountEur: z.number().int().nonnegative(),
  supplier: z.string().min(1).max(64),
});
export type OrderInput = z.infer<typeof orderParameters>;

/** The Authority action id of an order: derived from the business reference, never from the model's tool-call id. */
export const actionIdOf = (orderRef: string): string => `po:${orderRef}`;

/** A clock you control. */
export class FixedClock {
  private ms = Date.parse("2026-06-01T09:00:00.000Z");
  now(): string {
    return new Date(this.ms).toISOString();
  }
  advance(milliseconds: number): void {
    this.ms += milliseconds;
  }
}

/** Faults that the host's own storage can have: the two ways the outcome can become uncertain (see `SDK.md`). */
export interface HostFaults {
  /** The first redemption is written, then its acknowledgement is lost: the SDK answers `UNKNOWN_OUTCOME`. */
  readonly loseFirstRedemptionAcknowledgement?: boolean;
  /** Writing `ACTION_EXECUTED` fails: the effect ran, the journal does not say so. */
  readonly failToReportExecution?: boolean;
}

type BackendParts = ReturnType<Backend["build"]>;

function withFaults(backend: Backend, faults: HostFaults): Backend {
  return {
    build(ingestionClock) {
      const parts: BackendParts = backend.build(ingestionClock);
      let redemptions = 0;
      return {
        store: {
          getEvents: (filter) => parts.store.getEvents(filter),
          getBySequence: (range) => parts.store.getBySequence(range),
          append: async (drafts) => {
            if (faults.failToReportExecution && drafts.some((d) => d.event_type === "ACTION_EXECUTED")) throw new Error("journal write failed");
            return parts.store.append(drafts);
          },
        },
        issuance: parts.issuance,
        redemption: {
          redeem: async (...args) => {
            const result = await parts.redemption.redeem(...args);
            if (faults.loseFirstRedemptionAcknowledgement && redemptions++ === 0) throw new Error("connection reset after commit");
            return result;
          },
        },
      };
    },
  };
}

export interface Host {
  readonly clock: FixedClock;
  readonly authority: Authority;
  readonly events: EventBuilders;
  readonly supplier: SimulatedSupplier;
  readonly tool: AuthorityFunctionTool;
  /** What reached the OPERATOR (never the model): one entry per failure that Authority diagnosed. */
  readonly diagnostics: Diagnostic[];
  /** The human `alice` approves this exact action. Done by the host, outside the Agents SDK. */
  approve(actionId: string): Promise<void>;
  /** The human `alice` revokes the delegation. */
  revoke(): Promise<void>;
  /** The journal as `EVENT_TYPE` or `EVENT_TYPE(code)` for `ACTION_EXECUTED`. */
  journal(): Promise<string[]>;
}

export async function createHost(options: { readonly faults?: HostFaults } = {}): Promise<Host> {
  const clock = new FixedClock();
  const events = createEventBuilders({ clock });
  const diagnostics: Diagnostic[] = [];
  const authority = createAuthority({
    backend: withFaults(memoryBackend(), options.faults ?? {}),
    clock,
    enforcementPointId: "supplier-orders-tool",
    onDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
  });
  await authority.record([
    events.delegation({
      delegationId: PRINCIPAL.delegationId,
      grantor: "alice",
      grantee: PRINCIPAL.agentId,
      capabilities: [{ resource: "purchase_order", action: "create" }],
      canDelegate: false,
      expiresAt: null,
      thresholds: { automaticMax: { value: 2000, currency: "EUR" }, approvalMax: { value: 5000, currency: "EUR" } },
      totalBudget: { value: 5000, currency: "EUR" },
    }),
  ]);

  const supplier = new SimulatedSupplier();
  const tool = authorityTool({
    authority,
    name: "place_supplier_order",
    description: "Place a purchase order with a supplier. orderRef is the order's business reference.",
    parameters: orderParameters,
    principal: PRINCIPAL,
    describeAction: (order) => ({
      actionId: actionIdOf(order.orderRef),
      capability: { resource: "purchase_order", action: "create" },
      amount: { value: order.amountEur, currency: "EUR" },
      recipient: order.supplier,
      args: { orderRef: order.orderRef, sku: order.sku, qty: order.qty },
    }),
    effect: async (order, context) => {
      const { confirmation } = await supplier.place({ ...order, idempotencyKey: context.idempotencyKey });
      return { confirmation };
    },
  });

  return {
    clock,
    authority,
    events,
    supplier,
    tool,
    diagnostics,
    async approve(actionId) {
      clock.advance(60_000);
      await authority.record([
        events.approvalRequest({ approvalId: `ap-${actionId}`, actionId, requestedBy: PRINCIPAL.agentId, requestedFrom: "alice", reasonCode: "OVER_AUTOMATIC_LIMIT" }),
        events.approvalGranted({ approvalId: `ap-${actionId}`, actionId, approver: "alice" }),
      ]);
    },
    async revoke() {
      clock.advance(60_000);
      await authority.record([events.revocation({ delegationId: PRINCIPAL.delegationId, revokedBy: "alice", reasonCode: "OWNER_REQUEST" })]);
    },
    async journal() {
      const all = (await authority.events()) as unknown as { event_type: string; payload: { execution_result?: string } }[];
      return all.map((e) => (e.event_type === "ACTION_EXECUTED" ? `ACTION_EXECUTED(${String(e.payload.execution_result)})` : e.event_type));
    },
  };
}
