/**
 * Final targeted review of PR #24: the shared per-store lock, idempotent
 * ingestion, I31 validation, and the absence of a double success, checked
 * together under a deterministic randomized workload.
 */
import { describe, expect, it } from "vitest";
import { toDraft, type CanonicalStore } from "../../src/domain/events.js";
import { validateRedemptionEvent, type RedeemCapabilityResult } from "../../src/engine/redeemCapability.js";
import { InMemoryCapabilityRedemptionTransaction } from "../../src/storage/capabilityRedemptionTransaction.js";
import { InMemoryEventStore } from "../../src/storage/eventStore.js";
import { actionRequest } from "../fixtures/scenarios.js";
import type { CapabilityId } from "../../src/domain/types.js";
import { AGENT, PARAMS, T, auth, harness } from "./harness.js";

/** Small deterministic PRNG (no Math.random anywhere in the tests). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0x100000000);
}

class FailingOnceStore extends InMemoryEventStore {
  failNext = false;
  override async getEvents(filter?: Parameters<InMemoryEventStore["getEvents"]>[0]): ReturnType<InMemoryEventStore["getEvents"]> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("store unavailable");
    }
    return super.getEvents(filter);
  }
}

describe("the shared per-store lock", () => {
  it("a store failure inside one redemption rejects that call only and never wedges the lock for the others", async () => {
    const h = await harness({ storeFactory: (clock) => new FailingOnceStore(clock) });
    const store = h.store as FailingOnceStore;
    const id = await h.issue(T("09:10:00"));
    const other = new InMemoryCapabilityRedemptionTransaction(store);
    store.failNext = true;
    const settled = await Promise.allSettled([h.redemption.redeem(auth(AGENT), h.command(id), T("09:12:00")), other.redeem(auth(AGENT), h.command(id), T("09:12:00"))]);
    expect(settled[0]!.status).toBe("rejected"); // fail-closed: an exception is never a success
    expect(settled[1]!.status).toBe("fulfilled");
    expect((settled[1] as PromiseFulfilledResult<RedeemCapabilityResult>).value.ok).toBe(true);
    expect((await store.getEvents()).filter((e) => e.event_type === "CAPABILITY_REDEEMED")).toHaveLength(1);
  });

  it("two different store objects do NOT share a lock (the lock is per store object, by design)", async () => {
    const a = await harness();
    const b = await harness();
    const idA = await a.issue(T("09:10:00"));
    const idB = await b.issue(T("09:10:00"));
    const [ra, rb] = await Promise.all([a.redemption.redeem(auth(AGENT), a.command(idA), T("09:12:00")), b.redemption.redeem(auth(AGENT), b.command(idB), T("09:12:00"))]);
    expect(ra.ok && rb.ok).toBe(true); // independent stores, independent tickets
  });
});

describe("idempotent ingestion can never be read as a second success", () => {
  it("every successful redemption is backed by exactly one event at decision_sequence + 1; no result is ok without one", async () => {
    const h = await harness();
    const id = await h.issue(T("09:10:00"));
    const results = await Promise.all(Array.from({ length: 20 }, () => h.redemption.redeem(auth(AGENT), h.command(id), T("09:12:00"))));
    const events = await h.store.getEvents();
    const rows = events.filter((e) => e.event_type === "CAPABILITY_REDEEMED");
    expect(results.filter((r) => r.ok)).toHaveLength(rows.length);
    expect(rows).toHaveLength(1);
    const winner = results.find((r) => r.ok);
    if (winner === undefined || !winner.ok || rows[0]!.event_type !== "CAPABILITY_REDEEMED") throw new Error("fixture");
    expect(Number(rows[0]!.sequence)).toBe(Number(winner.redemption.decision_sequence) + 1);
  });
});

describe("randomized workload: tickets, redemptions, a revocation, concurrent instances, colliding ids", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])("seed %i: at most one ok per capability, every ok is I31-valid, no valid redemption without an ok", async (seed) => {
    const rand = lcg(seed * 7919);
    const h = await harness();
    const instances = [h.redemption, ...Array.from({ length: 3 }, () => new InMemoryCapabilityRedemptionTransaction(h.store, { nextAttemptId: () => 1 }))];
    const ids: CapabilityId[] = [];
    const oks = new Map<string, number>();
    let clock = 600; // seconds after 09:00
    const at = () => T(`09:${String(Math.floor(clock / 60)).padStart(2, "0")}:${String(clock % 60).padStart(2, "0")}`);
    let revoked = false;

    for (let wave = 0; wave < 6; wave += 1) {
      clock += 5;
      if (!revoked && ids.length < 4 && rand() < 0.8) ids.push(await h.issue(at(), AGENT, `k-${seed}-${wave}`));
      if (!revoked && wave >= 3 && rand() < 0.5) {
        await h.revoke(at());
        revoked = true;
      }
      if (rand() < 0.3) await h.store.append([toDraft(actionRequest({ sequence: 200 + wave, id: `noise-${seed}-${wave}`, requester: AGENT, delegationId: "d-redeem", parameters: PARAMS }))], at()); // a concurrent-looking write
      clock += 5;
      const ops = Array.from({ length: 4 + Math.floor(rand() * 8) }, () => {
        const id = ids[Math.floor(rand() * ids.length)];
        const instance = instances[Math.floor(rand() * instances.length)]!;
        return id === undefined ? undefined : { id, run: instance.redeem(auth(AGENT), h.command(id), at()) };
      }).filter((x): x is { id: CapabilityId; run: Promise<RedeemCapabilityResult> } => x !== undefined);
      for (const { id, run } of ops) {
        const r = await run;
        if (r.ok) oks.set(id, (oks.get(id) ?? 0) + 1);
      }
    }

    const events: CanonicalStore = await h.store.getEvents();
    for (const [id, n] of oks) expect(n, `capability ${id}`).toBe(1);
    const redeemed = events.filter((e) => e.event_type === "CAPABILITY_REDEEMED");
    const perCapability = new Map<string, number>();
    for (const e of redeemed) if (e.event_type === "CAPABILITY_REDEEMED") perCapability.set(e.payload.capability_id, (perCapability.get(e.payload.capability_id) ?? 0) + 1);
    for (const [id, n] of perCapability) expect(n, `events for ${id}`).toBe(1);
    for (const e of redeemed) {
      if (e.event_type !== "CAPABILITY_REDEEMED") continue;
      const valid = validateRedemptionEvent(events, e).ok;
      expect(valid, `capability ${e.payload.capability_id}: ok:true <=> I31-valid`).toBe(oks.has(e.payload.capability_id));
    }
  });
});
