/**
 * O1 targeted tests: faults whose reach is GUARANTEED (a valid issuance for a new action is pending, with earlier
 * grants, executions, redemptions and a sub-delegation in the journal), plus deterministic cases for first-match
 * semantics and malformed events placed after a match.
 */
import { describe, expect, it } from "vitest";
import { compareEngines, genJournal, issueProbe, OPTIMIZED, REFERENCE, scenario, singleFaults, observe } from "./helpers/o1.js";
import { JournalLookup } from "../../src/engine/journalIndex.js";
import { isJournalShapeSound } from "../../src/engine/journalShape.js";

const JUNK = [undefined, null, "zzz", 42, -1, [], {}, [null], true];

describe("O1 targeted fault injection with guaranteed reach", () => {
  for (const bounded of [false, true]) {
    it(`${bounded ? "bounded" : "unbounded"} delegation: every single-field fault of the journal gives the same result or the same error`, { timeout: 300_000 }, async () => {
      const prefix = await scenario(bounded);
      const base = issueProbe(REFERENCE, prefix, "agent", "act-2");
      expect(base.ok && base.value.includes('"ok":true')).toBe(true); // the pending issuance really succeeds on the clean journal
      expect(issueProbe(OPTIMIZED, prefix, "agent", "act-2")).toEqual(base);
      let mutants = 0, referenceThrew = 0, optimizedThrewAsWell = 0;
      for (const f of singleFaults(prefix, JUNK)) {
        mutants++;
        const a = issueProbe(OPTIMIZED, f.journal, "agent", "act-2");
        const b = issueProbe(REFERENCE, f.journal, "agent", "act-2");
        if (!b.ok) { referenceThrew++; if (!a.ok) optimizedThrewAsWell++; }
        expect({ fault: f.label, result: a }).toEqual({ fault: f.label, result: b });
      }
      expect(mutants).toBeGreaterThan(500);
      expect(referenceThrew).toBeGreaterThan(0);
      expect(optimizedThrewAsWell).toBe(referenceThrew);
    });
  }

  it("the shape check is one-sided: it accepts the clean scenarios and rejects the faults the reference throws on", async () => {
    for (const bounded of [false, true]) {
      const prefix = await scenario(bounded);
      expect(isJournalShapeSound(prefix)).toBe(true);
      for (const f of singleFaults(prefix, JUNK)) {
        const b = issueProbe(REFERENCE, f.journal, "agent", "act-2");
        if (!b.ok) expect({ fault: f.label, sound: isJournalShapeSound(f.journal) }).toEqual({ fault: f.label, sound: false });
      }
    }
  });
});

describe("shape check contract on CAPABILITY_ISSUED", () => {
  it("every required field of a grant, expires_at included, is checked: a missing or mistyped one is shape-unsound, and the engines still agree", async () => {
    const prefix = await scenario(true);
    const i = prefix.findIndex((e) => e.event_type === "CAPABILITY_ISSUED");
    expect(i).toBeGreaterThan(0);
    for (const field of Object.keys(prefix[i].payload)) {
      for (const bad of [undefined, null, [], {}, true, "zzz"]) {
        if (bad === "zzz" && field !== "decision_sequence") continue; // a string is a valid value for the string fields
        if (Array.isArray(bad) && field === "granted_chain_ref") continue; // an empty chain is structurally valid (the engine rejects it by its own rules)
        const j: any[] = JSON.parse(JSON.stringify(prefix));
        if (bad === undefined) delete j[i].payload[field]; else j[i].payload[field] = bad;
        expect({ field, bad, sound: isJournalShapeSound(j) }).toEqual({ field, bad, sound: false });
        expect(issueProbe(OPTIMIZED, j, "agent", "act-2")).toEqual(issueProbe(REFERENCE, j, "agent", "act-2"));
      }
    }
  });
});

describe("ACTION_EXECUTED.payload.execution_result", () => {
  const BAD = [undefined, null, 42, true, [], {}, ["EXECUTED"]];

  it("a missing or non-string execution_result makes the journal shape-unsound (original path), and the engines agree on result and errors", async () => {
    for (const bounded of [false, true]) {
      const prefix = await scenario(bounded);
      expect(isJournalShapeSound(prefix)).toBe(true);
      const idx = prefix.map((e, i) => (e.event_type === "ACTION_EXECUTED" ? i : -1)).filter((i) => i >= 0);
      expect(idx.length).toBeGreaterThan(0);
      for (const i of idx) {
        for (const bad of BAD) {
          const j: any[] = JSON.parse(JSON.stringify(prefix));
          if (bad === undefined) delete j[i].payload.execution_result; else j[i].payload.execution_result = bad;
          expect({ i, bad, sound: isJournalShapeSound(j) }).toEqual({ i, bad, sound: false });
          expect(issueProbe(OPTIMIZED, j, "agent", "act-2")).toEqual(issueProbe(REFERENCE, j, "agent", "act-2"));
          expect(compareEngines(j).divergences).toEqual([]);
        }
      }
    }
  });

  it("random journals with a damaged execution_result: no result, error or evaluation-order divergence", async () => {
    let damaged = 0;
    for (let s = 1; s <= 120; s++) {
      const base = await genJournal(s, 60, { budgetBias: s % 2 ? 0.7 : 0 });
      for (let i = 0; i < base.length; i++) {
        if (base[i].event_type !== "ACTION_EXECUTED") continue;
        for (const bad of BAD) {
          const j: any[] = JSON.parse(JSON.stringify(base));
          if (bad === undefined) delete j[i].payload.execution_result; else j[i].payload.execution_result = bad;
          damaged++;
          expect(compareEngines(j).divergences).toEqual([]);
        }
        break; // one ACTION_EXECUTED per journal keeps the run short
      }
    }
    expect(damaged).toBeGreaterThan(300);
  });
});

describe("JournalLookup: exactly the first match, exactly the original errors", () => {
  const act = (id: string, tag: string) => ({ event_type: "ACTION_REQUESTED", payload: { action_id: id, tag } }) as any;
  const del = (id: string, type: string, tag: string) => ({ event_type: type, payload: { delegation_id: id, tag } }) as any;
  const scanA = (store: any[]) => (id: any) => { for (const e of store) if (e.event_type === "ACTION_REQUESTED" && e.payload.action_id === id) return e; return undefined; };
  const scanD = (store: any[]) => (id: any) => { for (const e of store) if ((e.event_type === "DELEGATION_CREATED" || e.event_type === "SUBDELEGATION_CREATED") && e.payload.delegation_id === id) return e; return undefined; };

  it("duplicate ids: the FIRST event in array order wins, for actions and for delegations of either type", () => {
    const store = [act("a", "first"), act("a", "second"), del("d", "SUBDELEGATION_CREATED", "first"), del("d", "DELEGATION_CREATED", "second")];
    const lk = new JournalLookup(store as any);
    expect(lk.actionRequested("a" as any, scanA(store) as any)).toBe(store[0]);
    expect(lk.delegation("d" as any, scanD(store) as any)).toBe(store[2]);
    expect(lk.actionRequested("missing" as any, scanA(store) as any)).toBeUndefined();
  });

  it("the array order decides, not the sequence field", () => {
    const store = [{ ...act("a", "high"), sequence: 9 }, { ...act("a", "low"), sequence: 1 }];
    expect(new JournalLookup(store as any).actionRequested("a" as any, scanA(store) as any)).toBe(store[0]);
  });

  it("a malformed event AFTER the match: the original scan does not throw there, and neither does a lookup", () => {
    const store = [act("a", "ok"), { event_type: "ACTION_REQUESTED", payload: null }] as any[];
    expect(observe(() => scanA(store)("a"))).toEqual(observe(() => new JournalLookup(store).actionRequested("a" as any, scanA(store) as any)));
    expect(observe(() => scanA(store)("a")).ok).toBe(true);
  });

  it("a malformed event BEFORE the match / with no match: the same TypeError as the original scan", () => {
    for (const store of [[{ event_type: "ACTION_REQUESTED", payload: undefined }, act("a", "x")], [null, act("a", "x")], [{ event_type: "ACTION_REQUESTED" }]] as any[][]) {
      const expected = observe(() => scanA(store)("a"));
      expect(expected.ok).toBe(false);
      expect(observe(() => new JournalLookup(store as any).actionRequested("a" as any, scanA(store) as any))).toEqual(expected);
    }
    const dstore = [{ event_type: "DELEGATION_CREATED", payload: null }, del("d", "DELEGATION_CREATED", "x")] as any[];
    expect(observe(() => new JournalLookup(dstore).delegation("d" as any, scanD(dstore) as any))).toEqual(observe(() => scanD(dstore)("d")));
  });

  it("non-string ids never match through the Map", () => {
    const store = [{ event_type: "ACTION_REQUESTED", payload: { action_id: 7 } }, act("7", "string")] as any[];
    const lk = new JournalLookup(store);
    expect(lk.actionRequested("7" as any, scanA(store) as any)).toBe(store[1]);
    expect(lk.actionRequested(7 as any, scanA(store) as any)).toBe(scanA(store)(7)); // delegated to the original scan
  });
});
