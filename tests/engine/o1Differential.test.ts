/**
 * O1 differential tests: the optimized engine (src/engine) against the frozen reference (tests/oracle/engine).
 * Same journals, same calls; results AND thrown errors must be identical.
 *
 *   O1_JOURNALS   number of random journals per category (default 150; the audit run uses 10000 or more)
 *   O1_SEED       first seed (default 1)
 */
import { describe, expect, it } from "vitest";
import { compareEngines, genJournal, mutate, rng, singleFaults } from "./helpers/o1.js";
import { isJournalShapeSound } from "../../src/engine/journalShape.js";

const N = Number(process.env.O1_JOURNALS ?? 150);
const SEED = Number(process.env.O1_SEED ?? 1);

describe("O1 differential: optimized engine vs frozen reference", () => {
  it(`well-formed journals (${N}): identical results, budgets and no-budget alike`, { timeout: 600_000 }, async () => {
    let probes = 0, fast = 0;
    for (let s = SEED; s < SEED + N; s++) {
      const j = await genJournal(s, 80, { budgetBias: s % 2 === 0 ? 0.0 : 0.7 });
      if (isJournalShapeSound(j)) fast++;
      const r = compareEngines(j);
      probes += r.probes;
      if (r.divergences.length > 0) throw new Error(`seed ${s}: ${JSON.stringify(r.divergences.slice(0, 2), null, 1)}`);
    }
    console.info(`[O1] well-formed: journals=${N} probes=${probes} fastPathJournals=${fast} divergences=0`);
    expect(probes).toBeGreaterThan(N * 5);
    expect(fast).toBeGreaterThan(N * 0.9); // the fast path is really exercised, not silently bypassed
  });

  it(`malformed journals (${N}): identical results AND identical errors`, { timeout: 600_000 }, async () => {
    let threw = 0, unsound = 0;
    for (let s = SEED; s < SEED + N; s++) {
      const base = await genJournal(s, 60, { budgetBias: 0.5 });
      const j = mutate(base, rng(s * 31 + 7));
      if (!isJournalShapeSound(j)) unsound++;
      const r = compareEngines(j);
      threw += r.referenceThrew;
      if (r.divergences.length > 0) throw new Error(`seed ${s}: ${JSON.stringify(r.divergences.slice(0, 2), null, 1)}`);
    }
    console.info(`[O1] malformed: journals=${N} shapeUnsound=${unsound} referenceThrews=${threw} divergences=0`);
    expect(unsound).toBeGreaterThan(N * 0.5); // most mutations are caught by the shape check
    expect(threw).toBeGreaterThan(0); // the reference really does throw on some malformed journals: the error parity is exercised
  });

  it("exhaustive single-field faults on rich journals: every field of every event, deleted or replaced by junk", { timeout: 900_000 }, async () => {
    const seeds = Number(process.env.O1_FAULT_JOURNALS ?? 2);
    const junk = [undefined, null, "zzz", 42, [], {}];
    let mutants = 0, threw = 0;
    for (let s = 0; s < seeds; s++) {
      const base = await genJournal(900 + s, 28, { budgetBias: s % 2 === 0 ? 0.0 : 0.8 });
      for (const f of singleFaults(base, junk)) {
        mutants++;
        const r = compareEngines(f.journal);
        threw += r.referenceThrew;
        if (r.divergences.length > 0) throw new Error(`${f.label}: ${JSON.stringify(r.divergences.slice(0, 2), null, 1)}`);
      }
    }
    console.info(`[O1] single-field faults: journals=${seeds} mutants=${mutants} referenceThrews=${threw} divergences=0`);
    expect(mutants).toBeGreaterThan(1000);
    expect(threw).toBeGreaterThan(0);
  });
});
