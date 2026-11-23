import { describe, expect, it } from "vitest";
import { toDraft } from "../../src/domain/events.js";
import { createAuthority, memoryBackend, AuthorityConfigError, AuthorityInputError, systemClock } from "../../src/sdk/index.js";
import { RedemptionSchemaError } from "../../src/storage/postgresCapabilityRedemptionTransaction.js";
import { EUR, actionRequest } from "../fixtures/scenarios.js";
import { AGENT, call, eventsOf, faulty, setup, testClock } from "./harness.js";

const counter = () => {
  let n = 0;
  return { effect: async () => ++n, get runs() { return n; } };
};

describe("configuration (programmer errors throw, before anything can run)", () => {
  const base = { backend: memoryBackend(), clock: testClock(), enforcementPointId: "ep" };
  it("requires a backend, an explicit clock and an enforcement point", () => {
    expect(() => createAuthority({ ...base, backend: undefined as never })).toThrow(AuthorityConfigError);
    expect(() => createAuthority({ ...base, clock: undefined as never })).toThrow(/no default/);
    expect(() => createAuthority({ ...base, enforcementPointId: "  " })).toThrow(AuthorityConfigError);
  });
  it("bounds the ticket lifetime", () => {
    for (const ttl of [0, 999, 86_400_001, 1.5, Number.NaN]) {
      expect(() => createAuthority({ ...base, capabilityTtlMs: ttl })).toThrow(AuthorityConfigError);
    }
  });
  it("systemClock is an explicit opt-in that returns a canonical instant", () => {
    expect(systemClock.now()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("authorize", () => {
  it("authorizes within the automatic band and returns a ticket", async () => {
    const s = await setup();
    const r = await s.authority.authorize(call("a1"));
    expect(r.status).toBe("AUTHORIZED");
    if (r.status === "AUTHORIZED") {
      expect(r.ticket.actionId).toBe("a1");
      expect(r.ticket.enforcementPointId).toBe("ep-1");
      expect(Date.parse(r.ticket.expiresAt)).toBe(Date.parse(s.clock.now()) + 600_000);
    }
  });

  it("denies above the approval ceiling with the engine's reason", async () => {
    const s = await setup();
    expect(await s.authority.authorize(call("a1", { amount: { value: 6000, currency: "EUR" } }))).toEqual({ status: "DENIED", reason: "C8_AMOUNT_EXCEEDS_APPROVAL_CEILING" });
  });

  it("is idempotent: retrying returns the same ticket and issues no second one", async () => {
    const s = await setup();
    const first = await s.authority.authorize(call("a1"));
    s.clock.advance(5_000);
    const second = await s.authority.authorize(call("a1"));
    expect(first.status).toBe("AUTHORIZED");
    expect(second).toEqual(first);
    expect(await eventsOf(s.authority, "CAPABILITY_ISSUED")).toHaveLength(1);
    expect(await eventsOf(s.authority, "ACTION_REQUESTED")).toHaveLength(1);
  });

  it("refuses to reuse an actionId for a different call", async () => {
    const s = await setup();
    await s.authority.authorize(call("a1"));
    expect(await s.authority.authorize(call("a1", { amount: { value: 1900, currency: "EUR" } }))).toEqual({ status: "DENIED", reason: "ACTION_ID_REUSED_WITH_DIFFERENT_CALL" });
    expect(await s.authority.authorize(call("a1", { args: { sku: "other" } }))).toEqual({ status: "DENIED", reason: "ACTION_ID_REUSED_WITH_DIFFERENT_CALL" });
  });

  it("requires approval in the approval band, and a granted approval is honoured on retry (a refusal is never cached)", async () => {
    const s = await setup();
    const big = call("big", { amount: { value: 4800, currency: "EUR" } });
    expect(await s.authority.authorize(big)).toEqual({ status: "REQUIRES_APPROVAL", viaDelegation: "d1" });
    expect(await s.authority.authorize(big)).toEqual({ status: "REQUIRES_APPROVAL", viaDelegation: "d1" });
    await s.approve("big");
    const after = await s.authority.authorize(big);
    expect(after.status).toBe("AUTHORIZED");
    expect(await eventsOf(s.authority, "CAPABILITY_ISSUED")).toHaveLength(1);
  });

  it("binds an approval to the exact action: another action with the same content still requires approval", async () => {
    const s = await setup();
    const a = call("big-a", { amount: { value: 4800, currency: "EUR" } });
    const b = call("big-b", { amount: { value: 4800, currency: "EUR" } });
    await s.authority.authorize(a);
    await s.authority.authorize(b);
    await s.approve("big-a");
    expect((await s.authority.authorize(a)).status).toBe("AUTHORIZED");
    expect(await s.authority.authorize(b)).toEqual({ status: "REQUIRES_APPROVAL", viaDelegation: "d1" });
  });

  it("an unknown delegation or an agent that does not own it is denied", async () => {
    const s = await setup();
    expect((await s.authority.authorize(call("x1", { delegationId: "nope" }))).status).toBe("DENIED");
    expect(await s.authority.authorize(call("x2", { agentId: "mallory" }))).toMatchObject({ status: "DENIED", reason: "INVOKED_DELEGATION_NOT_OWNED_BY_REQUESTER" });
  });

  it("denies when the delegation was revoked before authorization", async () => {
    const s = await setup();
    await s.revoke();
    expect((await s.authority.authorize(call("a1"))).status).not.toBe("AUTHORIZED");
  });
});

describe("malformed input throws AuthorityInputError and nothing runs", () => {
  const bad: [string, Record<string, unknown>][] = [
    ["empty actionId", { actionId: "" }],
    ["empty agentId", { agentId: "" }],
    ["fractional amount", { amount: { value: 18.5, currency: "EUR" } }],
    ["negative amount", { amount: { value: -1, currency: "EUR" } }],
    ["empty currency", { amount: { value: 1, currency: "" } }],
    ["non-JSON args", { args: () => 1 }],
    ["undefined inside args", { args: { a: undefined } }],
    ["no capability", { capability: undefined }],
  ];
  for (const [label, override] of bad) {
    it(label, async () => {
      const s = await setup();
      const c = counter();
      await expect(s.authority.authorize(call("a1", override as never))).rejects.toBeInstanceOf(AuthorityInputError);
      await expect(s.authority.guard(call("a2", override as never), c.effect)).rejects.toBeInstanceOf(AuthorityInputError);
      expect(c.runs).toBe(0);
      expect(await eventsOf(s.authority, "ACTION_REQUESTED")).toHaveLength(0);
    });
  }
  it("circular args", async () => {
    const s = await setup();
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    await expect(s.authority.authorize(call("a1", { args: loop }))).rejects.toBeInstanceOf(AuthorityInputError);
  });
});

describe("guard: the effect runs only after a successful redemption", () => {
  it("runs the effect once, records the whole cycle, and passes an idempotency key", async () => {
    const s = await setup();
    let seen: string | undefined;
    const result = await s.authority.guard(call("a1"), async (ctx) => {
      seen = ctx.idempotencyKey;
      return "done";
    });
    expect(result).toMatchObject({ status: "EXECUTED", value: "done", report: { status: "REPORTED" } });
    const issued = (await eventsOf(s.authority, "CAPABILITY_ISSUED"))[0] as unknown as { payload: { capability_id: string } };
    expect(seen).toBe(issued.payload.capability_id);
    for (const t of ["ACTION_REQUESTED", "CAPABILITY_ISSUED", "CAPABILITY_REDEEMED", "ACTION_EXECUTED"]) {
      expect(await eventsOf(s.authority, t)).toHaveLength(1);
    }
  });

  it("refuses reuse: the same call a second time never runs the effect again", async () => {
    const s = await setup();
    const c = counter();
    expect((await s.authority.guard(call("a1"), c.effect)).status).toBe("EXECUTED");
    const again = await s.authority.guard(call("a1"), c.effect);
    expect(again).toMatchObject({ status: "BLOCKED", stage: "redeem", result: { status: "REFUSED", reason: "ALREADY_REDEEMED" } });
    expect(c.runs).toBe(1);
  });

  it("does not start the effect when authorization is refused", async () => {
    const s = await setup();
    const c = counter();
    const r = await s.authority.guard(call("big", { amount: { value: 4800, currency: "EUR" } }), c.effect);
    expect(r).toMatchObject({ status: "BLOCKED", stage: "authorize", result: { status: "REQUIRES_APPROVAL" } });
    expect(c.runs).toBe(0);
  });

  it("runs the approved action once and the approval cannot be reused afterwards", async () => {
    const s = await setup();
    const c = counter();
    const big = call("big", { amount: { value: 4800, currency: "EUR" } });
    await s.authority.authorize(big);
    await s.approve("big");
    expect((await s.authority.guard(big, c.effect)).status).toBe("EXECUTED");
    expect((await s.authority.guard(big, c.effect)).status).toBe("BLOCKED");
    expect(c.runs).toBe(1);
  });

  it("an effect that throws is not retried, consumes the ticket and is reported", async () => {
    const s = await setup();
    let runs = 0;
    const boom = new Error("target down");
    const r = await s.authority.guard(call("a1"), async () => {
      runs++;
      throw boom;
    });
    expect(r).toMatchObject({ status: "EFFECT_FAILED", code: "EFFECT_THREW", ticketConsumed: true, report: { status: "REPORTED" } });
    expect(r).not.toHaveProperty("error"); // the thrown value is not in the result (see diagnostics.test.ts)
    const again = await s.authority.guard(call("a1"), async () => ++runs);
    expect(again.status).toBe("BLOCKED");
    expect(runs).toBe(1);
  });
});

describe("redemption refusals (each leaves the effect unstarted)", () => {
  it("changed arguments, amount or recipient are refused with ARGUMENTS_MISMATCH, and the ticket stays usable for the real call", async () => {
    const s = await setup();
    const a = await s.authority.authorize(call("a1", { recipient: "vendor-1" }));
    if (a.status !== "AUTHORIZED") throw new Error("not authorized");
    for (const changed of [
      call("a1", { recipient: "vendor-1", args: { sku: "A-100", qty: 4 } }),
      call("a1", { recipient: "vendor-1", amount: { value: 1801, currency: "EUR" } }),
      call("a1", { recipient: "vendor-2" }),
      call("a1", { recipient: "vendor-1", amount: { value: 1800, currency: "USD" } }),
    ]) {
      expect(await s.authority.redeem(a.ticket, changed)).toEqual({ status: "REFUSED", reason: "ARGUMENTS_MISMATCH", ticketConsumed: false });
    }
    expect(await eventsOf(s.authority, "CAPABILITY_REDEEMED")).toHaveLength(0);
    expect((await s.authority.redeem(a.ticket, call("a1", { recipient: "vendor-1" }))).status).toBe("REDEEMED");
  });

  it("a revocation between authorize and redeem is honoured", async () => {
    const s = await setup();
    const a = await s.authority.authorize(call("a1"));
    if (a.status !== "AUTHORIZED") throw new Error("not authorized");
    await s.revoke();
    expect(await s.authority.redeem(a.ticket, call("a1"))).toMatchObject({ status: "REFUSED", reason: "AUTHORITY_NO_LONGER_VALID" });
  });

  it("an expired ticket is refused, including exactly at the boundary", async () => {
    const s = await setup({ ttlMs: 60_000 });
    const a = await s.authority.authorize(call("a1"));
    if (a.status !== "AUTHORIZED") throw new Error("not authorized");
    s.clock.advance(60_000);
    expect(await s.authority.redeem(a.ticket, call("a1"))).toMatchObject({ status: "REFUSED", reason: "EXPIRED" });
  });

  it("another enforcement point cannot redeem the ticket", async () => {
    const s = await setup();
    const a = await s.authority.authorize(call("a1"));
    if (a.status !== "AUTHORIZED") throw new Error("not authorized");
    expect(await s.another("ep-2").redeem(a.ticket, call("a1"))).toMatchObject({ status: "REFUSED", reason: "WRONG_ENFORCEMENT_POINT" });
  });

  it("another agent cannot redeem the ticket", async () => {
    const s = await setup();
    const a = await s.authority.authorize(call("a1"));
    if (a.status !== "AUTHORIZED") throw new Error("not authorized");
    expect(await s.authority.redeem(a.ticket, call("a1", { agentId: "mallory" }))).toMatchObject({ status: "REFUSED", reason: "REQUESTER_MISMATCH" });
  });

  it("a different action cannot redeem the ticket", async () => {
    const s = await setup();
    const a = await s.authority.authorize(call("a1"));
    if (a.status !== "AUTHORIZED") throw new Error("not authorized");
    await s.authority.authorize(call("a2"));
    expect(await s.authority.redeem(a.ticket, call("a2"))).toEqual({ status: "REFUSED", reason: "ACTION_ID_MISMATCH", ticketConsumed: false });
  });

  it("a forged ticket is refused", async () => {
    const s = await setup();
    const a = await s.authority.authorize(call("a1"));
    if (a.status !== "AUTHORIZED") throw new Error("not authorized");
    expect(await s.authority.redeem({ ...a.ticket, capabilityId: "cap-forged" }, call("a1"))).toMatchObject({ status: "REFUSED", reason: "CAPABILITY_NOT_FOUND" });
  });
});

describe("budget accounting coexists with reporting", () => {
  it("a 4000 EUR budget allows two 1800 EUR actions (each reported) and refuses the third", async () => {
    const s = await setup({ totalBudget: EUR(4000) });
    const c = counter();
    expect((await s.authority.guard(call("b1"), c.effect)).status).toBe("EXECUTED");
    expect((await s.authority.guard(call("b2"), c.effect)).status).toBe("EXECUTED");
    expect((await s.authority.guard(call("b3"), c.effect)).status).toBe("BLOCKED");
    expect(c.runs).toBe(2);
  });
});

describe("report", () => {
  it("refuses to report an unredeemed ticket and is idempotent after a redeemed one", async () => {
    const s = await setup();
    const a = await s.authority.authorize(call("a1"));
    if (a.status !== "AUTHORIZED") throw new Error("not authorized");
    expect(await s.authority.report(a.ticket, { resultCode: "EXECUTED" })).toEqual({ status: "REJECTED", reason: "TICKET_NOT_REDEEMED" });
    await s.authority.redeem(a.ticket, call("a1"));
    expect((await s.authority.report(a.ticket, { resultCode: "EXECUTED" })).status).toBe("REPORTED");
    expect(await s.authority.report(a.ticket, { resultCode: "EXECUTED" })).toEqual({ status: "ALREADY_REPORTED" });
    expect(await eventsOf(s.authority, "ACTION_EXECUTED")).toHaveLength(1);
  });
  it("rejects an empty result code", async () => {
    const s = await setup();
    const a = await s.authority.authorize(call("a1"));
    if (a.status !== "AUTHORIZED") throw new Error("not authorized");
    await expect(s.authority.report(a.ticket, { resultCode: "" })).rejects.toBeInstanceOf(AuthorityInputError);
  });
});

describe("failure handling: fail closed, never allowed", () => {
  it("a clock that throws or returns a non-canonical instant yields UNAVAILABLE and no effect", async () => {
    for (const now of [() => { throw new Error("no time"); }, () => "2026-01-01", () => "2026-01-01T09:00:00Z", () => "2026-02-30T09:00:00.000Z", () => 42 as never]) {
      const s = await setup();
      const bad = createAuthority({ backend: { build: () => s.parts }, clock: { now }, enforcementPointId: "ep-1" });
      const c = counter();
      expect((await bad.guard(call("c1"), c.effect)).status).toBe("BLOCKED");
      expect(await bad.authorize(call("c1"))).toMatchObject({ status: "UNAVAILABLE" });
      expect(c.runs).toBe(0);
    }
  });

  it("an unreadable store makes authorize UNAVAILABLE", async () => {
    const s = await setup({ wrap: (p) => faulty(p, { getEvents: () => "throw" }) });
    const c = counter();
    expect(await s.authority.guard(call("a1"), c.effect)).toMatchObject({ status: "BLOCKED", stage: "authorize", result: { status: "UNAVAILABLE" } });
    expect(c.runs).toBe(0);
  });

  it("a failing issuance is UNAVAILABLE, and a retry gets the ticket that the lost acknowledgement hid (same key)", async () => {
    const s = await setup({ wrap: (p) => faulty(p, { issue: (n) => (n === 0 ? "throw-after" : undefined) }) });
    expect((await s.authority.authorize(call("a1"))).status).toBe("UNAVAILABLE");
    const retry = await s.authority.authorize(call("a1"));
    expect(retry.status).toBe("AUTHORIZED");
    expect(await eventsOf(s.authority, "CAPABILITY_ISSUED")).toHaveLength(1);
  });

  it("a redemption that throws BEFORE writing: no effect; the ticket is still redeemable", async () => {
    const s = await setup({ wrap: (p) => faulty(p, { redeem: (n) => (n === 0 ? "throw" : undefined) }) });
    const c = counter();
    const r = await s.authority.guard(call("a1"), c.effect);
    expect(r).toMatchObject({ status: "BLOCKED", stage: "redeem", result: { status: "UNKNOWN_OUTCOME" } });
    expect(c.runs).toBe(0);
    expect((await s.authority.guard(call("a1"), c.effect)).status).toBe("EXECUTED");
  });

  it("a LOST ACKNOWLEDGEMENT (redemption committed, call threw) is UNKNOWN_OUTCOME: effect not started, ticket stays consumed, never redeemed twice", async () => {
    const s = await setup({ wrap: (p) => faulty(p, { redeem: (n) => (n === 0 ? "throw-after" : undefined) }) });
    const c = counter();
    const r = await s.authority.guard(call("a1"), c.effect);
    expect(r).toMatchObject({ status: "BLOCKED", stage: "redeem", result: { status: "UNKNOWN_OUTCOME" } });
    expect(c.runs).toBe(0);
    expect(await eventsOf(s.authority, "CAPABILITY_REDEEMED")).toHaveLength(1);
    expect(await s.authority.guard(call("a1"), c.effect)).toMatchObject({ status: "BLOCKED", result: { status: "REFUSED", reason: "ALREADY_REDEEMED" } });
    expect(c.runs).toBe(0);
    expect(await eventsOf(s.authority, "CAPABILITY_REDEEMED")).toHaveLength(1);
  });

  it("a redemption schema problem is UNAVAILABLE (nothing was written), not UNKNOWN_OUTCOME", async () => {
    const s = await setup({ wrap: (p) => faulty(p, { redeem: () => "throw", redeemError: () => new RedemptionSchemaError(["missing index"]) }) });
    expect(await s.authority.guard(call("a1"), counter().effect)).toMatchObject({ status: "BLOCKED", stage: "redeem", result: { status: "UNAVAILABLE" } });
  });

  it("a failure to REPORT never hides an effect that ran", async () => {
    const s = await setup({ wrap: (p) => faulty(p, { append: (_n, types) => (types.includes("ACTION_EXECUTED") ? "throw" : undefined) }) });
    const c = counter();
    const r = await s.authority.guard(call("a1"), c.effect);
    expect(r).toMatchObject({ status: "EXECUTED", value: 1, report: { status: "UNAVAILABLE" } });
    expect(c.runs).toBe(1);
  });

  it("a clock that goes backwards is refused as a stale instant, not accepted", async () => {
    const s = await setup();
    await s.authority.guard(call("a1"), counter().effect);
    s.clock.advance(-3_600_000);
    const r = await s.authority.authorize(call("a2"));
    expect(r.status).not.toBe("AUTHORIZED");
  });
});

describe("concurrency", () => {
  it("25 parallel guards of the same call run the effect exactly once", async () => {
    const s = await setup();
    const c = counter();
    const results = await Promise.all(Array.from({ length: 25 }, () => s.authority.guard(call("a1"), c.effect)));
    expect(c.runs).toBe(1);
    expect(results.filter((r) => r.status === "EXECUTED")).toHaveLength(1);
    expect(await eventsOf(s.authority, "CAPABILITY_ISSUED")).toHaveLength(1);
    expect(await eventsOf(s.authority, "CAPABILITY_REDEEMED")).toHaveLength(1);
  });

  it("two enforcement-point instances over one journal still run the effect at most once", async () => {
    const s = await setup();
    const other = s.another("ep-1");
    const c = counter();
    await Promise.all([...Array.from({ length: 12 }, () => s.authority.guard(call("a1"), c.effect)), ...Array.from({ length: 12 }, () => other.guard(call("a1"), c.effect))]);
    expect(c.runs).toBe(1);
    expect(await eventsOf(s.authority, "CAPABILITY_REDEEMED")).toHaveLength(1);
    expect(await eventsOf(s.authority, "CAPABILITY_ISSUED")).toHaveLength(1);
  });
});

describe("record()", () => {
  it("applies the engine's ingestion rules: duplicates are no-ops, conflicting content is refused", async () => {
    const s = await setup();
    const one = toDraft(actionRequest({ sequence: 5000, id: "z1", requester: AGENT as never, delegationId: "d1" }));
    const conflicting = toDraft(actionRequest({ sequence: 5000, id: "z2", requester: AGENT as never, delegationId: "d1" }));
    expect(await s.authority.record([one])).toMatchObject({ status: "RECORDED", outcomes: [{ accepted: true }] });
    expect(await s.authority.record([one])).toMatchObject({ status: "RECORDED", outcomes: [{ accepted: true }] });
    expect(await s.authority.record([conflicting])).toEqual({ status: "RECORDED", outcomes: [{ accepted: false, detail: expect.any(String) }] });
    expect(await eventsOf(s.authority, "ACTION_REQUESTED")).toHaveLength(1);
  });
});
