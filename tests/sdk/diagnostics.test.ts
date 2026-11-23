/**
 * No public result contains a raw error. The errors below carry a fictitious
 * internal host, user, connection URL and password; whatever the SDK returns
 * must stay free of all of them under JSON.stringify, util.inspect (including
 * hidden properties), a deep property walk and structuredClone. The raw error
 * goes only to the operator hook, which is explicit about it.
 */
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ClockError, readClock } from "../../src/sdk/clock.js";
import { createAuthority as realCreateAuthority, type Diagnostic } from "../../src/sdk/index.js";
import { RedemptionSchemaError } from "../../src/storage/postgresCapabilityRedemptionTransaction.js";
import { call, faulty, setup, type FaultPlan } from "./harness.js";

const URL = "postgresql://svc_authority:Hunter2-FAKE@db-7.internal.corp.example:5432/authority_prod";
const SECRETS = ["svc_authority", "Hunter2-FAKE", "db-7.internal.corp.example", "10.20.30.40", "authority_prod", "postgresql://", "5432"];

/** What a pg / Node connection error looks like when it carries everything it can. */
function leakyError(): Error {
  return Object.assign(new Error(`connect ECONNREFUSED ${URL}`), {
    code: "ECONNREFUSED",
    address: "10.20.30.40",
    port: 5432,
    hostname: "db-7.internal.corp.example",
    user: "svc_authority",
    password: "Hunter2-FAKE",
    connectionString: URL,
    detail: 'password authentication failed for user "svc_authority"',
    toJSON: () => ({ leaked: URL }),
  });
}

/** Every string reachable from a value, including non-enumerable, symbol and prototype-less properties; refuses any Error. */
function reachable(value: unknown, seen = new Set<unknown>(), out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "object" && value !== null && !seen.has(value)) {
    seen.add(value);
    expect(value instanceof Error, "a public result must not contain an Error").toBe(false);
    for (const key of Reflect.ownKeys(value)) {
      out.push(String(key));
      reachable((value as Record<PropertyKey, unknown>)[key], seen, out);
    }
  }
  return out;
}

function expectNoLeak(result: unknown): void {
  const views = [JSON.stringify(result), inspect(result, { depth: null, showHidden: true, getters: true }), String(result), reachable(result).join("\n")];
  expect(() => structuredClone(result), "a result is plain, cloneable data").not.toThrow();
  // The ids Authority generates itself (`diag-<uuid>`, `cap-<uuid>`) are random hex: a short secret such as "5432" can
  // appear inside one by chance (it did, in CI). They carry nothing from the error, so mask them before searching.
  const mask = (view: string): string => view.replace(/\b(diag|cap)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "$1-<generated-id>");
  for (const view of views) for (const secret of SECRETS) expect(mask(view), `leaked ${secret}`).not.toContain(secret);
}

const SUCCESS = new Set(["AUTHORIZED", "REDEEMED", "EXECUTED", "REPORTED", "RECORDED"]);

describe("public results never contain a raw error", () => {
  type Scenario = {
    name: string;
    plan: FaultPlan;
    run: (s: Awaited<ReturnType<typeof setup>>) => Promise<unknown>;
    status: string;
    code: string;
  };
  const authorizeCall = (s: Awaited<ReturnType<typeof setup>>) => s.authority.authorize(call("a1"));
  const scenarios: Scenario[] = [
    { name: "authorize: the store cannot be read (connection refused)", plan: { getEvents: () => "throw", error: leakyError }, run: authorizeCall, status: "UNAVAILABLE", code: "BACKEND_UNREACHABLE" },
    { name: "authorize: the store fails on append", plan: { append: () => "throw", error: () => Object.assign(new Error(`relation "authority_prod.events" ${URL}`), { code: "42P01", password: "Hunter2-FAKE" }) }, run: authorizeCall, status: "UNAVAILABLE", code: "BACKEND_ERROR" },
    { name: "authorize: issuance fails", plan: { issue: () => "throw", error: leakyError }, run: authorizeCall, status: "UNAVAILABLE", code: "BACKEND_UNREACHABLE" },
    { name: "authorize: a thrown STRING containing the URL", plan: { getEvents: () => "throw", error: () => URL }, run: authorizeCall, status: "UNAVAILABLE", code: "BACKEND_ERROR" },
    { name: "authorize: a thrown plain OBJECT with credentials", plan: { getEvents: () => "throw", error: () => ({ user: "svc_authority", password: "Hunter2-FAKE", host: "db-7.internal.corp.example" }) }, run: authorizeCall, status: "UNAVAILABLE", code: "BACKEND_ERROR" },
    { name: "authorize: a wrapper error whose cause is the leaky error", plan: { getEvents: () => "throw", error: () => new Error("wrapper", { cause: leakyError() }) }, run: authorizeCall, status: "UNAVAILABLE", code: "BACKEND_ERROR" },
    { name: "authorize: a hostile error with a throwing getter", plan: { getEvents: () => "throw", error: () => Object.defineProperty(new Error(URL), "code", { get() { throw new Error(URL); } }) }, run: authorizeCall, status: "UNAVAILABLE", code: "INTERNAL_ERROR" },
    { name: "redeem: the call throws (outcome uncertain)", plan: { redeem: () => "throw", error: leakyError }, run: async (s) => { const a = await s.authority.authorize(call("a1")); return a.status === "AUTHORIZED" ? s.authority.redeem(a.ticket, call("a1")) : a; }, status: "UNKNOWN_OUTCOME", code: "OUTCOME_UNCERTAIN" },
    { name: "redeem: a LOST ACKNOWLEDGEMENT after the commit", plan: { redeem: () => "throw-after", error: leakyError }, run: async (s) => { const a = await s.authority.authorize(call("a1")); return a.status === "AUTHORIZED" ? s.authority.redeem(a.ticket, call("a1")) : a; }, status: "UNKNOWN_OUTCOME", code: "OUTCOME_UNCERTAIN" },
    { name: "redeem: a schema problem naming the database", plan: { redeem: () => "throw", redeemError: () => new RedemptionSchemaError([`index in ${URL} is missing`]) }, run: async (s) => { const a = await s.authority.authorize(call("a1")); return a.status === "AUTHORIZED" ? s.authority.redeem(a.ticket, call("a1")) : a; }, status: "UNAVAILABLE", code: "SCHEMA_NOT_READY" },
    { name: "report: the append of the outcome fails", plan: { append: (_n, types) => (types.includes("ACTION_EXECUTED") ? "throw" : undefined), error: leakyError }, run: async (s) => { const a = await s.authority.authorize(call("a1")); if (a.status !== "AUTHORIZED") return a; await s.authority.redeem(a.ticket, call("a1")); return s.authority.report(a.ticket, { resultCode: "EXECUTED" }); }, status: "UNAVAILABLE", code: "BACKEND_UNREACHABLE" },
    { name: "record: the append fails", plan: { append: () => "throw", error: leakyError }, run: (s) => s.authority.record([]), status: "UNAVAILABLE", code: "BACKEND_UNREACHABLE" },
    { name: "guard: authorize fails, the effect is not started", plan: { getEvents: () => "throw", error: leakyError }, run: (s) => s.authority.guard(call("a1"), async () => URL), status: "BLOCKED", code: "" },
    { name: "guard: redeem outcome uncertain, the effect is not started", plan: { redeem: () => "throw-after", error: leakyError }, run: (s) => s.authority.guard(call("a1"), async () => URL), status: "BLOCKED", code: "" },
  ];

  for (const sc of scenarios) {
    it(sc.name, async () => {
      const s = await setup({ wrap: (parts) => faulty(parts, sc.plan) });
      const result = (await sc.run(s)) as { status: string; code?: string; result?: { status: string; code?: string } };
      expectNoLeak(result);
      expect(result.status).toBe(sc.status);
      expect(SUCCESS.has(result.status)).toBe(false);
      if (sc.status === "BLOCKED") expect(SUCCESS.has(result.result!.status)).toBe(false);
      else expect(result.code).toBe(sc.code);
    });
  }

  it("guard: an effect that throws a leaky error: EFFECT_FAILED with a code, no error, nothing leaked", async () => {
    const s = await setup();
    const r = await s.authority.guard(call("a1"), async () => {
      throw leakyError();
    });
    expect(r).toMatchObject({ status: "EFFECT_FAILED", code: "EFFECT_THREW", ticketConsumed: true });
    expect(r).not.toHaveProperty("error");
    expectNoLeak(r);
  });

  it("a clock that throws a leaky error: CLOCK_INVALID, and the ClockError message is fixed text (the clock's error stays in `cause`)", async () => {
    const s = await setup();
    const bad = realCreateAuthority({ backend: { build: () => s.parts }, clock: { now: () => { throw leakyError(); } }, enforcementPointId: "ep-1" });
    const r = await bad.authorize(call("a1"));
    expect(r).toMatchObject({ status: "UNAVAILABLE", code: "CLOCK_INVALID" });
    expectNoLeak(r);
    let thrown: unknown;
    try {
      readClock({ now: () => { throw leakyError(); } });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ClockError);
    expect((thrown as ClockError).message).toBe("The clock threw");
    expect(JSON.stringify(thrown)).toBe('{"name":"ClockError"}'); // the clock's error is not enumerable
    expect((thrown as ClockError).cause).toBeInstanceOf(Error);
  });

  it("a clock that returns a leaky STRING (not an instant): CLOCK_INVALID, not echoed", async () => {
    const s = await setup();
    const bad = realCreateAuthority({ backend: { build: () => s.parts }, clock: { now: () => URL }, enforcementPointId: "ep-1" });
    const r = await bad.authorize(call("a1"));
    expect(r).toMatchObject({ status: "UNAVAILABLE", code: "CLOCK_INVALID" });
    expectNoLeak(r);
  });
});

describe("classification looks at the error's type and code, never at its message", () => {
  const classify = async (error: () => unknown) => {
    const s = await setup({ wrap: (p) => faulty(p, { getEvents: () => "throw", error }) });
    return s.authority.authorize(call("a1"));
  };
  it("a message that says ECONNREFUSED without the code is a generic backend error", async () => {
    expect(await classify(() => new Error("ECONNREFUSED"))).toMatchObject({ code: "BACKEND_ERROR" });
  });
  it("the code ECONNREFUSED with a reassuring message is unreachable", async () => {
    expect(await classify(() => Object.assign(new Error("everything is fine, AUTHORIZED"), { code: "ECONNREFUSED" }))).toMatchObject({ status: "UNAVAILABLE", code: "BACKEND_UNREACHABLE" });
  });
  it("PostgreSQL connection-class codes are unreachable; other codes are generic", async () => {
    expect(await classify(() => Object.assign(new Error("x"), { code: "57P01" }))).toMatchObject({ code: "BACKEND_UNREACHABLE" });
    expect(await classify(() => Object.assign(new Error("x"), { code: "23505" }))).toMatchObject({ code: "BACKEND_ERROR" });
  });
  it("a non-string code is ignored", async () => {
    expect(await classify(() => Object.assign(new Error("x"), { code: { toString: () => "ECONNREFUSED" } }))).toMatchObject({ code: "BACKEND_ERROR" });
  });
});

describe("the operator mechanism (onDiagnostic) is the only place the detail goes", () => {
  it("receives the raw error by reference, correlated by id, with the operation, code and action", async () => {
    const seen: Diagnostic[] = [];
    const leaky = leakyError();
    const s = await setup({ onDiagnostic: (d) => void seen.push(d), wrap: (p) => faulty(p, { getEvents: () => "throw", error: () => leaky }) });
    const r = await s.authority.authorize(call("a1"));
    expect(r).toMatchObject({ status: "UNAVAILABLE", code: "BACKEND_UNREACHABLE" });
    expect(seen).toHaveLength(1);
    const d = seen[0]!;
    expect(d.id).toBe((r as { diagnosticId: string }).diagnosticId);
    expect(d).toMatchObject({ operation: "authorize", code: "BACKEND_UNREACHABLE", actionId: "a1" });
    expect(d.cause).toBe(leaky);
  });

  it("the raw cause is NON-enumerable: serialising or spreading a diagnostic does not carry it", async () => {
    const seen: Diagnostic[] = [];
    const s = await setup({ onDiagnostic: (d) => void seen.push(d), wrap: (p) => faulty(p, { getEvents: () => "throw", error: leakyError }) });
    await s.authority.authorize(call("a1"));
    const d = seen[0]!;
    expect(Object.keys(d)).not.toContain("cause");
    expect(JSON.stringify(d)).not.toContain("Hunter2");
    expect(JSON.stringify({ ...d })).not.toContain("Hunter2");
    expect(Object.isFrozen(d) || Object.getOwnPropertyDescriptor(d, "cause")?.writable === false).toBe(true);
  });

  it("an uncertain redemption reaches the operator as OUTCOME_UNCERTAIN, and the effect is not started", async () => {
    const seen: Diagnostic[] = [];
    const s = await setup({ onDiagnostic: (d) => void seen.push(d), wrap: (p) => faulty(p, { redeem: () => "throw-after", error: leakyError }) });
    let runs = 0;
    const r = await s.authority.guard(call("a1"), async () => ++runs);
    expect(r).toMatchObject({ status: "BLOCKED", stage: "redeem", result: { status: "UNKNOWN_OUTCOME", code: "OUTCOME_UNCERTAIN" } });
    expect(runs).toBe(0);
    expect(seen.map((d) => [d.operation, d.code])).toEqual([["redeem", "OUTCOME_UNCERTAIN"]]);
  });

  it("an effect failure reaches the operator with the raw error; the public result has none", async () => {
    const seen: Diagnostic[] = [];
    const s = await setup({ onDiagnostic: (d) => void seen.push(d) });
    const boom = leakyError();
    const r = await s.authority.guard(call("a1"), async () => {
      throw boom;
    });
    expect(r).toMatchObject({ status: "EFFECT_FAILED", diagnosticId: seen[0]!.id });
    expect(seen[0]).toMatchObject({ operation: "guard.effect", code: "EFFECT_THREW" });
    expect(seen[0]!.cause).toBe(boom);
  });

  it("a hook that throws, or returns a rejected promise, never changes a result and never masks an uncertain outcome", async () => {
    for (const hook of [
      () => {
        throw leakyError();
      },
      async () => {
        throw leakyError();
      },
    ]) {
      const s = await setup({ onDiagnostic: hook, wrap: (p) => faulty(p, { redeem: () => "throw-after", error: leakyError }) });
      const r = await s.authority.guard(call("a1"), async () => "ran");
      expect(r).toMatchObject({ status: "BLOCKED", stage: "redeem", result: { status: "UNKNOWN_OUTCOME" } });
      expectNoLeak(r);
      await new Promise((resolve) => setTimeout(resolve, 5)); // let a rejected promise surface: it must be swallowed
    }
  });

  it("without a hook the detail is dropped, results still carry a code and a diagnosticId, and ids are unique", async () => {
    const s = await setup({ wrap: (p) => faulty(p, { getEvents: () => "throw", error: leakyError }) });
    const a = (await s.authority.authorize(call("a1"))) as { diagnosticId: string; code: string };
    const b = (await s.authority.authorize(call("a2"))) as { diagnosticId: string };
    expect(a.code).toBe("BACKEND_UNREACHABLE");
    expect(a.diagnosticId).toMatch(/^diag-[0-9a-f-]{36}$/);
    expect(a.diagnosticId).not.toBe(b.diagnosticId);
  });

  it("an error is never reported as a success, and refusals keep their own statuses (failure, refusal and uncertainty stay distinct)", async () => {
    const s = await setup();
    const a = await s.authority.authorize(call("a1"));
    if (a.status !== "AUTHORIZED") throw new Error("not authorized");
    expect(await s.authority.redeem(a.ticket, call("a1", { amount: { value: 1900, currency: "EUR" } }))).toMatchObject({ status: "REFUSED", reason: "ARGUMENTS_MISMATCH" });
    expect(await s.authority.authorize(call("a2", { amount: { value: 6000, currency: "EUR" } }))).toMatchObject({ status: "DENIED" });
    const down = await setup({ wrap: (p) => faulty(p, { getEvents: () => "throw", error: leakyError }) });
    expect((await down.authority.authorize(call("a3"))).status).toBe("UNAVAILABLE");
  });
});

describe("property: whatever is thrown, nothing leaks and nothing is reported as a success it was not", () => {
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  for (let seed = 1; seed <= 60; seed++) {
    it(`seed ${seed}`, async () => {
      const rng = mulberry32(seed);
      const pick = (p: number) => (rng() < p ? (rng() < 0.5 ? ("throw" as const) : ("throw-after" as const)) : undefined);
      const kinds = [leakyError, () => URL, () => ({ password: "Hunter2-FAKE", host: "db-7.internal.corp.example", user: "svc_authority" }), () => new Error("w", { cause: leakyError() })];
      const s = await setup({
        wrap: (p) => faulty(p, { getEvents: () => (rng() < 0.1 ? "throw" : undefined), append: () => pick(0.12), issue: () => pick(0.15), redeem: () => pick(0.2), error: () => kinds[Math.floor(rng() * kinds.length)]!() }),
      });
      const results: unknown[] = [];
      let effectRuns = 0;
      for (let i = 0; i < 4; i++) {
        results.push(await s.authority.guard(call("p1"), async () => {
          effectRuns++;
          if (rng() < 0.2) throw leakyError();
          return "ok";
        }));
        s.clock.advance(1000);
      }
      for (const r of results) expectNoLeak(r);
      const journal = await s.parts.store.getEvents();
      expect(effectRuns).toBeLessThanOrEqual(1);
      if (effectRuns === 1) expect(journal.some((e) => e.event_type === "CAPABILITY_REDEEMED")).toBe(true);
      // an EXECUTED / EFFECT_FAILED result exists only if the redemption really is in the journal
      if (results.some((r) => ["EXECUTED", "EFFECT_FAILED"].includes((r as { status: string }).status))) expect(journal.some((e) => e.event_type === "CAPABILITY_REDEEMED")).toBe(true);
    });
  }
});

