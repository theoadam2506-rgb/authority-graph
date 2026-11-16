/**
 * Replay cost measurement for Authority Proof L3.
 *
 * The engine's `replayCanonicalStore` copies state per event, so its cost grows
 * faster than linearly. This script measures wall time and peak RSS of that
 * replay, through the same path the verifier uses, and is the source of the
 * numbers behind `DEFAULT_MAX_REPLAY_EVENTS` (docs/v1/ATTESTATIONS.md).
 *
 *   npm run proof:bench                  sizes 1000 2000 5000 10000, 120 s budget each
 *   npm run proof:bench -- 500 5000      explicit sizes
 *   npm run proof:bench -- --budget 30   per-size time budget in seconds
 *   npm run proof:bench:smoke            small sizes, fails on any error (run in CI)
 *
 * Each size runs in its own child process (so its peak RSS is its own) and is
 * killed when the budget expires: a size over budget is reported as TIMEOUT and
 * the script exits non-zero. Journals are synthetic and valid: one delegation,
 * one action, one real issuance, then copies of it with distinct ids.
 * Absolute numbers depend on the machine: read the ratios.
 */
import { spawnSync } from "node:child_process";
import { argumentsDigest } from "../src/domain/canonicalJson.js";
import { toDraft, type CanonicalStore } from "../src/domain/events.js";
import { actionId, capabilityId, clientIdempotencyKey, enforcementPointId, iso8601, monetaryParameters, noExpiry, thresholds } from "../src/domain/types.js";
import { attestIssuance } from "../src/proof/attestation.js";
import { verifyAttestationL3 } from "../src/proof/replay.js";
import { replayCanonicalStore } from "../src/engine/replayCanonical.js";
import { InMemoryEventStore } from "../src/storage/eventStore.js";
import { InMemoryCapabilityIssuanceTransaction } from "../src/storage/capabilityIssuanceTransaction.js";
import { testKeys, testSigner } from "../tests/proof/fixture.js";
import { EUR, PURCHASE_ORDER_CREATE, THEO, actionRequest, rootDelegation } from "../tests/fixtures/scenarios.js";

export async function build(count: number): Promise<CanonicalStore> {
  const t = Date.parse("2025-01-01T09:05:00.000Z");
  let r = 0;
  const store = new InMemoryEventStore({ authorityTime: () => iso8601("2025-01-01T09:00:00.000Z") }, undefined, () => new Date(Date.parse("2025-01-01T12:00:00.000Z") + 1000 * r++).toISOString());
  const params = monetaryParameters(EUR(1800), undefined, argumentsDigest({ sku: "A" }));
  await store.append([
    toDraft(rootDelegation({ sequence: 1, id: "d-b", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: "agent-a" as never, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, expires: noExpiry, amountThresholds: thresholds(EUR(2000), EUR(2000)) } as never)),
    toDraft(actionRequest({ sequence: 2, id: "act-b", requester: "agent-a" as never, delegationId: "d-b", parameters: params })),
  ]);
  const issuance = new InMemoryCapabilityIssuanceTransaction(store);
  const out = await issuance.issue({ principalId: "agent-a" as never }, clientIdempotencyKey("k0"), { action_id: actionId("act-b"), enforcement_point_id: enforcementPointId("ep-b") }, { nextCapabilityId: () => capabilityId("cap-b-1"), expiresAt: (x: string) => iso8601(new Date(Date.parse(x) + 3600_000).toISOString()) }, iso8601(new Date(t).toISOString()));
  if (out.outcome !== "EXECUTED" || !out.result.ok) throw new Error(`bench issuance failed: ${JSON.stringify(out).slice(0, 200)}`);
  const base = await store.getEvents();
  const template = base[2] as any;
  const events: any[] = [...base];
  for (let i = events.length; i < count; i += 1) {
    const n = i - 1; // cap-b-N
    events.push({
      ...template,
      event_id: `capability-issued:cap-b-${n}:act-b`,
      payload: { ...template.payload, capability_id: `cap-b-${n}` },
      sequence: i + 1,
      recorded_at: new Date(Date.parse("2025-01-01T12:00:00.000Z") + 1000 * i).toISOString(),
    });
  }
  return events as unknown as CanonicalStore;
}

async function child(n: number): Promise<void> {
  const events = await build(n);
  const t0 = process.hrtime.bigint();
  const res = replayCanonicalStore(events);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  // End to end: strict journal read + L3 verification of a signed issuance (what the CLI does), same journal.
  const att = JSON.stringify(await attestIssuance(events, "cap-b-1" as never, testSigner()));
  const journal = JSON.stringify(events);
  const t1 = process.hrtime.bigint();
  const l3 = verifyAttestationL3(att, { keys: testKeys(), journal, maxEvents: n });
  const e2e = Number(process.hrtime.bigint() - t1) / 1e6;
  const ok = res.ok && l3.result === "CONSISTENT_L3";
  console.log(JSON.stringify({ events: n, ok, ms: Math.round(ms), e2e_ms: Math.round(e2e), peak_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024) }));
  process.exit(ok ? 0 : 3);
}

function parent(argv: string[]): void {
  let budget = 120;
  const sizes: number[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--budget") budget = Number(argv[++i]);
    else if (argv[i] === "--smoke") continue;
    else if (Number.isInteger(Number(argv[i])) && Number(argv[i]) >= 3) sizes.push(Number(argv[i]));
    else throw new Error(`bad argument ${argv[i]}`);
  }
  const smoke = argv.includes("--smoke");
  const list = sizes.length > 0 ? sizes : smoke ? [200, 500] : [1000, 2000, 5000, 10000];
  if (!(budget > 0)) throw new Error("bad --budget");
  let failed = false;
  console.log(`replay benchmark, budget ${budget} s per size (each size in its own process)`);
  for (const n of list) {
    const r = spawnSync(process.execPath, [...process.execArgv, process.argv[1] as string, "--child", String(n)], { encoding: "utf8", timeout: budget * 1000, killSignal: "SIGKILL" });
    if (r.error !== undefined && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      console.log(`${String(n).padStart(7)} events  TIMEOUT after ${budget} s`);
      failed = true;
      continue;
    }
    const line = r.stdout.trim().split("\n").pop() ?? "";
    if (r.status !== 0) {
      console.log(`${String(n).padStart(7)} events  FAILED (exit ${r.status}) ${r.stderr.slice(0, 200)} ${line}`);
      failed = true;
      continue;
    }
    const m = JSON.parse(line) as { ms: number; e2e_ms: number; peak_rss_mb: number };
    console.log(`${String(n).padStart(7)} events  replay ${String(m.ms).padStart(7)} ms  L3 end-to-end ${String(m.e2e_ms).padStart(7)} ms  peak RSS ${String(m.peak_rss_mb).padStart(5)} MB`);
  }
  process.exit(failed ? 1 : 0);
}

const ci = process.argv.indexOf("--child");
if (!process.argv[1]?.endsWith("bench-replay.ts")) { /* imported */ } else if (ci !== -1) await child(Number(process.argv[ci + 1]));
else parent(process.argv.slice(2));
