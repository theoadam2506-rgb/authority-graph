import { describe, expect, it } from "vitest";
import { canonicalizeToolArguments } from "../../src/domain/canonicalJson.js";
import { SIGNING_PREFIX, attestIssuance, attestRedemption, signingBytes, type Attestation } from "../../src/proof/attestation.js";
import { base64urlEncode } from "../../src/proof/encoding.js";
import { generateDevelopmentKeyPair, createEd25519Signer, keyIdOf, type TrustedKeys } from "../../src/proof/keys.js";
import { NOT_ESTABLISHED, validateExpectedContext, verifyAttestation, type ExpectedContext } from "../../src/proof/verify.js";
import { EP, TEST_KEY_ID, TEST_PRIVATE_JWK, TEST_PUBLIC_JWK, buildFixture, testKeys, testSigner } from "./fixture.js";

async function samples() {
  const f = await buildFixture();
  const issuance = await attestIssuance(f.events, f.capabilityId, testSigner());
  const redemption = await attestRedemption(f.events, f.capabilityId, testSigner());
  return { f, issuance, redemption, issuanceText: JSON.stringify(issuance), redemptionText: JSON.stringify(redemption) };
}
const check = (r: { checks: readonly { id: string; status: string }[] }, id: string) => r.checks.find((c) => c.id === id)?.status;

describe("what a result says, and what it never says", () => {
  it("L1 alone is CONSISTENT_L1, with L2 NOT_CHECKED, and every result lists what is not established", async () => {
    const { redemptionText } = await samples();
    const r = verifyAttestation(redemptionText, { keys: testKeys() });
    expect(r.result).toBe("CONSISTENT_L1");
    expect(r.levels).toEqual({ L0: "PASS", L1: "PASS", L2: "NOT_CHECKED" });
    expect(r.not_established).toEqual(NOT_ESTABLISHED);
    expect(r.not_established.join(" ")).toMatch(/decision is correct/);
    expect(r.not_established.join(" ")).toMatch(/authentic/);
    expect(r.not_established.join(" ")).toMatch(/complete/);
    expect(r.not_established.join(" ")).toMatch(/not a person or an organization/);
    expect(r.key).toEqual({ key_id: TEST_KEY_ID });
  });

  it("the passing checks themselves say they are not a validation of the decision", async () => {
    const { redemptionText } = await samples();
    const r = verifyAttestation(redemptionText, { keys: testKeys(), expected: { enforcement_point_id: EP } });
    expect(r.checks.find((c) => c.id === "L0.CONSISTENCY")?.detail).toMatch(/not a validation of the decision/);
    expect(r.checks.find((c) => c.id === "L1.SIGNATURE")?.detail).toMatch(/nothing about whether the decision is right/);
    expect(r.checks.find((c) => c.id === "L2.CONTEXT")?.detail).toMatch(/not a validation of the decision/);
  });

  it("a REJECTED result carries the same list, and no verdict word suggests the decision was judged", async () => {
    const r = verifyAttestation("{}", { keys: testKeys() });
    expect(r.result).toBe("REJECTED");
    expect(r.not_established).toEqual(NOT_ESTABLISHED);
    expect(JSON.stringify(r)).not.toMatch(/"valid"|"authorized"|"approved"/i);
  });

  it("MISLEADING-BY-DESIGN CASE: a validly signed LIE passes L1 and L2, because L0-L2 do not validate the decision", async () => {
    const { redemption } = await samples();
    // The key holder signs a statement the journal does not support: another principal, a journal head that matches no journal.
    const lie = structuredClone(redemption) as unknown as Record<string, any>;
    lie.statement.principal_id = "someone-who-never-acted";
    lie.journal.head_hash = "ab".repeat(32);
    const signature = (await testSigner().sign(signingBytes({ ...lie, signature: { alg: "Ed25519", key_id: TEST_KEY_ID } } as never)));
    lie.signature.sig = base64urlEncode(signature);
    const r = verifyAttestation(JSON.stringify(lie), { keys: testKeys(), expected: { enforcement_point_id: EP, principal_id: "someone-who-never-acted" } });
    expect(r.result).toBe("CONSISTENT_L2"); // consistent with ITSELF and with what the verifier asked for; not true
    expect(r.not_established.join(" ")).toMatch(/not re-derived/);
  });
});

describe("L0: refusing malformed input", () => {
  it.each([
    ["not JSON", "this is not json"], ["empty", ""], ["a JSON array", "[]"], ["null", "null"], ["a duplicate key", '{"kind":"ISSUANCE","kind":"REDEMPTION"}'],
  ])("%s", (_name, text) => expect(verifyAttestation(text as string, { keys: testKeys() }).result).toBe("REJECTED"));

  it("duplicate keys inside a real attestation are refused at L0, never resolved by 'last one wins'", async () => {
    const { redemptionText } = await samples();
    const duplicated = redemptionText.replace('"kind":"REDEMPTION"', '"kind":"REDEMPTION","kind":"ISSUANCE"');
    const r = verifyAttestation(duplicated, { keys: testKeys() });
    expect(r.result).toBe("REJECTED");
    expect(r.checks.find((c) => c.id === "L0.JSON_STRICT")?.detail).toMatch(/DUPLICATE_KEY/);
  });

  it.each([
    ["a fractional sequence", (t: string) => t.replace(/"head_sequence":(\d+)/, '"head_sequence":$1.0')],
    ["an exponent sequence", (t: string) => t.replace(/"head_sequence":(\d+)/, '"head_sequence":$1e0')],
    ["an unrepresentable integer", (t: string) => t.replace(/"head_sequence":(\d+)/, '"head_sequence":9007199254740993')],
    ["a leading zero", (t: string) => t.replace(/"head_sequence":(\d+)/, '"head_sequence":0$1')],
    ["negative zero", (t: string) => t.replace(/"decision_sequence":(\d+)/, '"decision_sequence":-0')],
  ])("%s is refused at L0", async (_n, mutate) => {
    const { redemptionText } = await samples();
    const r = verifyAttestation((mutate as (t: string) => string)(redemptionText), { keys: testKeys() });
    expect(r.levels.L0).toBe("FAIL");
    expect(r.checks.find((c) => c.id === "L0.JSON_STRICT")?.detail).toMatch(/NUMBER_NOT_EXACT_INTEGER/);
  });

  it("the same document with different whitespace or key order still verifies (one signed meaning, many texts), but never with a different meaning", async () => {
    const { redemption } = await samples();
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(redemption).reverse()), null, 3);
    expect(verifyAttestation(reordered, { keys: testKeys() }).result).toBe("CONSISTENT_L1");
  });

  it("raw bytes work, invalid UTF-8 and a BOM do not, and oversized input is refused", async () => {
    const { redemptionText } = await samples();
    expect(verifyAttestation(new TextEncoder().encode(redemptionText), { keys: testKeys() }).result).toBe("CONSISTENT_L1");
    expect(verifyAttestation(new Uint8Array([0x7b, 0xff, 0x7d]), { keys: testKeys() }).levels.L0).toBe("FAIL");
    expect(verifyAttestation("﻿" + redemptionText, { keys: testKeys() }).levels.L0).toBe("FAIL");
    expect(verifyAttestation(redemptionText + " ".repeat(70_000), { keys: testKeys() }).levels.L0).toBe("FAIL");
  });

  it("a statement inconsistent with itself is refused at L0, even though its signature would verify", async () => {
    const { redemption } = await samples();
    const cases: [string, (a: Record<string, any>) => void][] = [
      ["head before the event", (a) => { a.journal.head_sequence = 1; }],
      ["decision_sequence is not sequence - 1", (a) => { a.statement.decision_sequence = 0; }],
    ];
    for (const [name, mutate] of cases) {
      const a = structuredClone(redemption) as unknown as Record<string, any>;
      mutate(a);
      a.signature.sig = base64urlEncode(await testSigner().sign(signingBytes({ ...a, signature: { alg: "Ed25519", key_id: TEST_KEY_ID } } as never)));
      const r = verifyAttestation(JSON.stringify(a), { keys: testKeys() });
      expect(r.levels.L0, name).toBe("FAIL");
      expect(check(r, "L0.CONSISTENCY"), name).toBe("FAIL");
    }
    const { issuance } = await samples();
    const i = structuredClone(issuance) as unknown as Record<string, any>;
    i.statement.expires_at = i.statement.event.authority_time;
    i.signature.sig = base64urlEncode(await testSigner().sign(signingBytes({ ...i, signature: { alg: "Ed25519", key_id: TEST_KEY_ID } } as never)));
    expect(check(verifyAttestation(JSON.stringify(i), { keys: testKeys() }), "L0.CONSISTENCY")).toBe("FAIL");
  });
});

describe("L1: every byte of the document and the signature is bound", () => {
  /** Every leaf of the attestation except the signature, with a mutated value that keeps its shape. */
  function leaves(a: Attestation): { path: (string | number)[]; mutate: (copy: Record<string, any>) => void }[] {
    const out: { path: (string | number)[]; mutate: (copy: Record<string, any>) => void }[] = [];
    const walk = (value: unknown, path: (string | number)[]): void => {
      if (path[0] === "signature") return;
      if (Array.isArray(value)) value.forEach((v, i) => walk(v, [...path, i]));
      else if (typeof value === "object" && value !== null) for (const k of Object.keys(value)) walk((value as Record<string, unknown>)[k], [...path, k]);
      else out.push({ path, mutate: (copy) => {
        let o: any = copy;
        for (const p of path.slice(0, -1)) o = o[p];
        const key = path[path.length - 1]!;
        const v = o[key];
        if (typeof v === "number") o[key] = v + 1;
        else if (/^\d{4}-\d\d-\d\dT/.test(v)) o[key] = new Date(Date.parse(v) + 1).toISOString();
        else if (/^[0-9a-f]{64}$/.test(v)) o[key] = (v[0] === "0" ? "1" : "0") + v.slice(1);
        else if (v === "ISSUANCE" || v === "REDEMPTION") o[key] = v === "ISSUANCE" ? "REDEMPTION" : "ISSUANCE";
        else if (v === "delegation") o[key] = "approval";
        else o[key] = v + "x";
      } });
    };
    walk(a, []);
    return out;
  }

  it.each(["issuanceText", "redemptionText"] as const)("mutating ANY leaf of the %s makes the result REJECTED", async (which) => {
    const s = await samples();
    const original = JSON.parse(s[which]) as Attestation;
    const all = leaves(original);
    expect(all.length).toBeGreaterThan(15);
    let rejectedAtL1 = 0;
    for (const leaf of all) {
      const copy = structuredClone(original) as unknown as Record<string, any>;
      leaf.mutate(copy);
      const r = verifyAttestation(JSON.stringify(copy), { keys: testKeys() });
      expect(r.result, leaf.path.join(".")).toBe("REJECTED");
      if (r.levels.L0 === "PASS") {
        expect(check(r, "L1.SIGNATURE"), leaf.path.join(".")).toBe("FAIL");
        rejectedAtL1 += 1;
      }
    }
    expect(rejectedAtL1).toBeGreaterThan(5); // the signature, not just the schema, is what catches well-formed edits
  });

  it("flipping any single bit of the signature is refused", async () => {
    const { redemption } = await samples();
    const sig = Buffer.from(redemption.signature.sig, "base64url");
    for (let byte = 0; byte < 64; byte += 1) {
      const bad = Buffer.from(sig);
      bad[byte] = (bad[byte] ?? 0) ^ (1 << (byte % 8));
      const a = { ...redemption, signature: { ...redemption.signature, sig: bad.toString("base64url") } };
      expect(verifyAttestation(JSON.stringify(a), { keys: testKeys() }).result, `byte ${byte}`).toBe("REJECTED");
    }
  });

  it("a signature that is not canonical base64url, or padded, is refused before any cryptography", async () => {
    const { redemption } = await samples();
    for (const sig of [redemption.signature.sig + "=", redemption.signature.sig.slice(0, -1), redemption.signature.sig.replace(/-/g, "+")]) {
      const r = verifyAttestation(JSON.stringify({ ...redemption, signature: { ...redemption.signature, sig } }), { keys: testKeys() });
      expect(r.result).toBe("REJECTED");
    }
  });

  it("base64url with non-zero stray trailing bits decodes to the same bytes but is a DIFFERENT text: refused (one text per value)", async () => {
    const { redemption } = await samples();
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const sibling = (text: string): string => {
      const last = alphabet.indexOf(text[text.length - 1]!);
      const other = alphabet[last ^ 1]!; // differs only in the lowest (stray) bit
      return text.slice(0, -1) + other;
    };
    // Same bytes, different spelling:
    expect(Buffer.from(sibling(redemption.signature.sig), "base64url").equals(Buffer.from(redemption.signature.sig, "base64url"))).toBe(true);
    for (const field of ["sig", "key_id"] as const) {
      const a = { ...redemption, signature: { ...redemption.signature, [field]: sibling(redemption.signature[field]) } };
      const r = verifyAttestation(JSON.stringify(a), { keys: testKeys() });
      expect(r.result, field).toBe("REJECTED");
      expect(r.levels.L0, field).toBe("FAIL");
    }
  });

  it("an attestation signed by a key the verifier does not trust is refused (key_id is not self-authenticating)", async () => {
    const { f } = await samples();
    const stranger = generateDevelopmentKeyPair();
    const a = await attestRedemption(f.events, f.capabilityId, createEd25519Signer(stranger.privateJwk));
    const r = verifyAttestation(JSON.stringify(a), { keys: testKeys() });
    expect(r.result).toBe("REJECTED");
    expect(check(r, "L1.KEY_KNOWN")).toBe("FAIL");
  });

  it("claiming another trusted key's key_id does not transfer its authority: the signature fails", async () => {
    const { f } = await samples();
    const other = generateDevelopmentKeyPair();
    const keys: TrustedKeys = new Map([...testKeys(), [keyIdOf(other.publicJwk), { publicKey: other.publicJwk }]]);
    const byOther = await attestRedemption(f.events, f.capabilityId, createEd25519Signer(other.privateJwk));
    const swapped = { ...byOther, signature: { ...byOther.signature, key_id: TEST_KEY_ID } };
    expect(verifyAttestation(JSON.stringify(swapped), { keys }).result).toBe("REJECTED");
    expect(verifyAttestation(JSON.stringify(byOther), { keys }).result).toBe("CONSISTENT_L1");
  });

  it("a trusted-keys entry whose public key does not hash to its key_id cannot be used", async () => {
    const { redemption } = await samples();
    const other = generateDevelopmentKeyPair();
    const keys: TrustedKeys = new Map([[TEST_KEY_ID, { publicKey: other.publicJwk }]]);
    const r = verifyAttestation(JSON.stringify(redemption), { keys });
    expect(r.result).toBe("REJECTED");
    expect(check(r, "L1.KEY_BINDING")).toBe("FAIL");
  });

  it("the algorithm is fixed: alg none, ES256 or HS256 are refused at L0", async () => {
    const { redemption } = await samples();
    for (const alg of ["none", "ES256", "HS256", "EdDSA", "ed25519"]) {
      const r = verifyAttestation(JSON.stringify({ ...redemption, signature: { ...redemption.signature, alg } }), { keys: testKeys() });
      expect(r.levels.L0, alg).toBe("FAIL");
    }
  });

  it("an ISSUANCE signature cannot be passed off as a REDEMPTION, nor an old protocol version as the current one", async () => {
    const { issuance, redemption } = await samples();
    expect(verifyAttestation(JSON.stringify({ ...issuance, kind: "REDEMPTION" }), { keys: testKeys() }).result).toBe("REJECTED");
    expect(verifyAttestation(JSON.stringify({ ...redemption, proof_version: "authority-attestation/v0" }), { keys: testKeys() }).result).toBe("REJECTED");
  });

  it("the domain separation prefix is part of what is signed: a signature over the bare JCS does not verify", async () => {
    const { redemption } = await samples();
    const { signature, ...rest } = redemption;
    const bare = Buffer.from(canonicalizeToolArguments({ ...rest, signature: { alg: signature.alg, key_id: signature.key_id } }), "utf8");
    const sig = base64urlEncode(await testSigner().sign(bare));
    expect(verifyAttestation(JSON.stringify({ ...redemption, signature: { ...signature, sig } }), { keys: testKeys() }).result).toBe("REJECTED");
    expect(SIGNING_PREFIX.length).toBeGreaterThan(0);
  });
});

describe("L1: key windows and revocation (evaluated on the CLAIMED time)", () => {
  const claimed = "2025-01-01T09:12:00.000Z";
  it.each([
    ["not_before in the future of the claim", { notBefore: "2025-01-01T09:12:00.001Z" }, "REJECTED"],
    ["not_before exactly at the claim", { notBefore: claimed }, "CONSISTENT_L1"],
    ["not_after before the claim", { notAfter: "2025-01-01T09:11:59.999Z" }, "REJECTED"],
    ["not_after exactly at the claim", { notAfter: claimed }, "CONSISTENT_L1"],
    ["revoked from exactly the claim (inclusive)", { revokedFrom: claimed }, "REJECTED"],
    ["revoked from just after the claim", { revokedFrom: "2025-01-01T09:12:00.001Z" }, "CONSISTENT_L1"],
    ["revoked from before the claim", { revokedFrom: "2025-01-01T00:00:00.000Z" }, "REJECTED"],
    ["revoked ALWAYS", { revokedFrom: "ALWAYS" }, "REJECTED"],
  ] as const)("%s", async (_name, extra, expected) => {
    const { redemptionText } = await samples();
    expect(verifyAttestation(redemptionText, { keys: testKeys(extra) }).result).toBe(expected);
  });

  it("RESIDUAL, DOCUMENTED: a revocation INSTANT does not stop a compromised key from signing a backdated claim; only ALWAYS does", async () => {
    const { redemption } = await samples();
    const keys = testKeys({ revokedFrom: "2025-06-01T00:00:00.000Z" }); // the operator learns of the compromise on 2025-06-01
    // The attacker holds the key and signs, today, a statement CLAIMING an earlier time.
    const forged = structuredClone(redemption) as unknown as Record<string, any>;
    forged.statement.event.authority_time = "2025-01-01T09:12:00.000Z";
    forged.statement.principal_id = "attacker-chosen";
    forged.signature.sig = base64urlEncode(await testSigner().sign(signingBytes({ ...forged, signature: { alg: "Ed25519", key_id: TEST_KEY_ID } } as never)));
    expect(verifyAttestation(JSON.stringify(forged), { keys }).result).toBe("CONSISTENT_L1"); // indistinguishable from a genuine pre-compromise attestation
    expect(verifyAttestation(JSON.stringify(forged), { keys: testKeys({ revokedFrom: "ALWAYS" }) }).result).toBe("REJECTED");
  });

  it("a label is never read: a key labelled as someone else's is still just a key", async () => {
    const { redemptionText } = await samples();
    const r = verifyAttestation(redemptionText, { keys: testKeys({ label: "Example Bank (verified)" }) });
    expect(r.key).toEqual({ key_id: TEST_KEY_ID, label: "Example Bank (verified)" });
    expect(r.not_established.join(" ")).toMatch(/not a person or an organization/);
  });
});

describe("L2: the expected context", () => {
  const exp = (e: ExpectedContext): ExpectedContext => e;

  it("passes when everything expected matches, for both kinds", async () => {
    const { f, redemptionText, issuanceText, redemption, issuance } = await samples();
    const r = verifyAttestation(redemptionText, { keys: testKeys(), expected: exp({ kind: "REDEMPTION", capability_id: f.capabilityId, action_id: redemption.statement.action_id, action_fingerprint: redemption.statement.action_fingerprint, principal_id: redemption.statement.principal_id, enforcement_point_id: EP, journal_head_hash: redemption.journal.head_hash, journal_head_sequence: redemption.journal.head_sequence }) });
    expect(r.result).toBe("CONSISTENT_L2");
    expect(r.levels).toEqual({ L0: "PASS", L1: "PASS", L2: "PASS" });
    expect(verifyAttestation(issuanceText, { keys: testKeys(), expected: exp({ kind: "ISSUANCE", capability_id: f.capabilityId, enforcement_point_id: EP, action_fingerprint: issuance.statement.action_fingerprint }) }).result).toBe("CONSISTENT_L2");
  });

  it.each([
    ["kind", { kind: "ISSUANCE" }], ["capability_id", { capability_id: "cap-other" }], ["action_id", { action_id: "act-other" }], ["action_fingerprint", { action_fingerprint: "f".repeat(64) }],
    ["principal_id", { principal_id: "someone-else" }], ["enforcement_point_id", { enforcement_point_id: "ep-other" }], ["journal_head_hash", { journal_head_hash: "0".repeat(64) }], ["journal_head_sequence", { journal_head_sequence: 999 }],
  ] as const)("a mismatching expected %s is refused at L2 and the result is REJECTED", async (name, wrong) => {
    const { redemptionText } = await samples();
    const r = verifyAttestation(redemptionText, { keys: testKeys(), expected: { enforcement_point_id: EP, ...wrong } as ExpectedContext });
    expect(r.result).toBe("REJECTED");
    expect(r.levels).toEqual({ L0: "PASS", L1: "PASS", L2: "FAIL" });
    expect(r.checks.find((c) => c.id === "L2.CONTEXT")?.detail).toContain(name);
  });

  it("a REDEMPTION cannot be verified at L2 without the expected enforcement_point_id", async () => {
    const { f, redemptionText } = await samples();
    const r = verifyAttestation(redemptionText, { keys: testKeys(), expected: { capability_id: f.capabilityId } });
    expect(r.result).toBe("REJECTED");
    expect(r.checks.find((c) => c.id === "L2.CONTEXT")?.detail).toMatch(/requires the expected enforcement_point_id/);
  });

  it("an empty expected context binds nothing and is refused rather than passing vacuously", async () => {
    const { issuanceText } = await samples();
    const r = verifyAttestation(issuanceText, { keys: testKeys(), expected: {} });
    expect(r.result).toBe("REJECTED");
    expect(r.checks.find((c) => c.id === "L2.CONTEXT")?.detail).toMatch(/binds nothing/);
  });

  it("freshness is explicit and ISSUANCE-only: valid strictly before expires_at, expired at it, and not applicable to a REDEMPTION", async () => {
    const { issuance, issuanceText, redemptionText } = await samples();
    const expiresMs = Date.parse(issuance.statement.expires_at);
    const at = (ms: number) => new Date(ms).toISOString();
    expect(verifyAttestation(issuanceText, { keys: testKeys(), expected: { capability_id: issuance.statement.capability_id, at: at(expiresMs - 1) } }).result).toBe("CONSISTENT_L2");
    expect(verifyAttestation(issuanceText, { keys: testKeys(), expected: { capability_id: issuance.statement.capability_id, at: at(expiresMs) } }).result).toBe("REJECTED");
    expect(verifyAttestation(redemptionText, { keys: testKeys(), expected: { enforcement_point_id: EP, at: at(expiresMs - 1) } }).result).toBe("REJECTED");
  });

  it("L2 is not evaluated when L1 failed (a forged document never gets a context verdict)", async () => {
    const { redemption } = await samples();
    const r = verifyAttestation(JSON.stringify({ ...redemption, statement: { ...redemption.statement, capability_id: "tampered" } }), { keys: testKeys(), expected: { enforcement_point_id: EP, capability_id: "tampered" } });
    expect(r.levels).toEqual({ L0: "PASS", L1: "FAIL", L2: "NOT_CHECKED" });
  });
});

describe("L2: the expected context is validated as strictly as the attestation (no silent pass from a verifier's own mistake)", () => {
  const detail = (r: { checks: readonly { id: string; detail?: string }[] }) => r.checks.find((c) => c.id === "L2.EXPECTED_VALID")?.detail ?? "";

  it("a canonical expected.at is accepted: valid strictly before expires_at on an ISSUANCE", async () => {
    const { issuance, issuanceText } = await samples();
    const r = verifyAttestation(issuanceText, { keys: testKeys(), expected: { capability_id: issuance.statement.capability_id, at: "2025-01-01T09:11:00.000Z" } });
    expect(r.result).toBe("CONSISTENT_L2");
    expect(check(r, "L2.EXPECTED_VALID")).toBe("PASS");
  });

  it.each([
    ["a date without a time", "2025-01-01"],
    ["no milliseconds", "2025-01-01T09:11:00Z"],
    ["one millisecond digit", "2025-01-01T09:11:00.0Z"],
    ["four millisecond digits", "2025-01-01T09:11:00.0000Z"],
    ["a numeric offset", "2025-01-01T10:11:00.000+01:00"],
    ["a zero offset instead of Z", "2025-01-01T09:11:00.000+00:00"],
    ["no zone designator", "2025-01-01T09:11:00.000"],
    ["a lowercase t", "2025-01-01t09:11:00.000Z"],
    ["a lowercase z", "2025-01-01T09:11:00.000z"],
    ["a space instead of T", "2025-01-01 09:11:00.000Z"],
    ["an impossible date (30 February)", "2025-02-30T09:11:00.000Z"],
    ["an impossible month", "2025-13-01T09:11:00.000Z"],
    ["hour 24", "2025-01-01T24:00:00.000Z"],
    ["a leap second", "2025-12-31T23:59:60.000Z"],
    ["leading whitespace", " 2025-01-01T09:11:00.000Z"],
    ["trailing whitespace", "2025-01-01T09:11:00.000Z "],
    ["an extended year", "+012025-01-01T09:11:00.000Z"],
    ["an empty string", ""],
    ["a word", "now"],
    ["a numeric string", "1735722660000"],
    ["a number", 1735722660000],
    ["null", null],
    ["a boolean", true],
    ["an object", {}],
    ["an array", ["2025-01-01T09:11:00.000Z"]],
  ])("expected.at = %s is refused as invalid, not guessed", async (_name, at) => {
    const { issuance, issuanceText } = await samples();
    const r = verifyAttestation(issuanceText, { keys: testKeys(), expected: { capability_id: issuance.statement.capability_id, at } as unknown as ExpectedContext });
    expect(r.result).toBe("REJECTED");
    expect(r.levels).toEqual({ L0: "PASS", L1: "PASS", L2: "FAIL" });
    expect(check(r, "L2.EXPECTED_VALID")).toBe("FAIL");
    expect(detail(r)).toMatch(/expected\.at must be a canonical UTC instant/);
  });

  it("an invalid expected.at is reported as invalid on a REDEMPTION too (never silently ignored)", async () => {
    const { redemptionText } = await samples();
    const r = verifyAttestation(redemptionText, { keys: testKeys(), expected: { enforcement_point_id: EP, at: "2025-01-01" } as ExpectedContext });
    expect(r.result).toBe("REJECTED");
    expect(check(r, "L2.EXPECTED_VALID")).toBe("FAIL");
  });

  it("a canonical expected.at on a REDEMPTION is still refused (freshness is ISSUANCE-only)", async () => {
    const { redemptionText } = await samples();
    const r = verifyAttestation(redemptionText, { keys: testKeys(), expected: { enforcement_point_id: EP, at: "2025-01-01T09:11:00.000Z" } });
    expect(r.result).toBe("REJECTED");
    expect(check(r, "L2.EXPECTED_VALID")).toBe("PASS");
    expect(r.checks.find((c) => c.id === "L2.CONTEXT")?.detail).toMatch(/applies to ISSUANCE only/);
  });

  it("an undefined expected.at binds nothing and is treated as absent (the object is not refused for it)", async () => {
    const { redemptionText } = await samples();
    expect(verifyAttestation(redemptionText, { keys: testKeys(), expected: { enforcement_point_id: EP, at: undefined } as unknown as ExpectedContext }).result).toBe("CONSISTENT_L2");
  });

  it.each([
    ["enforcement_pont_id (a typo)", { enforcement_pont_id: EP }],
    ["a member of the attestation instead of the context", { journal: "x" }],
    ["a snake/camel mix-up", { enforcementPointId: EP }],
  ])("an unknown expected member (%s) is refused: a typo must not look like a bound context", async (_name, expected) => {
    const { issuanceText } = await samples();
    const r = verifyAttestation(issuanceText, { keys: testKeys(), expected: expected as unknown as ExpectedContext });
    expect(r.result).toBe("REJECTED");
    expect(detail(r)).toMatch(/unknown expected member/);
  });

  it.each([
    ["journal_head_hash in uppercase", { journal_head_hash: "AB".repeat(32) }],
    ["journal_head_hash too short", { journal_head_hash: "ab" }],
    ["action_fingerprint not hex", { action_fingerprint: "z".repeat(64) }],
    ["journal_head_sequence zero", { journal_head_sequence: 0 }],
    ["journal_head_sequence fractional", { journal_head_sequence: 1.5 }],
    ["journal_head_sequence as a string", { journal_head_sequence: "5" }],
    ["journal_head_sequence NaN", { journal_head_sequence: Number.NaN }],
    ["kind DECISION", { kind: "DECISION" }],
    ["an empty identifier", { capability_id: "" }],
    ["a non-string identifier", { action_id: 5 }],
    ["an identifier with a control character", { principal_id: "a\u0000b" }],
    ["an over-long identifier", { enforcement_point_id: "x".repeat(257) }],
  ])("%s is refused as an invalid expected context", async (_name, bad) => {
    const { issuanceText } = await samples();
    const r = verifyAttestation(issuanceText, { keys: testKeys(), expected: { capability_id: "c", ...bad } as unknown as ExpectedContext });
    expect(r.result).toBe("REJECTED");
    expect(check(r, "L2.EXPECTED_VALID")).toBe("FAIL");
  });

  it.each([[null], [[]], ["x"], [5]])("an expected context that is not an object (%j) is refused", async (bad) => {
    const { issuanceText } = await samples();
    const r = verifyAttestation(issuanceText, { keys: testKeys(), expected: bad as unknown as ExpectedContext });
    expect(r.result).not.toBe("CONSISTENT_L2");
  });

  it("validateExpectedContext is exported and agrees: canonical contexts have no problem", () => {
    expect(validateExpectedContext({ at: "2025-01-01T09:11:00.000Z", enforcement_point_id: EP, journal_head_sequence: 5, journal_head_hash: "ab".repeat(32) })).toEqual([]);
    expect(validateExpectedContext({ at: "2025-01-01" }).length).toBe(1);
  });

  it("an invalid expected context is never evaluated when L1 already failed (no verdict for a forged document)", async () => {
    const { redemption } = await samples();
    const r = verifyAttestation(JSON.stringify({ ...redemption, statement: { ...redemption.statement, capability_id: "tampered" } }), { keys: testKeys(), expected: { at: "nope" } as unknown as ExpectedContext });
    expect(r.levels).toEqual({ L0: "PASS", L1: "FAIL", L2: "NOT_CHECKED" });
  });
});

describe("robustness: seeded mutation of the raw text", () => {
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0x100000000);
  }
  it("never throws, and never accepts a text whose canonical meaning differs from the genuine one (3000 mutations)", async () => {
    const { redemptionText, redemption } = await samples();
    const genuine = canonicalizeToolArguments(redemption);
    const rand = lcg(20250101);
    const alphabet = '{}[]",:0123456789abcxyz \n\\-.eE';
    let accepted = 0;
    for (let n = 0; n < 3000; n += 1) {
      let t = redemptionText;
      const edits = 1 + Math.floor(rand() * 3);
      for (let e = 0; e < edits; e += 1) {
        const pos = Math.floor(rand() * t.length);
        const op = rand();
        if (op < 0.4) t = t.slice(0, pos) + t.slice(pos + 1);
        else if (op < 0.8) t = t.slice(0, pos) + alphabet[Math.floor(rand() * alphabet.length)] + t.slice(pos + 1);
        else t = t.slice(0, pos) + alphabet[Math.floor(rand() * alphabet.length)] + t.slice(pos);
      }
      let result;
      expect(() => { result = verifyAttestation(t, { keys: testKeys(), expected: { enforcement_point_id: EP } }); }).not.toThrow();
      if ((result as unknown as { result: string }).result !== "REJECTED") {
        accepted += 1;
        const parsed = (result as unknown as { attestation: Attestation }).attestation;
        expect(canonicalizeToolArguments(parsed)).toBe(genuine); // only a re-spelling of the very same document can pass
      }
    }
    expect(accepted).toBeLessThan(3000); // the mutator really does change things
  });
});

void TEST_PRIVATE_JWK; void TEST_PUBLIC_JWK;
