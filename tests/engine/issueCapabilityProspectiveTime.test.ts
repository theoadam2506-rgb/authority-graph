/**
 * PR4B-5 — GREEN round. `issueCapability` now receives an explicit
 * prospective `authorityTime` (src/engine/issueCapability.ts) instead of
 * deriving "now" from `reconstructAuthorityTimeAt(store, snapshotSequence)`
 * — the RED round's finding (see git history for this file's prior
 * revision): time can pass with zero new events, and the old derivation
 * made a delegation that expired hours ago look valid forever for want of
 * a subsequent event.
 *
 * `validateChain.ts`'s own docstring documents the contract this now
 * satisfies:
 *
 *   "`authorityTime` is always the caller-supplied trusted instant — never
 *   derived from occurred_at, never a `max(...)` over visible events' own
 *   authority_time (...)"
 *
 * This mirrors the legacy prospective path, `authorityAt` (authorityAt.ts),
 * which always took an explicit `AuthorityInstant` from the caller and
 * never reconstructed "now" from the log (see
 * tests/adversarial/expiration.test.ts's "time passing with no new event"
 * test, which this file's scenario deliberately mirrors).
 *
 * Scenario used throughout this file:
 *   T1 = 2030-01-01T10:00:00.000Z — the only authority_time in the store
 *   T2 = 2030-01-01T11:00:00.000Z — the delegation's own expires_at
 *   T3 = 2030-01-01T12:00:00.000Z — the real/trusted instant of the
 *        issuance attempt this file models — T1 < T2 < T3
 *
 * No event with authority_time > T1 is ever added to the store in any
 * scenario below — that absence is the whole point (see test C).
 */
import { describe, expect, it, vi } from "vitest";
import { issueCapability, type IssueCapabilityDependencies } from "../../src/engine/issueCapability.js";
import { buildCapabilityIssuedDraft } from "../../src/storage/capabilityIssuanceTransaction.js";
import type { AuthenticatedPrincipal } from "../../src/domain/authenticatedPrincipal.js";
import { isEventType } from "../../src/domain/events.js";
import { actionId, capabilityId, enforcementPointId, expiresAt, iso8601, nonMonetaryParameters, thresholds, type Iso8601, type PrincipalId } from "../../src/domain/types.js";
import type { IssueCapabilityCommand } from "../../src/domain/capabilityCommand.js";
import { PURCHASE_ORDER_CREATE, THEO, actionRequest, rootDelegation } from "../fixtures/scenarios.js";
import { principal } from "../fixtures/ids.js";

const AGENT = principal("prospective-time-agent");
const EP = enforcementPointId("ep-prospective-time");

const T1 = iso8601("2030-01-01T10:00:00.000Z");
const T2 = "2030-01-01T11:00:00.000Z"; // the delegation's expires_at
const T3 = iso8601("2030-01-01T12:00:00.000Z"); // T1 < T2 < T3 — the real evaluation instant
const T3_BEFORE_EXPIRY = iso8601("2030-01-01T10:30:00.000Z"); // T1 < T3_BEFORE_EXPIRY < T2

function authenticated(principalId: PrincipalId): AuthenticatedPrincipal {
  return { principalId };
}

function makeDependencies(startId = 1): IssueCapabilityDependencies {
  let counter = startId;
  return {
    nextCapabilityId: () => capabilityId(`cap-prospective-${counter++}`),
    expiresAt: (authorityTime) => iso8601(new Date(Date.parse(authorityTime) + 5 * 60_000).toISOString()),
  };
}

/**
 * Builds the exact scenario: a delegation created (and everything else in
 * the store) at authority_time T1, expiring at T2, with NO event of any
 * kind carrying an authority_time later than T1. Both events explicitly
 * pin `timing.authorityTime` to T1 — nothing here relies on a default.
 */
function buildStaleLogScenario() {
  const root = rootDelegation({
    sequence: 1,
    id: "d-prospective-root",
    grantor: THEO,
    grantorType: "HUMAN_ROOT",
    grantee: AGENT,
    capabilities: [PURCHASE_ORDER_CREATE],
    canDelegate: false,
    amountThresholds: thresholds(100000, 100000),
    expires: expiresAt(iso8601(T2)),
    timing: { authorityTime: T1 },
  });
  const request = actionRequest({
    sequence: 2,
    id: "act-prospective-1",
    requester: AGENT,
    delegationId: "d-prospective-root",
    parameters: nonMonetaryParameters(),
    timing: { authorityTime: T1 },
  });
  if (!isEventType(request, "ACTION_REQUESTED")) {
    throw new Error("fixture returned an unexpected event_type");
  }
  const store = [root, request];
  const command: IssueCapabilityCommand = { action_id: request.payload.action_id, enforcement_point_id: EP };
  return { store, command };
}

describe("[PR4B-5] issueCapability takes authorityTime as its own explicit parameter, never smuggled into the command", () => {
  it("authorityTime is not, and must never become, a field of IssueCapabilityCommand", () => {
    const { command } = buildStaleLogScenario();

    // Structural fact about the command's own shape: exactly action_id +
    // enforcement_point_id, exhaustive. issueCapability's authorityTime is
    // a separate, fifth function parameter (see the calls below) — not a
    // field a caller could set independently of it, and not something
    // idempotency's commandsEqual ever compares (see item K of the design
    // report and issueCapabilityIdempotency.ts's own docstring).
    const commandKeys = Object.keys(command).sort();
    expect(commandKeys).toEqual(["action_id", "enforcement_point_id"]);
    expect(commandKeys).not.toContain("authorityTime");
  });

  it("[was BLOCKER, now fixed] rejects an issuance whose real evaluation instant T3 is past the delegation's expires_at T2, even though the log's own last authority_time T1 predates T2", () => {
    const { store, command } = buildStaleLogScenario();

    const result = issueCapability(store, authenticated(AGENT), command, makeDependencies(), T3);

    // Exactly the assertion the RED round demanded, unweakened: expired-at-
    // T3 must be denied, on the same C11_CAPABILITY_NOT_COVERED path
    // validateChain already uses for any other expired chain (see
    // tests/adversarial/expiration.test.ts).
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("NOT_AUTHORIZED");
      if (result.reason !== "CAPABILITY_ID_COLLISION" && result.decision !== undefined) {
        expect(result.decision.outcome).toBe("DENIED");
      }
    }
  });
});

describe("[PR4B-5 control] before expiration must remain eligible — the fix must not simply reject every delegation carrying an expires_at", () => {
  it("issues normally when the explicit authorityTime is genuinely before expires_at", () => {
    const { store, command } = buildStaleLogScenario();

    expect(Date.parse(T1)).toBeLessThan(Date.parse(T3_BEFORE_EXPIRY));
    expect(Date.parse(T3_BEFORE_EXPIRY)).toBeLessThan(Date.parse(T2));

    const result = issueCapability(store, authenticated(AGENT), command, makeDependencies(), T3_BEFORE_EXPIRY);
    expect(result.ok).toBe(true);
  });
});

describe("[PR4B-5] time can pass with zero new events — the scenario does not (and must not) rely on an inserted event to advance time", () => {
  it("the stale-log scenario's store contains no event with authority_time between T1 and T3 — no heartbeat/dummy event was added to simulate T3", () => {
    const { store } = buildStaleLogScenario();

    // Exhaustive: exactly two events, both pinned to T1. This is the whole
    // point of PR4B-5 — Authority reasons about a real "now" (T3, passed
    // explicitly above) WITHOUT any corresponding event ever having been
    // ingested between T1 and T3.
    expect(store).toHaveLength(2);
    for (const event of store) {
      expect(event.authority_time).toBe(T1);
    }
    expect(Date.parse(T1)).toBeLessThan(Date.parse(T3));
  });
});

describe("[PR4B-5] determinism", () => {
  it("same canonical snapshot + same explicit authorityTime + same authenticatedPrincipal + same command + deterministic dependencies => same result", () => {
    const { store, command } = buildStaleLogScenario();
    // A fixed, non-counter capability_id generator: a determinism check
    // must hold every input fixed across both calls, including this one —
    // otherwise a difference would come from this test's own fixture, not
    // from issueCapability itself.
    const deps: IssueCapabilityDependencies = {
      nextCapabilityId: () => capabilityId("cap-prospective-fixed"),
      expiresAt: (authorityTime) => iso8601(new Date(Date.parse(authorityTime) + 5 * 60_000).toISOString()),
    };

    const first = issueCapability(store, authenticated(AGENT), command, deps, T3_BEFORE_EXPIRY);
    const second = issueCapability(store, authenticated(AGENT), command, deps, T3_BEFORE_EXPIRY);
    expect(first).toEqual(second);
  });

  it("the SAME snapshot, varying only the explicit authorityTime across the expires_at boundary, changes the outcome exactly as expected — with no event ever added to the snapshot", () => {
    const { store, command } = buildStaleLogScenario();
    const deps = makeDependencies();

    const before = issueCapability(store, authenticated(AGENT), command, deps, T3_BEFORE_EXPIRY);
    const after = issueCapability(store, authenticated(AGENT), command, deps, T3);

    expect(before.ok).toBe(true);
    expect(after.ok).toBe(false);
    // Same store object, same command, same dependencies instance — only
    // the explicit authorityTime argument differs between the two calls.
    expect(store).toHaveLength(2);
  });
});

describe("[PR4B-5] the exact same explicit authorityTime flows through the whole decision", () => {
  it("dependencies.expiresAt receives exactly the authorityTime argument, never a reconstructed snapshot instant", () => {
    const { store, command } = buildStaleLogScenario();
    const receivedInstants: Iso8601[] = [];
    const deps: IssueCapabilityDependencies = {
      nextCapabilityId: () => capabilityId("cap-expires-at-probe"),
      expiresAt: (authorityTime) => {
        receivedInstants.push(authorityTime);
        return iso8601(new Date(Date.parse(authorityTime) + 5 * 60_000).toISOString());
      },
    };

    const result = issueCapability(store, authenticated(AGENT), command, deps, T3_BEFORE_EXPIRY);

    expect(result.ok).toBe(true);
    expect(receivedInstants).toEqual([T3_BEFORE_EXPIRY]);
    // Not T1 — the value reconstructAuthorityTimeAt would have produced
    // from this exact store, which is precisely the bug PR4B-5 fixed.
    expect(receivedInstants).not.toContain(T1);
  });

  it("CAPABILITY_ISSUED.authority_time is exactly the explicit authorityTime used for the decision (buildCapabilityIssuedDraft), and decision_sequence is unchanged (still the snapshotSequence, not derived from time)", () => {
    const { store, command } = buildStaleLogScenario();
    const result = issueCapability(store, authenticated(AGENT), command, makeDependencies(), T3_BEFORE_EXPIRY);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok:true");
    }
    expect(result.capability.decision_sequence).toBe(2);

    const draft = buildCapabilityIssuedDraft(authenticated(AGENT), T3_BEFORE_EXPIRY, result.capability);
    expect(draft.occurred_at).toBe(T3_BEFORE_EXPIRY);
    expect(draft.occurred_at).not.toBe(T1);
    if (draft.event_type !== "CAPABILITY_ISSUED") {
      throw new Error("expected buildCapabilityIssuedDraft to return a CAPABILITY_ISSUED draft");
    }
    expect(draft.payload.decision_sequence).toBe(2);
  });
});

describe("[PR4B-5A RED] STALE_AUTHORITY_TIME — authorityTime older than the canonical maximum already visible in the snapshot", () => {
  /**
   * PR4B-5A — the follow-up debate to PR4B-5 found that an explicit
   * `authorityTime` can still be OLDER than an authority_time already
   * canonically present in the very snapshot passed to `issueCapability`.
   * T3 < T2 (a delegation's own expiry) is one such incoherence, already
   * covered above; this block covers the more general case: T3 older than
   * ANY already-canonical event's authority_time, unrelated to expiry —
   * the agent's authority itself may be perfectly valid at T3 (no
   * expires_at, no capacity issue), yet the evaluation instant itself is
   * incoherent with what the log already canonically knows.
   *
   * Decision retained (PR4B-5A): this must be refused with
   * `{ ok: false, reason: "STALE_AUTHORITY_TIME" }` — never
   * `NOT_AUTHORIZED` (the agent's authority is not the problem), never
   * `CAPACITY_EXCEEDED`, never a silent clamp, never a `CAPABILITY_ISSUED`.
   * The boundary is inclusive on the valid side: `authorityTime === max
   * visible` must NOT be refused for this reason.
   */
  const T4 = iso8601("2030-02-01T00:00:00.000Z"); // strictly after T3, the later canonical event's own authority_time
  const T5 = iso8601("2030-03-01T00:00:00.000Z"); // strictly after T4

  function buildNewerCanonicalEventScenario() {
    const root = rootDelegation({
      sequence: 1,
      id: "d-stale-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      amountThresholds: thresholds(100000, 100000),
      // no `expires` — noExpiry: the agent's authority itself remains
      // perfectly valid at T3. Only the evaluation instant is incoherent.
      timing: { authorityTime: T1 },
    });
    // The ACTION_REQUESTED is itself the later, already-canonical event —
    // legitimately accepted into the store at authority_time T4, strictly
    // after T3. Not a rejected draft, not a fabricated heartbeat: this is
    // exactly the kind of ordinary history a real deployment would have.
    const request = actionRequest({
      sequence: 2,
      id: "act-stale-1",
      requester: AGENT,
      delegationId: "d-stale-root",
      parameters: nonMonetaryParameters(),
      timing: { authorityTime: T4 },
    });
    if (!isEventType(request, "ACTION_REQUESTED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    const store = [root, request];
    const command: IssueCapabilityCommand = { action_id: request.payload.action_id, enforcement_point_id: EP };
    return { store, command };
  }

  it("[BLOCKER RED] authorityTime = T3, strictly before the canonical maximum T4 already visible, must be refused with STALE_AUTHORITY_TIME — currently FAILS: the capability is issued", () => {
    const { store, command } = buildNewerCanonicalEventScenario();

    // Sanity check on the scenario itself.
    const maxVisibleMs = Math.max(...store.map((event) => Date.parse(event.authority_time)));
    expect(maxVisibleMs).toBe(Date.parse(T4));
    expect(Date.parse(T3)).toBeLessThan(maxVisibleMs);

    const nextCapabilityId = vi.fn(() => capabilityId("cap-should-never-be-generated"));
    const expiresAtSpy = vi.fn((authorityTime: Iso8601) => iso8601(new Date(Date.parse(authorityTime) + 5 * 60_000).toISOString()));
    const deps: IssueCapabilityDependencies = { nextCapabilityId, expiresAt: expiresAtSpy };

    const result = issueCapability(store, authenticated(AGENT), command, deps, T3);

    // SECURE, EXPECTED behavior once fixed: a temporal-consistency refusal,
    // never an authority verdict (the agent's own authority is fine at T3).
    // ACTUAL, CURRENT behavior: issueCapability has no notion of "the
    // canonical maximum already visible" — it issues at T3 without
    // complaint. This assertion is deliberately the SECURE expectation; it
    // is expected to fail until PR4B-5A's fix lands.
    expect(result.ok).toBe(false);
    expect(result).toEqual({ ok: false, reason: "STALE_AUTHORITY_TIME" });

    // The refusal must happen BEFORE any capability generation — neither
    // dependency should ever be consulted for a stale instant.
    expect(nextCapabilityId).not.toHaveBeenCalled();
    expect(expiresAtSpy).not.toHaveBeenCalled();
  });

  it("[control] authorityTime === the canonical maximum (T4 itself) is NOT stale — the boundary is inclusive on the valid side", () => {
    const { store, command } = buildNewerCanonicalEventScenario();
    const result = issueCapability(store, authenticated(AGENT), command, makeDependencies(), T4);
    expect(result.ok).toBe(true);
    if (result.ok === false) {
      expect(result.reason).not.toBe("STALE_AUTHORITY_TIME");
    }
  });

  it("[control] authorityTime strictly after the canonical maximum is NOT stale", () => {
    const { store, command } = buildNewerCanonicalEventScenario();
    const result = issueCapability(store, authenticated(AGENT), command, makeDependencies(), T5);
    expect(result.ok).toBe(true);
    if (result.ok === false) {
      expect(result.reason).not.toBe("STALE_AUTHORITY_TIME");
    }
  });

  it("[control] an empty snapshot (no canonical events at all) is never stale — there is no maximum to be older than", () => {
    const command: IssueCapabilityCommand = { action_id: actionId("act-ghost-stale"), enforcement_point_id: EP };
    const result = issueCapability([], authenticated(AGENT), command, makeDependencies(), T3);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).not.toBe("STALE_AUTHORITY_TIME");
      expect(result.reason).toBe("ACTION_NOT_FOUND");
    }
  });
});

describe("[PR4B-5] wall-clock independence — preventive regression lock", () => {
  it("src/storage/postgresCapabilityIssuanceTransaction.ts never calls Date.now() (its own separate, legitimate new Date().toISOString() infrastructure-clock default must not be confused with an authority-time source)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const absolutePath = fileURLToPath(new URL("../../src/storage/postgresCapabilityIssuanceTransaction.ts", import.meta.url));
    const code = readFileSync(absolutePath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/Date\.now\(/);
    // `new Date().toISOString()` remains, by design, the readInfrastructureClock
    // default (recorded_at) — a different concept from authority_time/
    // authorityTime, and out of scope for this lock. This test exists so
    // that a regression cannot silently reach for Date.now() as a shortcut
    // for the prospective instant this file's other tests demand be
    // supplied explicitly by the caller instead.
  });
});
