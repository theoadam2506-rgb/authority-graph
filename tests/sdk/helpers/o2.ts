/**
 * O2-1 differential helpers: the SAME random SDK scenario is executed against the current SDK (src/sdk) and against the frozen
 * pre-change SDK + storage (tests/oracle/sdk, tests/oracle/storage, copied from 56924b8). Results and final journals must match.
 */
import { createAuthority as createCurrent, createEventBuilders as buildersCurrent, memoryBackend as memCurrent, postgresBackend as pgCurrent } from "../../../src/sdk/index.js";
import { createAuthority as createOracle, createEventBuilders as buildersOracle, memoryBackend as memOracle, postgresBackend as pgOracle } from "../../oracle/sdk/index.js";
import { rng } from "../../engine/helpers/o1.js";

export type Impl = "current" | "oracle";
export const IMPLS = {
  current: { createAuthority: createCurrent as any, createEventBuilders: buildersCurrent as any, memoryBackend: memCurrent as any, postgresBackend: pgCurrent as any },
  oracle: { createAuthority: createOracle as any, createEventBuilders: buildersOracle as any, memoryBackend: memOracle as any, postgresBackend: pgOracle as any },
};

const norm = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "string" ? x.replace(/diag-[0-9a-f-]{36}/g, "diag-*").replace(/:attempt-[0-9a-f-]+$/, ":attempt-*") : x)));

export interface ScenarioOptions { readonly steps: number; readonly budgetBias: number; readonly backend: (impl: (typeof IMPLS)["current"]) => any; readonly wrapBackend?: (backend: any) => any }
export interface ScenarioResult { readonly results: unknown[]; readonly journal: unknown[] }

export async function runScenario(seed: number, impl: Impl, o: ScenarioOptions): Promise<ScenarioResult> {
  const I = IMPLS[impl];
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const int = (a: number, b: number): number => a + Math.floor(r() * (b - a + 1));
  let now = Date.parse("2026-06-01T09:00:00.000Z");
  const clock = { now: () => new Date(now).toISOString() };
  let n = 0;
  const ev = I.createEventBuilders({ clock, newEventId: () => `evt-${++n}` });
  const base = o.backend(I);
  const a = I.createAuthority({ backend: o.wrapBackend ? o.wrapBackend(base) : base, clock, enforcementPointId: "ep", newId: () => `cap-${++n}` });
  const results: unknown[] = [];
  const log = (label: string, v: unknown) => results.push([label, norm(v)]);
  const caps = [{ resource: "r", action: "x" }, { resource: "r", action: "y" }];
  const dels: { id: string; grantee: string; cap: (typeof caps)[number] }[] = [];
  const calls = new Map<string, any>();
  const tickets: any[] = [];
  let dn = 0, an = 0, apn = 0;
  const constraints = (): any => {
    const c: any = { expiresAt: r() < 0.05 ? new Date(now + int(1, 40) * 1000).toISOString() : null };
    if (r() < o.budgetBias) c.totalBudget = { value: int(4, 30), currency: "EUR" };
    if (r() < 0.1) c.maxAmount = { value: int(8, 20), currency: "EUR" };
    c.thresholds = { automaticMax: { value: int(5, 12), currency: "EUR" }, approvalMax: { value: int(13, 30), currency: "EUR" } };
    return c;
  };
  const rec = async (label: string, d: () => any) => { try { log(label, await a.record([d()])); } catch (e: any) { log(label, { threw: e?.name }); } };
  const safe = async (label: string, f: () => Promise<unknown>) => { try { log(label, await f()); } catch (e: any) { log(label, { threw: `${e?.name}:${String(e?.message).slice(0, 60)}` }); } };
  const agents = ["a1", "a2", "a3"];
  for (let i = 0; i < o.steps; i++) {
    now += int(0, 4) * 1000;
    const k = r();
    if (k < 0.12 || dels.length === 0) {
      const g = pick(agents); const cap = pick(caps); const id = `d${dn++}`;
      await rec("delegation", () => ev.delegation({ delegationId: id, grantor: "alice", grantee: g, capabilities: r() < 0.7 ? [cap] : caps, canDelegate: r() < 0.6, ...constraints() }));
      dels.push({ id, grantee: g, cap });
    } else if (k < 0.135) {
      const p = pick(dels); const g = pick(agents.filter((x) => x !== p.grantee)); const id = `d${dn++}`;
      await rec("subdelegation", () => ev.subdelegation({ delegationId: id, parentDelegationId: p.id, grantor: p.grantee, grantee: g, capabilities: [p.cap], canDelegate: false, ...constraints() }));
      dels.push({ id, grantee: g, cap: p.cap });
    } else if (k < 0.145) {
      const d = pick(dels);
      await rec("revocation", () => ev.revocation({ delegationId: d.id, revokedBy: "alice", reasonCode: "FUZZ" }));
    } else if (k < 0.4 && calls.size > 0) {
      // retry of a previous action: identical call, or the same action id with a different call
      const [id, c] = pick([...calls.entries()]);
      const call = r() < 0.7 ? c : { ...c, amount: { value: c.amount.value + 1, currency: c.amount.currency } };
      await safe(r() < 0.7 ? "retry" : "reuse", () => a.authorize(call));
    } else if (k < 0.5 && tickets.length > 0) {
      const t = pick(tickets);
      const c = calls.get(t.actionId)!;
      await safe("redeem", () => a.redeem(t, r() < 0.8 ? c : { ...c, amount: { value: c.amount.value + 1, currency: c.amount.currency } }));
      if (r() < 0.7) await safe("report", () => a.report(t, { resultCode: "OK" }));
    } else {
      const d = pick(dels); const id = `act${an++}`;
      const call = { actionId: id, agentId: r() < 0.9 ? d.grantee : pick(agents), delegationId: d.id, capability: r() < 0.9 ? d.cap : pick(caps), amount: { value: int(1, 16), currency: "EUR" } };
      calls.set(id, call);
      if (r() < 0.25) {
        try {
          const res = await a.authorize(call); log("authorize", res);
          if (res.status === "AUTHORIZED") tickets.push(res.ticket);
          if (res.status === "REQUIRES_APPROVAL") {
            const ap = `ap${apn++}`;
            await rec("approvalRequest", () => ev.approvalRequest({ approvalId: ap, actionId: id, requestedBy: call.agentId, requestedFrom: "alice", reasonCode: "R" }));
            await rec(r() < 0.8 ? "approvalGranted" : "approvalDenied", () => (r() < 0.8 ? ev.approvalGranted({ approvalId: ap, actionId: id, approver: "alice" }) : ev.approvalDenied({ approvalId: ap, actionId: id, denier: "alice", reasonCode: "NO" })));
            const again = await a.authorize(call); log("authorize-after-approval", again);
            if (again.status === "AUTHORIZED") tickets.push(again.ticket);
          }
        } catch (e: any) { log("authorize", { threw: e?.name }); }
      } else {
        await safe("guard", () => a.guard(call, async () => { if (r() < 0.1) throw new Error("boom"); return "ok"; }));
      }
    }
  }
  const journal = ((await a.events()) as any[]).map((e) => { const { recorded_at: _r, ...rest } = e; return norm(rest); });
  return { results, journal };
}
