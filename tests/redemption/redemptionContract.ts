/**
 * Backend-agnostic CONTRACT for capability redemption (V1). It is run today
 * against the in-memory transaction (redemptionContract.memory.test.ts). The
 * future PostgreSQL pull request plugs its own `ContractEnv` factory into the
 * SAME suite: nothing here may assume memory. What the factory must provide:
 *
 *  - `spawn()`   a second, independent redeemer over the SAME persisted state
 *                (for PostgreSQL: another pool + store + transaction; think
 *                "another process"). It must not share the mutex of `main`.
 *  - `restart()` drop every in-process object (stores, caches, counters) and
 *                reopen over the persisted events (for PostgreSQL: new pools).
 *  - `rawAppend` write a draft straight into the store, bypassing the
 *                transaction (the A31/A37 surface).
 *  - `collidingAttemptIds` every attempt id the environment generates is the
 *                same value: the suite must still hold, because correctness
 *                may never rest on attempt-id uniqueness.
 */
import { describe, expect, it } from "vitest";
import type { RedeemCapabilityCommand } from "../../src/domain/capabilityCommand.js";
import type { CanonicalStore, DraftAuthorityEvent } from "../../src/domain/events.js";
import { validateRedemptionEvent, type RedeemCapabilityResult } from "../../src/engine/redeemCapability.js";
import type { AuthenticatedPrincipal } from "../../src/domain/authenticatedPrincipal.js";
import type { CapabilityId, Iso8601, IngestOutcome } from "../../src/domain/types.js";
import { AGENT, T, auth } from "./harness.js";

export interface RedeemerHandle {
  redeem(who: AuthenticatedPrincipal, command: RedeemCapabilityCommand, at: Iso8601): Promise<RedeemCapabilityResult>;
}

export interface ContractEnv extends RedeemerHandle {
  events(): Promise<CanonicalStore>;
  issue(at: Iso8601): Promise<CapabilityId>;
  command(id: CapabilityId): RedeemCapabilityCommand;
  spawn(): Promise<RedeemerHandle>;
  restart(): Promise<void>;
  rawAppend(draft: DraftAuthorityEvent, at: Iso8601): Promise<IngestOutcome>;
  /** A CAPABILITY_REDEEMED draft for `id` with the given event_id, built exactly like the transaction would. */
  redeemedDraft(id: CapabilityId, eventId: string, overrides?: { readonly decisionSequence?: number }): Promise<DraftAuthorityEvent>;
  close(): Promise<void>;
}

export type ContractEnvFactory = (options: { readonly collidingAttemptIds: boolean }) => Promise<ContractEnv>;

const redeemedEvents = (events: CanonicalStore) => events.filter((e) => e.event_type === "CAPABILITY_REDEEMED");
const successes = (rs: readonly RedeemCapabilityResult[]) => rs.filter((r) => r.ok).length;

export function describeRedemptionContract(backend: string, make: ContractEnvFactory): void {
  describe(`redemption contract [${backend}]`, () => {
    async function withEnv<T>(collidingAttemptIds: boolean, fn: (env: ContractEnv) => Promise<T>): Promise<T> {
      const env = await make({ collidingAttemptIds });
      try {
        return await fn(env);
      } finally {
        await env.close();
      }
    }

    it("C1: with colliding attempt ids and 6 independent redeemers x 10 callers, exactly one caller gets ok:true", () =>
      withEnv(true, async (env) => {
        const id = await env.issue(T("09:10:00"));
        const redeemers: RedeemerHandle[] = [env, ...(await Promise.all(Array.from({ length: 5 }, () => env.spawn())))];
        const results = await Promise.all(redeemers.flatMap((r) => Array.from({ length: 10 }, () => r.redeem(auth(AGENT), env.command(id), T("09:12:00")))));
        expect(successes(results)).toBe(1);
        expect(redeemedEvents(await env.events())).toHaveLength(1);
        for (const r of results) if (!r.ok) expect(["ALREADY_REDEEMED", "REDEMPTION_COLLISION", "CONCURRENT_WRITE_DETECTED"]).toContain(r.reason);
      }));

    it("C2: after a restart (counters and caches gone) a redeemed ticket stays redeemed and nothing is written", () =>
      withEnv(false, async (env) => {
        const id = await env.issue(T("09:10:00"));
        expect((await env.redeem(auth(AGENT), env.command(id), T("09:12:00"))).ok).toBe(true);
        const before = (await env.events()).length;
        await env.restart();
        expect(await env.redeem(auth(AGENT), env.command(id), T("09:13:00"))).toEqual({ ok: false, reason: "ALREADY_REDEEMED" });
        expect((await env.events()).length).toBe(before);
      }));

    it("C3: a restart between issuance and redemption loses nothing: the ticket is redeemable exactly once", () =>
      withEnv(false, async (env) => {
        const id = await env.issue(T("09:10:00"));
        await env.restart();
        const results = await Promise.all([env.redeem(auth(AGENT), env.command(id), T("09:12:00")), env.redeem(auth(AGENT), env.command(id), T("09:12:00"))]);
        expect(successes(results)).toBe(1);
        expect(redeemedEvents(await env.events())).toHaveLength(1);
      }));

    it("C4: attempt ids restart after a restart yet distinct capabilities redeem independently, each exactly once", () =>
      withEnv(true, async (env) => {
        const first = await env.issue(T("09:10:00"));
        expect((await env.redeem(auth(AGENT), env.command(first), T("09:11:00"))).ok).toBe(true);
        await env.restart();
        const second = await env.issue(T("09:12:00")); // a second capability for the same action (new idempotency key)
        expect((await env.redeem(auth(AGENT), env.command(second), T("09:13:00"))).ok).toBe(true);
        expect(redeemedEvents(await env.events())).toHaveLength(2);
        expect(await env.redeem(auth(AGENT), env.command(first), T("09:14:00"))).toEqual({ ok: false, reason: "ALREADY_REDEEMED" });
      }));

    it("C5: a second CAPABILITY_REDEEMED for the same capability_id, with another event_id, is refused at the store", () =>
      withEnv(false, async (env) => {
        const id = await env.issue(T("09:10:00"));
        expect((await env.redeem(auth(AGENT), env.command(id), T("09:12:00"))).ok).toBe(true);
        const n = (await env.events()).length;
        const out = await env.rawAppend(await env.redeemedDraft(id, "another-event-id", { decisionSequence: n }), T("09:13:00"));
        expect(out.accepted).toBe(false);
        expect(redeemedEvents(await env.events())).toHaveLength(1);
      }));

    it("C6: a CAPABILITY_REDEEMED reusing an existing event_id with different content is refused (EVENT_ID_CONFLICT)", () =>
      withEnv(false, async (env) => {
        const id = await env.issue(T("09:10:00"));
        expect((await env.redeem(auth(AGENT), env.command(id), T("09:12:00"))).ok).toBe(true);
        const existing = redeemedEvents(await env.events())[0]!;
        const clash = await env.redeemedDraft(id, existing.event_id, { decisionSequence: 7 });
        expect(await env.rawAppend(clash, T("09:13:00"))).toEqual({ accepted: false, reasonCode: "EVENT_ID_CONFLICT" });
      }));

    it("C7: an exact duplicate of an existing CAPABILITY_REDEEMED is a no-op, never a second redemption, and the ticket stays consumed", () =>
      withEnv(false, async (env) => {
        const id = await env.issue(T("09:10:00"));
        expect((await env.redeem(auth(AGENT), env.command(id), T("09:12:00"))).ok).toBe(true);
        const existing = redeemedEvents(await env.events())[0]!;
        const before = (await env.events()).length;
        if (existing.event_type !== "CAPABILITY_REDEEMED") throw new Error("fixture");
        const dup = await env.redeemedDraft(id, existing.event_id, { decisionSequence: Number(existing.payload.decision_sequence) });
        await env.rawAppend(dup, T("09:12:00"));
        expect((await env.events()).length).toBe(before);
        expect(await env.redeem(auth(AGENT), env.command(id), T("09:13:00"))).toEqual({ ok: false, reason: "ALREADY_REDEEMED" });
      }));

    it("C8: decision_sequence, ingestion sequence and instant are coherent for every successful redemption", () =>
      withEnv(false, async (env) => {
        const id = await env.issue(T("09:10:00"));
        expect((await env.redeem(auth(AGENT), env.command(id), T("09:12:00"))).ok).toBe(true);
        const events = await env.events();
        const e = redeemedEvents(events)[0]!;
        if (e.event_type !== "CAPABILITY_REDEEMED") throw new Error("fixture");
        expect(Number(e.sequence)).toBe(Number(e.payload.decision_sequence) + 1);
        expect(e.authority_time).toBe(T("09:12:00"));
        expect(events.filter((x) => x.sequence < e.sequence).every((x) => Date.parse(x.authority_time) <= Date.parse(e.authority_time))).toBe(true);
        expect(validateRedemptionEvent(events, e)).toEqual({ ok: true });
      }));
  });
}
