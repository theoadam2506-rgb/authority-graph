/**
 * The only "external system" of the example: a simulated supplier. It is a list in memory, not a network call.
 * It records what it was asked to do, with the idempotency key it received, so that the example (and its tests) can
 * see what the target holds. Authority never sees this list, and cannot.
 */
export interface SupplierOrder {
  readonly orderRef: string;
  readonly sku: string;
  readonly qty: number;
  readonly amountEur: number;
  readonly supplier: string;
  /** What the guarded effect received: the Authority ticket id. */
  readonly idempotencyKey: string;
}

/**
 * - `ok`: records the order and replies.
 * - `rejects`: refuses the order cleanly; nothing is recorded.
 * - `completes-then-loses-reply`: records the order, then the reply never arrives (the caller gets a timeout).
 */
export type SupplierBehaviour = "ok" | "rejects" | "completes-then-loses-reply";

export class SimulatedSupplier {
  readonly orders: SupplierOrder[] = [];
  behaviour: SupplierBehaviour = "ok";

  async place(order: SupplierOrder): Promise<{ readonly confirmation: string }> {
    switch (this.behaviour) {
      case "rejects":
        throw new Error("supplier refused the order");
      case "completes-then-loses-reply":
        this.orders.push(order);
        throw new Error("timeout while waiting for the supplier's reply");
      case "ok":
        this.orders.push(order);
        return { confirmation: `CONF-${this.orders.length}` };
    }
  }
}
