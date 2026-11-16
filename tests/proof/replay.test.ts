/**
 * L3: deterministic replay of an attestation against a journal. Each test pins
 * one claim: what is validated (the attested prefix versus the whole journal
 * provided), what an anchor does and does not say, and that a signed statement
 * the replay does not reproduce is refused.
 */
import { describe, expect, it } from "vitest";
import type { AuthorityEvent } from "../../src/domain/events.js";
import { iso8601 } from "../../src/domain/types.js";
import { attestIssuance, attestRedemption, issuanceStatementOf, redemptionStatementOf, signingBytes, type Attestation } from "../../src/proof/attestation.js";
import { base64urlEncode } from "../../src/proof/encoding.js";
import { journalHead } from "../../src/proof/journalHash.js";
import { DEFAULT_MAX_REPLAY_EVENTS, REPORT_VERSION, verifyAttestationL3, type L3Options } from "../../src/proof/replay.js";
import { stableStringify } from "../../src/proof/stableJson.js";
import { TEST_KEY_ID, buildFixture, testKeys, testSigner, EP } from "./fixture.js";

const text = (events: readonly unknown[]) => JSON.stringify(events);
const heads = (...pairs: [number, string][]) => pairs.map(([head_sequence, head_hash]) => ({ head_sequence, head_hash }));
const checkStatus = (r: { checks: readonly { id: string; status: string }[] }, id: string) => r.checks.find((c) => c.id === id)?.status;
const failing = (r: { checks: readonly { id: string; status: string }[] }) => r.checks.find((c) => c.status === "FAIL")?.id;

async function resign(doc: Record<string, any>): Promise<string> {
  doc.signature.sig = base64urlEncode(await testSigner().sign(signingBytes({ ...doc, signature: { alg: "Ed25519", key_id: doc.signature.key_id } } as never)));
  return JSON.stringify(doc);
}
const verify = (att: unknown, journal: string | Uint8Array | undefined, extra: Partial<L3Options> = {}) =>
  verifyAttestationL3(typeof att === "string" ? att : JSON.stringify(att), { keys: testKeys(), ...(journal !== undefined ? { journal } : {}), ...extra });

async function base() {
  const f = await buildFixture();
  const redemption = await attestRedemption(f.events, f.capabilityId, testSigner());
  const issuance = await attestIssuance(f.events, f.capabilityId, testSigner());
  return { f, redemption, issuance, journal: text(f.events), head: journalHead(f.events) };
}

describe("L3: the happy path, and what the report says", () => {
  it.each(["issuance", "redemption"] as const)("a genuine %s attestation replays against its journal: CONSISTENT_L3, not anchored", async (which) => {
    const b = await base();
    const r = verify(b[which], b.journal);
    expect(r.result).toBe("CONSISTENT_L3");
    expect(r.report_version).toBe(REPORT_VERSION);
    expect(r.levels).toEqual({ L0: "PASS", L1: "PASS", L2: "NOT_CHECKED", L3: "PASS" });
    expect(r.scope).toBe("FULL_JOURNAL");
    expect(r.anchored).toBe(false);
    expect(r.anchor?.status).toBe("NONE_SUPPLIED");
    expect(r.anchor?.explanation).toMatch(/self-consistent, would pass/);
    expect(r.journal).toMatchObject({ events_provided: 5, attested_prefix: { head_sequence: 5, replay: "PASS", head_hash_matches: "PASS", statement_matches_event: "PASS", decision_rederived: "PASS" }, full_journal: { scope_checked: true, replay: "PASS", events_after_attested_head: 0 } });
    for (const id of ["L3.JOURNAL_READ", "L3.PREFIX_REPLAY", "L3.HEAD", "L3.EVENT", "L3.DECISION", "L3.FULL_REPLAY"]) expect(checkStatus(r, id), id).toBe("PASS");
    expect(checkStatus(r, "L3.ANCHOR")).toBe("NOT_CHECKED");
  });

  it("every report lists what is not established, including journal authenticity, completeness and the anchor's independence", async () => {
    const b = await base();
    const r = verify(b.redemption, b.journal);
    const joined = r.not_established.join(" | ");
    expect(joined).toMatch(/events of the journal are authentic/);
    expect(joined).toMatch(/journal is complete/);
    expect(joined).toMatch(/cannot tell whether your anchor is independent/);
    expect(joined).toMatch(/after the attested head/);
    expect(joined).toMatch(/not a person or an organization/);
  });

  it("the report is deterministic: identical bytes on every run, and for a re-spelled journal", async () => {
    const b = await base();
    const a = stableStringify(verify(b.redemption, b.journal));
    expect(stableStringify(verify(b.redemption, b.journal))).toBe(a);
    expect(stableStringify(verify(b.redemption, JSON.stringify(JSON.parse(b.journal), null, 4)))).toBe(a.replace(/"L3.JOURNAL_READ"[\s\S]*?\}/, (m) => m)); // same decision either way
    expect(verify(b.redemption, JSON.stringify(JSON.parse(b.journal), null, 4)).result).toBe("CONSISTENT_L3");
  });

  it("without a journal, L3 is NOT_CHECKED and the result is the L0-L2 result, never L3", async () => {
    const b = await base();
    const r = verify(b.redemption, undefined);
    expect(r.result).toBe("CONSISTENT_L1");
    expect(r.levels.L3).toBe("NOT_CHECKED");
    expect(r.journal).toBeNull();
    expect(r.anchor).toBeNull();
    expect(r.anchored).toBe(false);
  });

  it("the L2 context still applies and is reported alongside L3", async () => {
    const b = await base();
    const ok = verify(b.redemption, b.journal, { expected: { enforcement_point_id: EP } });
    expect(ok.levels).toEqual({ L0: "PASS", L1: "PASS", L2: "PASS", L3: "PASS" });
    const bad = verify(b.redemption, b.journal, { expected: { enforcement_point_id: "ep-other" } });
    expect(bad.result).toBe("REJECTED");
    expect(bad.levels).toMatchObject({ L2: "FAIL", L3: "NOT_CHECKED" }); // a failing level stops the run
  });
});

describe("L3: anchors say exactly what they say", () => {
  it("an anchor that matches and covers the attested prefix gives anchored: true, with the provenance and independence stated", async () => {
    const b = await base();
    const r = verify(b.redemption, b.journal, { trustedHeads: [{ head_sequence: 5, head_hash: b.head.head_hash, label: "my own copy" }] });
    expect(r.result).toBe("CONSISTENT_L3");
    expect(r.anchored).toBe(true);
    expect(r.anchor).toMatchObject({ status: "COVERS_ATTESTED_PREFIX", supplied: 1, matched: 1, provenance: "SUPPLIED_BY_VERIFIER", independence: "NOT_ESTABLISHED", covering: { head_sequence: 5, label: "my own copy" } });
    expect(r.anchor?.explanation).toMatch(/does NOT mean the anchor is independent/);
    expect(r.anchor?.explanation).toMatch(/a file on the same machine proves nothing about its own independence/);
  });

  it("independence is NOT_ESTABLISHED in every anchored report, whatever the label says", async () => {
    const b = await base();
    const r = verify(b.redemption, b.journal, { trustedHeads: [{ head_sequence: 5, head_hash: b.head.head_hash, label: "independent notary, certified" }] });
    expect(r.anchor?.independence).toBe("NOT_ESTABLISHED");
    expect(JSON.stringify(r)).not.toMatch(/"independence":"ESTABLISHED"/);
  });

  it("an anchor earlier than the attested head matches but does not cover it: anchored stays false", async () => {
    const b = await base();
    const r = verify(b.redemption, b.journal, { trustedHeads: [{ head_sequence: 3, head_hash: journalHead(b.f.events, 3).head_hash }] });
    expect(r.result).toBe("CONSISTENT_L3");
    expect(r.anchored).toBe(false);
    expect(r.anchor).toMatchObject({ status: "BELOW_ATTESTED_HEAD", matched: 1, covering: null });
    expect(r.anchor?.explanation).toMatch(/only part of the attested prefix|cover only part/);
  });

  it("several anchors: the smallest one that covers the attested prefix is reported", async () => {
    const b = await base();
    const r = verify(b.redemption, b.journal, { trustedHeads: heads([2, journalHead(b.f.events, 2).head_hash], [4, journalHead(b.f.events, 4).head_hash], [5, b.head.head_hash]) });
    expect(r.anchor).toMatchObject({ supplied: 3, matched: 3, status: "COVERS_ATTESTED_PREFIX", covering: { head_sequence: 5 } });
  });

  it("an anchor that the journal does not match is REJECTED: a divergent or rewritten journal", async () => {
    const b = await base();
    const r = verify(b.redemption, b.journal, { trustedHeads: heads([5, "ab".repeat(32)]) });
    expect(r.result).toBe("REJECTED");
    expect(failing(r)).toBe("L3.ANCHOR");
    expect(r.anchored).toBe(false);
    // Even a lower anchor that mismatches refuses the whole result:
    expect(verify(b.redemption, b.journal, { trustedHeads: heads([2, "cd".repeat(32)], [5, b.head.head_hash]) }).result).toBe("REJECTED");
  });

  it("an anchor beyond the journal's length means the journal is truncated relative to the verifier's anchor: REJECTED", async () => {
    const b = await base();
    const r = verify(b.redemption, b.journal, { trustedHeads: heads([9, "ab".repeat(32)]) });
    expect(r.result).toBe("REJECTED");
    expect(r.checks.find((c) => c.id === "L3.ANCHOR")?.detail).toMatch(/truncated relative to your anchor/);
  });

  it("anchor hashing is over the journal as exported: a tampered recorded_at before the anchor is detected by the anchor even where replay accepts it", async () => {
    const b = await base();
    const tampered = JSON.parse(b.journal) as Record<string, unknown>[];
    tampered[0] = { ...tampered[0]!, recorded_at: "2031-01-01T00:00:00.000Z" };
    const r = verify(b.redemption, text(tampered), { trustedHeads: heads([5, b.head.head_hash]) });
    expect(r.result).toBe("REJECTED");
    expect(failing(r)).toBe("L3.HEAD"); // the attested head already differs; the anchor would say the same
  });
});

describe("L3: truncated, reordered, divergent and modified journals", () => {
  it("a journal shorter than the attested head is truncated relative to the attestation", async () => {
    const b = await base();
    for (const n of [0, 1, 3, 4]) {
      const r = verify(b.redemption, text(b.f.events.slice(0, n)));
      expect(r.result, `n=${n}`).toBe("REJECTED");
      expect(failing(r), `n=${n}`).toBe("L3.PREFIX_REPLAY");
      expect(r.checks.find((c) => c.status === "FAIL")?.detail, `n=${n}`).toMatch(/truncated relative to the attestation/);
    }
  });

  it("reordered events do not replay", async () => {
    const b = await base();
    const swapped = [...b.f.events];
    [swapped[2], swapped[3]] = [swapped[3]!, swapped[2]!];
    const r = verify(b.redemption, text(swapped));
    expect(r.result).toBe("REJECTED");
    expect(failing(r)).toBe("L3.PREFIX_REPLAY");
  });

  it("an event removed from the middle does not replay", async () => {
    const b = await base();
    const r = verify(b.redemption, text(b.f.events.filter((e) => e.sequence !== 2)));
    expect(r.result).toBe("REJECTED");
    expect(["L3.PREFIX_REPLAY"]).toContain(failing(r));
  });

  it("a duplicated event does not replay", async () => {
    const b = await base();
    const r = verify(b.redemption, text([...b.f.events, b.f.events[0]]));
    expect(r.result).toBe("REJECTED");
    expect(failing(r)).toBe("L3.FULL_REPLAY");
  });

  it.each([
    ["recorded_at", { recorded_at: "2031-01-01T00:00:00.000Z" }],
    ["occurred_at", { occurred_at: "2031-01-01T00:00:00.000Z" }],
  ])("a modified %s replays (it is not decisional) but changes the hash: refused at L3.HEAD", async (_n, patch) => {
    const b = await base();
    const t = JSON.parse(b.journal) as Record<string, unknown>[];
    t[1] = { ...t[1]!, ...patch };
    const r = verify(b.redemption, text(t));
    expect(r.result).toBe("REJECTED");
    expect(checkStatus(r, "L3.PREFIX_REPLAY")).toBe("PASS");
    expect(failing(r)).toBe("L3.HEAD");
  });

  it("a divergent journal of the SAME length (another valid history) is refused: the head does not match", async () => {
    const b = await base();
    const other = await buildFixture({ amount: 1700 });
    expect(other.events).toHaveLength(b.f.events.length);
    const alt = verify(b.redemption, text(other.events));
    expect(alt.result).toBe("REJECTED");
    expect(failing(alt)).toBe("L3.HEAD");
    expect(checkStatus(alt, "L3.PREFIX_REPLAY")).toBe("PASS"); // internally consistent, just not THE journal this attests
    // and an anchor taken from the right journal exposes the substitution too
    expect(verify(b.redemption, text(other.events), { trustedHeads: heads([5, b.head.head_hash]) }).result).toBe("REJECTED");
  });

  it("modifying an event's payload so that it no longer replays is refused at the prefix", async () => {
    const b = await base();
    const t = JSON.parse(b.journal) as Record<string, any>[];
    t[2] = { ...t[2]!, payload: { ...t[2]!.payload, enforcement_point_id: "ep-other" } };
    expect(verify(b.redemption, text(t)).result).toBe("REJECTED");
  });
});

describe("L3: the attested prefix and the whole journal provided are validated separately", () => {
  async function withSuffix() {
    const f = await buildFixture({ revocation: true });
    expect(f.events).toHaveLength(6);
    const prefix = f.events.slice(0, 5);
    const redemption = await attestRedemption(prefix, f.capabilityId, testSigner());
    return { f, redemption, prefix };
  }

  it("a valid longer journal passes; events after the head are counted and a later revocation is listed for information only", async () => {
    const { f, redemption } = await withSuffix();
    const r = verify(redemption, text(f.events));
    expect(r.result).toBe("CONSISTENT_L3");
    expect(r.journal?.full_journal).toEqual({ scope_checked: true, replay: "PASS", events_after_attested_head: 1 });
    expect(r.later_revocations).toMatchObject({ count: 1, listed: [{ sequence: 6, delegation_id: "d-proof", revoked_by_principal_id: "theo" }] });
    expect(r.later_revocations?.note).toMatch(/never change the result/);
  });

  it("without the suffix there is nothing to list", async () => {
    const { redemption, prefix } = await withSuffix();
    expect(verify(redemption, text(prefix)).later_revocations).toMatchObject({ count: 0, listed: [] });
  });

  it.each([
    ["a duplicate event_id with different content", (e: Record<string, any>[]) => [...e.slice(0, 5), { ...e[5]!, event_id: e[0]!.event_id }]],
    ["a sequence gap", (e: Record<string, any>[]) => [...e.slice(0, 5), { ...e[5]!, sequence: 9 }]],
    ["authority_time going backwards", (e: Record<string, any>[]) => [...e.slice(0, 5), { ...e[5]!, authority_time: "2025-01-01T08:00:00.000Z" }]],
    ["a non-event junk element", (e: Record<string, any>[]) => [...e.slice(0, 5), null]],
    ["an unauthorized revocation", (e: Record<string, any>[]) => [...e.slice(0, 5), { ...e[5]!, principal_id: "mallory", payload: { ...e[5]!.payload, revoked_by_principal_id: "mallory" } }]],
  ])("a suffix with %s: the prefix is sound, the full journal is refused", async (_name, mutate) => {
    const { f, redemption } = await withSuffix();
    const bad = text(mutate(JSON.parse(text(f.events))));
    const r = verify(redemption, bad);
    expect(r.result).toBe("REJECTED");
    expect(failing(r)).toBe("L3.FULL_REPLAY");
    expect(r.checks.find((c) => c.id === "L3.FULL_REPLAY")?.detail).toMatch(/attested prefix is sound/);
    expect(r.journal?.attested_prefix).toMatchObject({ replay: "PASS", head_hash_matches: "PASS", statement_matches_event: "PASS", decision_rederived: "PASS" });
    expect(r.journal?.full_journal.replay).toBe("FAIL");
    expect(r.later_revocations).toBeNull(); // nothing is reported from an unvalidated suffix
  });

  it("scope ATTESTED_PREFIX_ONLY validates the prefix, leaves the suffix unchecked, and says so", async () => {
    const { f, redemption } = await withSuffix();
    const bad = text([...JSON.parse(text(f.events)).slice(0, 5), null]);
    const r = verify(redemption, bad, { scope: "ATTESTED_PREFIX_ONLY" });
    expect(r.result).toBe("CONSISTENT_L3");
    expect(r.scope).toBe("ATTESTED_PREFIX_ONLY");
    expect(r.journal?.full_journal).toEqual({ scope_checked: false, replay: "NOT_CHECKED", events_after_attested_head: 1 });
    expect(r.journal?.scope_explanation).toMatch(/NOT validated/);
    expect(checkStatus(r, "L3.FULL_REPLAY")).toBe("NOT_CHECKED");
    expect(r.later_revocations).toBeNull();
  });

  it("an invalid PREFIX is refused in both scopes", async () => {
    const { f, redemption } = await withSuffix();
    const bad = JSON.parse(text(f.events)) as Record<string, any>[];
    bad[3] = { ...bad[3]!, sequence: 12 };
    for (const scope of ["FULL_JOURNAL", "ATTESTED_PREFIX_ONLY"] as const) {
      const r = verify(redemption, text(bad), { scope });
      expect(r.result, scope).toBe("REJECTED");
      expect(failing(r), scope).toBe("L3.PREFIX_REPLAY");
    }
  });

  it("an anchor covering events after the attested head is accepted in prefix-only scope (hashing needs no validation) and the scope still says the suffix was not checked", async () => {
    const { f, redemption } = await withSuffix();
    const r = verify(redemption, text(f.events), { scope: "ATTESTED_PREFIX_ONLY", trustedHeads: heads([6, journalHead(f.events).head_hash]) });
    expect(r.anchored).toBe(true);
    expect(r.journal?.full_journal.replay).toBe("NOT_CHECKED");
  });
});

describe("L3 refuses a signed statement the deterministic replay does not reproduce", () => {
  it("a validly signed lie about the journal head is refused at L3.HEAD (it passes L1 and L2)", async () => {
    const { redemption, journal } = await base();
    const lie = structuredClone(redemption) as unknown as Record<string, any>;
    lie.journal.head_hash = "ab".repeat(32);
    const signed = await resign(lie);
    expect(verifyAttestationL3(signed, { keys: testKeys(), expected: { enforcement_point_id: EP } }).result).toBe("CONSISTENT_L2"); // no journal: nothing contradicts it
    const r = verify(signed, journal, { expected: { enforcement_point_id: EP } });
    expect(r.result).toBe("REJECTED");
    expect(r.levels).toMatchObject({ L1: "PASS", L2: "PASS", L3: "FAIL" });
    expect(failing(r)).toBe("L3.HEAD");
  });

  it.each([
    ["principal_id", (s: Record<string, any>) => { s.principal_id = "someone-else"; }],
    ["action_fingerprint", (s: Record<string, any>) => { s.action_fingerprint = "f".repeat(64); }],
    ["capability_id", (s: Record<string, any>) => { s.capability_id = "cap-proof-2"; }],
    ["enforcement_point_id", (s: Record<string, any>) => { s.enforcement_point_id = "ep-other"; }],
    ["action_id", (s: Record<string, any>) => { s.action_id = "act-other"; }],
    ["event authority_time", (s: Record<string, any>) => { s.event.authority_time = "2025-01-01T09:12:00.001Z"; }],
  ])("a signed REDEMPTION statement with another %s is refused at L3.EVENT", async (_name, mutate) => {
    const { redemption, journal } = await base();
    const doc = structuredClone(redemption) as unknown as Record<string, any>;
    mutate(doc.statement);
    const r = verify(await resign(doc), journal);
    expect(r.result).toBe("REJECTED");
    expect(failing(r)).toBe("L3.EVENT");
    expect(r.checks.find((c) => c.id === "L3.EVENT")?.detail).toMatch(/differs from the journal's event/);
  });

  it.each([
    ["granted_chain_ref", (s: Record<string, any>) => { s.granted_chain_ref = [{ kind: "delegation", delegation_id: "d-other" }]; }],
    ["expires_at", (s: Record<string, any>) => { s.expires_at = "2030-01-01T00:00:00.000Z"; }],
  ])("a signed ISSUANCE statement with another %s is refused at L3.EVENT", async (_name, mutate) => {
    const { issuance, journal } = await base();
    const doc = structuredClone(issuance) as unknown as Record<string, any>;
    mutate(doc.statement);
    const r = verify(await resign(doc), journal);
    expect(r.result).toBe("REJECTED");
    expect(failing(r)).toBe("L3.EVENT");
  });

  it("a statement about an event that is not of the attested kind at that sequence is refused", async () => {
    const { redemption, journal } = await base();
    const doc = structuredClone(redemption) as unknown as Record<string, any>;
    doc.statement.event.sequence = 3;
    doc.statement.decision_sequence = 2;
    const r = verify(await resign(doc), journal);
    expect(r.result).toBe("REJECTED");
    expect(failing(r)).toBe("L3.EVENT");
  });

  it("a forged redemption written after a revocation, with a signature over a statement that matches it exactly, is refused by the engine's validator (L3.DECISION)", async () => {
    const f = await buildFixture({ forgedRedemptionAfterRevocation: true });
    expect(f.events).toHaveLength(7);
    await expect(attestRedemption(f.events, f.unredeemedCapabilityId, testSigner())).rejects.toMatchObject({ code: "REDEMPTION_NOT_VALID" }); // the honest builder refuses
    // A key holder skips the builder and signs the matching statement anyway:
    const forgedEvent = f.events[6] as Extract<AuthorityEvent, { event_type: "CAPABILITY_REDEEMED" }>;
    const head = journalHead(f.events);
    const doc: Record<string, any> = {
      proof_version: "authority-attestation/v1", kind: "REDEMPTION", engine: { id: "authority-graph", protocol_version: 1, event_schema_version: 1 },
      statement: redemptionStatementOf(forgedEvent), journal: { scheme: "authority-journal-chain/v1", ...head },
      signature: { alg: "Ed25519", key_id: TEST_KEY_ID, sig: "A".repeat(86) },
    };
    const signed = await resign(doc);
    const r = verify(signed, text(f.events));
    expect(r.levels).toMatchObject({ L0: "PASS", L1: "PASS", L3: "FAIL" });
    expect(r.result).toBe("REJECTED");
    expect(checkStatus(r, "L3.PREFIX_REPLAY")).toBe("PASS");
    expect(checkStatus(r, "L3.HEAD")).toBe("PASS");
    expect(checkStatus(r, "L3.EVENT")).toBe("PASS");
    expect(failing(r)).toBe("L3.DECISION");
    expect(r.checks.find((c) => c.id === "L3.DECISION")?.detail).toMatch(/AUTHORITY_NOT_VALID_AT_DECISION/);
    void issuanceStatementOf;
  });

  it("an issuance signed over a forged CAPABILITY_ISSUED (fingerprint of another action) is refused at L3.DECISION", async () => {
    const f = await buildFixture();
    const forged = JSON.parse(text(f.events)) as Record<string, any>[];
    forged[2] = { ...forged[2]!, payload: { ...forged[2]!.payload, action_fingerprint: "0".repeat(64) } };
    // the replay accepts Authority-generated events as written; the engine's grant validation does not
    const prefixHead = journalHead(forged as never);
    const doc: Record<string, any> = {
      proof_version: "authority-attestation/v1", kind: "ISSUANCE", engine: { id: "authority-graph", protocol_version: 1, event_schema_version: 1 },
      statement: issuanceStatementOf(forged[2] as never), journal: { scheme: "authority-journal-chain/v1", ...prefixHead },
      signature: { alg: "Ed25519", key_id: TEST_KEY_ID, sig: "A".repeat(86) },
    };
    const r = verify(await resign(doc), text(forged));
    expect(r.result).toBe("REJECTED");
    expect(["L3.PREFIX_REPLAY", "L3.DECISION"]).toContain(failing(r));
  });
});

describe("a revoked key stays REJECTED, whatever the journal says", () => {
  it.each([
    ["revoked ALWAYS", { revokedFrom: "ALWAYS" }],
    ["revoked from before the claimed time", { revokedFrom: "2025-01-01T00:00:00.000Z" }],
    ["not_after before the claimed time", { notAfter: "2025-01-01T09:00:00.000Z" }],
  ])("%s: the statement matches the journal and an anchor covers it, yet the result is REJECTED and L3 is not run", async (_n, keyExtra) => {
    const b = await base();
    const r = verifyAttestationL3(JSON.stringify(b.redemption), { keys: testKeys(keyExtra as never), journal: b.journal, trustedHeads: [{ head_sequence: 5, head_hash: b.head.head_hash }] });
    expect(r.result).toBe("REJECTED");
    expect(r.levels).toMatchObject({ L1: "FAIL", L3: "NOT_CHECKED" });
    expect(r.journal).toBeNull();
    expect(r.anchor).toBeNull();
    expect(r.anchored).toBe(false);
    expect(r.checks.some((c) => c.level === 3)).toBe(false); // no L3 check even exists in the report
    expect(JSON.stringify(r)).not.toMatch(/CONSISTENT/);
  });

  it("an unknown key is REJECTED the same way", async () => {
    const b = await base();
    const r = verifyAttestationL3(JSON.stringify(b.redemption), { keys: new Map(), journal: b.journal });
    expect(r.result).toBe("REJECTED");
    expect(r.levels.L3).toBe("NOT_CHECKED");
  });
});

describe("L3: reading the journal strictly and within bounds", () => {
  it.each([
    ["not JSON", "this is not json"],
    ["not an array", '{"events":[]}'],
    ["a duplicate key inside an event", '[{"event_id":"a","event_id":"b"}]'],
    ["an inexact number", '[{"sequence":1.0}]'],
    ["an empty input", ""],
  ])("%s is refused at L3.JOURNAL_READ", async (_n, journal) => {
    const b = await base();
    const r = verify(b.redemption, journal);
    expect(r.result).toBe("REJECTED");
    expect(failing(r)).toBe("L3.JOURNAL_READ");
  });

  it("invalid UTF-8 bytes are refused", async () => {
    const b = await base();
    expect(failing(verify(b.redemption, new Uint8Array([0x5b, 0xff, 0x5d])))).toBe("L3.JOURNAL_READ");
    expect(verify(b.redemption, new TextEncoder().encode(b.journal)).result).toBe("CONSISTENT_L3");
  });

  it("the replay limit refuses a journal above it, and states the limit is provisional", async () => {
    const b = await base();
    const r = verify(b.redemption, b.journal, { maxEvents: 4 });
    expect(r.result).toBe("REJECTED");
    expect(failing(r)).toBe("L3.JOURNAL_READ");
    expect(r.checks.find((c) => c.id === "L3.JOURNAL_READ")?.detail).toMatch(/provisional/);
    expect(DEFAULT_MAX_REPLAY_EVENTS).toBe(10_000);
  });

  it("the byte limit refuses an oversized journal", async () => {
    const b = await base();
    expect(failing(verify(b.redemption, b.journal, { maxJournalBytes: 100 }))).toBe("L3.JOURNAL_READ");
  });
});

void iso8601;
void ({} as Attestation);
