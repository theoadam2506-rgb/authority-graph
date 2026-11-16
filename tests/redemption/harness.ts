/**
 * Shared scaffold for the V1 redemption tests: a store, an issuance and a
 * redemption transaction, and one delegation + one action to redeem. All
 * times are explicit; nothing reads a clock.
 */
import { argumentsDigest } from "../../src/domain/canonicalJson.js";
import type { AuthenticatedPrincipal } from "../../src/domain/authenticatedPrincipal.js";
import type { RedeemCapabilityCommand } from "../../src/domain/capabilityCommand.js";
import { toDraft } from "../../src/domain/events.js";
import {
  actionId, capability, capabilityId, clientIdempotencyKey, enforcementPointId, expiresAt, iso8601, monetaryParameters, thresholds, noExpiry,
  type ActionParameters, type CapabilityId, type ExpiresAt, type Iso8601, type Money, type PrincipalId,
} from "../../src/domain/types.js";
import { InMemoryEventStore } from "../../src/storage/eventStore.js";
import { InMemoryCapabilityIssuanceTransaction } from "../../src/storage/capabilityIssuanceTransaction.js";
import { InMemoryCapabilityRedemptionTransaction } from "../../src/storage/capabilityRedemptionTransaction.js";
import type { IssueCapabilityDependencies } from "../../src/engine/issueCapability.js";
import { AGENT_A, EUR, PURCHASE_ORDER_CREATE, THEO, actionRequest, rootDelegation, revokeDelegation } from "../fixtures/scenarios.js";

export const AGENT = AGENT_A;
import { AGENT_B } from "../fixtures/scenarios.js";
export const AGENT_B_PRINCIPAL = AGENT_B;
export const EP = enforcementPointId("ep-redeem-1");
export const T = (hhmmss: string): Iso8601 => iso8601(`2025-01-01T${hhmmss}.000Z`);
export const auth = (principalId: PrincipalId): AuthenticatedPrincipal => ({ principalId });
export const TOOL_ARGS = { to: "vendor-1", sku: "A-100", qty: 3 };
export const PARAMS: ActionParameters = monetaryParameters(EUR(1800), undefined, argumentsDigest(TOOL_ARGS));

export interface Harness {
  readonly store: InMemoryEventStore;
  readonly issuance: InMemoryCapabilityIssuanceTransaction;
  readonly redemption: InMemoryCapabilityRedemptionTransaction;
  issue(at: Iso8601, who?: PrincipalId, key?: string): Promise<CapabilityId>;
  command(id: CapabilityId, overrides?: Partial<RedeemCapabilityCommand>): RedeemCapabilityCommand;
  revoke(at: Iso8601): Promise<void>;
}

export interface HarnessOptions {
  readonly delegationExpiry?: ExpiresAt;
  readonly ticketTtlMs?: number;
  readonly totalBudget?: Money;
  readonly params?: ActionParameters;
  readonly storeFactory?: (clock: { authorityTime: () => Iso8601 }) => InMemoryEventStore;
}

export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  let seedTime = T("09:00:00");
  const clock = { authorityTime: () => seedTime };
  const store = options.storeFactory?.(clock) ?? new InMemoryEventStore(clock);
  const issuance = new InMemoryCapabilityIssuanceTransaction(store);
  const redemption = new InMemoryCapabilityRedemptionTransaction(store);
  const params = options.params ?? PARAMS;

  const seed = await store.append([
    toDraft(rootDelegation({
      sequence: 1, id: "d-redeem", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false,
      expires: options.delegationExpiry ?? noExpiry, amountThresholds: thresholds(EUR(2000), EUR(2000)),
      ...(options.totalBudget !== undefined ? { totalBudget: options.totalBudget } : {}),
    })),
    toDraft(actionRequest({ sequence: 2, id: "act-redeem", requester: AGENT, delegationId: "d-redeem", parameters: params })),
  ]);
  if (!seed.outcomes.every((o) => o.accepted)) throw new Error("seed rejected");
  seedTime = T("09:05:00");

  let counter = 0;
  const ttl = options.ticketTtlMs ?? 5 * 60_000;
  const deps = (): IssueCapabilityDependencies => ({
    nextCapabilityId: () => capabilityId(`cap-redeem-${++counter}`),
    expiresAt: (t) => iso8601(new Date(Date.parse(t) + ttl).toISOString()),
  });

  return {
    store, issuance, redemption,
    async issue(at, who = AGENT, key = `k-${counter}`) {
      const out = await issuance.issue(auth(who), clientIdempotencyKey(key), { action_id: actionId("act-redeem"), enforcement_point_id: EP }, deps(), at);
      if (out.outcome !== "EXECUTED" || !out.result.ok) throw new Error(`issuance failed: ${JSON.stringify(out)}`);
      return out.result.capability.capability_id;
    },
    command(id, overrides = {}) {
      return { capability_id: id, enforcement_point_id: EP, observed_capability: capability("purchase_order", "create"), observed_parameters: params, ...overrides };
    },
    async revoke(at) {
      const r = await store.append([toDraft(revokeDelegation({ sequence: 99, targetId: "d-redeem", issuedBy: THEO }))], at);
      if (!r.outcomes[0]?.accepted) throw new Error("revocation rejected");
    },
  };
}

export { expiresAt };
