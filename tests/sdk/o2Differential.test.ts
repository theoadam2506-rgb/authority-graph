/**
 * O2-1 (memory backend): the SDK after the change against the frozen SDK + storage of 56924b8, same random scenarios,
 * with and without budgets. Results and final journals must be identical; the number of lock-free journal reads may only go down.
 *
 *   O2_SCENARIOS   scenarios per category (default 200; the audit run uses 10000)
 */
import { describe, expect, it } from "vitest";
import { IMPLS, runScenario, type Impl } from "./helpers/o2.js";

const N = Number(process.env.O2_SCENARIOS ?? 200);

describe("O2-1 differential (memory): current SDK vs frozen SDK", () => {
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

  it("journal reads by the SDK itself (store.getEvents) per authorize() path: one fewer only when the request already exists", async () => {
    const counts: Record<string, Record<Impl, number>> = {};
    for (const impl of ["current", "oracle"] as Impl[]) {
      const I = IMPLS[impl];
      let reads = 0;
      const base = I.memoryBackend();
      const backend = { ...base, build: (o: any) => { const p = base.build(o); const store = { append: (...x: any[]) => p.store.append(...x), getBySequence: (...x: any[]) => p.store.getBySequence(...x), getEvents: (...x: any[]) => { reads++; return p.store.getEvents(...x); } }; return { ...p, store }; } };
      let now = Date.parse("2026-06-01T09:00:00.000Z");
      const clock = { now: () => new Date(now).toISOString() };
      const ev = I.createEventBuilders({ clock });
      const a = I.createAuthority({ backend, clock, enforcementPointId: "ep" });
      await a.record([ev.delegation({ delegationId: "d", grantor: "alice", grantee: "agent", capabilities: [{ resource: "r", action: "x" }], canDelegate: false, expiresAt: null, thresholds: { automaticMax: { value: 5, currency: "EUR" }, approvalMax: { value: 50, currency: "EUR" } } })]);
      const call = (id: string, v = 3) => ({ actionId: id, agentId: "agent", delegationId: "d", capability: { resource: "r", action: "x" }, amount: { value: v, currency: "EUR" } });
      const measure = async (label: string, fn: () => Promise<any>) => { reads = 0; now += 1000; await fn(); (counts[label] ??= {} as any)[impl] = reads; };
      await measure("new action", () => a.authorize(call("a1")));
      await measure("same action again", () => a.authorize(call("a1")));
      await measure("id reused with a different call", () => a.authorize(call("a1", 4)));
      await a.authorize(call("a2", 20));
      await a.record([ev.approvalRequest({ approvalId: "ap2", actionId: "a2", requestedBy: "agent", requestedFrom: "alice", reasonCode: "R" })]);
      await a.record([ev.approvalGranted({ approvalId: "ap2", actionId: "a2", approver: "alice" })]);
      await measure("authorize after approval", () => a.authorize(call("a2", 20)));
    }
    console.info("[O2] SDK-level journal reads per call (oracle -> current): " + Object.entries(counts).map(([k, v]) => `${k} ${v.oracle}->${v.current}`).join("; "));
    expect(counts["new action"]).toEqual({ current: counts["new action"]!.oracle, oracle: counts["new action"]!.oracle });
    expect(counts["id reused with a different call"]!.current).toBe(counts["id reused with a different call"]!.oracle);
    expect(counts["same action again"]!.current).toBe(counts["same action again"]!.oracle - 1);
    expect(counts["authorize after approval"]!.current).toBe(counts["authorize after approval"]!.oracle - 1);
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
});
