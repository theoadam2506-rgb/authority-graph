/**
 * Property: whatever fails, wherever, and however often the caller retries,
 * the effect (a) never runs without a recorded redemption of its ticket,
 * (b) runs at most once per action, and (c) a ticket is never redeemed twice.
 * Deterministic: a seeded generator drives random faults (thrown before or
 * after the real call) in the store, the issuance and the redemption.
 */
import { describe, expect, it } from "vitest";
import type { Fault } from "./harness.js";
import { call, faulty, setup } from "./harness.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("property: the effect never runs without a recorded redemption, and at most once", () => {
  for (let seed = 1; seed <= 150; seed++) {
    it(`seed ${seed}`, async () => {
      const rng = mulberry32(seed);
      const pick = (p: number, kinds: Fault[]): Fault | undefined => (rng() < p ? kinds[Math.floor(rng() * kinds.length)] : undefined);
      const s = await setup({
        wrap: (parts) =>
          faulty(parts, {
            getEvents: () => pick(0.12, ["throw"]),
            append: () => pick(0.12, ["throw", "throw-after"]),
            issue: () => pick(0.15, ["throw", "throw-after"]),
            redeem: () => pick(0.2, ["throw", "throw-after"]),
          }),
      });

      let effectRuns = 0;
      let effectWithoutRedemption = 0;
      const effect = async (ctx: { idempotencyKey: string }) => {
        const journal = await s.parts.store.getEvents();
        const redeemed = journal.some((e) => e.event_type === "CAPABILITY_REDEEMED" && e.payload.capability_id === ctx.idempotencyKey);
        if (!redeemed) effectWithoutRedemption++;
        effectRuns++;
        if (rng() < 0.15) throw new Error("effect failed");
        return effectRuns;
      };

      const attempts = 3 + Math.floor(rng() * 4);
      for (let i = 0; i < attempts; i++) {
        if (rng() < 0.5) {
          await Promise.all([s.authority.guard(call("p1"), effect), s.authority.guard(call("p1"), effect)]);
        } else {
          await s.authority.guard(call("p1"), effect);
        }
        s.clock.advance(1_000);
      }

      const journal = await s.parts.store.getEvents();
      const issued = journal.filter((e) => e.event_type === "CAPABILITY_ISSUED");
      const redeemed = journal.filter((e) => e.event_type === "CAPABILITY_REDEEMED");
      expect(effectWithoutRedemption).toBe(0);
      expect(effectRuns).toBeLessThanOrEqual(1);
      expect(issued.length).toBeLessThanOrEqual(1);
      expect(redeemed.length).toBeLessThanOrEqual(1);
      if (effectRuns === 1) expect(redeemed).toHaveLength(1);
    });
  }
});
