/**
 * Adversarial tests for report(): the binding between the ticket, the action,
 * the identity, the fingerprint and the events actually in the journal. The
 * ticket is a plain object the caller can alter; none of the alterations below
 * may record anything.
 */
import { describe, expect, it } from "vitest";
import { toDraft } from "../../src/domain/events.js";
import type { ActionId, CapabilityId, EnforcementPointId, Fingerprint, SequenceNumber } from "../../src/domain/types.js";
import { explainAction } from "../../src/engine/explainAction.js";
import { buildCapabilityRedeemedDraft } from "../../src/storage/capabilityRedemptionTransaction.js";
import { AuthorityInputError, type Ticket } from "../../src/sdk/index.js";
import { actionExecution, AGENT_A, PURCHASE_ORDER_CREATE } from "../fixtures/scenarios.js";
import { AGENT, call, eventsOf, setup, type Setup } from "./harness.js";

async function redeemed(s: Setup, id = "a1", overrides = {}): Promise<Ticket> {
  const c = call(id, overrides);
  const a = await s.authority.authorize(c);
  if (a.status !== "AUTHORIZED") throw new Error(`not authorized: ${JSON.stringify(a)}`);
  const r = await s.authority.redeem(a.ticket, c);
  if (r.status !== "REDEEMED") throw new Error(`not redeemed: ${JSON.stringify(r)}`);
  return a.ticket;
}

const executed = (s: Setup) => eventsOf(s.authority, "ACTION_EXECUTED");

describe("report(): a ticket that disagrees with the journal records nothing", () => {
  const forgeries: [string, (t: Ticket) => Partial<Ticket>, string][] = [
    ["another identity", () => ({ agentId: "mallory" }), "agentId"],
    ["another fingerprint", () => ({ fingerprint: "0".repeat(64) }), "fingerprint"],
    ["a decision sequence in the future", (t) => ({ decisionSequence: t.decisionSequence + 100 }), "decisionSequence"],
    ["a decision sequence of zero", () => ({ decisionSequence: 0 }), "decisionSequence"],
    ["an emptied chain", () => ({ grantedChain: [] }), "grantedChain"],
    ["a chain with an extra approval link", (t) => ({ grantedChain: [...t.grantedChain, { kind: "approval" as const, approval_id: "ap-x" as never }] }), "grantedChain"],
    ["another enforcement point", () => ({ enforcementPointId: "ep-2" }), "enforcementPointId"],
    ["another action", () => ({ actionId: "a-other" }), "actionId"],
  ];
  for (const [label, patch, field] of forgeries) {
    it(`${label}`, async () => {
      const s = await setup();
      const ticket = await redeemed(s);
      const r = await s.authority.report({ ...ticket, ...patch(ticket) }, { resultCode: "EXECUTED" });
      expect(r).toEqual({ status: "REJECTED", reason: `TICKET_DOES_NOT_MATCH_JOURNAL:${field}` });
      expect(await executed(s)).toHaveLength(0);
      // the genuine ticket still reports
      expect((await s.authority.report(ticket, { resultCode: "EXECUTED" })).status).toBe("REPORTED");
    });
  }

  it("a capability that was never issued", async () => {
    const s = await setup();
    const ticket = await redeemed(s);
    expect(await s.authority.report({ ...ticket, capabilityId: "cap-never-issued" }, { resultCode: "EXECUTED" })).toEqual({ status: "REJECTED", reason: "UNKNOWN_TICKET" });
    expect(await executed(s)).toHaveLength(0);
  });

  it("the capability of ANOTHER redeemed action cannot be used to report this one", async () => {
    const s = await setup();
    const first = await redeemed(s, "a1");
    const second = await redeemed(s, "a2");
    const r = await s.authority.report({ ...second, capabilityId: first.capabilityId }, { resultCode: "EXECUTED" });
    expect(r).toEqual({ status: "REJECTED", reason: "TICKET_DOES_NOT_MATCH_JOURNAL:actionId" });
    expect(await executed(s)).toHaveLength(0);
  });

  it("an issued but unredeemed ticket cannot be reported, even with every field right", async () => {
    const s = await setup();
    const a = await s.authority.authorize(call("a1"));
    if (a.status !== "AUTHORIZED") throw new Error("not authorized");
    expect(await s.authority.report(a.ticket, { resultCode: "EXECUTED" })).toEqual({ status: "REJECTED", reason: "TICKET_NOT_REDEEMED" });
    expect(await executed(s)).toHaveLength(0);
  });

  it("only the enforcement point that redeemed the ticket can report it", async () => {
    const s = await setup();
    const ticket = await redeemed(s);
    expect(await s.another("ep-2").report(ticket, { resultCode: "EXECUTED" })).toEqual({ status: "REJECTED", reason: "WRONG_ENFORCEMENT_POINT" });
    expect(await executed(s)).toHaveLength(0);
  });

  it("a forged CAPABILITY_REDEEMED written around the SDK (it can burn a ticket) is not enough to report", async () => {
    const s = await setup();
    const a = await s.authority.authorize(call("a1"));
    if (a.status !== "AUTHORIZED") throw new Error("not authorized");
    const forged = buildCapabilityRedeemedDraft(
      { principalId: AGENT as never },
      s.clock.now() as never,
      {
        capability_id: a.ticket.capabilityId as CapabilityId,
        action_id: a.ticket.actionId as ActionId,
        action_fingerprint: a.ticket.fingerprint as Fingerprint,
        decision_sequence: 1 as SequenceNumber, // not the sequence just before the event
        enforcement_point_id: a.ticket.enforcementPointId as EnforcementPointId,
      },
      "forged-attempt",
    );
    expect(await s.authority.record([forged])).toMatchObject({ status: "RECORDED", outcomes: [{ accepted: true }] });
    expect(await s.authority.report(a.ticket, { resultCode: "EXECUTED" })).toMatchObject({ status: "REJECTED", reason: expect.stringContaining("REDEMPTION_NOT_VALID") });
    expect(await executed(s)).toHaveLength(0);
    // and the ticket is consumed: the honest redemption now fails
    expect(await s.authority.redeem(a.ticket, call("a1"))).toMatchObject({ status: "REFUSED", reason: "ALREADY_REDEEMED" });
  });
});

describe("report(): what is recorded comes from the journal, once", () => {
  it("records the requester, the issued fingerprint, the issuance decision sequence and the granted chain", async () => {
    const s = await setup();
    const ticket = await redeemed(s);
    expect(await s.authority.report(ticket, { resultCode: "EXECUTED" })).toMatchObject({ status: "REPORTED" });
    const events = await s.authority.events();
    const issued = events.find((e) => e.event_type === "CAPABILITY_ISSUED")!;
    const exec = events.find((e) => e.event_type === "ACTION_EXECUTED")!;
    if (issued.event_type !== "CAPABILITY_ISSUED" || exec.event_type !== "ACTION_EXECUTED") throw new Error("unexpected events");
    expect(exec.principal_id).toBe(AGENT);
    expect(exec.payload).toMatchObject({
      action_id: "a1",
      executed_by_principal_id: AGENT,
      action_fingerprint: issued.payload.action_fingerprint,
      decision_sequence: issued.payload.decision_sequence,
      execution_result: "EXECUTED",
    });
    expect(exec.payload.authority_chain_ref).toEqual(issued.payload.granted_chain_ref);
    expect(exec.sequence).toBeGreaterThan(events.find((e) => e.event_type === "CAPABILITY_REDEEMED")!.sequence);
  });

  it("the first report wins: a second one, with another code, records nothing and the journal keeps the first", async () => {
    const s = await setup();
    const ticket = await redeemed(s);
    expect((await s.authority.report(ticket, { resultCode: "EXECUTED" })).status).toBe("REPORTED");
    expect(await s.authority.report(ticket, { resultCode: "EFFECT_FAILED" })).toEqual({ status: "ALREADY_REPORTED" });
    const all = await executed(s);
    expect(all).toHaveLength(1);
    expect((all[0] as unknown as { payload: { execution_result: string } }).payload.execution_result).toBe("EXECUTED");
  });

  it("concurrent reports write exactly one event (callers may each be told REPORTED, with the same sequence, when the duplicate is byte-identical)", async () => {
    for (const moving of [false, true]) {
      const s = await setup();
      const ticket = await redeemed(s);
      const results = await Promise.all(
        Array.from({ length: 10 }, async (_, i) => {
          if (moving) s.clock.advance(i);
          return s.authority.report(ticket, { resultCode: "EXECUTED" });
        }),
      );
      for (const r of results) expect(["REPORTED", "ALREADY_REPORTED"]).toContain(r.status);
      expect(new Set(results.filter((r) => r.status === "REPORTED").map((r) => (r as { sequence: number }).sequence)).size).toBeLessThanOrEqual(1);
      expect(await executed(s)).toHaveLength(1);
    }
  });

  it("the result code is a short code, never free text or data", async () => {
    const s = await setup();
    const ticket = await redeemed(s);
    for (const bad of ["executed", "ok done", "token=abc123", "A".repeat(65), "É"]) {
      await expect(s.authority.report(ticket, { resultCode: bad })).rejects.toBeInstanceOf(AuthorityInputError);
    }
    expect(await executed(s)).toHaveLength(0);
  });

  it("the journal written by guard is explained by the engine as authorized, with no integrity flag", async () => {
    const s = await setup();
    await s.authority.guard(call("a1"), async () => "ok");
    const events = await s.authority.events();
    const at = { atSequence: Math.max(...events.map((e) => Number(e.sequence))) as unknown as SequenceNumber, authorityTime: s.clock.now() as never };
    const report = explainAction(events, { actionId: "a1" as ActionId }, at);
    expect(report.execution?.authorityAtDecision.outcome).toBe("AUTHORIZED");
    expect(JSON.stringify(report.execution?.invokedAuthorityAtDecision)).toContain("AUTHORIZED");
    expect(JSON.stringify(report.execution?.recordedChainIntegrity)).toContain("EXACT");
    expect(JSON.stringify(report.execution?.recordedValidation)).not.toMatch(/MISMATCH|UNRESOLVABLE|DENIED/);
  });

  it("an approved action: the recorded chain carries the approval and the engine reports it as consumed", async () => {
    const s = await setup();
    const big = call("big", { amount: { value: 4800, currency: "EUR" } });
    await s.authority.authorize(big);
    await s.approve("big");
    expect((await s.authority.guard(big, async () => "ok")).status).toBe("EXECUTED");
    const events = await s.authority.events();
    const at = { atSequence: Math.max(...events.map((e) => Number(e.sequence))) as unknown as SequenceNumber, authorityTime: s.clock.now() as never };
    const report = explainAction(events, { actionId: "big" as ActionId }, at);
    expect(report.execution?.consumedApprovalId).toBe("ap-big");
  });
});

describe("limits of report(), as tests (not guarantees)", () => {
  it("record() is trusted ingress: a forged ACTION_EXECUTED written around the SDK is accepted by ingestion, and only the engine's explanation exposes it", async () => {
    const s = await setup();
    const a = await s.authority.authorize(call("a1"));
    if (a.status !== "AUTHORIZED") throw new Error("not authorized");
    const forged = toDraft(
      actionExecution({ sequence: 7000, actionId: "a1", executor: AGENT_A, decisionSequence: a.ticket.decisionSequence, chain: a.ticket.grantedChain as never, capability: PURCHASE_ORDER_CREATE, fingerprintOverride: "f".repeat(64) }),
    );
    expect(await s.authority.record([forged])).toMatchObject({ status: "RECORDED", outcomes: [{ accepted: true }] });
    const events = await s.authority.events();
    const at = { atSequence: Math.max(...events.map((e) => Number(e.sequence))) as unknown as SequenceNumber, authorityTime: s.clock.now() as never };
    expect(explainAction(events, { actionId: "a1" as ActionId }, at).execution?.authorityAtDecision).toEqual({ outcome: "DENIED", reasonCode: "C6_ACTION_FINGERPRINT_MISMATCH" });
  });

  it("an honest report asserts, it does not prove: the SDK cannot know the effect really happened", async () => {
    const s = await setup();
    const ticket = await redeemed(s);
    // the enforcement point may report success for an effect that never ran
    expect((await s.authority.report(ticket, { resultCode: "EXECUTED" })).status).toBe("REPORTED");
  });
});
