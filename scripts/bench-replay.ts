/**
 * Replay cost measurement (Authority Proof L3). The engine's `replayCanonicalStore`
 * copies state per event, so cost grows faster than linearly; this script measures
 * wall time and peak RSS for journals of increasing size, through the same path the
 * verifier uses. It supplies the numbers behind `DEFAULT_MAX_REPLAY_EVENTS`.
 *
 *   npm run proof:bench [-- 1000 5000 10000]
 *
 * Journals are synthetic: one delegation, one action, then N issuances. Results
 * depend on the machine: read the ratios, not the absolute values.
 */
import { argumentsDigest } from "../src/domain/canonicalJson.js";
import { toDraft } from "../src/domain/events.js";
import { argumentsDigest } from "../src/domain/canonicalJson.js";
import { actionId, capability, capabilityId, clientIdempotencyKey, enforcementPointId, iso8601, monetaryParameters, noExpiry, thresholds } from "../src/domain/types.js";
import { replayCanonicalStore } from "../src/engine/replayCanonical.js";
import { InMemoryEventStore } from "../src/storage/eventStore.js";
import { InMemoryCapabilityIssuanceTransaction } from "../src/storage/capabilityIssuanceTransaction.js";
import { EUR, PURCHASE_ORDER_CREATE, THEO, actionRequest, rootDelegation } from "../tests/fixtures/scenarios.js";

const sizes = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n) && n > 2);
const targets = sizes.length > 0 ? sizes : [1000, 5000, 10000, 20000];
const max = Math.max(...targets);

async function build(count: number) {
  let t = Date.parse("2025-01-01T09:00:00.000Z");
  let r = 0;
  const store = new InMemoryEventStore({ authorityTime: () => iso8601(new Date(t).toISOString()) }, undefined, () => new Date(Date.parse("2025-01-01T12:00:00.000Z") + 1000 * r++).toISOString());
  const params = monetaryParameters(EUR(1800), undefined, argumentsDigest({ sku: "A" }));
  await store.append([
    toDraft(rootDelegation({ sequence: 1, id: "d-b", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: "agent-a" as never, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, expires: noExpiry, amountThresholds: thresholds(EUR(2000), EUR(2000)) } as never)),
    toDraft(actionRequest({ sequence: 2, id: "act-b", requester: "agent-a" as never, delegationId: "d-b", parameters: params })),
  ]);
  t += 5 * 60_000;
  const issuance = new InMemoryCapabilityIssuanceTransaction(store);
  let n = 0;
  const deps = { nextCapabilityId: () => capabilityId(`cap-b-${++n}`), expiresAt: (x: string) => iso8601(new Date(Date.parse(x) + 3600_000).toISOString()) };
  for (let i = 0; i < count - 2; i += 1) {
    const out = await issuance.issue({ principalId: "agent-a" as never }, clientIdempotencyKey(`k${i}`), { action_id: actionId("act-b"), enforcement_point_id: enforcementPointId("ep-b") }, deps, iso8601(new Date(t).toISOString()));
    if (out.outcome !== "EXECUTED" || !out.result.ok) throw new Error(`bench issuance ${i} failed: ${JSON.stringify(out).slice(0, 200)}`);
  }
  return store.getEvents();
}

const all = await build(max);
console.log(`built ${all.length} events`);
for (const n of targets) {
  const slice = all.slice(0, n);
  if (global.gc) global.gc();
  const t0 = process.hrtime.bigint();
  const res = replayCanonicalStore(slice);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`${String(n).padStart(7)} events  replay ${ms.toFixed(0).padStart(8)} ms  ok=${res.ok}  peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MB`);
}
