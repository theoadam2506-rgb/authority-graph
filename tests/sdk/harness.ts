/**
 * Scaffold for the SDK tests: a controllable clock, one delegation
 * (THEO -> AGENT_A, automatic up to 2500 EUR, approval up to 5000 EUR) and a
 * fault-injecting backend wrapper. Nothing reads the real clock.
 */
import { toDraft } from "../../src/domain/events.js";
import { thresholds } from "../../src/domain/types.js";
import type { Money } from "../../src/domain/types.js";
import { createAuthority, memoryBackend, type Authority, type Backend, type ToolCall } from "../../src/sdk/index.js";
import type { BackendParts } from "../../src/sdk/backend.js";
import { AGENT_A, EUR, PURCHASE_ORDER_CREATE, THEO, actionRequest, approvalGrant, approvalRequest, revokeDelegation, rootDelegation } from "../fixtures/scenarios.js";

export const AGENT = AGENT_A as string;
export const OWNER = THEO;

export interface TestClock {
  now(): string;
  advance(ms: number): void;
  set(value: string): void;
}

export function testClock(start = "2026-01-01T09:00:00.000Z"): TestClock {
  let t = Date.parse(start);
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms) => {
      t += ms;
    },
    set: (value) => {
      t = Date.parse(value);
    },
  };
}

export const call = (actionId: string, overrides: Partial<ToolCall> = {}): ToolCall => ({
  actionId,
  agentId: AGENT,
  delegationId: "d1",
  capability: { resource: "purchase_order", action: "create" },
  amount: { value: 1800, currency: "EUR" },
  args: { sku: "A-100", qty: 3 },
  ...overrides,
});

export type Fault = "throw" | "throw-after";
export interface FaultPlan {
  getEvents?: (n: number) => Fault | undefined;
  append?: (n: number, draftTypes: readonly string[]) => Fault | undefined;
  issue?: (n: number) => Fault | undefined;
  redeem?: (n: number) => Fault | undefined;
  /** Error to throw for redeem (default: a plain Error). */
  redeemError?: () => Error;
}

/** Wraps real parts so that chosen calls throw before ("throw") or after ("throw-after", a lost acknowledgement) the real call. */
export function faulty(parts: BackendParts, plan: FaultPlan): BackendParts {
  const counters = { getEvents: 0, append: 0, issue: 0, redeem: 0 };
  const boom = (label: string, error?: () => Error) => (error ? error() : new Error(`injected ${label} failure`));
  return {
    store: {
      getEvents: async (filter) => {
        const fault = plan.getEvents?.(counters.getEvents++);
        if (fault !== undefined) throw boom("getEvents");
        return parts.store.getEvents(filter);
      },
      getBySequence: (range) => parts.store.getBySequence(range),
      append: async (drafts) => {
        const fault = plan.append?.(counters.append++, drafts.map((d) => d.event_type));
        if (fault === "throw") throw boom("append");
        const result = await parts.store.append(drafts);
        if (fault === "throw-after") throw boom("append");
        return result;
      },
    },
    issuance: {
      issue: async (...args) => {
        const fault = plan.issue?.(counters.issue++);
        if (fault === "throw") throw boom("issue");
        const result = await parts.issuance.issue(...args);
        if (fault === "throw-after") throw boom("issue");
        return result;
      },
    },
    redemption: {
      redeem: async (...args) => {
        const fault = plan.redeem?.(counters.redeem++);
        if (fault === "throw") throw boom("redeem", plan.redeemError);
        const result = await parts.redemption.redeem(...args);
        if (fault === "throw-after") throw boom("redeem", plan.redeemError);
        return result;
      },
    },
  };
}

export interface Setup {
  readonly clock: TestClock;
  readonly authority: Authority;
  /** The real (unwrapped) parts, to build a second authority over the same journal. */
  readonly parts: BackendParts;
  /** Another authority (own enforcement point) over the same journal. */
  another(enforcementPointId: string, wrap?: (p: BackendParts) => BackendParts): Authority;
  seq(): number;
  approve(actionId: string, approvalId?: string): Promise<void>;
  revoke(delegationId?: string): Promise<void>;
}

export interface SetupOptions {
  readonly totalBudget?: Money;
  readonly ttlMs?: number;
  readonly wrap?: (parts: BackendParts) => BackendParts;
  readonly enforcementPointId?: string;
}

export async function setup(options: SetupOptions = {}): Promise<Setup> {
  const clock = testClock();
  let real: BackendParts | undefined;
  const capturing: Backend = {
    build(ingestionClock) {
      real = memoryBackend().build(ingestionClock);
      return options.wrap ? options.wrap(real) : real;
    },
  };
  const authority = createAuthority({
    backend: capturing,
    clock,
    enforcementPointId: options.enforcementPointId ?? "ep-1",
    ...(options.ttlMs !== undefined ? { capabilityTtlMs: options.ttlMs } : {}),
  });
  if (real === undefined) throw new Error("backend not built");
  const parts = real;
  let counter = 1000;
  const seq = () => ++counter;
  const delegation = toDraft(
    rootDelegation({
      sequence: seq(),
      id: "d1",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(EUR(2500), EUR(5000)),
      ...(options.totalBudget !== undefined ? { totalBudget: options.totalBudget } : {}),
    }),
  );
  // Seed through the real (unwrapped) store so injected faults only affect what the tests exercise.
  const seeded = await parts.store.append([delegation]);
  if (!seeded.outcomes.every((o) => o.accepted)) throw new Error(`seed rejected: ${JSON.stringify(seeded)}`);

  return {
    clock,
    authority,
    parts,
    another: (enforcementPointId, wrap) =>
      createAuthority({ backend: { build: () => (wrap ? wrap(parts) : parts) }, clock, enforcementPointId }),
    seq,
    async approve(actionId, approvalId = `ap-${actionId}`) {
      const r = await authority.record([
        toDraft(approvalRequest({ sequence: seq(), id: approvalId, actionId, requestedFrom: THEO, requester: AGENT_A })),
        toDraft(approvalGrant({ sequence: seq(), id: approvalId, actionId, approver: THEO })),
      ]);
      if (r.status !== "RECORDED" || !r.outcomes.every((o) => o.accepted)) throw new Error(`approval rejected: ${JSON.stringify(r)}`);
    },
    async revoke(delegationId = "d1") {
      const r = await authority.record([toDraft(revokeDelegation({ sequence: seq(), targetId: delegationId, issuedBy: THEO }))]);
      if (r.status !== "RECORDED" || !r.outcomes.every((o) => o.accepted)) throw new Error(`revocation rejected: ${JSON.stringify(r)}`);
    },
  };
}

export const eventsOf = async (a: Authority, type: string) => (await a.events()).filter((e) => e.event_type === type);

export { actionRequest };
