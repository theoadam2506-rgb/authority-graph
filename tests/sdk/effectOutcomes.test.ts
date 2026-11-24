/**
 * CHARACTERIZATION TESTS: what the SDK does today when the outcome of an external effect is failed,
 * unknown, or only partly recorded.
 *
 * These tests pin the CURRENT behaviour, including the parts that are imperfect or surprising. They
 * describe; they do not endorse. If one of them fails after a change, that change altered a documented
 * behaviour of `guard`, `redeem`, `report` or the budget accounting, and it must be a deliberate,
 * validated decision, with `docs/v1/SDK.md` ("Failed, confirmed and uncertain outcomes") updated.
 *
 * Each test names the limit it pins. The limits are listed in `docs/v1/SDK.md`:
 *  G2  guard() cannot tell a confirmed failure from an unknown result.
 *  G3  the first `ACTION_EXECUTED` of an action wins: it cannot be corrected.
 *  G4  a redeemed ticket that was never reported is a state with no status of its own.
 *  G5  a failed effect never releases the budget.
 *  G6  the idempotency key is the ticket id: a new action carries another key.
 *  G7  the engine gives no meaning to the result code.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Ticket } from "../../src/sdk/index.js";
import { EUR } from "../fixtures/scenarios.js";
import { call, eventsOf, faulty, setup, type Setup } from "./harness.js";

/** The `execution_result` of every ACTION_EXECUTED in the journal, in order. */
const executedCodes = async (s: Setup): Promise<string[]> =>
  (await eventsOf(s.authority, "ACTION_EXECUTED")).map((e) => (e.event_type === "ACTION_EXECUTED" ? String(e.payload.execution_result) : ""));

/** The public result without what legitimately differs between two calls (the random diagnostic id, the journal sequence of the report). */
const withoutDiagnosticId = (r: object): object => {
  const { diagnosticId: _ignored, report, ...rest } = r as { diagnosticId?: string; report?: { status: string } };
  return { ...rest, report: report === undefined ? undefined : { status: report.status } };
};

const twoThousand = (id: string) => call(id, { amount: { value: 2000, currency: "EUR" } });

describe("G2: guard() does not distinguish a confirmed failure from an unknown result", () => {
  it("a target that REFUSED the call and a call that TIMED OUT give the same public result and the same journal code", async () => {
    const s = await setup();
    const refused = await s.authority.guard(call("refused"), async () => {
      throw Object.assign(new Error("402 card declined by the issuer"), { code: "CARD_DECLINED" });
    });
    const timedOut = await s.authority.guard(call("timed-out"), async () => {
      throw new Error("timeout after 30s");
    });
    expect(refused).toMatchObject({ status: "EFFECT_FAILED", code: "EFFECT_THREW", ticketConsumed: true, report: { status: "REPORTED" } });
    expect(withoutDiagnosticId(refused)).toEqual(withoutDiagnosticId(timedOut));
    // Both are recorded with the same code.
    expect(await executedCodes(s)).toEqual(["EFFECT_FAILED", "EFFECT_FAILED"]);
  });

  it("a failure that the effect HANDLES ITSELF and returns is recorded as EXECUTED", async () => {
    const s = await setup();
    const r = await s.authority.guard(call("handled"), async () => ({ ok: false, error: "card declined" }));
    expect(r).toMatchObject({ status: "EXECUTED", value: { ok: false }, report: { status: "REPORTED" } });
    // The journal says EXECUTED although the host knows that the effect failed: guard always reports EXECUTED when the effect returns.
    expect(await executedCodes(s)).toEqual(["EXECUTED"]);
  });

  it("a code of the caller's own choice can only be recorded by calling authorize, redeem and report directly", async () => {
    const s = await setup();
    const a = await s.authority.authorize(call("manual"));
    if (a.status !== "AUTHORIZED") throw new Error("not authorized");
    expect((await s.authority.redeem(a.ticket, call("manual"))).status).toBe("REDEEMED");
    expect(await s.authority.report(a.ticket, { resultCode: "TARGET_REJECTED" })).toMatchObject({ status: "REPORTED" });
    expect(await executedCodes(s)).toEqual(["TARGET_REJECTED"]);
  });
});

describe("G3: the first ACTION_EXECUTED of an action wins and cannot be corrected", () => {
  it("EFFECT_FAILED first, then a later report of EXECUTED: ALREADY_REPORTED, the journal keeps EFFECT_FAILED", async () => {
    const s = await setup();
    let ticket: Ticket | undefined;
    const r = await s.authority.guard(call("a1"), async (context) => {
      ticket = context.ticket;
      throw new Error("reply lost");
    });
    expect(r.status).toBe("EFFECT_FAILED");
    if (ticket === undefined) throw new Error("the effect did not receive a ticket");
    // Imagine the host learns later that the effect did complete: the SDK cannot record it.
    expect(await s.authority.report(ticket, { resultCode: "EXECUTED" })).toEqual({ status: "ALREADY_REPORTED" });
    expect(await s.authority.report(ticket, { resultCode: "EFFECT_FAILED" })).toEqual({ status: "ALREADY_REPORTED" });
    expect(await executedCodes(s)).toEqual(["EFFECT_FAILED"]);
  });

  it("a report that FAILED to be written leaves no ACTION_EXECUTED, and a later report with the same ticket can still be made once", async () => {
    let failures = 1;
    const s = await setup({
      wrap: (p) =>
        faulty(p, {
          append: (_n, types) => (types.includes("ACTION_EXECUTED") && failures-- > 0 ? "throw" : undefined),
        }),
    });
    let ticket: Ticket | undefined;
    const r = await s.authority.guard(call("a1"), async (context) => {
      ticket = context.ticket;
      return "done";
    });
    expect(r).toMatchObject({ status: "EXECUTED", report: { status: "UNAVAILABLE" } });
    expect(await executedCodes(s)).toEqual([]);
    if (ticket === undefined) throw new Error("the effect did not receive a ticket");
    expect(await s.authority.report(ticket, { resultCode: "EXECUTED" })).toMatchObject({ status: "REPORTED" });
    expect(await s.authority.report(ticket, { resultCode: "EFFECT_FAILED" })).toEqual({ status: "ALREADY_REPORTED" });
    expect(await executedCodes(s)).toEqual(["EXECUTED"]);
  });
});

describe("G4: a redeemed ticket that was never reported has no status of its own", () => {
  it("every call answers as for a consumed ticket; ticketConsumed describes the CALL, not the ticket's history", async () => {
    const s = await setup();
    const a = await s.authority.authorize(call("a1"));
    if (a.status !== "AUTHORIZED") throw new Error("not authorized");
    expect((await s.authority.redeem(a.ticket, call("a1"))).status).toBe("REDEEMED");
    // ... the process stops here: the effect may or may not have started, and nothing was reported.

    let runs = 0;
    const again = await s.authority.guard(call("a1"), async () => ++runs);
    expect(again).toMatchObject({ status: "BLOCKED", stage: "redeem", result: { status: "REFUSED", reason: "ALREADY_REDEEMED", ticketConsumed: false } });
    expect(runs).toBe(0);
    expect(await s.authority.redeem(a.ticket, call("a1"))).toEqual({ status: "REFUSED", reason: "ALREADY_REDEEMED", ticketConsumed: false });
    // The ticket IS consumed (one redemption in the journal) although the refusal says ticketConsumed: false.
    expect(await eventsOf(s.authority, "CAPABILITY_REDEEMED")).toHaveLength(1);
    expect(await eventsOf(s.authority, "ACTION_EXECUTED")).toHaveLength(0);
  });

  it("authorize() on that action answers AUTHORIZED with the same ticket again: AUTHORIZED does not mean 'still usable'", async () => {
    const s = await setup();
    const first = await s.authority.authorize(call("a1"));
    if (first.status !== "AUTHORIZED") throw new Error("not authorized");
    await s.authority.redeem(first.ticket, call("a1"));
    const second = await s.authority.authorize(call("a1"));
    expect(second.status).toBe("AUTHORIZED");
    if (second.status === "AUTHORIZED") expect(second.ticket.capabilityId).toBe(first.ticket.capabilityId);
    expect(await eventsOf(s.authority, "CAPABILITY_ISSUED")).toHaveLength(1);
  });

  it("the outcome can still be reported afterwards, by calling report with the ticket that the host kept", async () => {
    const s = await setup();
    const a = await s.authority.authorize(call("a1"));
    if (a.status !== "AUTHORIZED") throw new Error("not authorized");
    await s.authority.redeem(a.ticket, call("a1"));
    expect(await s.authority.report(a.ticket, { resultCode: "EFFECT_UNKNOWN" })).toMatchObject({ status: "REPORTED" });
    expect(await executedCodes(s)).toEqual(["EFFECT_UNKNOWN"]);
  });
});

describe("G5: a failed effect never releases the budget", () => {
  const budget = EUR(3000);

  it("control: with room in the budget, a second 2,000 EUR action is authorized", async () => {
    const s = await setup({ totalBudget: EUR(5000) });
    await s.authority.guard(twoThousand("a1"), async () => {
      throw new Error("timeout");
    });
    expect((await s.authority.authorize(twoThousand("a2"))).status).toBe("AUTHORIZED");
  });

  it("after an EFFECT_FAILED, the second 2,000 EUR action against a 3,000 EUR budget is DENIED", async () => {
    const s = await setup({ totalBudget: budget });
    expect((await s.authority.guard(twoThousand("a1"), async () => { throw new Error("timeout"); })).status).toBe("EFFECT_FAILED");
    expect(await s.authority.authorize(twoThousand("a2"))).toEqual({ status: "DENIED", reason: "C9_TOTAL_BUDGET_EXCEEDED" });
  });

  it("a ticket redeemed and never reported also holds the budget (CAPACITY_EXCEEDED)", async () => {
    const s = await setup({ totalBudget: budget });
    const a = await s.authority.authorize(twoThousand("a1"));
    if (a.status !== "AUTHORIZED") throw new Error("not authorized");
    await s.authority.redeem(a.ticket, twoThousand("a1"));
    expect(await s.authority.authorize(twoThousand("a2"))).toEqual({ status: "DENIED", reason: "CAPACITY_EXCEEDED" });
  });

  it("a ticket that was only ISSUED holds the budget too", async () => {
    const s = await setup({ totalBudget: budget });
    expect((await s.authority.authorize(twoThousand("a1"))).status).toBe("AUTHORIZED");
    expect(await s.authority.authorize(twoThousand("a2"))).toEqual({ status: "DENIED", reason: "CAPACITY_EXCEEDED" });
  });
});

describe("G6: the idempotency key is the ticket id, so a new action carries another key", () => {
  it("the effect receives the ticket id as its idempotency key, and the same action always has the same ticket", async () => {
    const s = await setup();
    let seen: { idempotencyKey: string; ticket: Ticket } | undefined;
    await s.authority.guard(call("a1"), async (context) => {
      seen = context;
      return 1;
    });
    if (seen === undefined) throw new Error("the effect did not run");
    expect(seen.idempotencyKey).toBe(seen.ticket.capabilityId);
    const again = await s.authority.authorize(call("a1"));
    if (again.status === "AUTHORIZED") expect(again.ticket.capabilityId).toBe(seen.idempotencyKey);
  });

  it("retrying after a failure through a NEW ACTION gives the target a DIFFERENT key: it cannot deduplicate against the first attempt", async () => {
    const s = await setup();
    const keys: string[] = [];
    const first = await s.authority.guard(call("first"), async (context) => {
      keys.push(context.idempotencyKey);
      throw new Error("reply lost");
    });
    expect(first.status).toBe("EFFECT_FAILED");
    // Same content, a new action id: the SDK authorizes it as a new action (the first one is closed, I32).
    const retry = await s.authority.guard(call("second"), async (context) => {
      keys.push(context.idempotencyKey);
      return "sent again";
    });
    expect(retry.status).toBe("EXECUTED");
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys.every((k) => k.startsWith("cap-"))).toBe(true);
  });
});

describe("G7: the engine gives no meaning to the result code", () => {
  const codes = ["EXECUTED", "EFFECT_FAILED", "EFFECT_UNKNOWN", "ANYTHING_AT_ALL"];

  it("whatever code is reported, the next decision is the same: the code has no effect on the budget", async () => {
    const answers: unknown[] = [];
    for (const code of codes) {
      const s = await setup({ totalBudget: EUR(3000) });
      const a = await s.authority.authorize(twoThousand("a1"));
      if (a.status !== "AUTHORIZED") throw new Error("not authorized");
      await s.authority.redeem(a.ticket, twoThousand("a1"));
      expect(await s.authority.report(a.ticket, { resultCode: code })).toMatchObject({ status: "REPORTED" });
      answers.push(await s.authority.authorize(twoThousand("a2")));
    }
    expect(new Set(answers.map((x) => JSON.stringify(x))).size).toBe(1);
    expect(answers[0]).toEqual({ status: "DENIED", reason: "C9_TOTAL_BUDGET_EXCEEDED" });
  });

  it("a code that does not match ^[A-Z0-9_]{1,64}$ is refused as a programming error, before anything is written", async () => {
    const s = await setup();
    const a = await s.authority.authorize(call("a1"));
    if (a.status !== "AUTHORIZED") throw new Error("not authorized");
    await s.authority.redeem(a.ticket, call("a1"));
    await expect(s.authority.report(a.ticket, { resultCode: "card declined (4242)" })).rejects.toThrow(/resultCode must match/);
    expect(await executedCodes(s)).toEqual([]);
  });

  it("in the sources, execution_result is only defined and written: no code reads it to decide anything", () => {
    const root = join(__dirname, "..", "..", "src");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".ts")) files.push(path);
      }
    };
    walk(root);
    const mentions = files.filter((f) => /execution_result|ExecutionResultCode|executionResultCode/.test(readFileSync(f, "utf8"))).map((f) => f.slice(root.length + 1));
    expect(mentions.sort()).toEqual(["domain/events.ts", "domain/types.ts", "sdk/authority.ts"]);
  });
});
