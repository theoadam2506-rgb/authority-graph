/**
 * V1 redemption transaction (invariants I28 to I30): single use under
 * concurrency, defence in depth at ingestion, fail-closed on a concurrent
 * write, and no change to any existing decision.
 */
import { describe, expect, it } from "vitest";
import { toDraft, type DraftAuthorityEvent } from "../../src/domain/events.js";
import { authorityAt, explainAction } from "../../src/engine/authority.js";
import { replayCanonicalStore } from "../../src/engine/replayCanonical.js";
import { actionId, sequenceNumber, type SequenceNumber } from "../../src/domain/types.js";
import { InMemoryEventStore } from "../../src/storage/eventStore.js";
import { InMemoryCapabilityRedemptionTransaction, buildCapabilityRedeemedDraft } from "../../src/storage/capabilityRedemptionTransaction.js";
import { PURCHASE_ORDER_CREATE, THEO, actionRequest } from "../fixtures/scenarios.js";
import { AGENT, PARAMS, T, auth, harness } from "./harness.js";

const redeemedCount = async (store: InMemoryEventStore): Promise<number> => (await store.getEvents()).filter((e) => e.event_type === "CAPABILITY_REDEEMED").length;

describe("single use under concurrency (I28)", () => {
  it("50 concurrent redemptions through one transaction: exactly one succeeds, 49 are ALREADY_REDEEMED, one event", async () => {
    const h = await harness();
    const id = await h.issue(T("09:10:00"));
    const results = await Promise.all(Array.from({ length: 50 }, () => h.redemption.redeem(auth(AGENT), h.command(id), T("09:12:00"))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === "ALREADY_REDEEMED")).toHaveLength(49);
    expect(await redeemedCount(h.store)).toBe(1);
  });

  it("two transaction instances over the same store, racing: at most one succeeds and exactly one event exists", async () => {
    const h = await harness();
    const second = new InMemoryCapabilityRedemptionTransaction(h.store);
    const id = await h.issue(T("09:10:00"));
    const results = await Promise.all([
      h.redemption.redeem(auth(AGENT), h.command(id), T("09:12:00")),
      second.redeem(auth(AGENT), h.command(id), T("09:12:00")),
      h.redemption.redeem(auth(AGENT), h.command(id), T("09:12:00")),
      second.redeem(auth(AGENT), h.command(id), T("09:12:00")),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await redeemedCount(h.store)).toBe(1);
    for (const r of results) if (!r.ok) expect(["ALREADY_REDEEMED", "REDEMPTION_COLLISION", "CONCURRENT_WRITE_DETECTED"]).toContain(r.reason);
  });

  it("defence in depth: a second CAPABILITY_REDEEMED for the same capability_id is refused at ingestion even with a different event_id, and logged", async () => {
    const h = await harness();
    const id = await h.issue(T("09:10:00"));
    expect((await h.redemption.redeem(auth(AGENT), h.command(id), T("09:12:00"))).ok).toBe(true);
    const events = await h.store.getEvents();
    const first = events.find((e) => e.event_type === "CAPABILITY_REDEEMED");
    if (first === undefined || first.event_type !== "CAPABILITY_REDEEMED") throw new Error("fixture");
    const sneaky: DraftAuthorityEvent = { ...buildCapabilityRedeemedDraft(auth(AGENT), T("09:13:00"), { ...first.payload, decision_sequence: sequenceNumber(events.length) }, "forged-attempt"), event_id: "another-event-id" as never };
    const r = await h.store.append([sneaky], T("09:13:00"));
    expect(r.outcomes[0]).toEqual({ accepted: false, reasonCode: "BUSINESS_ID_COLLISION" });
    expect(await redeemedCount(h.store)).toBe(1);
    expect((await h.store.getSecurityLog()).some((e) => e.reasonCode === "BUSINESS_ID_COLLISION")).toBe(true);
  });

  it("a redemption does not collide with the CAPABILITY_ISSUED it consumes (distinct business-id kinds)", async () => {
    const h = await harness();
    const id = await h.issue(T("09:10:00"));
    expect((await h.redemption.redeem(auth(AGENT), h.command(id), T("09:12:00"))).ok).toBe(true);
    const events = await h.store.getEvents();
    expect(events.filter((e) => e.event_type === "CAPABILITY_ISSUED")).toHaveLength(1);
    expect(events.filter((e) => e.event_type === "CAPABILITY_REDEEMED")).toHaveLength(1);
  });
});

/** A store whose first getEvents() lets a hook write AFTER the snapshot was taken and BEFORE the caller can act on it: the TOCTOU window. */
class RacingStore extends InMemoryEventStore {
  hook: (() => Promise<void>) | undefined;
  override async getEvents(filter?: Parameters<InMemoryEventStore["getEvents"]>[0]): ReturnType<InMemoryEventStore["getEvents"]> {
    const snapshot = await super.getEvents(filter);
    const hook = this.hook;
    this.hook = undefined;
    if (hook !== undefined) await hook();
    return snapshot;
  }
}

describe("a concurrent write between snapshot and append (I30, fail-closed)", () => {
  it("a revocation landing in that window is never answered REDEEMED; the ticket is consumed and the agent is DENIED afterwards", async () => {
    const racing = await harness({ storeFactory: (clock) => new RacingStore(clock) });
    const store = racing.store as RacingStore;
    const id = await racing.issue(T("09:10:00"));
    store.hook = () => racing.revoke(T("09:11:00"));
    const r = await racing.redemption.redeem(auth(AGENT), racing.command(id), T("09:12:00"));
    expect(r).toMatchObject({ ok: false, reason: "CONCURRENT_WRITE_DETECTED", detail: { ticketConsumed: true } });
    // The ticket is burned (append-only), so it cannot be retried into an authorization...
    expect(await racing.redemption.redeem(auth(AGENT), racing.command(id), T("09:13:00"))).toEqual({ ok: false, reason: "ALREADY_REDEEMED" });
    // ...and the authority really is gone.
    const events = await store.getEvents();
    expect(authorityAt(events, { agentId: AGENT, principalId: THEO, capability: PURCHASE_ORDER_CREATE, parameters: PARAMS }, { atSequence: sequenceNumber(events.length), authorityTime: T("09:14:00") })).toMatchObject({ outcome: "DENIED" });
  });

  it("even a harmless concurrent write is treated the same way (conservative: authorize again)", async () => {
    const racing = await harness({ storeFactory: (clock) => new RacingStore(clock) });
    const store = racing.store as RacingStore;
    const id = await racing.issue(T("09:10:00"));
    store.hook = async () => {
      const r = await store.append([toDraft(actionRequest({ sequence: 99, id: "act-unrelated", requester: AGENT, delegationId: "d-redeem", parameters: PARAMS }))], T("09:11:00"));
      expect(r.outcomes[0]?.accepted).toBe(true);
    };
    expect(await racing.redemption.redeem(auth(AGENT), racing.command(id), T("09:12:00"))).toMatchObject({ ok: false, reason: "CONCURRENT_WRITE_DETECTED", detail: { ticketConsumed: true } });
  });

  it("STALE_AUTHORITY_TIME from the store's hidden high-water mark refuses the redemption without consuming the ticket", async () => {
    const h = await harness();
    const id = await h.issue(T("09:10:00"));
    // A REJECTED draft (same event_id, different content) still advances the store's hidden mark to 09:30.
    const root = (await h.store.getEvents())[0]!;
    const conflicting = { ...toDraft(root), payload: { ...root.payload, can_delegate: true } } as DraftAuthorityEvent;
    expect((await h.store.append([conflicting], T("09:30:00"))).outcomes[0]).toEqual({ accepted: false, reasonCode: "EVENT_ID_CONFLICT" });
    expect(await h.redemption.redeem(auth(AGENT), h.command(id), T("09:12:00"))).toEqual({ ok: false, reason: "STALE_AUTHORITY_TIME" });
    expect(await redeemedCount(h.store)).toBe(0);
    // Nothing was consumed: at a coherent instant the same ticket redeems (it expires 09:15, so use a fresh ticket window).
    const id2 = await h.issue(T("09:31:00"));
    expect((await h.redemption.redeem(auth(AGENT), h.command(id2), T("09:32:00"))).ok).toBe(true);
  });
});

describe("existing decisions are unchanged by the new event (I30)", () => {
  it("authorityAt and explainAction give identical answers with and without a CAPABILITY_REDEEMED in the log", async () => {
    const h = await harness();
    const id = await h.issue(T("09:10:00"));
    const preEvents = await h.store.getEvents();
    const preSeq = sequenceNumber(preEvents.length);
    const query = { agentId: AGENT, principalId: THEO, capability: PURCHASE_ORDER_CREATE, parameters: PARAMS };
    const at = (seq: SequenceNumber) => ({ atSequence: seq, authorityTime: T("09:20:00") });
    const before = authorityAt(preEvents, query, at(preSeq));
    const beforeExplain = explainAction(preEvents, { actionId: actionId("act-redeem") }, at(preSeq));
    expect((await h.redemption.redeem(auth(AGENT), h.command(id), T("09:12:00"))).ok).toBe(true);
    const postEvents = await h.store.getEvents();
    expect(authorityAt(postEvents, query, at(sequenceNumber(postEvents.length)))).toEqual(before);
    expect(authorityAt(postEvents, query, at(preSeq))).toEqual(before);
    expect(explainAction(postEvents, { actionId: actionId("act-redeem") }, at(preSeq))).toEqual(beforeExplain);
  });

  it("a log containing CAPABILITY_REDEEMED replays exactly through replayCanonicalStore", async () => {
    const h = await harness();
    const id = await h.issue(T("09:10:00"));
    expect((await h.redemption.redeem(auth(AGENT), h.command(id), T("09:12:00"))).ok).toBe(true);
    const events = await h.store.getEvents();
    const replay = replayCanonicalStore(JSON.parse(JSON.stringify(events)));
    expect(replay).toMatchObject({ ok: true });
  });
});
