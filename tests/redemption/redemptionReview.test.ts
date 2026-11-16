/**
 * Targeted review of the redemption guarantees (PR #24 review):
 *  1. confinement of the attempt-id counter;
 *  2. no two callers ever get ok:true;
 *  3. CONCURRENT_WRITE_DETECTED: ticket consumed, nothing authorized, recognisable afterwards;
 *  4. coherence of decision_sequence, ingestion sequence and the redemption instant.
 */
import { describe, expect, it } from "vitest";
import { toDraft, type AuthorityEvent, type CanonicalStore, type DraftAuthorityEvent } from "../../src/domain/events.js";
import { validateRedemptionEvent, type RedemptionEventValidation } from "../../src/engine/redeemCapability.js";
import { rebuildIngestionState } from "../../src/engine/ingest.js";
import * as redemptionModule from "../../src/storage/capabilityRedemptionTransaction.js";
import { InMemoryCapabilityRedemptionTransaction, buildCapabilityRedeemedDraft } from "../../src/storage/capabilityRedemptionTransaction.js";
import { InMemoryEventStore } from "../../src/storage/eventStore.js";
import { actionId, capabilityId, clientIdempotencyKey, iso8601, sequenceNumber } from "../../src/domain/types.js";
import { EUR, THEO, actionRequest } from "../fixtures/scenarios.js";
import { monetaryParameters } from "../../src/domain/types.js";
import { AGENT, EP, PARAMS, T, auth, harness } from "./harness.js";

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

const redeemed = (events: CanonicalStore) => events.filter((e): e is Extract<AuthorityEvent, { event_type: "CAPABILITY_REDEEMED" }> => e.event_type === "CAPABILITY_REDEEMED");

describe("1. the attempt-id counter is confined to the in-memory transaction", () => {
  it("is not exported: the module's public surface has no counter, and building a draft requires an explicit attempt id", () => {
    expect(Object.keys(redemptionModule).sort()).toEqual(["InMemoryCapabilityRedemptionTransaction", "buildCapabilityRedeemedDraft"]);
    expect(buildCapabilityRedeemedDraft.length).toBe(4);
  });

  it("never excludes anything: with every attempt id colliding, 8 transaction instances x 25 callers still yield exactly one ok:true", async () => {
    const h = await harness();
    const id = await h.issue(T("09:10:00"));
    const instances = Array.from({ length: 8 }, () => new InMemoryCapabilityRedemptionTransaction(h.store, { nextAttemptId: () => 1 }));
    const results = await Promise.all(instances.flatMap((i) => Array.from({ length: 25 }, () => i.redeem(auth(AGENT), h.command(id), T("09:12:00")))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(redeemed(await h.store.getEvents())).toHaveLength(1);
  });

  it("a restart resets the counter without consequence: the rebuilt store still refuses a second redemption", async () => {
    const h = await harness();
    const id = await h.issue(T("09:10:00"));
    expect((await h.redemption.redeem(auth(AGENT), h.command(id), T("09:12:00"))).ok).toBe(true);
    const events = await h.store.getEvents();
    const restarted = new InMemoryEventStore({ authorityTime: () => T("09:20:00") }, rebuildIngestionState(events));
    const tx = new InMemoryCapabilityRedemptionTransaction(restarted, { nextAttemptId: () => 1 }); // same id the first attempt used
    expect(await tx.redeem(auth(AGENT), h.command(id), T("09:13:00"))).toEqual({ ok: false, reason: "ALREADY_REDEEMED" });
    expect(redeemed(await restarted.getEvents())).toHaveLength(1);
  });

  it("DOCUMENTED HAZARD: ingestion alone treats an identical redemption draft as an accepted duplicate (I8), which is why attempt-id uniqueness is not what protects single use", async () => {
    const h = await harness();
    const id = await h.issue(T("09:10:00"));
    const events = await h.store.getEvents();
    const issued = events.find((e) => e.event_type === "CAPABILITY_ISSUED")!;
    if (issued.event_type !== "CAPABILITY_ISSUED") throw new Error("fixture");
    const data = { capability_id: id, action_id: issued.payload.action_id, action_fingerprint: issued.payload.action_fingerprint, decision_sequence: sequenceNumber(events.length), enforcement_point_id: issued.payload.enforcement_point_id };
    const draft = buildCapabilityRedeemedDraft(auth(AGENT), T("09:12:00"), data, 1);
    const a = await h.store.append([draft], T("09:12:00"));
    const b = await h.store.append([draft], T("09:12:00"));
    expect(a.outcomes[0]).toEqual(b.outcomes[0]); // both "accepted" at the same sequence
    expect(redeemed(await h.store.getEvents())).toHaveLength(1);
  });
});

describe("2. no two callers can both be told ok:true", () => {
  it("100 rounds of mixed instance and caller counts: exactly one ok:true every round", async () => {
    for (let round = 0; round < 100; round += 1) {
      const h = await harness();
      const id = await h.issue(T("09:10:00"));
      const instances = [h.redemption, ...Array.from({ length: round % 5 }, () => new InMemoryCapabilityRedemptionTransaction(h.store, { nextAttemptId: () => round % 2 }))];
      const callers = 2 + (round % 9);
      const results = await Promise.all(Array.from({ length: callers }, (_v, i) => instances[i % instances.length]!.redeem(auth(AGENT), h.command(id), T("09:12:00"))));
      expect(results.filter((r) => r.ok), `round ${round}`).toHaveLength(1);
      expect(redeemed(await h.store.getEvents()), `round ${round}`).toHaveLength(1);
    }
  });

  it("a second redemption started INSIDE the first one's snapshot window waits and is refused; only the first is ok", async () => {
    const racing = await harness({ storeFactory: (clock) => new RacingStore(clock) });
    const store = racing.store as RacingStore;
    const id = await racing.issue(T("09:10:00"));
    const other = new InMemoryCapabilityRedemptionTransaction(store);
    let second: ReturnType<typeof other.redeem> | undefined;
    store.hook = async () => { second = other.redeem(auth(AGENT), racing.command(id), T("09:12:00")); }; // started, deliberately not awaited here
    const first = await racing.redemption.redeem(auth(AGENT), racing.command(id), T("09:12:00"));
    expect(first.ok).toBe(true);
    expect(await second).toEqual({ ok: false, reason: "ALREADY_REDEEMED" });
  });

  it("a competing writer that BYPASSES the transaction and wins the window gets the event; the transaction is refused, never ok:true", async () => {
    const racing = await harness({ storeFactory: (clock) => new RacingStore(clock) });
    const store = racing.store as RacingStore;
    const id = await racing.issue(T("09:10:00"));
    const events = await store.getEvents();
    const issued = events.find((e) => e.event_type === "CAPABILITY_ISSUED")!;
    if (issued.event_type !== "CAPABILITY_ISSUED") throw new Error("fixture");
    store.hook = async () => {
      const draft = buildCapabilityRedeemedDraft(auth(AGENT), T("09:11:30"), { capability_id: id, action_id: issued.payload.action_id, action_fingerprint: issued.payload.action_fingerprint, decision_sequence: sequenceNumber(events.length), enforcement_point_id: issued.payload.enforcement_point_id }, "bypass");
      expect((await store.append([draft], T("09:11:30"))).outcomes[0]?.accepted).toBe(true);
    };
    const r = await racing.redemption.redeem(auth(AGENT), racing.command(id), T("09:12:00"));
    expect(r.ok).toBe(false);
    expect(redeemed(await store.getEvents())).toHaveLength(1);
  });
});

describe("3. CONCURRENT_WRITE_DETECTED consumes the ticket without authorizing the effect", () => {
  async function burned() {
    const racing = await harness({ storeFactory: (clock) => new RacingStore(clock) });
    const store = racing.store as RacingStore;
    const id = await racing.issue(T("09:10:00"));
    store.hook = () => racing.revoke(T("09:11:00"));
    const r = await racing.redemption.redeem(auth(AGENT), racing.command(id), T("09:12:00"));
    return { racing, store, id, r };
  }

  it("the result says so explicitly: ticketConsumed and the sequence of the written event", async () => {
    const { store, r } = await burned();
    const events = await store.getEvents();
    const e = redeemed(events)[0]!;
    expect(r).toMatchObject({ ok: false, reason: "CONCURRENT_WRITE_DETECTED", detail: { ticketConsumed: true, redemptionSequence: e.sequence } });
  });

  it("the event exists, is recognisable (sequence != decision_sequence + 1) and validateRedemptionEvent says it authorized nothing", async () => {
    const { store } = await burned();
    const events = await store.getEvents();
    const e = redeemed(events)[0]!;
    expect(Number(e.sequence)).toBeGreaterThan(Number(e.payload.decision_sequence) + 1);
    expect(validateRedemptionEvent(events, e)).toEqual({ ok: false, reason: "DECISION_SEQUENCE_NOT_IMMEDIATE" });
  });

  it("the ticket cannot be retried (ALREADY_REDEEMED) and no new redemption event is written", async () => {
    const { racing, store, id } = await burned();
    const n = (await store.getEvents()).length;
    expect(await racing.redemption.redeem(auth(AGENT), racing.command(id), T("09:13:00"))).toEqual({ ok: false, reason: "ALREADY_REDEEMED" });
    expect((await store.getEvents()).length).toBe(n);
  });

  it("KNOWN COST: the consumed ticket stays engaged, so re-authorizing the same action against a total_budget can fail with CAPACITY_EXCEEDED", async () => {
    const racing = await harness({ storeFactory: (clock) => new RacingStore(clock), totalBudget: EUR(2000) });
    const store = racing.store as RacingStore;
    const id = await racing.issue(T("09:10:00"));
    store.hook = async () => { await store.append([toDraft(actionRequest({ sequence: 99, id: "act-noise", requester: AGENT, delegationId: "d-redeem", parameters: monetaryParameters(EUR(1)) }))], T("09:11:00")); };
    expect(await racing.redemption.redeem(auth(AGENT), racing.command(id), T("09:12:00"))).toMatchObject({ reason: "CONCURRENT_WRITE_DETECTED" });
    const again = await racing.issuance.issue(auth(AGENT), clientIdempotencyKey("again"), { action_id: actionId("act-redeem"), enforcement_point_id: EP }, { nextCapabilityId: () => capabilityId("cap-again"), expiresAt: (t) => iso8601(new Date(Date.parse(t) + 300_000).toISOString()) }, T("09:13:00"));
    expect(again).toMatchObject({ outcome: "EXECUTED", result: { ok: false, reason: "CAPACITY_EXCEEDED" } });
  });
});

describe("4. decision_sequence, ingestion sequence and the redemption instant agree", () => {
  const ok = (v: RedemptionEventValidation) => v.ok;

  it("for successful redemptions at several instants and positions: sequence == decision_sequence + 1, authority_time == the explicit instant, monotone, before expiry, and the event validates", async () => {
    for (const at of ["09:10:00", "09:12:30", "09:14:59"]) {
      const h = await harness();
      const id = await h.issue(T("09:10:00"));
      await h.store.append([toDraft(actionRequest({ sequence: 99, id: `noise-${at}`, requester: AGENT, delegationId: "d-redeem", parameters: PARAMS }))], T("09:10:00"));
      expect((await h.redemption.redeem(auth(AGENT), h.command(id), T(at))).ok, at).toBe(true);
      const events = await h.store.getEvents();
      const e = redeemed(events)[0]!;
      expect(Number(e.sequence)).toBe(Number(e.payload.decision_sequence) + 1);
      expect(Number(e.sequence)).toBe(events.length);
      expect(e.authority_time).toBe(T(at));
      expect(events.every((x) => Date.parse(x.authority_time) <= Date.parse(e.authority_time))).toBe(true);
      expect(ok(validateRedemptionEvent(events, e))).toBe(true);
    }
  });

  it("same-instant ordering follows the log: a revocation logged BEFORE the redemption at the same instant denies it; logged AFTER, it does not undo it", async () => {
    const before = await harness();
    const id1 = await before.issue(T("09:10:00"));
    await before.revoke(T("09:12:00"));
    expect(await before.redemption.redeem(auth(AGENT), before.command(id1), T("09:12:00"))).toMatchObject({ ok: false, reason: "AUTHORITY_NO_LONGER_VALID" });

    const after = await harness();
    const id2 = await after.issue(T("09:10:00"));
    expect((await after.redemption.redeem(auth(AGENT), after.command(id2), T("09:12:00"))).ok).toBe(true);
    await after.revoke(T("09:12:00"));
    const events = await after.store.getEvents();
    expect(validateRedemptionEvent(events, redeemed(events)[0]!)).toEqual({ ok: true }); // authorized at ITS snapshot
  });

  describe("validateRedemptionEvent rejects each kind of incoherence", () => {
    async function base() {
      const h = await harness();
      const id = await h.issue(T("09:10:00"));
      expect((await h.redemption.redeem(auth(AGENT), h.command(id), T("09:12:00"))).ok).toBe(true);
      const events = await h.store.getEvents();
      const e = redeemed(events)[0]!;
      const swap = (patch: (ev: typeof e) => AuthorityEvent): CanonicalStore => events.map((x) => (x === e ? patch(e) : x));
      return { h, id, events, e, swap };
    }

    it("decision_sequence off by one", async () => {
      const { e, swap } = await base();
      const events = swap((x) => ({ ...x, payload: { ...x.payload, decision_sequence: sequenceNumber(Number(x.payload.decision_sequence) - 1) } }));
      expect(validateRedemptionEvent(events, events.find((x) => x.event_type === "CAPABILITY_REDEEMED") as never)).toEqual({ ok: false, reason: "DECISION_SEQUENCE_NOT_IMMEDIATE" });
      void e;
    });

    it("redeemed at the ticket's expiry instant, or before it was issued", async () => {
      const { swap } = await base();
      const late = swap((x) => ({ ...x, authority_time: T("09:15:00") }));
      expect(validateRedemptionEvent(late, late.find((x) => x.event_type === "CAPABILITY_REDEEMED") as never)).toEqual({ ok: false, reason: "REDEEMED_AT_OR_AFTER_EXPIRY" });
      const early = swap((x) => ({ ...x, authority_time: T("09:09:00") }));
      expect(validateRedemptionEvent(early, early.find((x) => x.event_type === "CAPABILITY_REDEEMED") as never)).toEqual({ ok: false, reason: "REDEEMED_BEFORE_ISSUANCE" });
    });

    it("fingerprint or enforcement point different from the ticket's", async () => {
      const { swap } = await base();
      const fp = swap((x) => ({ ...x, payload: { ...x.payload, action_fingerprint: "0".repeat(64) as never } }));
      expect(validateRedemptionEvent(fp, fp.find((x) => x.event_type === "CAPABILITY_REDEEMED") as never)).toEqual({ ok: false, reason: "REDEMPTION_FIELDS_MISMATCH" });
    });

    it("a second redemption of the same capability is NOT_FIRST_REDEMPTION; a redemption with no ticket is CAPABILITY_NOT_FOUND", async () => {
      const { events, e } = await base();
      const dup = { ...e, event_id: "dup" as never, sequence: sequenceNumber(events.length + 1), payload: { ...e.payload, decision_sequence: sequenceNumber(events.length) } } as AuthorityEvent;
      const withDup = [...events, dup];
      expect(validateRedemptionEvent(withDup, dup as never)).toEqual({ ok: false, reason: "NOT_FIRST_REDEMPTION" });
      expect(validateRedemptionEvent(events, { ...e, payload: { ...e.payload, capability_id: capabilityId("nope") } } as never)).toEqual({ ok: false, reason: "CAPABILITY_NOT_FOUND" });
    });

    it("a redemption written around the transaction AFTER a revocation authorizes nothing (AUTHORITY_NOT_VALID_AT_DECISION)", async () => {
      const h = await harness();
      const id = await h.issue(T("09:10:00"));
      await h.revoke(T("09:11:00"));
      const events = await h.store.getEvents();
      const issued = events.find((e) => e.event_type === "CAPABILITY_ISSUED")!;
      if (issued.event_type !== "CAPABILITY_ISSUED") throw new Error("fixture");
      const forged: DraftAuthorityEvent = buildCapabilityRedeemedDraft(auth(AGENT), T("09:12:00"), { capability_id: id, action_id: issued.payload.action_id, action_fingerprint: issued.payload.action_fingerprint, decision_sequence: sequenceNumber(events.length), enforcement_point_id: issued.payload.enforcement_point_id }, "forged");
      expect((await h.store.append([forged], T("09:12:00"))).outcomes[0]?.accepted).toBe(true); // ingestion does not judge Authority-generated events
      const after = await h.store.getEvents();
      expect(validateRedemptionEvent(after, redeemed(after)[0]!)).toEqual({ ok: false, reason: "AUTHORITY_NOT_VALID_AT_DECISION" });
      void THEO;
    });
  });
});
