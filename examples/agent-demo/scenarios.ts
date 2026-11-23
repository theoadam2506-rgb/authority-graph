/**
 * Authority Graph, an AI agent and a guarded tool: seven scenarios, deterministic,
 * offline. No API key, no account, no database, no LLM. The "agent" is a scripted
 * function that proposes tool calls; the "tool" is a sandbox that only appends to
 * an in-memory list. Everything goes through the PUBLIC SDK entry point and its
 * typed event builders (the same imports an outside project has): nothing internal
 * is imported.
 *
 * What it shows, and what it does not: see docs/v1/AGENT_DEMO.md. In particular it
 * does NOT show, and Authority does not provide, exactly-once execution of the
 * external effect, identity verification, or an independent audit.
 */
import { createAuthority, createEventBuilders, memoryBackend, type Authority, type Backend, type ToolCall } from "../../src/sdk/index.js";

// ---------------------------------------------------------------------------
// The sandbox: a fixed clock and the only "external effect" in the demo
// ---------------------------------------------------------------------------

/** A clock you control. Authority has no default clock; here we choose a fixed, readable one. */
export class DemoClock {
  private ms = Date.parse("2026-06-01T09:00:00.000Z");
  now(): string {
    return new Date(this.ms).toISOString();
  }
  advance(milliseconds: number): void {
    this.ms += milliseconds;
  }
}

export interface Order {
  readonly orderId: string;
  readonly amountEur: number;
  readonly recipient: string;
  readonly idempotencyKey: string;
}

export interface StepRecord {
  readonly scenario: number;
  readonly title: string;
  readonly agentAsks: string;
  readonly authority: string;
  readonly tool: string;
}

export interface DemoReport {
  readonly steps: readonly StepRecord[];
  /** Every order the sandbox tool actually placed, in order. */
  readonly orders: readonly Order[];
  /** Facts the tests and the run script assert. */
  readonly facts: Readonly<Record<string, string | number | boolean>>;
}

const OWNER = "alice";
const AGENT = "procurement-agent";
const DELEGATION = "d-procurement";
const PURCHASE = { resource: "purchase_order", action: "create" } as const;

const describe = (call: ToolCall): string => `${call.actionId}: ${call.amount?.value ?? "-"} ${call.amount?.currency ?? ""} to ${call.recipient ?? "-"}`.replace(/\s+/g, " ");

/** A call the scripted agent wants to make. `args` is what the tool would really receive. */
const order = (actionId: string, value: number, recipient = "vendor-1", args: unknown = { sku: "A-100", qty: 3 }): ToolCall => ({
  actionId,
  agentId: AGENT,
  delegationId: DELEGATION,
  capability: PURCHASE,
  amount: { value, currency: "EUR" },
  recipient,
  args,
});

// ---------------------------------------------------------------------------
// A backend that loses the acknowledgement of a redemption (scenario 7)
// ---------------------------------------------------------------------------

/**
 * Wraps a backend so that the redemption IS written but the caller is told the
 * connection dropped, like a lost COMMIT acknowledgement. Uses only the public
 * `Backend` interface.
 */
function losingTheAcknowledgement(inner: Backend): Backend {
  return {
    build(ingestionClock) {
      const parts = inner.build(ingestionClock);
      return {
        ...parts,
        redemption: {
          redeem: async (...args) => {
            await parts.redemption.redeem(...args);
            throw new Error("connection reset by peer after COMMIT (simulated)");
          },
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The demo
// ---------------------------------------------------------------------------

export async function runAgentDemo(): Promise<DemoReport> {
  const clock = new DemoClock();
  const steps: StepRecord[] = [];
  const orders: Order[] = [];
  const facts: Record<string, string | number | boolean> = {};

  let eventCounter = 0;
  let ticketCounter = 0;
  const events = createEventBuilders({ clock, newEventId: () => `evt-demo-${++eventCounter}` });
  const newAuthority = (backend: Backend): Authority =>
    createAuthority({ backend, clock, enforcementPointId: "purchase-gateway", capabilityTtlMs: 300_000, newId: () => `cap-demo-${++ticketCounter}` });

  /** The sandbox tool. It is the ONLY place an "effect" happens, and it records what it received. */
  const placeOrder = async (call: ToolCall, idempotencyKey: string): Promise<string> => {
    orders.push({ orderId: call.actionId, amountEur: call.amount?.value ?? 0, recipient: call.recipient ?? "", idempotencyKey });
    return `order ${call.actionId} placed`;
  };
  const toolRuns = (): number => orders.length;
  const note = (scenario: number, title: string, call: string, authority: string, tool: string): void => {
    steps.push({ scenario, title, agentAsks: call, authority, tool });
  };
  const must = (condition: boolean, message: string): void => {
    if (!condition) throw new Error(`Demo expectation failed: ${message}`);
  };

  // --- Setup: a human delegates a narrow, bounded power to the agent --------
  const authority = newAuthority(memoryBackend());
  const delegated = await authority.record([
    events.delegation({
      delegationId: DELEGATION,
      grantor: OWNER,
      grantee: AGENT,
      capabilities: [PURCHASE],
      canDelegate: false,
      expiresAt: "2026-12-31T00:00:00.000Z",
      // Up to 2,000 EUR the agent acts alone; up to 5,000 EUR a human must approve; above, never.
      thresholds: { automaticMax: { value: 2000, currency: "EUR" }, approvalMax: { value: 5000, currency: "EUR" } },
    }),
  ]);
  must(delegated.status === "RECORDED" && delegated.outcomes.every((o) => o.accepted), "the delegation is accepted");

  // --- 1. Allowed, then refused ------------------------------------------------
  {
    const call = order("po-1001", 1200);
    const result = await authority.guard(call, ({ idempotencyKey }) => placeOrder(call, idempotencyKey));
    must(result.status === "EXECUTED" && toolRuns() === 1, "an allowed call runs the tool once");
    note(1, "An allowed action", describe(call), "AUTHORIZED, REDEEMED", "ran once");

    const refusals: [string, ToolCall][] = [
      ["a capability that was never delegated", { ...order("po-1002", 100), capability: { resource: "purchase_order", action: "delete" } }],
      ["a delegation that belongs to someone else", { ...order("po-1003", 100), agentId: "other-agent" }],
      ["an amount above the approval ceiling", order("po-1004", 9000)],
    ];
    for (const [label, refused] of refusals) {
      const before = toolRuns();
      const r = await authority.guard(refused, ({ idempotencyKey }) => placeOrder(refused, idempotencyKey));
      must(r.status === "BLOCKED" && r.stage === "authorize" && r.result.status === "DENIED" && toolRuns() === before, `${label} is denied and the tool does not run`);
      note(1, `Refused: ${label}`, describe(refused), r.status === "BLOCKED" && r.result.status === "DENIED" ? `DENIED (${r.result.reason})` : "?", "did not run");
      facts[`denied:${label}`] = r.status === "BLOCKED" && r.result.status === "DENIED" ? r.result.reason : "";
    }
  }

  // --- 2. Human approval -------------------------------------------------------
  {
    const call = order("po-2001", 3500);
    const first = await authority.guard(call, ({ idempotencyKey }) => placeOrder(call, idempotencyKey));
    must(first.status === "BLOCKED" && first.stage === "authorize" && first.result.status === "REQUIRES_APPROVAL" && toolRuns() === 1, "3,500 EUR waits for a human");
    note(2, "Needs a human: blocked", describe(call), "REQUIRES_APPROVAL", "did not run");

    // The agent tries to approve its own request. The engine refuses it: only the delegation's grantor can approve.
    const selfApproval = await authority.record([
      events.approvalRequest({ approvalId: "ap-2001", actionId: "po-2001", requestedBy: AGENT, requestedFrom: OWNER, reasonCode: "OVER_AUTOMATIC_LIMIT" }),
      events.approvalGranted({ approvalId: "ap-2001", actionId: "po-2001", approver: AGENT }),
    ]);
    must(selfApproval.status === "RECORDED" && selfApproval.outcomes[0]?.accepted === true && selfApproval.outcomes[1]?.accepted === false, "the agent cannot approve itself");
    const stillBlocked = await authority.authorize(call);
    must(stillBlocked.status === "REQUIRES_APPROVAL", "a refused self-approval changes nothing");
    note(2, "The agent approves itself", describe(call), `approval refused by the engine (${selfApproval.status === "RECORDED" ? selfApproval.outcomes[1]?.detail : "?"}); still REQUIRES_APPROVAL`, "did not run");

    // The human approves THIS action.
    const approval = await authority.record([events.approvalGranted({ approvalId: "ap-2001", actionId: "po-2001", approver: OWNER })]);
    must(approval.status === "RECORDED" && approval.outcomes[0]?.accepted === true, "the owner's approval is accepted");
    const approved = await authority.guard(call, ({ idempotencyKey }) => placeOrder(call, idempotencyKey));
    must(approved.status === "EXECUTED" && toolRuns() === 2, "after the human's approval the call runs once");
    note(2, "The human approves", describe(call), "approval accepted; AUTHORIZED, REDEEMED", "ran once");

    // The approval covers that exact action only.
    const other = order("po-2002", 3500);
    const second = await authority.guard(other, ({ idempotencyKey }) => placeOrder(other, idempotencyKey));
    must(second.status === "BLOCKED" && second.stage === "authorize" && second.result.status === "REQUIRES_APPROVAL" && toolRuns() === 2, "the approval does not cover another action");
    note(2, "Another action of the same size", describe(other), "REQUIRES_APPROVAL (the approval was for po-2001 only)", "did not run");
  }

  // --- 3. A ticket is single use ----------------------------------------------
  let singleUseTicketId = "";
  {
    const call = order("po-3001", 800);
    const authorized = await authority.authorize(call);
    must(authorized.status === "AUTHORIZED", "po-3001 is authorized");
    if (authorized.status !== "AUTHORIZED") throw new Error("unreachable");
    singleUseTicketId = authorized.ticket.capabilityId;
    const redeemed = await authority.redeem(authorized.ticket, call);
    must(redeemed.status === "REDEEMED", "the first redemption succeeds");
    await placeOrder(call, authorized.ticket.capabilityId);
    const before = toolRuns();
    const again = await authority.redeem(authorized.ticket, call);
    must(again.status === "REFUSED" && again.reason === "ALREADY_REDEEMED" && toolRuns() === before, "a second redemption is refused");
    const replayed = await authority.guard(call, ({ idempotencyKey }) => placeOrder(call, idempotencyKey));
    must(replayed.status === "BLOCKED" && replayed.stage === "redeem" && toolRuns() === before, "guard() on the same action runs nothing");
    note(3, "A ticket works once", describe(call), `first redeem: REDEEMED; second redeem: REFUSED (${again.status === "REFUSED" ? again.reason : "?"})`, "ran once, not twice");
  }

  // --- 4. Substituted arguments ------------------------------------------------
  {
    const call = order("po-4001", 1200, "vendor-1", { sku: "A-100", qty: 3 });
    const authorized = await authority.authorize(call);
    must(authorized.status === "AUTHORIZED", "po-4001 is authorized");
    if (authorized.status !== "AUTHORIZED") throw new Error("unreachable");
    const before = toolRuns();
    const swaps: [string, ToolCall, string][] = [
      ["a larger amount", order("po-4001", 1900, "vendor-1", { sku: "A-100", qty: 3 }), "po-4001: 1900 EUR instead of 1200"],
      ["another recipient", order("po-4001", 1200, "attacker-account", { sku: "A-100", qty: 3 }), "po-4001: recipient attacker-account instead of vendor-1"],
      ["other tool arguments", order("po-4001", 1200, "vendor-1", { sku: "A-100", qty: 300 }), "po-4001: qty 300 instead of 3"],
      ["another action id", order("po-9999", 1200), "po-9999 presented with po-4001's ticket"],
    ];
    for (const [label, swapped, shown] of swaps) {
      const r = await authority.redeem(authorized.ticket, swapped);
      must(r.status === "REFUSED" && r.ticketConsumed === false && toolRuns() === before, `${label} is refused at redemption`);
      note(4, `Substitution: ${label}`, `${shown} (authorized: ${describe(call)})`, `REFUSED (${r.status === "REFUSED" ? r.reason : "?"})`, "did not run");
      facts[`substitution:${label}`] = r.status === "REFUSED" ? r.reason : "";
    }
    // The unchanged call still works: the refusals did not burn the ticket.
    const honest = await authority.redeem(authorized.ticket, call);
    must(honest.status === "REDEEMED", "the unchanged call is still redeemable");
    await placeOrder(call, authorized.ticket.capabilityId);
    note(4, "The unchanged call", describe(call), "REDEEMED (a refused substitution does not consume the ticket)", "ran once");
  }

  // --- 5. Revocation -----------------------------------------------------------
  {
    // Its own authority and delegation, so that revoking does not end the rest of the demo.
    const revocable = newAuthority(memoryBackend());
    await revocable.record([
      events.delegation({
        delegationId: "d-revocable",
        grantor: OWNER,
        grantee: AGENT,
        capabilities: [PURCHASE],
        canDelegate: false,
        expiresAt: null,
        thresholds: { automaticMax: { value: 2000, currency: "EUR" }, approvalMax: { value: 5000, currency: "EUR" } },
      }),
    ]);
    const call: ToolCall = { ...order("po-5001", 1500), delegationId: "d-revocable" };
    const authorized = await revocable.authorize(call);
    must(authorized.status === "AUTHORIZED", "po-5001 is authorized");
    if (authorized.status !== "AUTHORIZED") throw new Error("unreachable");
    const stranger = await revocable.record([events.revocation({ delegationId: "d-revocable", revokedBy: AGENT, reasonCode: "NOT_ALLOWED" })]);
    must(stranger.status === "RECORDED" && stranger.outcomes[0]?.accepted === false, "the agent cannot revoke its own delegation");
    const revoked = await revocable.record([events.revocation({ delegationId: "d-revocable", revokedBy: OWNER, reasonCode: "OWNER_REQUEST" })]);
    must(revoked.status === "RECORDED" && revoked.outcomes[0]?.accepted === true, "the owner revokes the delegation");
    const before = toolRuns();
    const late = await revocable.redeem(authorized.ticket, call);
    must(late.status === "REFUSED" && late.reason === "AUTHORITY_NO_LONGER_VALID" && toolRuns() === before, "a ticket issued before the revocation is refused at redemption");
    const fresh: ToolCall = { ...order("po-5002", 100), delegationId: "d-revocable" };
    const next = await revocable.guard(fresh, ({ idempotencyKey }) => placeOrder(fresh, idempotencyKey));
    must(next.status === "BLOCKED" && next.stage === "authorize" && next.result.status === "DENIED" && toolRuns() === before, "after the revocation nothing new is authorized");
    note(5, "Revocation between authorize and redeem", describe(call), `ticket issued, then the owner revoked: REFUSED (${late.status === "REFUSED" ? late.reason : "?"})`, "did not run");
    note(5, "A new action after the revocation", describe(fresh), `DENIED (${next.status === "BLOCKED" && next.result.status === "DENIED" ? next.result.reason : "?"})`, "did not run");
    facts["revocation:redeem"] = late.status === "REFUSED" ? late.reason : "";
  }

  // --- 6. One ticket per action (I32) ------------------------------------------
  {
    const call = order("po-6001", 600);
    const first = await authority.authorize(call);
    const sameAgain = await authority.authorize(call);
    must(first.status === "AUTHORIZED" && sameAgain.status === "AUTHORIZED" && first.ticket.capabilityId === sameAgain.ticket.capabilityId, "asking again returns the same ticket, not a second one");
    if (first.status !== "AUTHORIZED") throw new Error("unreachable");
    const redeemed = await authority.redeem(first.ticket, call);
    must(redeemed.status === "REDEEMED", "po-6001 is redeemed");
    clock.advance(600_000); // the ticket's lifetime is over
    const afterExpiry = await authority.authorize(call);
    must(afterExpiry.status === "AUTHORIZED" && afterExpiry.ticket.capabilityId === first.ticket.capabilityId, "after redemption and expiry the action still has its one ticket");
    const reused = await authority.authorize({ ...call, amount: { value: 1900, currency: "EUR" } });
    must(reused.status === "DENIED" && reused.reason === "ACTION_ID_REUSED_WITH_DIFFERENT_CALL", "an action id cannot be reused for a different call");

    // Someone writes around the SDK: a hand-made second CAPABILITY_ISSUED for the same action.
    const journal = (await authority.events()) as unknown as readonly { readonly event_type: string; readonly payload: { readonly action_id?: string } }[];
    const issued = journal.find((e) => e.event_type === "CAPABILITY_ISSUED" && e.payload.action_id === "po-6001");
    must(issued !== undefined, "the journal holds the ticket of po-6001");
    const { sequence: _a, authority_time: _b, recorded_at: _c, assurance_level: _d, ...draft } = issued as unknown as Record<string, unknown>;
    const forged = { ...draft, event_id: "evt-forged-second-ticket", payload: { ...(draft.payload as object), capability_id: "cap-forged-second-ticket" } };
    const attempt = await authority.record([forged as never]);
    const detail = attempt.status === "RECORDED" ? (attempt.outcomes[0]?.detail ?? "") : "";
    must(attempt.status === "RECORDED" && attempt.outcomes[0]?.accepted === false && detail === "BUSINESS_ID_COLLISION", "a second ticket for the same action is refused at ingestion (I32)");
    const count = ((await authority.events()) as unknown as readonly { readonly event_type: string; readonly payload: { readonly action_id?: string } }[]).filter(
      (e) => e.event_type === "CAPABILITY_ISSUED" && e.payload.action_id === "po-6001",
    ).length;
    must(count === 1, "the journal still holds exactly one ticket for po-6001");
    facts["i32:ticketsForTheAction"] = count;
    facts["i32:forgedSecondTicket"] = detail;
    note(6, "One ticket per action (I32)", describe(call), `asking again: same ticket; after redemption and expiry: same ticket; other arguments under the same id: DENIED (${reused.status === "DENIED" ? reused.reason : "?"}); a hand-written second ticket: refused (${detail})`, "journal holds 1 ticket for the action");
  }

  // --- 7. An unknown outcome is never presented as a success ------------------
  {
    // 7a. Authority itself cannot tell whether the redemption was written.
    const lossy = newAuthority(losingTheAcknowledgement(memoryBackend()));
    await lossy.record([
      events.delegation({
        delegationId: "d-lossy",
        grantor: OWNER,
        grantee: AGENT,
        capabilities: [PURCHASE],
        canDelegate: false,
        expiresAt: null,
        thresholds: { automaticMax: { value: 2000, currency: "EUR" }, approvalMax: { value: 5000, currency: "EUR" } },
      }),
    ]);
    const call: ToolCall = { ...order("po-7001", 400), delegationId: "d-lossy" };
    const before = toolRuns();
    const r = await lossy.guard(call, ({ idempotencyKey }) => placeOrder(call, idempotencyKey));
    must(r.status === "BLOCKED" && r.stage === "redeem" && r.result.status === "UNKNOWN_OUTCOME" && toolRuns() === before, "a redemption with a lost acknowledgement is UNKNOWN_OUTCOME and the tool does not run");
    note(7, "The redemption's outcome is unknown", describe(call), `UNKNOWN_OUTCOME (${r.status === "BLOCKED" && r.result.status === "UNKNOWN_OUTCOME" ? r.result.code : "?"}); a retry would report ALREADY_REDEEMED either way`, "did not run: NOT a success, NOT a confirmed failure");
    facts["unknown:redeem"] = r.status === "BLOCKED" && r.result.status === "UNKNOWN_OUTCOME" ? r.result.status : "";

    // 7b. The ticket was redeemed, the effect started, and the tool call timed out. Did the order happen? Nobody here knows.
    const healthy = newAuthority(memoryBackend());
    await healthy.record([
      events.delegation({
        delegationId: "d-healthy",
        grantor: OWNER,
        grantee: AGENT,
        capabilities: [PURCHASE],
        canDelegate: false,
        expiresAt: null,
        thresholds: { automaticMax: { value: 2000, currency: "EUR" }, approvalMax: { value: 5000, currency: "EUR" } },
      }),
    ]);
    const slow: ToolCall = { ...order("po-7002", 700), delegationId: "d-healthy" };
    const timedOut = await healthy.guard(slow, async () => {
      throw new Error("tool call timed out after 30s (simulated)");
    });
    must(timedOut.status === "EFFECT_FAILED" && timedOut.ticketConsumed === true && toolRuns() === before, "an effect that throws is EFFECT_FAILED, never EXECUTED");
    const journal = (await healthy.events()) as unknown as readonly { readonly event_type: string; readonly payload: { readonly action_id?: string; readonly execution_result?: string } }[];
    const reported = journal.find((e) => e.event_type === "ACTION_EXECUTED" && e.payload.action_id === "po-7002");
    must(reported?.payload.execution_result === "EFFECT_FAILED", "the journal records EFFECT_FAILED, not EXECUTED");
    note(7, "The tool call times out after redemption", describe(slow), `EFFECT_FAILED (ticket consumed, never retried); journal says ${reported?.payload.execution_result}; check the target with the idempotency key`, "outcome UNKNOWN: not a confirmed success");
    facts["unknown:effect"] = timedOut.status;
  }

  facts["orders"] = orders.length;
  facts["singleUseTicket"] = singleUseTicketId;
  return { steps, orders, facts };
}

// ---------------------------------------------------------------------------
// Output (the documentation quotes this text and a test compares it)
// ---------------------------------------------------------------------------

const TITLES: Record<number, string> = {
  1: "1. Authorize or refuse, from the delegation",
  2: "2. An action that needs a human approval",
  3: "3. A ticket works once",
  4: "4. Arguments substituted after authorization",
  5: "5. Revocation",
  6: "6. One ticket per action (I32)",
  7: "7. An unknown outcome is not a success",
};

export function formatDemo(report: DemoReport): string {
  const lines: string[] = [];
  let current = 0;
  for (const step of report.steps) {
    if (step.scenario !== current) {
      current = step.scenario;
      lines.push("", TITLES[current] ?? `${current}.`);
    }
    lines.push(`  - ${step.title}`, `      agent asks : ${step.agentAsks}`, `      Authority  : ${step.authority}`, `      tool       : ${step.tool}`);
  }
  lines.push("", `Orders the sandbox tool actually placed: ${report.orders.length}`);
  for (const o of report.orders) lines.push(`  - ${o.orderId}: ${o.amountEur} EUR to ${o.recipient} (idempotency key ${o.idempotencyKey})`);
  lines.push("", "Every expectation held. This demo does not show exactly-once execution of the external effect, identity verification or an independent audit: see docs/v1/AGENT_DEMO.md.");
  return lines.join("\n").replace(/^\n/, "");
}
