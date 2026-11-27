/** B1 review: the journal generators and the mutation helper are functions of their seed (same seed, same journal, byte for byte). */
import { describe, expect, it } from "vitest";
import { genJournal, mutate, rng } from "./helpers/o1.js";
import { coherentJournal, randomJournal } from "./helpers/b1.js";

const N = Number(process.env.B1_REPRO_SEEDS ?? 20_000);
const snapshot = (seedBase: number) => {
  const out: string[] = [];
  for (let s = 0; s < N; s++) {
    const base = s % 2 === 0 ? coherentJournal(seedBase + s, 5 + (s % 40)) : randomJournal(seedBase + s, 3 + (s % 22));
    out.push(JSON.stringify(mutate(base, rng(31 * s + 5))));
  }
  return out;
};

describe("B1 test generators are reproducible", () => {
  it(`two passes over ${N} seeds of generator + mutate give identical journals`, () => {
    const a = snapshot(9_000_000), b = snapshot(9_000_000);
    const differing = a.map((x, i) => (x === b[i] ? -1 : i)).filter((i) => i >= 0);
    expect(differing).toEqual([]);
  });
  it("mutate never changes its input nor the junk values it takes (junk is frozen and cloned)", () => {
    const base = coherentJournal(42, 30);
    const before = JSON.stringify(base);
    for (let s = 0; s < 500; s++) mutate(base, rng(s));
    expect(JSON.stringify(base)).toBe(before);
  });
  it("SDK-generated journals are reproducible too, except `recorded_at` (the infrastructure wall clock) and the redemption `:attempt-N` suffix (a process-wide counter): neither is derived from the seed by design", async () => {
    const strip = (events: any[]) => JSON.stringify(events.map(({ recorded_at: _r, ...rest }) => rest)).replace(/:attempt-\d+/g, ":attempt-*");
    for (const seed of [1, 7, 99]) {
      const a = await genJournal(seed, 25, { budgetBias: 0.7, deterministicIds: true });
      const b = await genJournal(seed, 25, { budgetBias: 0.7, deterministicIds: true });
      expect(strip(a)).toBe(strip(b));
    }
  });
});
