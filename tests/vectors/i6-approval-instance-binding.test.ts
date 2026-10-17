/**
 * I6 portable vector: an approval is bound to its action instance.
 *
 * Scenario (tests/fixtures/i6InstanceBinding.ts): A1 and A2 have the same
 * fingerprint, requester and invoked delegation D1 (approval band); P1 is
 * granted for A1 only, P2 later for A2. Three distinct surfaces are asserted
 * separately, and none is deduced from another:
 *  - INVOKED:  `explainAction(...).invokedAuthorityNow`
 *  - RECORDED: `explainAction(...).execution.recordedValidation`
 *  - ISSUANCE: `issueCapability` (and the absence of a CAPABILITY_ISSUED)
 *
 * The same journal is also published as a share candidate,
 * tests/vectors/candidates/i6-approval-instance-binding.v1.json. That file is
 * an Authority candidate, NOT a claim of AgentCreds conformance. It is
 * replayed here so it cannot drift from the engine.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { explainAction, ingestAll } from "../../src/engine/authority.js";
import { issueCapability } from "../../src/engine/issueCapability.js";
import { toDraft, type CanonicalStore } from "../../src/domain/events.js";
import { capabilityId, enforcementPointId, iso8601 } from "../../src/domain/types.js";
import { action } from "../fixtures/ids.js";
import { i6Events, i6Through, I6_AGENT } from "../fixtures/i6InstanceBinding.js";
import { instant, sequentialClock } from "../fixtures/scenarios.js";

const ISSUANCE_TIME = iso8601("2025-01-01T00:20:00.000Z");
const EP = enforcementPointId("ep-i6-vector");
const deps = {
  nextCapabilityId: () => capabilityId("cap-i6-1"),
  expiresAt: (t: string) => iso8601(new Date(Date.parse(t) + 5 * 60_000).toISOString()),
};

const ingest = (through: number): CanonicalStore => ingestAll(i6Through(through).map(toDraft), sequentialClock).canonicalStore;
const invoked = (store: CanonicalStore, id: string, at: number) => explainAction(store, { actionId: action(id) }, instant(at)).invokedAuthorityNow;
const recorded = (store: CanonicalStore, id: string, at: number) => explainAction(store, { actionId: action(id) }, instant(at)).execution?.recordedValidation;
const issue = (store: CanonicalStore, id: string) => issueCapability(store, { principalId: I6_AGENT }, { action_id: action(id), enforcement_point_id: EP }, deps, ISSUANCE_TIME);
const issuedEvents = (store: CanonicalStore) => store.filter((e) => e.event_type === "CAPABILITY_ISSUED");

describe("I6 vector — approval bound to the action instance", () => {
  const beforeForgery = ingest(5);
  const afterForgery = ingest(6);
  const afterP2 = ingest(8);

  it("A1 and A2 differ only by action_id: same fingerprint, requester and delegation", () => {
    const [a1, a2] = [i6Events[1], i6Events[2]];
    if (a1?.event_type !== "ACTION_REQUESTED" || a2?.event_type !== "ACTION_REQUESTED") {
      throw new Error("fixture shape");
    }
    expect(a1.payload.action_id).not.toBe(a2.payload.action_id);
    expect(a1.payload.parameters).toEqual(a2.payload.parameters);
    expect(a1.payload.requesting_principal_id).toBe(a2.payload.requesting_principal_id);
    expect(a1.payload.delegation_id).toBe(a2.payload.delegation_id);
    expect(a1.payload.capability_requested).toEqual(a2.payload.capability_requested);
    expect(JSON.stringify(a1.payload.parameters)).not.toContain("action_id");
  });

  it("1. INVOKED: A1 with P1 is AUTHORIZED", () => {
    expect(invoked(beforeForgery, "A1", 5)).toMatchObject({ outcome: "AUTHORIZED", chain: ["D1"], approvalId: "P1" });
  });

  it("2. INVOKED: A2 with P1 on the log is REQUIRES_APPROVAL, with no approval reference", () => {
    const a2 = invoked(beforeForgery, "A2", 5);
    expect(a2).toMatchObject({ outcome: "REQUIRES_APPROVAL", viaDelegation: "D1" });
    expect(a2).not.toHaveProperty("approvalId");
  });

  it("3. RECORDED: a forged ACTION_EXECUTED for A2 citing D1 and P1 is REQUIRES_APPROVAL, never AUTHORIZED", () => {
    const validation = recorded(afterForgery, "A2", 6);
    expect(validation).toMatchObject({ outcome: "REQUIRES_APPROVAL", viaDelegation: "D1" });
    expect(validation).not.toMatchObject({ approvalId: "P1" });
    // INVOKED view of A2 is unchanged by the forgery.
    expect(invoked(afterForgery, "A2", 6)).toMatchObject({ outcome: "REQUIRES_APPROVAL", viaDelegation: "D1" });
  });

  it("4. INVOKED: the invalid execution does not consume P1 — A1 remains AUTHORIZED with P1", () => {
    expect(invoked(afterForgery, "A1", 6)).toMatchObject({ outcome: "AUTHORIZED", chain: ["D1"], approvalId: "P1" });
  });

  it("5/6. ISSUANCE: A2 with only P1 is refused NOT_AUTHORIZED/REQUIRES_APPROVAL and creates no CAPABILITY_ISSUED (before and after the forgery)", () => {
    for (const store of [beforeForgery, afterForgery]) {
      const result = issue(store, "A2");
      expect(result).toMatchObject({ ok: false, reason: "NOT_AUTHORIZED", decision: { outcome: "REQUIRES_APPROVAL" } });
      expect(result).not.toHaveProperty("capability");
      expect(issuedEvents(store)).toHaveLength(0);
    }
  });

  it("7. after P2 (bound to A2), A2 is AUTHORIZED in INVOKED and any capability references P2, never P1", () => {
    expect(invoked(afterP2, "A2", 8)).toMatchObject({ outcome: "AUTHORIZED", chain: ["D1"], approvalId: "P2" });
    const result = issue(afterP2, "A2");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok:true");
    }
    expect(result.capability.action_id).toBe("A2");
    expect(result.capability.granted_chain_ref).toEqual([
      { kind: "delegation", delegation_id: "D1" },
      { kind: "approval", approval_id: "P2" },
    ]);
    expect(JSON.stringify(result.capability.granted_chain_ref)).not.toContain("P1");
    // A1 is unaffected: its capability, if issued, would still rest on P1.
    expect(invoked(afterP2, "A1", 8)).toMatchObject({ outcome: "AUTHORIZED", approvalId: "P1" });
  });
});

interface CandidateStep {
  readonly step: number;
  readonly surface: "INVOKED" | "RECORDED" | "ISSUANCE";
  readonly action_id: string;
  readonly events_through: number;
  readonly at?: { readonly sequence: number; readonly authority_time: string };
  readonly authority_time?: string;
  readonly expect: Record<string, unknown>;
}

describe("I6 vector — share candidate JSON", () => {
  const candidate = JSON.parse(readFileSync(fileURLToPath(new URL("./candidates/i6-approval-instance-binding.v1.json", import.meta.url)), "utf8")) as {
    status: string;
    events: unknown;
    steps: CandidateStep[];
  };

  it("declares itself a candidate and carries the canonical journal of the scenario", () => {
    expect(candidate.status).toBe("AUTHORITY_CANDIDATE_NOT_AGENTCREDS_CONFORMANCE");
    expect(candidate.events).toEqual(JSON.parse(JSON.stringify(ingest(8))));
  });

  it("every step, replayed against the engine with its explicit instants, yields the declared outcome", () => {
    expect(candidate.steps.length).toBeGreaterThanOrEqual(8);
    for (const s of candidate.steps) {
      const store = ingest(s.events_through);
      let actual: unknown;
      if (s.surface === "ISSUANCE") {
        const r = issueCapability(store, { principalId: I6_AGENT }, { action_id: action(s.action_id), enforcement_point_id: EP }, deps, iso8601(s.authority_time ?? ""));
        actual = r.ok
          ? { ok: true, granted_chain_ref: r.capability.granted_chain_ref }
          : { ok: false, reason: r.reason, decision_outcome: r.reason === "CAPABILITY_ID_COLLISION" ? undefined : r.decision?.outcome };
      } else {
        const at = { atSequence: s.at!.sequence, authorityTime: s.at!.authority_time };
        const e = explainAction(store, { actionId: action(s.action_id) }, at as never);
        actual = s.surface === "INVOKED" ? e.invokedAuthorityNow : e.execution?.recordedValidation;
      }
      expect(actual, `step ${s.step}`).toMatchObject(s.expect);
    }
  });
});
