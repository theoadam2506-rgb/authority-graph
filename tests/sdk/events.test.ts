/**
 * Typed event builders: they must produce exactly what the engine accepts,
 * refuse malformed or ambiguous input before it reaches the engine, and never
 * weaken a rule the engine enforces at ingestion.
 */
import { describe, expect, it } from "vitest";
import { AuthorityInputError, ClockError, createAuthority, createEventBuilders, memoryBackend, type DelegationInput } from "../../src/sdk/index.js";
import * as sdk from "../../src/sdk/index.js";
import { testClock } from "./harness.js";

const NOW = "2026-01-01T09:00:00.000Z";
const FAR = "2026-12-31T00:00:00.000Z";

const setup = () => {
  const clock = testClock(NOW);
  let n = 0;
  const events = createEventBuilders({ clock, newEventId: () => `evt-${++n}` });
  const authority = createAuthority({ backend: memoryBackend(), clock, enforcementPointId: "gateway" });
  return { clock, events, authority };
};

const good: DelegationInput = {
  delegationId: "d1",
  grantor: "owner",
  grantee: "agent",
  capabilities: [{ resource: "purchase_order", action: "create" }],
  canDelegate: false,
  expiresAt: FAR,
  thresholds: { automaticMax: { value: 2500, currency: "EUR" }, approvalMax: { value: 5000, currency: "EUR" } },
};
const order = (actionId: string, value: number) => ({
  actionId,
  agentId: "agent",
  delegationId: "d1",
  capability: { resource: "purchase_order", action: "create" },
  amount: { value, currency: "EUR" },
  args: { sku: "A-100" },
});

describe("event builders: what they produce", () => {
  it("a built delegation is accepted by the engine and lets a guarded call run once", async () => {
    const { events, authority } = setup();
    const recorded = await authority.record([events.delegation(good)]);
    expect(recorded.status).toBe("RECORDED");
    expect(recorded.status === "RECORDED" && recorded.outcomes.every((o) => o.accepted)).toBe(true);
    let effects = 0;
    const result = await authority.guard(order("po-1", 1800), async () => ++effects);
    expect(result.status).toBe("EXECUTED");
    const replay = await authority.guard(order("po-1", 1800), async () => ++effects);
    expect(replay.status).toBe("BLOCKED");
    expect(effects).toBe(1);
  });

  it("the envelope comes from the injected clock and the author is the acting principal", () => {
    const { events } = setup();
    const e = events.delegation(good);
    expect(e.occurred_at).toBe(NOW);
    expect(e.principal_id).toBe("owner");
    expect(e.event_type).toBe("DELEGATION_CREATED");
    expect(e.payload).toMatchObject({ grantor_type: "HUMAN_ROOT", parent_delegation_id: null, can_delegate: false });
  });

  it("a sub-delegation, a revocation, an approval request, a grant and a denial have the engine's payload shapes", () => {
    const { events } = setup();
    expect(events.subdelegation({ delegationId: "d2", parentDelegationId: "d1", grantor: "agent", grantee: "agent-2", capabilities: [{ resource: "r", action: "a" }], canDelegate: false, expiresAt: null }).payload).toMatchObject({ parent_delegation_id: "d1", grantee_principal_id: "agent-2" });
    expect(events.revocation({ delegationId: "d1", revokedBy: "owner", reasonCode: "OWNER_REQUEST" }).payload).toEqual({ delegation_id: "d1", revoked_by_principal_id: "owner", reason_code: "OWNER_REQUEST" });
    expect(events.approvalRequest({ approvalId: "ap-1", actionId: "po-1", requestedBy: "agent", requestedFrom: "owner", reasonCode: "OVER_AUTOMATIC_LIMIT" }).principal_id).toBe("agent");
    expect(events.approvalGranted({ approvalId: "ap-1", actionId: "po-1", approver: "owner" }).payload).toEqual({ approval_id: "ap-1", action_id: "po-1", approving_principal_id: "owner" });
    expect(events.approvalDenied({ approvalId: "ap-1", actionId: "po-1", denier: "owner", reasonCode: "NOT_WANTED" }).event_type).toBe("APPROVAL_DENIED");
  });

  it("no builder exists for events that Authority writes itself", () => {
    const { events } = setup();
    expect(Object.keys(events).sort()).toEqual(["approvalDenied", "approvalGranted", "approvalRequest", "delegation", "revocation", "subdelegation"]);
  });
});

describe("event builders: the full approval and revocation journey through the engine", () => {
  it("an over-limit call needs the human's approval for that exact action, then runs once", async () => {
    const { events, authority } = setup();
    await authority.record([events.delegation(good)]);
    const first = await authority.authorize(order("po-big", 3000));
    expect(first.status).toBe("REQUIRES_APPROVAL");
    const approved = await authority.record([
      events.approvalRequest({ approvalId: "ap-1", actionId: "po-big", requestedBy: "agent", requestedFrom: "owner", reasonCode: "OVER_AUTOMATIC_LIMIT" }),
      events.approvalGranted({ approvalId: "ap-1", actionId: "po-big", approver: "owner" }),
    ]);
    expect(approved.status === "RECORDED" && approved.outcomes.map((o) => o.accepted)).toEqual([true, true]);
    const second = await authority.authorize(order("po-big", 3000));
    expect(second.status).toBe("AUTHORIZED");
    // The approval covers that action only: another action of the same size still needs its own.
    expect((await authority.authorize(order("po-other", 3000))).status).toBe("REQUIRES_APPROVAL");
  });

  it("the engine, not the builder, refuses an approval from someone who is not the grantor", async () => {
    const { events, authority } = setup();
    await authority.record([events.delegation(good)]);
    await authority.authorize(order("po-big", 3000));
    const recorded = await authority.record([
      events.approvalRequest({ approvalId: "ap-1", actionId: "po-big", requestedBy: "agent", requestedFrom: "agent", reasonCode: "OVER_AUTOMATIC_LIMIT" }),
      events.approvalGranted({ approvalId: "ap-1", actionId: "po-big", approver: "agent" }),
    ]);
    expect(recorded.status === "RECORDED" && recorded.outcomes[1]?.accepted).toBe(false);
    expect((await authority.authorize(order("po-big", 3000))).status).not.toBe("AUTHORIZED");
  });

  it("a revocation built by the grantor stops the next authorization; one built by a stranger is refused by the engine", async () => {
    const { events, authority } = setup();
    await authority.record([events.delegation(good)]);
    const stranger = await authority.record([events.revocation({ delegationId: "d1", revokedBy: "agent", reasonCode: "MALICE" })]);
    expect(stranger.status === "RECORDED" && stranger.outcomes[0]?.accepted).toBe(false);
    expect((await authority.authorize(order("po-1", 100))).status).toBe("AUTHORIZED");
    const revoked = await authority.record([events.revocation({ delegationId: "d1", revokedBy: "owner", reasonCode: "OWNER_REQUEST" })]);
    expect(revoked.status === "RECORDED" && revoked.outcomes[0]?.accepted).toBe(true);
    expect((await authority.authorize(order("po-2", 100))).status).toBe("DENIED");
  });

  it("the same event id twice is not accepted twice", async () => {
    const { events, authority } = setup();
    const draft = events.delegation({ ...good, eventId: "evt-fixed" });
    await authority.record([draft]);
    const again = await authority.record([events.delegation({ ...good, delegationId: "d-other", eventId: "evt-fixed" })]);
    expect(again.status === "RECORDED" && again.outcomes[0]?.accepted).toBe(false);
  });
});

describe("event builders: adversarial input is refused before it reaches the engine", () => {
  const { events } = setup();
  const refuse = (input: unknown, pattern?: RegExp) => {
    expect(() => events.delegation(input as DelegationInput)).toThrow(AuthorityInputError);
    if (pattern) expect(() => events.delegation(input as DelegationInput)).toThrow(pattern);
  };

  it("unknown keys, including __proto__ and constructor tricks", () => {
    refuse({ ...good, extra: 1 }, /unknown key/);
    refuse(JSON.parse('{"delegationId":"d","grantor":"a","grantee":"b","capabilities":[{"resource":"r","action":"a"}],"canDelegate":false,"expiresAt":null,"__proto__":{"canDelegate":true}}'), /unknown key/);
    refuse({ ...good, constructor: { prototype: {} } }, /unknown key/);
    refuse({ ...good, grant_type: "HUMAN_ROOT" }, /unknown key/);
  });

  it("not a plain object: arrays, null, primitives, class instances, symbol keys, getters", () => {
    for (const bad of [null, undefined, 3, "x", [], [good], new Map(), new (class Foo {})()]) refuse(bad, /plain object/);
    refuse({ ...good, [Symbol("x")]: 1 }, /symbol/);
    refuse(Object.defineProperty({ ...good }, "grantee", { get: () => "agent", enumerable: true }), /plain data property/);
    refuse(Object.defineProperty({ ...good }, "grantee", { value: "agent", enumerable: false }), /plain data property/);
  });

  it("missing or implicit values: nothing is defaulted", () => {
    const { canDelegate: _c, ...noCanDelegate } = good;
    const { expiresAt: _e, ...noExpiry } = good;
    refuse(noCanDelegate, /canDelegate/);
    refuse(noExpiry, /expiresAt/);
    refuse({ ...good, canDelegate: "yes" }, /true or false/);
    refuse({ ...good, canDelegate: 1 }, /true or false/);
    refuse({ ...good, expiresAt: undefined }, /expiresAt/);
    refuse({ ...good, expiresAt: "" }, /canonical UTC instant/);
  });

  it("identifiers: empty, too long, control characters, padded, lone surrogates, non-strings", () => {
    for (const field of ["delegationId", "grantor", "grantee"] as const) {
      for (const bad of ["", " ", " a", "a ", "a\nb", "a\u0000b", "a‮b".replace("‮", "\u0085"), "a".repeat(257), "\ud800", 5, null, {}, ["a"]]) refuse({ ...good, [field]: bad });
    }
    refuse({ ...good, grantee: "owner" }, /differ/);
    expect(events.delegation({ ...good, delegationId: "a".repeat(256) }).event_type).toBe("DELEGATION_CREATED");
  });

  it("money: floats, negatives, NaN, Infinity, unsafe integers, strings, bad currency, extra keys", () => {
    for (const value of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "100", null, 1e21]) {
      refuse({ ...good, maxAmount: { value, currency: "EUR" } }, /non-negative safe integer/);
    }
    refuse({ ...good, maxAmount: { value: 1, currency: "" } }, /currency/);
    refuse({ ...good, maxAmount: { value: 1, currency: "EUR", extra: true } }, /unknown key/);
    refuse({ ...good, maxAmount: 100 }, /plain object/);
  });

  it("currencies are never mixed or converted (I25), and the approval band must be ordered", () => {
    refuse({ ...good, maxAmount: { value: 9000, currency: "USD" } }, /same currency/);
    refuse({ ...good, thresholds: { automaticMax: { value: 10, currency: "EUR" }, approvalMax: { value: 20, currency: "USD" } } }, /same currency/);
    refuse({ ...good, thresholds: { automaticMax: { value: 600, currency: "EUR" }, approvalMax: { value: 500, currency: "EUR" } } }, /must not exceed/);
    refuse({ ...good, thresholds: { automaticMax: { value: 1, currency: "EUR" } } }, /approvalMax/);
  });

  it("capabilities are exact: empty, wildcard, duplicate, malformed, oversized", () => {
    refuse({ ...good, capabilities: [] }, /non-empty array/);
    refuse({ ...good, capabilities: "purchase_order:create" }, /non-empty array/);
    refuse({ ...good, capabilities: [{ resource: "*", action: "create" }] }, /not a wildcard/);
    refuse({ ...good, capabilities: [{ resource: "purchase_order", action: "*" }] }, /not a wildcard/);
    refuse({ ...good, capabilities: [{ resource: "a", action: "b" }, { resource: "a", action: "b" }] }, /duplicate/);
    refuse({ ...good, capabilities: [{ resource: "a" }] }, /action/);
    refuse({ ...good, capabilities: Array.from({ length: 65 }, (_, i) => ({ resource: `r${i}`, action: "a" })) }, /at most 64/);
  });

  it("instants must be canonical: other formats, offsets, impossible dates", () => {
    for (const bad of ["2026-12-31", "2026-12-31T00:00:00Z", "2026-12-31T00:00:00+01:00", "2026-02-30T00:00:00.000Z", "tomorrow", 1767225600000, true]) refuse({ ...good, expiresAt: bad });
  });

  it("reason codes are short codes, never free text", () => {
    for (const bad of ["owner request", "lowercase", "", "A".repeat(65), "ÉTÉ", "X\nY"]) {
      expect(() => events.revocation({ delegationId: "d1", revokedBy: "owner", reasonCode: bad })).toThrow(/\^\[A-Z0-9_\]/);
    }
  });

  it("a sub-delegation cannot be its own parent; a grant needs every field", () => {
    expect(() => events.subdelegation({ delegationId: "d1", parentDelegationId: "d1", grantor: "a", grantee: "b", capabilities: [{ resource: "r", action: "a" }], canDelegate: false, expiresAt: null })).toThrow(/own parent/);
    expect(() => events.approvalGranted({ approvalId: "ap", actionId: "act" } as never)).toThrow(/approver/);
    expect(() => events.approvalGranted({ approvalId: "ap", actionId: "act", approver: "o", status: "GRANTED" } as never)).toThrow(/unknown key/);
  });

  it("the input is not mutated, and the output does not alias it", () => {
    const input = JSON.parse(JSON.stringify(good)) as DelegationInput;
    const before = JSON.stringify(input);
    const built = events.delegation(input);
    expect(JSON.stringify(input)).toBe(before);
    (input.capabilities as unknown as { resource: string }[])[0]!.resource = "changed";
    expect((built.payload as unknown as { capabilities: { resource: string }[] }).capabilities[0]!.resource).toBe("purchase_order");
  });

  it("a throwing or non-canonical clock stops the build (fail closed), with no raw detail in the message", () => {
    const secret = "postgres://user:hunter2@internal-host/db";
    const throwing = createEventBuilders({ clock: { now: () => { throw new Error(secret); } } });
    expect(() => throwing.delegation(good)).toThrow(ClockError);
    try { throwing.delegation(good); } catch (e) { expect((e as Error).message).not.toContain("hunter2"); }
    for (const bad of ["2026-01-01", "now", 5, "2026-01-01T00:00:00Z"]) {
      expect(() => createEventBuilders({ clock: { now: () => bad as never } }).delegation(good)).toThrow(ClockError);
    }
  });

  it("there is no default clock: the factory refuses to start without one", () => {
    expect(() => createEventBuilders({} as never)).toThrow(AuthorityInputError);
    expect(() => createEventBuilders({ clock: {} } as never)).toThrow(AuthorityInputError);
    expect(() => createEventBuilders(undefined as never)).toThrow(AuthorityInputError);
  });

  it("a generated or supplied event id must itself be valid", () => {
    const bad = createEventBuilders({ clock: testClock(NOW), newEventId: () => "" });
    expect(() => bad.delegation(good)).toThrow(AuthorityInputError);
    expect(() => events.delegation({ ...good, eventId: 12 as never })).toThrow(AuthorityInputError);
  });

  it("the default event ids are unique", () => {
    const e = createEventBuilders({ clock: testClock(NOW) });
    expect(new Set(Array.from({ length: 50 }, () => e.revocation({ delegationId: "d", revokedBy: "o", reasonCode: "X" }).event_id)).size).toBe(50);
  });
});

describe("export surface", () => {
  it("adds only createEventBuilders to the runtime exports, and still not authorityAt", () => {
    expect(Object.keys(sdk).sort()).toEqual(["AuthorityConfigError", "AuthorityInputError", "ClockError", "createAuthority", "createEventBuilders", "memoryBackend", "postgresBackend", "systemClock"]);
    expect("authorityAt" in sdk).toBe(false);
  });
});
