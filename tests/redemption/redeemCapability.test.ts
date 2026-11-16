/**
 * V1 redemption kernel (invariants I26 to I30): precedence of refusals,
 * TOCTOU re-check, expiry boundary, argument binding, no side effect on
 * refusal. Entirely in memory and deterministic.
 */
import { describe, expect, it } from "vitest";
import { argumentsDigest } from "../../src/domain/canonicalJson.js";
import { authorityAt } from "../../src/engine/authority.js";
import { redeemCapability } from "../../src/engine/redeemCapability.js";
import { toDraft } from "../../src/domain/events.js";
import { actionId, capability, capabilityId, clientIdempotencyKey, iso8601, monetaryParameters, nonMonetaryParameters, sequenceNumber, enforcementPointId, type ActionParameters } from "../../src/domain/types.js";
import { EUR, PURCHASE_ORDER_CREATE, THEO, AGENT_B, actionRequest } from "../fixtures/scenarios.js";
import { AGENT, EP, PARAMS, T, auth, expiresAt, harness } from "./harness.js";

describe("redeemCapability: the happy path", () => {
  it("redeems once, writes CAPABILITY_REDEEMED right after the snapshot it decided on, at the explicit instant", async () => {
    const h = await harness();
    const id = await h.issue(T("09:10:00"));
    const before = await h.store.getEvents();
    const r = await h.redemption.redeem(auth(AGENT), h.command(id), T("09:12:00"));
    expect(r.ok).toBe(true);
    const events = await h.store.getEvents();
    const redeemed = events.filter((e) => e.event_type === "CAPABILITY_REDEEMED");
    expect(redeemed).toHaveLength(1);
    const e = redeemed[0]!;
    expect(Number(e.sequence)).toBe(before.length + 1);
    expect(e.authority_time).toBe(T("09:12:00"));
    expect(e.event_type === "CAPABILITY_REDEEMED" && e.payload).toMatchObject({ capability_id: id, action_id: "act-redeem", enforcement_point_id: EP, decision_sequence: before.length });
  });

  it("is pure: same inputs, same decision, and the input snapshot is untouched", async () => {
    const h = await harness();
    const id = await h.issue(T("09:10:00"));
    const snap = await h.store.getEvents();
    const frozen = JSON.stringify(snap);
    const a = redeemCapability(snap, auth(AGENT), h.command(id), T("09:12:00"));
    const b = redeemCapability(snap, auth(AGENT), h.command(id), T("09:12:00"));
    expect(a).toEqual(b);
    expect(JSON.stringify(snap)).toBe(frozen);
  });
});

describe("redeemCapability: refusals", () => {
  it("CAPABILITY_NOT_FOUND for an unknown capability_id", async () => {
    const h = await harness();
    await h.issue(T("09:10:00"));
    const r = await h.redemption.redeem(auth(AGENT), h.command("nope" as never), T("09:12:00"));
    expect(r).toEqual({ ok: false, reason: "CAPABILITY_NOT_FOUND" });
  });

  it("REQUESTER_MISMATCH: another authenticated principal cannot redeem someone else's ticket", async () => {
    const h = await harness();
    const id = await h.issue(T("09:10:00"));
    expect(await h.redemption.redeem(auth(AGENT_B), h.command(id), T("09:12:00"))).toEqual({ ok: false, reason: "REQUESTER_MISMATCH" });
    expect((await h.store.getEvents()).some((e) => e.event_type === "CAPABILITY_REDEEMED")).toBe(false);
  });

  it("WRONG_ENFORCEMENT_POINT", async () => {
    const h = await harness();
    const id = await h.issue(T("09:10:00"));
    const r = await h.redemption.redeem(auth(AGENT), h.command(id, { enforcement_point_id: enforcementPointId("ep-other") }), T("09:12:00"));
    expect(r).toEqual({ ok: false, reason: "WRONG_ENFORCEMENT_POINT" });
  });

  it("ALREADY_REDEEMED: a second sequential redemption is refused and writes nothing", async () => {
    const h = await harness();
    const id = await h.issue(T("09:10:00"));
    expect((await h.redemption.redeem(auth(AGENT), h.command(id), T("09:12:00"))).ok).toBe(true);
    const n = (await h.store.getEvents()).length;
    expect(await h.redemption.redeem(auth(AGENT), h.command(id), T("09:13:00"))).toEqual({ ok: false, reason: "ALREADY_REDEEMED" });
    expect((await h.store.getEvents()).length).toBe(n);
  });

  it("expiry boundary: one millisecond before expires_at is valid, expires_at itself is EXPIRED", async () => {
    const ok = await harness();
    const id1 = await ok.issue(T("09:10:00")); // expires 09:15:00.000
    expect((await ok.redemption.redeem(auth(AGENT), ok.command(id1), iso8601("2025-01-01T09:14:59.999Z"))).ok).toBe(true);
    const late = await harness();
    const id2 = await late.issue(T("09:10:00"));
    expect(await late.redemption.redeem(auth(AGENT), late.command(id2), T("09:15:00"))).toEqual({ ok: false, reason: "EXPIRED" });
    expect((await late.store.getEvents()).some((e) => e.event_type === "CAPABILITY_REDEEMED")).toBe(false);
  });

  it("STALE_AUTHORITY_TIME: an instant older than one already in the log is refused", async () => {
    const h = await harness();
    const id = await h.issue(T("09:10:00"));
    expect(await h.redemption.redeem(auth(AGENT), h.command(id), T("09:09:00"))).toEqual({ ok: false, reason: "STALE_AUTHORITY_TIME" });
  });

  it("refusal precedence is fixed: a requester mismatch is reported before a wrong enforcement point and before expiry", async () => {
    const h = await harness();
    const id = await h.issue(T("09:10:00"));
    const r = await h.redemption.redeem(auth(AGENT_B), h.command(id, { enforcement_point_id: enforcementPointId("ep-other") }), T("10:00:00"));
    expect(r).toEqual({ ok: false, reason: "REQUESTER_MISMATCH" });
  });
});

describe("redeemCapability: argument binding (the ticket is for THIS call)", () => {
  const cases: [string, ActionParameters][] = [
    ["a different amount", monetaryParameters(EUR(1900), undefined, argumentsDigest({ to: "vendor-1", sku: "A-100", qty: 3 }))],
    ["a different arguments digest (same amount)", monetaryParameters(EUR(1800), undefined, argumentsDigest({ to: "vendor-2", sku: "A-100", qty: 3 }))],
    ["no digest at all (scheme downgrade)", monetaryParameters(EUR(1800))],
    ["a non-monetary action", nonMonetaryParameters(undefined, argumentsDigest({ to: "vendor-1", sku: "A-100", qty: 3 }))],
  ];
  it.each(cases)("ARGUMENTS_MISMATCH for %s", async (_label, observed) => {
    const h = await harness();
    const id = await h.issue(T("09:10:00"));
    const r = await h.redemption.redeem(auth(AGENT), h.command(id, { observed_parameters: observed }), T("09:12:00"));
    expect(r).toEqual({ ok: false, reason: "ARGUMENTS_MISMATCH" });
    expect((await h.store.getEvents()).some((e) => e.event_type === "CAPABILITY_REDEEMED")).toBe(false);
  });

  it("ARGUMENTS_MISMATCH for a different capability", async () => {
    const h = await harness();
    const id = await h.issue(T("09:10:00"));
    const r = await h.redemption.redeem(auth(AGENT), h.command(id, { observed_capability: capability("payment", "execute") }), T("09:12:00"));
    expect(r).toEqual({ ok: false, reason: "ARGUMENTS_MISMATCH" });
  });

  it("ARGUMENTS_MISMATCH for malformed observed parameters, without throwing", async () => {
    const h = await harness();
    const id = await h.issue(T("09:10:00"));
    const bad = { kind: "monetary", amount: { value: -1, currency: "EUR" } } as unknown as ActionParameters;
    expect(await h.redemption.redeem(auth(AGENT), h.command(id, { observed_parameters: bad }), T("09:12:00"))).toEqual({ ok: false, reason: "ARGUMENTS_MISMATCH" });
  });

  it("LIMIT: with scheme-v1 parameters (no arguments_digest) the tool arguments are NOT bound; only capability, amount and recipient are", async () => {
    const h = await harness({ params: monetaryParameters(EUR(1800)) });
    const id = await h.issue(T("09:10:00"));
    // Same capability, amount, recipient; the (unobserved) tool arguments could be anything.
    const r = await h.redemption.redeem(auth(AGENT), h.command(id, { observed_parameters: monetaryParameters(EUR(1800)) }), T("09:12:00"));
    expect(r.ok).toBe(true);
  });
});

describe("redeemCapability: the TOCTOU re-check (I27)", () => {
  it("a revocation written between issuance and redemption makes redemption fail, with the engine's own decision", async () => {
    const h = await harness();
    const id = await h.issue(T("09:10:00"));
    await h.revoke(T("09:11:00"));
    const r = await h.redemption.redeem(auth(AGENT), h.command(id), T("09:12:00"));
    expect(r).toMatchObject({ ok: false, reason: "AUTHORITY_NO_LONGER_VALID", detail: { decision: { outcome: "DENIED", reasonCode: "C12_DELEGATION_REVOKED" } } });
    expect((await h.store.getEvents()).some((e) => e.event_type === "CAPABILITY_REDEEMED")).toBe(false);
  });

  it("the invoked delegation expiring between issuance and redemption makes redemption fail while the ticket itself is still unexpired", async () => {
    const h = await harness({ delegationExpiry: expiresAt(T("09:11:00")) });
    const id = await h.issue(T("09:10:00")); // ticket expires 09:15, delegation 09:11
    const r = await h.redemption.redeem(auth(AGENT), h.command(id), T("09:12:00"));
    expect(r).toMatchObject({ ok: false, reason: "AUTHORITY_NO_LONGER_VALID" });
  });

  it("a revocation AFTER redemption does not undo it (the past stays the past) but the authority is then DENIED for new questions", async () => {
    const h = await harness();
    const id = await h.issue(T("09:10:00"));
    expect((await h.redemption.redeem(auth(AGENT), h.command(id), T("09:12:00"))).ok).toBe(true);
    await h.revoke(T("09:13:00"));
    const store = await h.store.getEvents();
    const last = sequenceNumber(store.length);
    expect(authorityAt(store, { agentId: AGENT, principalId: THEO, capability: PURCHASE_ORDER_CREATE, parameters: PARAMS }, { atSequence: last, authorityTime: T("09:14:00") })).toMatchObject({ outcome: "DENIED", reasonCode: "C12_DELEGATION_REVOKED" });
    expect(await h.redemption.redeem(auth(AGENT), h.command(id), T("09:14:00"))).toEqual({ ok: false, reason: "ALREADY_REDEEMED" });
  });
});

describe("redeemCapability: a ticket written around the transaction is not authority (I26)", () => {
  it("CAPABILITY_NOT_VALID for a CAPABILITY_ISSUED whose fingerprint does not match its action", async () => {
    const h = await harness();
    await h.issue(T("09:10:00"));
    const events = await h.store.getEvents();
    const issued = events.find((e) => e.event_type === "CAPABILITY_ISSUED");
    if (issued === undefined || issued.event_type !== "CAPABILITY_ISSUED") throw new Error("fixture");
    const forged = { ...issued, event_id: "forged-evt" as never, sequence: sequenceNumber(events.length + 1), payload: { ...issued.payload, capability_id: "cap-forged" as never, action_fingerprint: "0".repeat(64) as never } };
    const r = redeemCapability([...events, forged], auth(AGENT), h.command("cap-forged" as never), T("09:12:00"));
    expect(r).toMatchObject({ ok: false, reason: "CAPABILITY_NOT_VALID", detail: { grantRejection: "FINGERPRINT_MISMATCH" } });
  });
});

describe("redeemCapability: redemption never releases capacity (I29)", () => {
  async function secondAction(h: Awaited<ReturnType<typeof harness>>) {
    const r = await h.store.append([toDraft(actionRequest({ sequence: 3, id: "act-second", requester: AGENT, delegationId: "d-redeem", parameters: monetaryParameters(EUR(300)) }))], T("09:10:00"));
    expect(r.outcomes[0]?.accepted).toBe(true);
    let n = 0;
    return () =>
      h.issuance.issue(auth(AGENT), clientIdempotencyKey(`k-second-${++n}`), { action_id: actionId("act-second"), enforcement_point_id: EP }, { nextCapabilityId: () => capabilityId("cap-second"), expiresAt: (t) => iso8601(new Date(Date.parse(t) + 300_000).toISOString()) }, T("09:13:00"));
  }

  it("a redeemed ticket stays engaged: 1800 EUR redeemed of a 2000 EUR budget still leaves no room for 300 EUR", async () => {
    const h = await harness({ totalBudget: EUR(2000) });
    const id = await h.issue(T("09:10:00"));
    const tryIssueSecond = await secondAction(h);
    expect(await tryIssueSecond()).toMatchObject({ outcome: "EXECUTED", result: { ok: false, reason: "CAPACITY_EXCEEDED" } }); // engaged before redemption
    expect((await h.redemption.redeem(auth(AGENT), h.command(id), T("09:12:00"))).ok).toBe(true);
    expect(await tryIssueSecond()).toMatchObject({ outcome: "EXECUTED", result: { ok: false, reason: "CAPACITY_EXCEEDED" } }); // and after
  });

  it("control: with a 2200 EUR budget the same second ticket is issuable, so the refusal above is about capacity", async () => {
    const h = await harness({ totalBudget: EUR(2200) });
    await h.issue(T("09:10:00"));
    const tryIssueSecond = await secondAction(h);
    expect(await tryIssueSecond()).toMatchObject({ outcome: "EXECUTED", result: { ok: true } });
  });
});
