/**
 * O2-1 (memory backend): the SDK after the change against the frozen SDK + storage of 56924b8, same random scenarios,
 * with and without budgets. Results and final journals must be identical; the number of lock-free journal reads may only go down.
 *
 *   O2_SCENARIOS   scenarios per category (default 200; the audit run uses 10000)
 */
import { describe, expect, it } from "vitest";
import { IMPLS, runScenario, type Impl } from "./helpers/o2.js";
import { mutate, rng } from "../engine/helpers/o1.js";

const N = Number(process.env.O2_SCENARIOS ?? 200);

describe("O2 differential (memory): current SDK vs frozen SDK", () => {
  for (const [label, bias] of [["without budget", 0], ["with budget", 0.8]] as const) {
    it(`${label}: ${N} scenarios, identical results and journals`, { timeout: 900_000 }, async () => {
      let ops = 0;
      for (let seed = 1; seed <= N; seed++) {
        const opts = { steps: 45, budgetBias: bias, backend: (I: any) => I.memoryBackend() };
        const cur = await runScenario(seed, "current", opts);
        const old = await runScenario(seed, "oracle", opts);
        ops += cur.results.length;
        expect({ seed, results: cur.results }).toEqual({ seed, results: old.results });
        expect({ seed, journal: cur.journal }).toEqual({ seed, journal: old.journal });
      }
      console.info(`[O2] memory ${label}: scenarios=${N} operations=${ops} divergences=0`);
      expect(ops).toBeGreaterThan(N * 30);
    });
  }

  it("journal reads by the SDK itself per authorize() path: the lookup reads only the ACTION_REQUESTED rows; one full read fewer wherever the request is looked up", async () => {
    type Counts = { full: number; filtered: number };
    const counts: Record<string, Record<Impl, Counts>> = {};
    for (const impl of ["current", "oracle"] as Impl[]) {
      const I = IMPLS[impl];
      const c: Counts = { full: 0, filtered: 0 };
      const base = I.memoryBackend();
      const backend = { ...base, build: (o: any) => { const p = base.build(o); const store = { append: (...x: any[]) => p.store.append(...x), getBySequence: (...x: any[]) => p.store.getBySequence(...x), getEvents: (...x: any[]) => { if (x[0] === undefined) c.full++; else c.filtered++; return p.store.getEvents(...x); } }; return { ...p, store }; } };
      let now = Date.parse("2026-06-01T09:00:00.000Z");
      const clock = { now: () => new Date(now).toISOString() };
      const ev = I.createEventBuilders({ clock });
      const a = I.createAuthority({ backend, clock, enforcementPointId: "ep" });
      await a.record([ev.delegation({ delegationId: "d", grantor: "alice", grantee: "agent", capabilities: [{ resource: "r", action: "x" }], canDelegate: false, expiresAt: null, thresholds: { automaticMax: { value: 5, currency: "EUR" }, approvalMax: { value: 50, currency: "EUR" } } })]);
      const call = (id: string, v = 3) => ({ actionId: id, agentId: "agent", delegationId: "d", capability: { resource: "r", action: "x" }, amount: { value: v, currency: "EUR" } });
      const measure = async (label: string, fn: () => Promise<any>) => { c.full = 0; c.filtered = 0; now += 1000; await fn(); (counts[label] ??= {} as any)[impl] = { ...c }; };
      await measure("new action", () => a.authorize(call("a1")));
      await measure("same action again", () => a.authorize(call("a1")));
      await measure("id reused with a different call", () => a.authorize(call("a1", 4)));
      await a.authorize(call("a2", 20));
      await a.record([ev.approvalRequest({ approvalId: "ap2", actionId: "a2", requestedBy: "agent", requestedFrom: "alice", reasonCode: "R" })]);
      await a.record([ev.approvalGranted({ approvalId: "ap2", actionId: "a2", approver: "alice" })]);
      await measure("authorize after approval", () => a.authorize(call("a2", 20)));
    }
    console.info("[O2-T1] SDK-level journal reads per call, full+filtered (oracle -> current): " + Object.entries(counts).map(([k, v]) => `${k}: ${v.oracle.full}+${v.oracle.filtered} -> ${v.current.full}+${v.current.filtered}`).join("; "));
    expect(counts["new action"]).toEqual({ oracle: { full: 2, filtered: 0 }, current: { full: 1, filtered: 1 } });
    expect(counts["same action again"]).toEqual({ oracle: { full: 2, filtered: 0 }, current: { full: 1, filtered: 1 } });
    expect(counts["authorize after approval"]).toEqual({ oracle: { full: 2, filtered: 0 }, current: { full: 1, filtered: 1 } });
    expect(counts["id reused with a different call"]).toEqual({ oracle: { full: 1, filtered: 0 }, current: { full: 0, filtered: 1 } });
  });

  it("a racing writer appended the same request first (our append is refused, the journal read afterwards holds a matching request): same result before and after, the journal is read again", async () => {
    const results: Record<string, unknown> = {};
    for (const impl of ["current", "oracle"] as Impl[]) {
      const I = IMPLS[impl];
      const base = I.memoryBackend();
      let raced = false;
      const backend = { ...base, build: (o: any) => { const p = base.build(o); const store = {
        getBySequence: (...x: any[]) => p.store.getBySequence(...x),
        getEvents: (...x: any[]) => p.store.getEvents(...x),
        append: async (drafts: any[]) => {
          if (!raced && drafts[0]?.event_type === "ACTION_REQUESTED") { raced = true; await p.store.append([{ ...drafts[0], event_id: "racer-1" }]); return { outcomes: [{ accepted: false, reasonCode: "BUSINESS_ID_COLLISION" }] }; }
          return p.store.append(drafts);
        },
      }; return { ...p, store }; } };
      let now = Date.parse("2026-06-01T09:00:00.000Z");
      const clock = { now: () => new Date(now).toISOString() };
      const ev = I.createEventBuilders({ clock });
      const a = I.createAuthority({ backend, clock, enforcementPointId: "ep", newId: () => "cap-1" });
      await a.record([ev.delegation({ delegationId: "d", grantor: "alice", grantee: "agent", capabilities: [{ resource: "r", action: "x" }], canDelegate: false, expiresAt: null, thresholds: { automaticMax: { value: 5, currency: "EUR" }, approvalMax: { value: 50, currency: "EUR" } } })]);
      now += 1000;
      const r: any = await a.authorize({ actionId: "a1", agentId: "agent", delegationId: "d", capability: { resource: "r", action: "x" }, amount: { value: 3, currency: "EUR" } });
      results[impl] = r;
      expect(raced).toBe(true);
      expect(r.status).toBe("AUTHORIZED");
    }
    expect(results.current).toEqual(results.oracle);
  });

  // --- malformed journals: the SDK-level reads (what changed) see a poisoned view; both SDKs see exactly the same one -----
  const firstAR = (ev: any[]) => ev.findIndex((e) => e?.event_type === "ACTION_REQUESTED");
  const lastAR = (ev: any[]) => { for (let i = ev.length - 1; i >= 0; i--) if (ev[i]?.event_type === "ACTION_REQUESTED") return i; return -1; };
  const POISONS: Record<string, (events: any[]) => any[]> = {
    "JSON null payload on the first ACTION_REQUESTED (before every later target)": (ev) => { const i = firstAR(ev); if (i >= 0) ev[i] = { ...ev[i], payload: null }; return ev; },
    "JSON null payload on the LAST ACTION_REQUESTED (after every earlier target)": (ev) => { const i = lastAR(ev); if (i >= 0) ev[i] = { ...ev[i], payload: null }; return ev; },
    "a duplicate action id with different content, right after the first request": (ev) => { const i = firstAR(ev); if (i >= 0) ev.splice(i + 1, 0, { ...ev[i], event_id: "dup-" + ev[i].event_id, payload: { ...ev[i].payload, requesting_principal_id: "mallory", amount: undefined } }); return ev; },
    "a numeric action_id on the first ACTION_REQUESTED": (ev) => { const i = firstAR(ev); if (i >= 0) ev[i] = { ...ev[i], payload: { ...ev[i].payload, action_id: 7 } }; return ev; },
    "a missing action_id on the first ACTION_REQUESTED": (ev) => { const i = firstAR(ev); if (i >= 0) { const { action_id: _a, ...rest } = ev[i].payload; ev[i] = { ...ev[i], payload: rest }; } return ev; },
    "a string payload on the first ACTION_REQUESTED": (ev) => { const i = firstAR(ev); if (i >= 0) ev[i] = { ...ev[i], payload: "oops" }; return ev; },
    "seeded structural damage anywhere (rows are never null)": (ev) => mutate(ev, rng(ev.length * 7919 + 13)).filter((e) => e !== null && typeof e === "object"),
  };
  const poisoned = (poison: (events: any[]) => any[]) => (base: any) => ({ ...base, build: (o: any) => {
    const p = base.build(o);
    const view = async () => poison(JSON.parse(JSON.stringify(await p.store.getEvents())));
    const store = { append: (...x: any[]) => p.store.append(...x), getBySequence: (...x: any[]) => p.store.getBySequence(...x),
      getEvents: async (filter?: any) => { const ev = await view(); return filter?.eventType === undefined ? ev : ev.filter((e) => e?.event_type === filter.eventType); } };
    return { ...p, store };
  } });

  for (const [name, poison] of Object.entries(POISONS)) {
    it(`malformed journal, ${name}: identical results, errors and journals before and after`, { timeout: 300_000 }, async () => {
      const n = Number(process.env.O2_MALFORMED_SCENARIOS ?? 60);
      let threw = 0;
      for (let seed = 1; seed <= n; seed++) {
        const opts = { steps: 30, budgetBias: seed % 2 ? 0.7 : 0, backend: (I: any) => I.memoryBackend(), wrapBackend: poisoned(poison) };
        const cur = await runScenario(seed, "current", opts);
        const old = await runScenario(seed, "oracle", opts);
        threw += JSON.stringify(old.results).includes("UNAVAILABLE") ? 1 : 0;
        expect({ seed, results: cur.results }).toEqual({ seed, results: old.results });
        expect({ seed, journal: cur.journal }).toEqual({ seed, journal: old.journal });
      }
      if (name.startsWith("JSON null payload on the first")) expect(threw).toBeGreaterThan(0); // the reference really does fail closed on this journal: the error parity is exercised
    });
  }
});
