/**
 * B1 test material: hand-built journals over a tiny universe, so that EVERY journal up to a length can be enumerated.
 * Events are built as ingested events (sequence = position + 1, authority_time = base + sequence seconds). Nothing here goes through the SDK:
 * the journals may contain what ingestion would also accept, such as references to events that come later, duplicates, forged chains.
 */
import { rng } from "./o1.js";

export const BASE = Date.parse("2026-06-01T09:00:00.000Z");
export type Draft = (sequence: number) => any;

const iso = (ms: number) => new Date(ms).toISOString();
const envelope = (id: string, type: string, principal: string, payload: unknown): Draft => (sequence) => ({
  event_id: `${id}@${sequence}`, schema_version: 1, occurred_at: iso(BASE + sequence * 1000), principal_id: principal, sequence,
  authority_time: iso(BASE + sequence * 1000), recorded_at: iso(BASE + sequence * 1000), assurance_level: "ASSERTED_UNVERIFIED", event_type: type, payload,
});

export const cap = { resource: "r", action: "x" };
const money = (value: number, currency = "EUR") => ({ value, currency });
const fingerprintOf = async () => (await import("../../../src/domain/events.js")).computeActionFingerprint;
export const FP = await fingerprintOf();

export interface DelegationSpec { id: string; parent?: string; grantor: string; grantee: string; budget?: number; currency?: string; canDelegate?: boolean; expiresInSeconds?: number; thresholds?: [number, number]; capabilities?: unknown[] }
export function delegation(spec: DelegationSpec): Draft {
  const payload: any = {
    delegation_id: spec.id, grantor_principal_id: spec.grantor, grantee_principal_id: spec.grantee, capabilities: spec.capabilities ?? [cap], can_delegate: spec.canDelegate ?? true,
    expires_at: spec.expiresInSeconds === undefined ? { kind: "no_expiry" } : { kind: "at", value: iso(BASE + spec.expiresInSeconds * 1000) },
    thresholds: { automatic_max_amount: money(spec.thresholds?.[0] ?? 5, spec.currency ?? "EUR"), approval_max_amount: money(spec.thresholds?.[1] ?? 8, spec.currency ?? "EUR") },
    ...(spec.budget === undefined ? {} : { total_budget: money(spec.budget, spec.currency ?? "EUR") }),
  };
  if (spec.parent === undefined) { payload.grantor_type = "HUMAN_ROOT"; payload.parent_delegation_id = null; } else { payload.parent_delegation_id = spec.parent; }
  return envelope(`del-${spec.id}`, spec.parent === undefined ? "DELEGATION_CREATED" : "SUBDELEGATION_CREATED", spec.grantor, payload);
}
export const request = (action: string, by: string, via: string, amount: number, currency = "EUR"): Draft =>
  envelope(`req-${action}`, "ACTION_REQUESTED", by, { action_id: action, requesting_principal_id: by, delegation_id: via, capability_requested: cap, parameters: { kind: "monetary", amount: money(amount, currency) } });
export const execution = (action: string, by: string, chain: string[], approval?: string): Draft =>
  envelope(`exe-${action}-${by}-${chain.join("+")}`, "ACTION_EXECUTED", by, { action_id: action, executed_by_principal_id: by, action_fingerprint: "f".repeat(64), decision_sequence: 1, authority_chain_ref: [...chain.map((d) => ({ kind: "delegation", delegation_id: d })), ...(approval ? [{ kind: "approval", approval_id: approval }] : [])], execution_result: "EXECUTED" });
export const revocation = (target: string, by: string): Draft => envelope(`rev-${target}-${by}`, "DELEGATION_REVOKED", by, { delegation_id: target, revoked_by_principal_id: by, reason_code: "R" });
export const approvalRequested = (approval: string, action: string): Draft => envelope(`apr-${approval}`, "APPROVAL_REQUESTED", "bob", { approval_id: approval, action_id: action, requested_from_principal_id: "alice", policy_reason_code: "R" });
export const approvalGranted = (approval: string, action: string, by = "alice"): Draft => envelope(`apg-${approval}-${by}`, "APPROVAL_GRANTED", by, { approval_id: approval, action_id: action, approving_principal_id: by });

/** A grant for `action`: correct unless a flaw is asked for. `requestEvent` provides the capability and parameters the fingerprint is computed from. */
export interface GrantSpec { action: string; requestParameters: { capability: unknown; parameters: unknown }; chain: ({ delegation: string } | { approval: string })[]; decisionOffset?: number; badFingerprint?: boolean; id?: string }
export function grant(spec: GrantSpec): Draft {
  return (sequence) => envelope(`iss-${spec.id ?? spec.action}`, "CAPABILITY_ISSUED", "bob", {
    capability_id: `cap-${spec.id ?? spec.action}-${sequence}`, action_id: spec.action,
    action_fingerprint: spec.badFingerprint ? "0".repeat(64) : FP(spec.requestParameters.capability as any, spec.requestParameters.parameters as any),
    decision_sequence: sequence - 1 + (spec.decisionOffset ?? 0),
    granted_chain_ref: spec.chain.map((l) => ("delegation" in l ? { kind: "delegation", delegation_id: l.delegation } : { kind: "approval", approval_id: l.approval })),
    enforcement_point_id: "ep", expires_at: iso(BASE + 3600_000),
  })(sequence);
}
const params = (amount: number, currency = "EUR") => ({ capability: cap, parameters: { kind: "monetary", amount: money(amount, currency) } });
export const grantFor = (action: string, amount: number, chain: GrantSpec["chain"], extra: Partial<GrantSpec> = {}): Draft => grant({ action, requestParameters: params(amount), chain, ...extra });

/** The universe: alice (human root), bob (agent), carol (sub-agent); d1 (budget 10) and its sub-delegation d2 (budget 6); actions a1, a2, a3. */
export const ALPHABET: Record<string, Draft> = {
  D1: delegation({ id: "d1", grantor: "alice", grantee: "bob", budget: 10 }),
  D2: delegation({ id: "d2", parent: "d1", grantor: "bob", grantee: "carol", budget: 6, thresholds: [5, 8] }),
  D1dup: delegation({ id: "d1", grantor: "alice", grantee: "bob", budget: 3 }),                      // a second event for the same id, a tighter budget
  D1exp: delegation({ id: "d1", grantor: "alice", grantee: "bob", budget: 10, expiresInSeconds: 5 }), // expires 5 s after the base
  D1big: delegation({ id: "d1", grantor: "alice", grantee: "bob", budget: 10, thresholds: [9, 9] }),
  A5: request("a5", "bob", "d1", 7),
  G5: grantFor("a5", 7, [{ delegation: "d1" }]),
  A1: request("a1", "bob", "d1", 4),
  A2: request("a2", "carol", "d2", 5),
  A3: request("a3", "bob", "d1", 7),                                                                   // above the automatic ceiling: needs an approval
  A1dup: request("a1", "bob", "d1", 9),
  X1: execution("a1", "bob", ["d1"]),
  X2: execution("a2", "carol", ["d1", "d2"]),
  X2solo: execution("a2", "carol", ["d2"]),
  X1dup: execution("a1", "bob", ["d1"]),
  X1forged: execution("a1", "mallory", ["d1"]),                                                       // executed by someone who does not hold the delegation
  X3: execution("a3", "bob", ["d1"], "ap1"),                                                           // consumes the approval of a3
  R1: revocation("d1", "alice"),
  R2: revocation("d2", "bob"),
  R1outsider: revocation("d1", "mallory"),                                                             // not the grantor: no effect
  AP: approvalRequested("ap1", "a3"),
  APG: approvalGranted("ap1", "a3"),
  APGforged: approvalGranted("ap1", "a3", "mallory"),
  G1: grantFor("a1", 4, [{ delegation: "d1" }]),
  G2: grantFor("a2", 5, [{ delegation: "d1" }, { delegation: "d2" }]),
  G3: grantFor("a3", 7, [{ delegation: "d1" }, { approval: "ap1" }]),
  G1badSeq: grantFor("a1", 4, [{ delegation: "d1" }], { decisionOffset: -1, id: "a1-badseq" }),
  G1badChain: grantFor("a1", 4, [{ delegation: "d1" }, { delegation: "d2" }], { id: "a1-badchain" }),
  G1badFp: grantFor("a1", 4, [{ delegation: "d1" }], { badFingerprint: true, id: "a1-badfp" }),
};
export const NAMES = Object.keys(ALPHABET);

export function build(names: readonly string[]): any[] { return names.map((n, i) => ALPHABET[n]!(i + 1)); }

/** All sequences of length 1..k over `alphabet`, as arrays of names (depth-first, so memory stays flat). */
export function* sequences(alphabet: readonly string[], k: number): Generator<string[]> {
  const cur: string[] = [];
  function* rec(depth: number): Generator<string[]> {
    if (depth > 0) yield cur.slice();
    if (depth === k) return;
    for (const n of alphabet) { cur.push(n); yield* rec(depth + 1); cur.pop(); }
  }
  yield* rec(0);
}

// ------------------------------------------------------------------------------------------------ random journals over a wider universe
export function randomJournal(seed: number, length: number): any[] {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const int = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));
  const ds = ["d1", "d2", "d3", "d4"], actions = ["a1", "a2", "a3", "a4", "a5"], people = ["alice", "bob", "carol", "dave", "mallory"], currencies = ["EUR", "EUR", "EUR", "USD"];
  const reqs = new Map<string, { amount: number; currency: string }>();
  const drafts: Draft[] = [];
  for (let i = 0; i < length; i++) {
    const k = r();
    if (k < 0.14) {
      const id = pick(ds); const sub = r() < 0.5;
      drafts.push(delegation({ id, ...(sub ? { parent: pick(ds) } : {}), grantor: pick(people), grantee: pick(people), ...(r() < 0.7 ? { budget: int(1, 14) } : {}), currency: pick(currencies), canDelegate: r() < 0.8, ...(r() < 0.2 ? { expiresInSeconds: int(1, 40) } : {}), thresholds: [int(1, 6), int(6, 12)] }));
    } else if (k < 0.3) {
      const a = pick(actions); const amount = int(1, 12); const currency = pick(currencies); reqs.set(a, { amount, currency });
      drafts.push(request(a, pick(people), pick(ds), amount, currency));
    } else if (k < 0.45) drafts.push(execution(pick(actions), pick(people), r() < 0.3 ? [pick(ds)] : r() < 0.7 ? [pick(ds), pick(ds)] : [pick(ds), pick(ds), pick(ds)], r() < 0.1 ? "ap1" : undefined));
    else if (k < 0.52) drafts.push(revocation(pick(ds), pick(people)));
    else if (k < 0.57) drafts.push(approvalRequested(pick(["ap1", "ap2"]), pick(actions)));
    else if (k < 0.64) drafts.push(approvalGranted(pick(["ap1", "ap2"]), pick(actions), pick(people)));
    else {
      const a = pick(actions); const q = reqs.get(a) ?? { amount: int(1, 12), currency: "EUR" };
      const chain: GrantSpec["chain"] = [{ delegation: pick(ds) }, ...(r() < 0.5 ? [{ delegation: pick(ds) }] : []), ...(r() < 0.2 ? [{ approval: pick(["ap1", "ap2"]) }] : [])];
      drafts.push(grant({ action: a, requestParameters: params(q.amount, q.currency), chain, decisionOffset: r() < 0.15 ? -1 : 0, badFingerprint: r() < 0.08, id: `${a}-${i}` }));
    }
  }
  return drafts.map((d, i) => d(i + 1));
}

// ------------------------------------------------------------------------------------------------ coherent random journals (most grants valid)
/**
 * Mostly coherent: delegations form real trees (grantors are the parents' grantees), requests come from the delegate and are mostly in
 * threshold, grants carry the proper chain (root first) right after a decision, and the flaws that matter (late activation, wrong chain,
 * wrong fingerprint, wrong decision sequence, revocations, expiries, approvals, duplicated ids, budget pressure) are injected with small probabilities.
 */
export function coherentJournal(seed: number, length: number, options: { readonly lateActivation?: boolean } = {}): any[] {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const int = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));
  const people = ["alice", "bob", "carol", "dave", "erin"];
  const defs = new Map<string, { parent?: string; grantee: string; grantor: string }>();
  const reqs = new Map<string, { by: string; via: string; amount: number; currency: string }>();
  const approvals: string[] = [];
  const drafts: Draft[] = [];
  let nextD = 1, nextA = 1;
  const chainOf = (d: string): string[] => { const out: string[] = []; const seen = new Set<string>(); let cur: string | undefined = d; while (cur !== undefined && defs.has(cur) && !seen.has(cur)) { seen.add(cur); out.unshift(cur); cur = defs.get(cur)!.parent; } return out; };
  const flaw = (p: number) => r() < p;
  for (let i = 0; i < length; i++) {
    const k = r();
    if (defs.size === 0 || k < 0.14) {
      const root = defs.size === 0 || r() < 0.3;
      const id = flaw(0.05) && defs.size > 0 ? pick([...defs.keys()]) : `d${nextD++}`;
      const parent = root ? undefined : pick([...defs.keys()]);
      const grantor = root ? "alice" : defs.get(parent!)!.grantee;
      const grantee = pick(people);
      defs.set(id, { ...(parent === undefined ? {} : { parent }), grantee, grantor });
      drafts.push(delegation({ id, ...(parent === undefined ? {} : { parent }), grantor: flaw(0.04) ? pick(people) : grantor, grantee, ...(r() < 0.75 ? { budget: int(4, 24) } : {}), canDelegate: !flaw(0.08), ...(r() < 0.15 ? { expiresInSeconds: int(2, length + 4) } : {}), thresholds: [int(3, 7), int(7, 12)] }));
    } else if (k < 0.34) {
      const via = pick([...defs.keys()]); const a = flaw(0.05) && reqs.size > 0 ? pick([...reqs.keys()]) : `a${nextA++}`;
      const q = { by: flaw(0.05) ? pick(people) : defs.get(via)!.grantee, via, amount: int(1, 10), currency: flaw(0.04) ? "USD" : "EUR" };
      if (!reqs.has(a)) reqs.set(a, q);
      drafts.push(request(a, q.by, q.via, q.amount, q.currency));
    } else if (k < 0.5 && reqs.size > 0) {
      const a = pick([...reqs.keys()]); const q = reqs.get(a)!;
      const chain = chainOf(q.via);
      drafts.push(execution(a, flaw(0.1) ? pick(people) : q.by, flaw(0.1) ? chain.slice(1) : chain, r() < 0.05 && approvals.length ? pick(approvals) : undefined));
    } else if (k < 0.56) drafts.push(revocation(pick([...defs.keys()]), flaw(0.3) ? pick(people) : "alice"));
    else if (k < 0.62 && reqs.size > 0) { const id = `ap${approvals.length + 1}`; approvals.push(id); drafts.push(approvalRequested(id, pick([...reqs.keys()]))); }
    else if (k < 0.68 && approvals.length > 0 && reqs.size > 0) drafts.push(approvalGranted(pick(approvals), pick([...reqs.keys()]), flaw(0.15) ? pick(people) : "alice"));
    else if (reqs.size > 0) {
      const a = pick([...reqs.keys()]); const q = reqs.get(a)!;
      let chain: GrantSpec["chain"] = chainOf(q.via).map((delegation) => ({ delegation }));
      if (flaw(0.1)) chain = chain.slice(1); else if (flaw(0.07)) chain = [...chain, { delegation: pick([...defs.keys()]) }]; else if (approvals.length > 0 && flaw(0.2)) chain = [...chain, { approval: pick(approvals) }];
      drafts.push(grant({ action: a, requestParameters: params(flaw(0.05) ? q.amount + 1 : q.amount, q.currency), chain, decisionOffset: flaw(0.06) ? -1 : 0, badFingerprint: flaw(0.04), id: `${a}-${i}` }));
    }
  }
  if (options.lateActivation) { drafts.unshift(execution("a-late", "alice", ["d1"])); drafts.push(request("a-late", "alice", "d1", 1)); }
  return drafts.map((d, i) => d(i + 1));
}
