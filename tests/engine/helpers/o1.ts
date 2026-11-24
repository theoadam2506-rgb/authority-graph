/**
 * Differential-testing helpers for the O1 performance change: random journals, structural mutations, and a probe
 * suite that runs the SAME engine calls against the optimized engine (src/engine) and the frozen reference
 * (tests/oracle/engine), observing results AND thrown errors.
 */
import { createAuthority, createEventBuilders, memoryBackend } from "../../../src/sdk/index.js";
import type { DraftAuthorityEvent } from "../../../src/domain/events.js";
import * as opt from "../../../src/engine/issueCapability.js";
import * as optCap from "../../../src/engine/capacity.js";
import * as optBudget from "../../../src/engine/evaluateConstraints.js";
import * as optGrant from "../../../src/engine/grantValidation.js";
import * as optAt from "../../../src/engine/authorityAt.js";
import * as optRedeem from "../../../src/engine/redeemCapability.js";
import * as optExplain from "../../../src/engine/explainAction.js";
import * as refIssue from "../../oracle/engine/issueCapability.js";
import * as refCap from "../../oracle/engine/capacity.js";
import * as refBudget from "../../oracle/engine/evaluateConstraints.js";
import * as refGrant from "../../oracle/engine/grantValidation.js";
import * as refAt from "../../oracle/engine/authorityAt.js";
import * as refRedeem from "../../oracle/engine/redeemCapability.js";
import * as refExplain from "../../oracle/engine/explainAction.js";

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random but realistic journal, produced through the public SDK on the in-memory backend. */
export async function genJournal(seed: number, steps: number, opts: { readonly budgetBias?: number; readonly backend?: any; readonly deterministicIds?: boolean } = {}): Promise<any[]> {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const int = (a: number, b: number): number => a + Math.floor(r() * (b - a + 1));
  const budgetBias = opts.budgetBias ?? 0.5;
  let now = Date.parse("2026-06-01T09:00:00.000Z");
  const clock = { now: () => new Date(now).toISOString() };
  let idn = 0;
  const det = opts.deterministicIds === true;
  const ev = createEventBuilders({ clock, ...(det ? { newEventId: () => `evt-${++idn}` } : {}) });
  const a = createAuthority({ backend: opts.backend ?? memoryBackend(), clock, enforcementPointId: "ep", ...(det ? { newId: () => `cap-${++idn}` } : {}) });
  const iso = (ms: number) => new Date(ms).toISOString();
  const caps = [{ resource: "r", action: "x" }, { resource: "r", action: "y" }];
  const dels: { id: string; grantee: string; cap: typeof caps }[] = [];
  let dn = 0, an = 0, apn = 0;
  const constraints = (): any => {
    const c: any = { expiresAt: r() < 0.15 ? iso(now + int(1, 40) * 1000) : null };
    if (r() < budgetBias) c.totalBudget = { value: int(4, 40), currency: "EUR" };
    if (r() < 0.2) c.maxAmount = { value: int(3, 15), currency: "EUR" };
    if (r() < 0.6) c.thresholds = { automaticMax: { value: int(5, 12), currency: "EUR" }, approvalMax: { value: int(13, 30), currency: "EUR" } };
    return c;
  };
  const tryRec = async (d: () => DraftAuthorityEvent): Promise<void> => {
    try { await a.record([d()]); } catch { /* an invalid draft is part of the fuzz */ }
  };
  const agents = ["a1", "a2", "a3"];
  const mids = ["m1", "m2"];
  for (let i = 0; i < steps; i++) {
    now += int(0, 5) * 1000;
    const k = r();
    if (k < 0.12 || dels.length === 0) {
      const g = pick([...agents, ...mids]); const cap = r() < 0.7 ? [caps[0]!] : caps; const id = `d${dn++}`;
      await tryRec(() => ev.delegation({ delegationId: id, grantor: "alice", grantee: g, capabilities: cap, canDelegate: r() < 0.6, ...constraints() }));
      dels.push({ id, grantee: g, cap });
    } else if (k < 0.22) {
      const p = pick(dels); const g = pick(agents); const id = `d${dn++}`;
      await tryRec(() => ev.subdelegation({ delegationId: id, parentDelegationId: p.id, grantor: p.grantee, grantee: g, capabilities: [p.cap[0]!], canDelegate: false, ...constraints() }));
      dels.push({ id, grantee: g, cap: [p.cap[0]!] });
    } else if (k < 0.27) {
      const d = pick(dels);
      await tryRec(() => ev.revocation({ delegationId: d.id, revokedBy: r() < 0.9 ? "alice" : d.grantee, reasonCode: "FUZZ" }));
    } else {
      const d = pick(dels); const id = `act${an++}`;
      const call = { actionId: id, agentId: r() < 0.9 ? d.grantee : pick(agents), delegationId: d.id, capability: r() < 0.9 ? d.cap[0]! : caps[1]!, amount: { value: int(1, 9), currency: r() < 0.97 ? "EUR" : "USD" } };
      try {
        if (r() < 0.2) {
          const res = await a.authorize(call);
          if (res.status === "REQUIRES_APPROVAL") {
            const ap = `ap${apn++}`;
            await tryRec(() => ev.approvalRequest({ approvalId: ap, actionId: id, requestedBy: call.agentId, requestedFrom: "alice", reasonCode: "R" }));
            await tryRec(() => (r() < 0.8 ? ev.approvalGranted({ approvalId: ap, actionId: id, approver: "alice" }) : ev.approvalDenied({ approvalId: ap, actionId: id, denier: "alice", reasonCode: "NO" })));
            if (r() < 0.7) await a.authorize(call);
          }
        } else {
          await a.guard(call, async () => { if (r() < 0.1) throw new Error("boom"); return "ok"; });
        }
      } catch { /* part of the fuzz */ }
    }
  }
  return (await a.events()) as any[];
}

// --------------------------------------------------------------------------- structural mutations

function paths(value: any, prefix: (string | number)[] = [], out: (string | number)[][] = []): (string | number)[][] {
  if (typeof value === "object" && value !== null) {
    for (const k of Object.keys(value)) {
      const key: string | number = Array.isArray(value) ? Number(k) : k;
      out.push([...prefix, key]);
      paths(value[k], [...prefix, key], out);
    }
  }
  return out;
}

const JUNK: readonly unknown[] = [null, undefined, 42, -1, 1.5, "", "zzz", true, false, [], {}, [null], { kind: "delegation" }, "2026-01-01T00:00:00.000Z"];
const TYPES = ["DELEGATION_CREATED", "SUBDELEGATION_CREATED", "DELEGATION_REVOKED", "ACTION_REQUESTED", "APPROVAL_REQUESTED", "APPROVAL_GRANTED", "APPROVAL_DENIED", "ACTION_EXECUTED", "CAPABILITY_ISSUED", "CAPABILITY_REDEEMED", "NOPE"];

/** 1 to 3 random structural damages (missing/null/wrong-typed fields, wrong event_type, dropped/duplicated/nulled events). */
export function mutate(journal: readonly any[], r: () => number): any[] {
  const out: any[] = JSON.parse(JSON.stringify(journal));
  const n = 1 + Math.floor(r() * 3);
  for (let m = 0; m < n && out.length > 0; m++) {
    // bias towards the event types the grant validation reads
    let i = Math.floor(r() * out.length);
    if (r() < 0.6) {
      const hot = out.map((e, idx) => [e, idx] as const).filter(([e]) => e && ["CAPABILITY_ISSUED", "ACTION_EXECUTED", "ACTION_REQUESTED", "DELEGATION_CREATED", "SUBDELEGATION_CREATED", "DELEGATION_REVOKED"].includes(e.event_type));
      if (hot.length > 0) i = hot[Math.floor(r() * hot.length)]![1];
    }
    const kind = r();
    if (kind < 0.08) out.splice(i, 1);
    else if (kind < 0.14) out.splice(i, 0, JSON.parse(JSON.stringify(out[i])));
    else if (kind < 0.18) out[i] = null;
    else if (kind < 0.26 && out[i]) out[i].event_type = TYPES[Math.floor(r() * TYPES.length)];
    else if (out[i] && typeof out[i] === "object") {
      const ps = paths(out[i]);
      if (ps.length === 0) continue;
      const p = ps[Math.floor(r() * ps.length)]!;
      let parent: any = out[i];
      for (const k of p.slice(0, -1)) parent = parent[k];
      const last = p[p.length - 1]!;
      if (r() < 0.35) { if (Array.isArray(parent)) parent.splice(Number(last), 1); else delete parent[last]; }
      else parent[last] = JUNK[Math.floor(r() * JUNK.length)];
    }
  }
  return out;
}

// --------------------------------------------------------------------------- observation

export type Observation = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: string };

export function observe(fn: () => unknown): Observation {
  try {
    const v = fn();
    return { ok: true, value: JSON.stringify(v, (_k, x) => (x === undefined ? "__undefined__" : x)) ?? "undefined" };
  } catch (e) {
    const err = e as { name?: string; message?: string };
    return { ok: false, error: `${err?.name}: ${err?.message}` };
  }
}

export interface Engine {
  readonly issueCapability: typeof opt.issueCapability;
  readonly remainingCapacity: typeof optCap.remainingCapacity;
  readonly remainingBudget: typeof optBudget.remainingBudget;
  readonly validateAndSelectGrant: typeof optGrant.validateAndSelectGrant;
  readonly authorityAt: typeof optAt.authorityAt;
  readonly redeemCapability: typeof optRedeem.redeemCapability;
  readonly explainAction: typeof optExplain.explainAction;
}
export const OPTIMIZED: Engine = { issueCapability: opt.issueCapability, remainingCapacity: optCap.remainingCapacity, remainingBudget: optBudget.remainingBudget, validateAndSelectGrant: optGrant.validateAndSelectGrant, authorityAt: optAt.authorityAt, redeemCapability: optRedeem.redeemCapability, explainAction: optExplain.explainAction };
export const REFERENCE: Engine = { issueCapability: refIssue.issueCapability as any, remainingCapacity: refCap.remainingCapacity as any, remainingBudget: refBudget.remainingBudget as any, validateAndSelectGrant: refGrant.validateAndSelectGrant as any, authorityAt: refAt.authorityAt as any, redeemCapability: refRedeem.redeemCapability as any, explainAction: refExplain.explainAction as any };

const FIXED_DEPS = { nextCapabilityId: () => "cap-fixed" as any, expiresAt: (t: string) => new Date(Date.parse(t) + 600000).toISOString() as any };

function maxTime(store: readonly any[]): string {
  let m = Date.parse("2026-06-01T09:00:00.000Z");
  for (const e of store) { const ms = e && typeof e.authority_time === "string" ? Date.parse(e.authority_time) : NaN; if (ms > m) m = ms; }
  return new Date(m).toISOString();
}

/** The probe suite: every observation is labelled so the two engines can be compared one by one. */
export function runProbes(engine: Engine, journal: readonly any[]): [string, Observation][] {
  const out: [string, Observation][] = [];
  const safe = journal.filter((e) => e && typeof e === "object");
  const t = maxTime(journal);
  const actions = safe.filter((e) => e.event_type === "ACTION_REQUESTED" && e.payload && typeof e.sequence === "number").slice(0, 10);
  for (const a of actions) {
    const prefix = journal.filter((e) => e && e.sequence <= a.sequence);
    const who = a.payload?.requesting_principal_id;
    const cmd = { action_id: a.payload?.action_id, enforcement_point_id: "ep" } as any;
    out.push([`issue/prefix/${a.sequence}`, observe(() => engine.issueCapability(prefix as any, { principalId: who } as any, cmd, FIXED_DEPS as any, maxTime(prefix) as any))]);
    out.push([`issue/full/${a.sequence}`, observe(() => engine.issueCapability(journal as any, { principalId: who } as any, cmd, FIXED_DEPS as any, t as any))]);
    out.push([`issue/other/${a.sequence}`, observe(() => engine.issueCapability(prefix as any, { principalId: "someone-else" } as any, cmd, FIXED_DEPS as any, maxTime(prefix) as any))]);
    out.push([`explain/${a.sequence}`, observe(() => engine.explainAction(journal as any, { actionId: a.payload?.action_id } as any, { atSequence: journal.length, authorityTime: t } as any))]);
  }
  const grants = safe.filter((e) => e.event_type === "CAPABILITY_ISSUED").slice(0, 12);
  const validated: any[] = [];
  for (const g of grants) {
    const o = observe(() => { const v = engine.validateAndSelectGrant(journal as any, g); if ((v as any).ok) validated.push((v as any).grant); return v; });
    out.push([`grant/${g.sequence}`, o]);
    out.push([`redeem/${g.sequence}`, observe(() => engine.redeemCapability(journal as any, { principalId: safe.find((e) => e.event_type === "ACTION_REQUESTED" && e.payload?.action_id === g.payload?.action_id)?.payload?.requesting_principal_id } as any, { capability_id: g.payload?.capability_id, enforcement_point_id: g.payload?.enforcement_point_id, observed_capability: safe.find((e) => e.event_type === "ACTION_REQUESTED" && e.payload?.action_id === g.payload?.action_id)?.payload?.capability_requested, observed_parameters: safe.find((e) => e.event_type === "ACTION_REQUESTED" && e.payload?.action_id === g.payload?.action_id)?.payload?.parameters } as any, t as any))]);
  }
  const delegs = safe.filter((e) => (e.event_type === "DELEGATION_CREATED" || e.event_type === "SUBDELEGATION_CREATED") && e.payload).slice(0, 8);
  for (const d of delegs) {
    const budget = d.payload.total_budget ?? { value: 20, currency: "EUR" };
    out.push([`budget/${d.sequence}`, observe(() => engine.remainingBudget(d.payload.delegation_id, budget, journal as any))]);
    out.push([`budget/prefix/${d.sequence}`, observe(() => engine.remainingBudget(d.payload.delegation_id, budget, journal.filter((e) => e && e.sequence <= d.sequence + 6) as any))]);
    out.push([`capacity/${d.sequence}`, observe(() => engine.remainingCapacity(d.payload.delegation_id, budget, validated as any, journal as any))]);
    for (const a of actions.slice(0, 2)) {
      out.push([`authorityAt/${d.sequence}/${a.sequence}`, observe(() => engine.authorityAt(journal as any, { agentId: d.payload.grantee_principal_id, principalId: d.payload.grantor_principal_id, capability: a.payload?.capability_requested, parameters: a.payload?.parameters } as any, { atSequence: journal.length, authorityTime: t } as any))]);
    }
  }
  return out;
}

export interface Divergence { readonly label: string; readonly optimized: Observation; readonly reference: Observation }

export function compareEngines(journal: readonly any[]): { readonly divergences: Divergence[]; readonly probes: number; readonly referenceThrew: number } {
  const a = runProbes(OPTIMIZED, journal);
  const b = runProbes(REFERENCE, journal);
  const divergences: Divergence[] = [];
  let referenceThrew = 0;
  if (a.length !== b.length) divergences.push({ label: "probe-count", optimized: { ok: true, value: String(a.length) }, reference: { ok: true, value: String(b.length) } });
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const [label, x] = a[i]!; const [, y] = b[i]!;
    if (!y.ok) referenceThrew++;
    if (JSON.stringify(x) !== JSON.stringify(y)) divergences.push({ label, optimized: x, reference: y });
  }
  return { divergences, probes: a.length, referenceThrew };
}

/** Every single-field fault of a journal: for each event, each JSON path, each junk value (delete included). */
export function* singleFaults(journal: readonly any[], junk: readonly unknown[]): Generator<{ readonly label: string; readonly journal: any[] }> {
  for (let i = 0; i < journal.length; i++) {
    const ps = paths(journal[i]);
    for (const p of ps) {
      for (const j of junk) {
        const copy: any[] = JSON.parse(JSON.stringify(journal));
        let parent: any = copy[i];
        for (const k of p.slice(0, -1)) parent = parent[k];
        const last = p[p.length - 1]!;
        if (j === undefined) { if (Array.isArray(parent)) parent.splice(Number(last), 1); else delete parent[last]; } else parent[last] = j;
        yield { label: `event#${i}(${journal[i].event_type}) ${p.join(".")} <- ${JSON.stringify(j) ?? "DELETE"}`, journal: copy };
      }
    }
  }
}

export function issueProbe(engine: Engine, store: readonly any[], principal: string, actionId: string): Observation {
  return observe(() => engine.issueCapability(store as any, { principalId: principal } as any, { action_id: actionId, enforcement_point_id: "ep" } as any, FIXED_DEPS as any, maxTime(store) as any));
}

/** A small deterministic scenario: one delegation (optionally bounded), one completed action, then a second action just requested. */
export async function scenario(bounded: boolean): Promise<any[]> {
  let now = Date.parse("2026-06-01T09:00:00.000Z");
  const clock = { now: () => new Date(now).toISOString() };
  const ev = createEventBuilders({ clock });
  const a = createAuthority({ backend: memoryBackend(), clock, enforcementPointId: "ep" });
  await a.record([ev.delegation({ delegationId: "d", grantor: "alice", grantee: "agent", capabilities: [{ resource: "r", action: "x" }], canDelegate: true, expiresAt: null, ...(bounded ? { totalBudget: { value: 10, currency: "EUR" } } : {}), thresholds: { automaticMax: { value: 8, currency: "EUR" }, approvalMax: { value: 20, currency: "EUR" } } })]);
  await a.record([ev.subdelegation({ delegationId: "d2", parentDelegationId: "d", grantor: "agent", grantee: "sub", capabilities: [{ resource: "r", action: "x" }], canDelegate: false, expiresAt: null, thresholds: { automaticMax: { value: 8, currency: "EUR" }, approvalMax: { value: 20, currency: "EUR" } } })]);
  const call = (id: string, who = "agent", del = "d") => ({ actionId: id, agentId: who, delegationId: del, capability: { resource: "r", action: "x" }, amount: { value: 4, currency: "EUR" } });
  now += 1000; await a.guard(call("act-1"), async () => "ok");
  now += 1000; await a.guard(call("act-s", "sub", "d2"), async () => "ok");
  now += 1000; await a.authorize(call("act-2")); // issues a ticket too; the probe below uses the prefix cut at its request
  const full = (await a.events()) as any[];
  const req = full.find((e) => e.event_type === "ACTION_REQUESTED" && e.payload.action_id === "act-2")!;
  return full.filter((e) => e.sequence <= req.sequence);
}
