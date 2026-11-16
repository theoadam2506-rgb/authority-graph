/** The redemption contract (redemptionContract.ts) run against the in-memory transaction. */
import { toDraft } from "../../src/domain/events.js";
import { rebuildIngestionState } from "../../src/engine/ingest.js";
import { InMemoryEventStore } from "../../src/storage/eventStore.js";
import { InMemoryCapabilityIssuanceTransaction } from "../../src/storage/capabilityIssuanceTransaction.js";
import { InMemoryCapabilityRedemptionTransaction, buildCapabilityRedeemedDraft } from "../../src/storage/capabilityRedemptionTransaction.js";
import { actionId, capabilityId, clientIdempotencyKey, iso8601, thresholds, noExpiry, type CapabilityId, type Iso8601 } from "../../src/domain/types.js";
import { AGENT, EP, PARAMS, T, auth } from "./harness.js";
import { EUR, PURCHASE_ORDER_CREATE, THEO, actionRequest, rootDelegation } from "../fixtures/scenarios.js";
import { describeRedemptionContract, type ContractEnv } from "./redemptionContract.js";
import { capability } from "../../src/domain/types.js";

describeRedemptionContract("in-memory", async ({ collidingAttemptIds }): Promise<ContractEnv> => {
  let seedTime: Iso8601 = T("09:00:00");
  const clock = { authorityTime: () => seedTime };
  let store = new InMemoryEventStore(clock);
  await store.append([
    toDraft(rootDelegation({ sequence: 1, id: "d-redeem", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, expires: noExpiry, amountThresholds: thresholds(EUR(2000), EUR(2000)) })),
    toDraft(actionRequest({ sequence: 2, id: "act-redeem", requester: AGENT, delegationId: "d-redeem", parameters: PARAMS })),
  ]);
  seedTime = T("09:05:00");

  let capCounter = 0; // capability ids are an injected policy; a real deployment uses collision-free ids across restarts
  const ids = (): (() => number) => {
    let n = 0; // restarts at 1 after every restart, on purpose
    return () => (collidingAttemptIds ? 1 : ++n);
  };
  const open = (s: InMemoryEventStore) => ({
    issuance: new InMemoryCapabilityIssuanceTransaction(s),
    redemption: new InMemoryCapabilityRedemptionTransaction(s, { nextAttemptId: ids() }),
  });
  let tx = open(store);
  let keyCounter = 0;

  const env: ContractEnv = {
    events: () => store.getEvents(),
    async issue(at) {
      const out = await tx.issuance.issue(auth(AGENT), clientIdempotencyKey(`k-${++keyCounter}`), { action_id: actionId("act-redeem"), enforcement_point_id: EP }, {
        nextCapabilityId: () => capabilityId(`cap-contract-${++capCounter}`),
        expiresAt: (t) => iso8601(new Date(Date.parse(t) + 5 * 60_000).toISOString()),
      }, at);
      if (out.outcome !== "EXECUTED" || !out.result.ok) throw new Error(`issuance refused: ${JSON.stringify(out)}`);
      return out.result.capability.capability_id;
    },
    command: (id: CapabilityId) => ({ capability_id: id, enforcement_point_id: EP, observed_capability: capability("purchase_order", "create"), observed_parameters: PARAMS }),
    redeem: (who, command, at) => tx.redemption.redeem(who, command, at),
    async spawn() {
      const other = new InMemoryCapabilityRedemptionTransaction(store, { nextAttemptId: ids() });
      return { redeem: (who, command, at) => other.redeem(who, command, at) };
    },
    async restart() {
      const persisted = await store.getEvents();
      store = new InMemoryEventStore(clock, rebuildIngestionState(persisted)); // everything in process is gone
      tx = open(store);
    },
    rawAppend: async (draft, at) => (await store.append([draft], at)).outcomes[0]!,
    async redeemedDraft(id, eventIdValue, overrides) {
      const events = await store.getEvents();
      const issued = events.find((e) => e.event_type === "CAPABILITY_ISSUED" && e.payload.capability_id === id);
      if (issued === undefined || issued.event_type !== "CAPABILITY_ISSUED") throw new Error("no such capability");
      const d = buildCapabilityRedeemedDraft(auth(AGENT), T("09:13:00"), {
        capability_id: id, action_id: issued.payload.action_id, action_fingerprint: issued.payload.action_fingerprint,
        decision_sequence: (overrides?.decisionSequence ?? events.length) as never, enforcement_point_id: issued.payload.enforcement_point_id,
      }, "contract");
      return { ...d, event_id: eventIdValue as never };
    },
    close: async () => {},
  };
  return env;
});
