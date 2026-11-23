/**
 * I32 (D36): at most one CAPABILITY_ISSUED per action, definitively. Four
 * layers, each tested here on its own: the pure kernel, ingestion (business id,
 * so any writer), the in-memory transaction under concurrency, and journal
 * replay. The PostgreSQL layers are in tests/storage/postgresTicketPerAction.test.ts.
 */
import { describe, expect, it } from "vitest";
import { toDraft } from "../../src/domain/events.js";
import {
  actionId, capabilityId, clientIdempotencyKey, iso8601, type CapabilityId, type Iso8601,
} from "../../src/domain/types.js";
import { processDraft, rebuildIngestionState } from "../../src/engine/ingest.js";
import { issueCapability, type IssueCapabilityDependencies } from "../../src/engine/issueCapability.js";
import { replayCanonicalStore } from "../../src/engine/replayCanonical.js";
import { InMemoryCapabilityIssuanceTransaction, buildCapabilityIssuedDraft } from "../../src/storage/capabilityIssuanceTransaction.js";
import { InMemoryEventStore } from "../../src/storage/eventStore.js";
import { EUR, actionRequest, approvalGrant, approvalRequest, THEO } from "../fixtures/scenarios.js";
import { AGENT, AGENT_B_PRINCIPAL, EP, PARAMS, T, auth, harness, type Harness } from "../redemption/harness.js";

let counter = 0;
const deps = (spy?: { calls: number }): IssueCapabilityDependencies => ({
  nextCapabilityId: () => {
    if (spy) spy.calls++;
    return capabilityId(`cap-i32-${++counter}`);
  },
  expiresAt: (t) => iso8601(new Date(Date.parse(t) + 5 * 60_000).toISOString()),
});

const issueFor = (h: Harness, key: string, at: Iso8601 = T("09:10:00"), action = "act-redeem", who = AGENT) =>
  h.issuance.issue(auth(who), clientIdempotencyKey(key), { action_id: actionId(action), enforcement_point_id: EP }, deps(), at);

const tickets = async (h: Harness, action = "act-redeem") =>
  (await h.store.getEvents()).filter((e) => e.event_type === "CAPABILITY_ISSUED" && e.payload.action_id === action);

describe("I32 layer 1: the issuance kernel", () => {
  it("refuses a second ticket for the same action under another idempotency key, before any capacity or id is consumed", async () => {
    const h = await harness({ totalBudget: EUR(2000) });
    expect(await issueFor(h, "k1")).toMatchObject({ outcome: "EXECUTED", result: { ok: true } });
    const spy = { calls: 0 };
    const snapshot = await h.store.getEvents();
    const second = issueCapability(snapshot, auth(AGENT), { action_id: actionId("act-redeem"), enforcement_point_id: EP }, deps(spy), T("09:11:00"));
    // 1800 of a 2000 budget is already engaged: the refusal is ACTION_ALREADY_TICKETED, not CAPACITY_EXCEEDED, and no id was drawn
    expect(second).toEqual({ ok: false, reason: "ACTION_ALREADY_TICKETED" });
    expect(spy.calls).toBe(0);
  });

  it("an expired ticket does not free the action: a new action is required", async () => {
    const h = await harness();
    expect(await issueFor(h, "k1", T("09:10:00"))).toMatchObject({ result: { ok: true } }); // expires 09:15
    expect(await issueFor(h, "k2", T("10:30:00"))).toMatchObject({ outcome: "EXECUTED", result: { ok: false, reason: "ACTION_ALREADY_TICKETED" } });
    expect(await tickets(h)).toHaveLength(1);
  });

  it("the kernel itself (not only ingestion) keeps an expired or redeemed ticket's action closed", async () => {
    const h = await harness();
    const id = await h.issue(T("09:10:00")); // expires 09:15
    const command = { action_id: actionId("act-redeem"), enforcement_point_id: EP };
    const expired = issueCapability(await h.store.getEvents(), auth(AGENT), command, deps(), T("12:00:00"));
    expect(expired).toEqual({ ok: false, reason: "ACTION_ALREADY_TICKETED" });
    expect((await h.redemption.redeem(auth(AGENT), h.command(id), T("09:12:00"))).ok).toBe(true);
    expect(issueCapability(await h.store.getEvents(), auth(AGENT), command, deps(), T("12:00:00"))).toEqual({ ok: false, reason: "ACTION_ALREADY_TICKETED" });
  });

  it("a redeemed ticket does not free the action either", async () => {
    const h = await harness();
    const id = await h.issue(T("09:10:00"));
    expect((await h.redemption.redeem(auth(AGENT), h.command(id), T("09:12:00"))).ok).toBe(true);
    expect(await issueFor(h, "k2", T("09:13:00"))).toMatchObject({ result: { ok: false, reason: "ACTION_ALREADY_TICKETED" } });
  });

  it("the authentication-shaped checks keep their priority: another requester still gets REQUESTER_MISMATCH", async () => {
    const h = await harness();
    await issueFor(h, "k1");
    expect(await issueFor(h, "k2", T("09:11:00"), "act-redeem", AGENT_B_PRINCIPAL)).toMatchObject({ result: { ok: false, reason: "REQUESTER_MISMATCH" } });
  });

  it("a stale instant keeps its priority over I32", async () => {
    const h = await harness();
    await issueFor(h, "k1", T("09:10:00"));
    expect(await issueFor(h, "k2", T("09:00:00"))).toMatchObject({ result: { ok: false, reason: "STALE_AUTHORITY_TIME" } });
  });

  it("a different action is unaffected", async () => {
    const h = await harness();
    await issueFor(h, "k1");
    await h.store.append([toDraft(actionRequest({ sequence: 700, id: "act-other", requester: AGENT, delegationId: "d-redeem", parameters: PARAMS }))], T("09:10:00"));
    expect(await issueFor(h, "k2", T("09:10:00"), "act-other")).toMatchObject({ result: { ok: true } });
  });

  it("idempotency is unchanged: the same key replays the first ticket, another key is refused, and that refusal replays too", async () => {
    const h = await harness();
    const first = await issueFor(h, "k1");
    expect(await issueFor(h, "k1", T("09:20:00"))).toMatchObject({ outcome: "REPLAYED", result: first.outcome === "EXECUTED" ? first.result : undefined });
    const refused = await issueFor(h, "k2");
    expect(refused).toMatchObject({ outcome: "EXECUTED", result: { ok: false, reason: "ACTION_ALREADY_TICKETED" } });
    expect(await issueFor(h, "k2")).toMatchObject({ outcome: "REPLAYED", result: { ok: false, reason: "ACTION_ALREADY_TICKETED" } });
    expect(await tickets(h)).toHaveLength(1);
  });

  it("regression of the observed vector: one approved action, three idempotency keys, exactly one ticket and one redemption", async () => {
    const h = await harness();
    const id = await h.issue(T("09:10:00"));
    const second = await issueFor(h, "k-second", T("09:11:00"));
    const third = await issueFor(h, "k-third", T("09:11:00"));
    expect(second).toMatchObject({ result: { ok: false, reason: "ACTION_ALREADY_TICKETED" } });
    expect(third).toMatchObject({ result: { ok: false, reason: "ACTION_ALREADY_TICKETED" } });
    expect((await h.redemption.redeem(auth(AGENT), h.command(id), T("09:12:00"))).ok).toBe(true);
    expect((await h.store.getEvents()).filter((e) => e.event_type === "CAPABILITY_REDEEMED")).toHaveLength(1);
  });
});

describe("I32 layer 2: ingestion, for every writer", () => {
  async function seeded() {
    const h = await harness();
    await issueFor(h, "k1");
    const events = await h.store.getEvents();
    const issued = events.find((e) => e.event_type === "CAPABILITY_ISSUED");
    if (issued === undefined || issued.event_type !== "CAPABILITY_ISSUED") throw new Error("no ticket");
    return { h, events, issued };
  }
  const secondTicket = (issued: Awaited<ReturnType<typeof seeded>>["issued"], id: string) =>
    buildCapabilityIssuedDraft(auth(AGENT), T("09:11:00"), { ...issued.payload, capability_id: id as CapabilityId });

  it("a second CAPABILITY_ISSUED for the same action, written by hand with another capability_id and event_id, is refused (BUSINESS_ID_COLLISION)", async () => {
    const { h, issued } = await seeded();
    const out = await h.store.append([secondTicket(issued, "cap-written-by-hand")], T("09:11:00"));
    expect(out.outcomes[0]).toEqual({ accepted: false, reasonCode: "BUSINESS_ID_COLLISION" });
    expect(await tickets(h)).toHaveLength(1);
  });

  it("an exact duplicate of the existing ticket is still an idempotent no-op (I8), never a second ticket", async () => {
    const { h, issued, events } = await seeded();
    const out = await h.store.append([toDraft(issued)], T("09:11:00"));
    expect(out.outcomes[0]?.accepted).toBe(true);
    expect((await h.store.getEvents()).length).toBe(events.length);
  });

  it("the rule survives a restart: a store rebuilt from the persisted events still refuses it", async () => {
    const { events, issued } = await seeded();
    const reopened = new InMemoryEventStore({ authorityTime: () => T("09:30:00") }, rebuildIngestionState(events));
    const out = await reopened.append([secondTicket(issued, "cap-after-restart")]);
    expect(out.outcomes[0]).toEqual({ accepted: false, reasonCode: "BUSINESS_ID_COLLISION" });
    // and processDraft says the same over a rebuilt state
    expect(processDraft(rebuildIngestionState(events), secondTicket(issued, "cap-pure"), T("09:30:00"), T("09:30:00")).outcome).toEqual({ accepted: false, reasonCode: "BUSINESS_ID_COLLISION" });
  });

  it("the ticket's action id does not collide with the ACTION_REQUESTED it serves (distinct business-id kinds)", async () => {
    const h = await harness();
    expect(await issueFor(h, "k1")).toMatchObject({ result: { ok: true } });
    const events = await h.store.getEvents();
    expect(events.filter((e) => e.event_type === "ACTION_REQUESTED" && e.payload.action_id === "act-redeem")).toHaveLength(1);
    expect(events.filter((e) => e.event_type === "CAPABILITY_ISSUED" && e.payload.action_id === "act-redeem")).toHaveLength(1);
  });

  it("approval-bound action: the approval cannot buy a second ticket through any writer", async () => {
    const h = await harness();
    await h.store.append(
      [toDraft(approvalRequest({ sequence: 710, id: "ap-i32", actionId: "act-redeem", requestedFrom: THEO, requester: AGENT })), toDraft(approvalGrant({ sequence: 711, id: "ap-i32", actionId: "act-redeem", approver: THEO }))],
      T("09:10:00"),
    );
    const { issued } = await (async () => {
      await issueFor(h, "k1");
      const e = (await h.store.getEvents()).find((x) => x.event_type === "CAPABILITY_ISSUED")!;
      if (e.event_type !== "CAPABILITY_ISSUED") throw new Error("no ticket");
      return { issued: e };
    })();
    expect((await h.store.append([secondTicket(issued, "cap-with-approval")], T("09:11:00"))).outcomes[0]?.accepted).toBe(false);
    expect(await issueFor(h, "k2", T("09:11:00"))).toMatchObject({ result: { ok: false, reason: "ACTION_ALREADY_TICKETED" } });
  });
});

describe("I32 layer 3: the in-memory transaction under concurrency", () => {
  it("50 parallel issuances for one action with 50 distinct idempotency keys: exactly one ticket", async () => {
    const h = await harness();
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => issueFor(h, `p-${i}`)));
    expect(results.filter((r) => r.outcome === "EXECUTED" && r.result.ok)).toHaveLength(1);
    for (const r of results) if (r.outcome === "EXECUTED" && !r.result.ok) expect(r.result.reason).toBe("ACTION_ALREADY_TICKETED");
    expect(await tickets(h)).toHaveLength(1);
  });

  it("3 independent transaction instances over one store (no shared queue), 20 callers each: exactly one ticket, and no refusal is mislabelled CAPABILITY_ID_COLLISION", async () => {
    const h = await harness();
    const instances = [h.issuance, new InMemoryCapabilityIssuanceTransaction(h.store), new InMemoryCapabilityIssuanceTransaction(h.store)];
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        instances[i % 3]!.issue(auth(AGENT), clientIdempotencyKey(`m-${i}`), { action_id: actionId("act-redeem"), enforcement_point_id: EP }, deps(), T("09:10:00")),
      ),
    );
    expect(results.filter((r) => r.outcome === "EXECUTED" && r.result.ok)).toHaveLength(1);
    for (const r of results) if (r.outcome === "EXECUTED" && !r.result.ok) expect(r.result.reason).toBe("ACTION_ALREADY_TICKETED");
    expect(await tickets(h)).toHaveLength(1);
  });

  it("a writer that bypasses the transaction and tickets the action first is reported as ACTION_ALREADY_TICKETED, not as a capability_id collision", async () => {
    const h = await harness();
    await issueFor(h, "k-seed", T("09:10:00"), "act-redeem"); // the one legitimate ticket
    const e = (await tickets(h))[0]!;
    if (e.event_type !== "CAPABILITY_ISSUED") throw new Error("no ticket");
    // a different, fresh action; a raw writer tickets it between this transaction's snapshot and its append
    await h.store.append([toDraft(actionRequest({ sequence: 720, id: "act-raced", requester: AGENT, delegationId: "d-redeem", parameters: PARAMS }))], T("09:10:00"));
    const real = h.store.append.bind(h.store);
    let injected = false;
    (h.store as { append: typeof h.store.append }).append = async (drafts, at) => {
      if (!injected && drafts[0]?.event_type === "CAPABILITY_ISSUED") {
        injected = true;
        await real([buildCapabilityIssuedDraft(auth(AGENT), T("09:10:00"), { ...e.payload, capability_id: capabilityId("cap-raw"), action_id: actionId("act-raced") })], T("09:10:00"));
      }
      return real(drafts, at);
    };
    const out = await issueFor(h, "k-raced", T("09:10:00"), "act-raced");
    expect(out).toMatchObject({ outcome: "EXECUTED", result: { ok: false, reason: "ACTION_ALREADY_TICKETED" } });
    expect(await tickets(h, "act-raced")).toHaveLength(1);
  });
});

describe("I32 layer 4: replay refuses a journal that tickets an action twice", () => {
  it("replayCanonicalStore rejects the second ticket (REPLAY_REJECTED at its index)", async () => {
    const h = await harness();
    await issueFor(h, "k1");
    const events = await h.store.getEvents();
    const issued = events.find((e) => e.event_type === "CAPABILITY_ISSUED")!;
    const forged = { ...issued, event_id: "evt-forged-second-ticket", sequence: events.length + 1, payload: { ...issued.payload, capability_id: "cap-forged-second" } };
    expect(replayCanonicalStore(events)).toMatchObject({ ok: true });
    expect(replayCanonicalStore([...events, forged])).toEqual({ ok: false, reason: "REPLAY_REJECTED", atIndex: events.length });
  });

  it("two tickets for different actions replay fine", async () => {
    const h = await harness();
    await h.issue(T("09:10:00"));
    await h.issue(T("09:11:00")); // the harness gives each further ticket its own action
    expect(replayCanonicalStore(await h.store.getEvents())).toMatchObject({ ok: true });
  });
});

