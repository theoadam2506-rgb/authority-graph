import { createPublicKey, verify as nodeVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuthorityEvent, CanonicalStore } from "../../src/domain/events.js";
import { sequenceNumber } from "../../src/domain/types.js";
import {
  AttestationRefusedError, FORMAT_FIELDS, SIGNING_PREFIX, attestIssuance, attestRedemption, signingBytes, validateAttestationStructure, type Attestation, type IssuanceAttestation, type RedemptionAttestation,
} from "../../src/proof/attestation.js";
import { base64urlDecodeExact } from "../../src/proof/encoding.js";
import { journalHead } from "../../src/proof/journalHash.js";
import type { ProofSigner } from "../../src/proof/keys.js";
import { verifyAttestation } from "../../src/proof/verify.js";
import { EP, TEST_KEY_ID, TEST_PUBLIC_JWK, buildFixture, testKeys, testSigner } from "./fixture.js";

/** An independent canonical form for the restricted subset used here (ASCII strings, safe integers, arrays, objects): sorted keys, no whitespace. */
function independentCanonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(independentCanonical).join(",")}]`;
  if (typeof v === "object" && v !== null) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${independentCanonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

describe("building attestations", () => {
  it("an issuance attestation states exactly the CAPABILITY_ISSUED event, over the whole journal", async () => {
    const { events, capabilityId } = await buildFixture();
    const a = await attestIssuance(events, capabilityId, testSigner());
    const e = events.find((x) => x.event_type === "CAPABILITY_ISSUED" && x.payload.capability_id === capabilityId) as Extract<AuthorityEvent, { event_type: "CAPABILITY_ISSUED" }>;
    expect(a.kind).toBe("ISSUANCE");
    expect(a.statement).toEqual({
      event: { sequence: Number(e.sequence), event_id: e.event_id, authority_time: e.authority_time },
      capability_id: capabilityId, action_id: e.payload.action_id, action_fingerprint: e.payload.action_fingerprint, principal_id: e.principal_id,
      decision_sequence: Number(e.payload.decision_sequence), enforcement_point_id: EP, granted_chain_ref: [{ kind: "delegation", delegation_id: "d-proof" }], expires_at: e.payload.expires_at,
    });
    expect(a.journal).toEqual({ scheme: "authority-journal-chain/v1", ...journalHead(events) });
    expect(a.engine).toEqual({ id: "authority-graph", protocol_version: 1, event_schema_version: 1 });
    expect(a.signature).toMatchObject({ alg: "Ed25519", key_id: TEST_KEY_ID });
  });

  it("a redemption attestation states exactly the CAPABILITY_REDEEMED event", async () => {
    const { events, capabilityId } = await buildFixture();
    const a = await attestRedemption(events, capabilityId, testSigner());
    const e = events.find((x) => x.event_type === "CAPABILITY_REDEEMED") as Extract<AuthorityEvent, { event_type: "CAPABILITY_REDEEMED" }>;
    expect(a.kind).toBe("REDEMPTION");
    expect(a.statement).toEqual({
      event: { sequence: Number(e.sequence), event_id: e.event_id, authority_time: e.authority_time },
      capability_id: capabilityId, action_id: e.payload.action_id, action_fingerprint: e.payload.action_fingerprint, principal_id: e.principal_id,
      decision_sequence: Number(e.payload.decision_sequence), enforcement_point_id: EP,
    });
  });

  it("is deterministic: two builds give byte-identical JSON", async () => {
    const f1 = await buildFixture();
    const f2 = await buildFixture();
    expect(JSON.stringify(await attestRedemption(f1.events, f1.capabilityId, testSigner()))).toBe(JSON.stringify(await attestRedemption(f2.events, f2.capabilityId, testSigner())));
  });

  it("the signing input is exactly prefix + JCS(attestation with signature = {alg, key_id}), checked against an independent canonicalizer and raw node:crypto", async () => {
    const { events, capabilityId } = await buildFixture();
    const a = await attestRedemption(events, capabilityId, testSigner());
    const { sig, ...slot } = a.signature;
    const expected = SIGNING_PREFIX + independentCanonical({ ...a, signature: slot });
    expect(Buffer.from(signingBytes(a)).toString("utf8")).toBe(expected);
    expect(SIGNING_PREFIX).toBe("authority-attestation/v1\n");
    const ok = nodeVerify(null, Buffer.from(expected, "utf8"), createPublicKey({ key: { ...TEST_PUBLIC_JWK }, format: "jwk" }), base64urlDecodeExact(sig, 64)!);
    expect(ok).toBe(true);
  });

  it("alg and key_id are inside the signed bytes (changing either changes the signing input)", async () => {
    const { events, capabilityId } = await buildFixture();
    const a = await attestRedemption(events, capabilityId, testSigner());
    const base = Buffer.from(signingBytes(a)).toString("hex");
    expect(Buffer.from(signingBytes({ ...a, signature: { ...a.signature, key_id: "A".repeat(43) } })).toString("hex")).not.toBe(base);
    expect(Buffer.from(signingBytes({ ...a, signature: { ...a.signature, alg: "none" as never } })).toString("hex")).not.toBe(base);
    expect(Buffer.from(signingBytes({ ...a, signature: { ...a.signature, sig: "x".repeat(86) } })).toString("hex")).toBe(base); // the signature itself is the only thing excluded
  });
});

describe("the builders refuse to vouch for what the engine's own validators reject", () => {
  it("unknown capability", async () => {
    const { events } = await buildFixture();
    await expect(attestIssuance(events, "nope", testSigner())).rejects.toMatchObject({ code: "CAPABILITY_NOT_FOUND" });
    await expect(attestRedemption(events, "nope", testSigner())).rejects.toMatchObject({ code: "REDEMPTION_NOT_FOUND" });
  });
  it("a capability that was issued but never redeemed has no redemption to attest", async () => {
    const { events, unredeemedCapabilityId } = await buildFixture();
    await expect(attestRedemption(events, unredeemedCapabilityId, testSigner())).rejects.toBeInstanceOf(AttestationRefusedError);
    expect((await attestIssuance(events, unredeemedCapabilityId, testSigner())).kind).toBe("ISSUANCE");
  });
  it("a forged CAPABILITY_ISSUED (fingerprint does not match its action) is refused", async () => {
    const { events, capabilityId } = await buildFixture();
    const forged = events.map((e) => (e.event_type === "CAPABILITY_ISSUED" && e.payload.capability_id === capabilityId ? ({ ...e, payload: { ...e.payload, action_fingerprint: "0".repeat(64) } } as AuthorityEvent) : e));
    await expect(attestIssuance(forged, capabilityId, testSigner())).rejects.toMatchObject({ code: "ISSUANCE_NOT_VALID", detail: "FINGERPRINT_MISMATCH" });
  });
  it("a redemption that fails I31 (decision_sequence not immediate: the footprint of a concurrent write) is refused", async () => {
    const { events, capabilityId } = await buildFixture();
    const bad = events.map((e) => (e.event_type === "CAPABILITY_REDEEMED" ? ({ ...e, payload: { ...e.payload, decision_sequence: sequenceNumber(1) } } as AuthorityEvent) : e));
    await expect(attestRedemption(bad, capabilityId, testSigner())).rejects.toMatchObject({ code: "REDEMPTION_NOT_VALID", detail: "DECISION_SEQUENCE_NOT_IMMEDIATE" });
  });
  it("a journal with a gap cannot be attested", async () => {
    const { events, capabilityId } = await buildFixture();
    const gap: CanonicalStore = events.filter((e) => e.sequence !== 2);
    await expect(attestIssuance(gap, capabilityId, testSigner())).rejects.toBeInstanceOf(AttestationRefusedError);
  });
  it("a signer that returns something other than 64 bytes is refused", async () => {
    const { events, capabilityId } = await buildFixture();
    const broken: ProofSigner = { keyId: TEST_KEY_ID, sign: () => Promise.resolve(new Uint8Array(10)) };
    await expect(attestRedemption(events, capabilityId, broken)).rejects.toThrow(/64-byte/);
  });
});

describe("strict structure at every level of the envelope (L0)", () => {
  async function sample(): Promise<{ issuance: IssuanceAttestation; redemption: RedemptionAttestation }> {
    const f = await buildFixture();
    return { issuance: await attestIssuance(f.events, f.capabilityId, testSigner()), redemption: await attestRedemption(f.events, f.capabilityId, testSigner()) };
  }
  const withMember = (a: Attestation, path: string[]): unknown => {
    const copy = structuredClone(a) as unknown as Record<string, unknown>;
    let o: Record<string, unknown> = copy;
    for (const p of path) o = (Array.isArray(o[p]) ? (o[p] as Record<string, unknown>[])[0]! : o[p]) as Record<string, unknown>;
    o.unknown_member = 1;
    return copy;
  };

  it("a valid attestation passes", async () => {
    const { issuance, redemption } = await sample();
    expect(validateAttestationStructure(issuance).ok).toBe(true);
    expect(validateAttestationStructure(redemption).ok).toBe(true);
  });

  it.each([[[]], [["engine"]], [["journal"]], [["signature"]], [["statement"]], [["statement", "event"]], [["statement", "granted_chain_ref"]]])("an unknown member at %j is refused", async (path) => {
    const { issuance } = await sample();
    const r = validateAttestationStructure(withMember(issuance, path));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join(" ")).toMatch(/unknown member "unknown_member"/);
  });

  it("every member of every object is required", async () => {
    const { issuance } = await sample();
    const groups: [string[], readonly string[]][] = [
      [[], FORMAT_FIELDS.attestation], [["engine"], FORMAT_FIELDS.engine], [["journal"], FORMAT_FIELDS.journal], [["signature"], FORMAT_FIELDS.signature],
      [["statement", "event"], FORMAT_FIELDS.event], [["statement"], [...FORMAT_FIELDS.statementCommon, ...FORMAT_FIELDS.issuanceOnly]],
    ];
    for (const [path, fields] of groups) {
      for (const field of fields) {
        const copy = structuredClone(issuance) as unknown as Record<string, unknown>;
        let o = copy;
        for (const p of path) o = o[p] as Record<string, unknown>;
        delete o[field];
        expect(validateAttestationStructure(copy).ok, `${path.join(".")}.${field}`).toBe(false);
      }
    }
  });

  it("an ISSUANCE-only member in a REDEMPTION is refused, and a REDEMPTION lacking nothing is not an ISSUANCE", async () => {
    const { redemption, issuance } = await sample();
    const r = structuredClone(redemption) as unknown as Record<string, Record<string, unknown>>;
    r.statement!.expires_at = "2025-01-01T09:15:00.000Z";
    expect(validateAttestationStructure(r).ok).toBe(false);
    const i = structuredClone(issuance) as unknown as Record<string, unknown>;
    i.kind = "REDEMPTION";
    expect(validateAttestationStructure(i).ok).toBe(false);
  });

  it.each([
    ["proof_version", "authority-attestation/v2"], ["kind", "DECISION"], ["engine.id", "other-engine"], ["engine.protocol_version", 2], ["engine.event_schema_version", 2],
    ["journal.scheme", "authority-journal-chain/v2"], ["journal.head_hash", "A".repeat(64)], ["journal.head_sequence", 0], ["journal.head_sequence", 1.5],
    ["signature.alg", "none"], ["signature.alg", "ES256"], ["signature.key_id", "short"], ["signature.sig", "short"], ["signature.sig", "A".repeat(87)],
    ["statement.event.authority_time", "2025-01-01T09:12:00Z"], ["statement.event.authority_time", "2025-02-30T09:12:00.000Z"], ["statement.event.sequence", -1],
    ["statement.action_fingerprint", "xyz"], ["statement.capability_id", ""], ["statement.enforcement_point_id", "a\u0000b"], ["statement.decision_sequence", "3"],
    ["statement.expires_at", "tomorrow"],
  ])("%s = %j is refused", async (path, value) => {
    const { issuance } = await sample();
    const copy = structuredClone(issuance) as unknown as Record<string, unknown>;
    const parts = (path as string).split(".");
    let o = copy;
    for (const p of parts.slice(0, -1)) o = o[p] as Record<string, unknown>;
    o[parts[parts.length - 1]!] = value;
    expect(validateAttestationStructure(copy).ok).toBe(false);
  });

  it("a chain link must be a closed delegation or approval object, and the chain is bounded", async () => {
    const { issuance } = await sample();
    const mk = (chain: unknown) => ({ ...structuredClone(issuance), statement: { ...structuredClone(issuance.statement), granted_chain_ref: chain } });
    expect(validateAttestationStructure(mk([{ kind: "delegation", delegation_id: "d" }, { kind: "approval", approval_id: "a" }])).ok).toBe(true);
    expect(validateAttestationStructure(mk([{ kind: "delegation", delegation_id: "d", extra: 1 }])).ok).toBe(false);
    expect(validateAttestationStructure(mk([{ kind: "grant" }])).ok).toBe(false);
    expect(validateAttestationStructure(mk([])).ok).toBe(false);
    expect(validateAttestationStructure(mk(Array.from({ length: 65 }, () => ({ kind: "delegation", delegation_id: "d" })))).ok).toBe(false);
  });

  it("the verifier accepts what the builder produced and nothing about the builders' output is unknown to the verifier", async () => {
    const { issuance, redemption } = await sample();
    for (const a of [issuance, redemption]) expect(verifyAttestation(JSON.stringify(a), { keys: testKeys() }).result).toBe("CONSISTENT_L1");
  });
});
