/**
 * A minimal order registry: the HOST's own record of the orders that exist.
 *
 * In architecture A the order reference (`orderRef`) was a model argument that nothing checked. Here the host issues the
 * references itself: the tool refuses a reference that was never registered, and refuses arguments that do not match
 * what was registered, BEFORE Authority is asked (so nothing is journaled and no human is asked).
 *
 * What this does and does not give:
 *  - A model can no longer invent a reference to retry an uncertain operation: an invented reference is unregistered.
 *  - It does NOT know that two registered orders are the same purchase. If the host itself registers a second order
 *    for a purchase that may already have happened, the registry and Authority will let it run, and the target may
 *    receive both. Deduplicating that is the host's job and the target's.
 *  - It is an in-memory list. A real registry is the application's order table, with its own authorization.
 */
import type { PrecheckResult } from "./authorityTool.js";

export interface RegisteredOrder {
  readonly orderRef: string;
  readonly sku: string;
  readonly qty: number;
  readonly amountEur: number;
  readonly supplier: string;
}

export interface OrderRegistry {
  lookup(orderRef: string): Promise<RegisteredOrder | undefined>;
}

export class InMemoryOrderRegistry implements OrderRegistry {
  private readonly orders = new Map<string, RegisteredOrder>();

  /** Done by the host's own code, never by the model. Registering an existing reference is refused. */
  register(order: RegisteredOrder): void {
    if (this.orders.has(order.orderRef)) throw new Error(`order reference already registered: ${order.orderRef}`);
    this.orders.set(order.orderRef, order);
  }

  async lookup(orderRef: string): Promise<RegisteredOrder | undefined> {
    return this.orders.get(orderRef);
  }
}

/** The precheck for the tool: a registered reference, and arguments equal to the registration. */
export function registryPrecheck(registry: OrderRegistry) {
  return async (order: RegisteredOrder): Promise<PrecheckResult> => {
    const registered = await registry.lookup(order.orderRef);
    if (!registered) return { ok: false, reason: "UNREGISTERED_ORDER_REFERENCE" };
    const same = registered.sku === order.sku && registered.qty === order.qty && registered.amountEur === order.amountEur && registered.supplier === order.supplier;
    return same ? { ok: true } : { ok: false, reason: "ORDER_DOES_NOT_MATCH_REGISTRATION" };
  };
}
