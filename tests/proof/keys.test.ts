import { createPublicKey, sign as nodeSign, createPrivateKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { base64urlEncode } from "../../src/proof/encoding.js";
import { KeyFormatError, createEd25519Signer, generateDevelopmentKeyPair, keyIdOf, parsePrivateJwk, parsePublicJwk, parseTrustedKeys, verifyEd25519 } from "../../src/proof/keys.js";
import { RFC8032_TEST1, TEST_KEY_ID, TEST_PRIVATE_JWK, TEST_PUBLIC_JWK } from "./fixture.js";

const hex = (h: string) => Buffer.from(h, "hex");
const b64u = (h: string) => base64urlEncode(hex(h));

describe("Ed25519 through node:crypto matches the RFC 8032 vectors", () => {
  it("TEST 1 (empty message): our signer reproduces the published signature and the verifier accepts it", async () => {
    const signer = createEd25519Signer(TEST_PRIVATE_JWK);
    const sig = await signer.sign(new Uint8Array());
    expect(Buffer.from(sig).toString("hex")).toBe(RFC8032_TEST1.signatureOfEmptyHex);
    expect(verifyEd25519(new Uint8Array(), sig, TEST_PUBLIC_JWK)).toBe(true);
  });

  it("TEST 2 (one byte 0x72) from the RFC", async () => {
    const priv = { kty: "OKP", crv: "Ed25519", d: b64u("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb"), x: b64u("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c") };
    const expected = "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00";
    const sig = await createEd25519Signer(priv).sign(hex("72"));
    expect(Buffer.from(sig).toString("hex")).toBe(expected);
    expect(verifyEd25519(hex("72"), hex(expected), parsePublicJwk({ kty: "OKP", crv: "Ed25519", x: priv.x }))).toBe(true);
  });

  it("signatures are deterministic: the same message and key give the same bytes", async () => {
    const s = createEd25519Signer(TEST_PRIVATE_JWK);
    expect(Buffer.from(await s.sign(Buffer.from("m")))).toEqual(Buffer.from(await s.sign(Buffer.from("m"))));
  });
});

describe("signature verification refuses what is not a canonical valid signature", () => {
  const msg = Buffer.from("authority");
  const sign = () => Buffer.from(nodeSign(null, msg, createPrivateKey({ key: { ...TEST_PRIVATE_JWK }, format: "jwk" })));

  it("a flipped bit anywhere in the signature, the message or the key is refused", () => {
    const good = sign();
    expect(verifyEd25519(msg, good, TEST_PUBLIC_JWK)).toBe(true);
    for (let i = 0; i < 64; i += 7) {
      const bad = Buffer.from(good);
      bad[i] = (bad[i] ?? 0) ^ 1;
      expect(verifyEd25519(msg, bad, TEST_PUBLIC_JWK), `byte ${i}`).toBe(false);
    }
    expect(verifyEd25519(Buffer.from("authorit0"), good, TEST_PUBLIC_JWK)).toBe(false);
    expect(verifyEd25519(msg, good, generateDevelopmentKeyPair().publicJwk)).toBe(false);
  });

  it("a malleable signature (S + L) is refused", () => {
    const good = sign();
    const L = BigInt("0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed");
    const S = BigInt("0x" + Buffer.from(good.subarray(32)).reverse().toString("hex"));
    let t = S + L;
    const s2 = Buffer.alloc(32);
    for (let i = 0; i < 32; i += 1) {
      s2[i] = Number(t & 255n);
      t >>= 8n;
    }
    expect(verifyEd25519(msg, Buffer.concat([good.subarray(0, 32), s2]), TEST_PUBLIC_JWK)).toBe(false);
  });

  it("wrong lengths and garbage never throw, they are just false", () => {
    expect(verifyEd25519(msg, Buffer.alloc(63), TEST_PUBLIC_JWK)).toBe(false);
    expect(verifyEd25519(msg, Buffer.alloc(65), TEST_PUBLIC_JWK)).toBe(false);
    expect(verifyEd25519(msg, Buffer.alloc(64), TEST_PUBLIC_JWK)).toBe(false);
    expect(verifyEd25519(msg, sign(), { kty: "OKP", crv: "Ed25519", x: "AAAA" })).toBe(false);
  });
});

describe("JWK handling is strict", () => {
  it("accepts exactly {kty, crv, x} publicly and {kty, crv, x, d} privately", () => {
    expect(parsePublicJwk({ kty: "OKP", crv: "Ed25519", x: TEST_PUBLIC_JWK.x })).toEqual(TEST_PUBLIC_JWK);
    expect(parsePrivateJwk(TEST_PRIVATE_JWK)).toEqual(TEST_PRIVATE_JWK);
  });
  it.each([
    [{ kty: "OKP", crv: "Ed25519", x: TEST_PUBLIC_JWK.x, d: TEST_PRIVATE_JWK.d }, "private material in a public JWK"],
    [{ kty: "OKP", crv: "Ed25519", x: TEST_PUBLIC_JWK.x, kid: "k" }, "an unknown member"],
    [{ kty: "EC", crv: "P-256", x: TEST_PUBLIC_JWK.x }, "another key type"],
    [{ kty: "OKP", crv: "Ed448", x: TEST_PUBLIC_JWK.x }, "another curve"],
    [{ kty: "OKP", crv: "Ed25519" }, "no x"],
    [{ kty: "OKP", crv: "Ed25519", x: TEST_PUBLIC_JWK.x + "=" }, "padded base64url"],
    [{ kty: "OKP", crv: "Ed25519", x: TEST_PUBLIC_JWK.x.slice(0, -1) }, "short key"],
    [{ kty: "OKP", crv: "Ed25519", x: TEST_PUBLIC_JWK.x.replace(/.$/, (c) => (c === "A" ? "B" : "A")) + "A" }, "long key"],
    [null, "not an object"],
    [[], "an array"],
  ])("refuses %j (%s)", (jwk: unknown, _why: unknown) => expect(() => parsePublicJwk(jwk)).toThrow(KeyFormatError));

  it("a private JWK whose x does not match its d is refused", () => {
    expect(() => createEd25519Signer({ ...TEST_PRIVATE_JWK, x: generateDevelopmentKeyPair().publicJwk.x })).toThrow(/does not match/);
  });
});

describe("key_id names a public key, nothing else", () => {
  it("is the base64url SHA-256 of the raw 32 public bytes, 43 characters, and stable", () => {
    expect(TEST_KEY_ID).toHaveLength(43);
    expect(keyIdOf(TEST_PUBLIC_JWK)).toBe(TEST_KEY_ID);
    expect(keyIdOf(generateDevelopmentKeyPair().publicJwk)).not.toBe(TEST_KEY_ID);
  });
  it("the signer exposes the same key_id, and a label in a trusted-keys file never changes it", () => {
    expect(createEd25519Signer(TEST_PRIVATE_JWK).keyId).toBe(TEST_KEY_ID);
    const doc = JSON.stringify({ format: "authority-trusted-keys/v1", keys: [{ jwk: TEST_PUBLIC_JWK, label: "ACME Corp production signer" }] });
    const keys = parseTrustedKeys(doc);
    expect([...keys.keys()]).toEqual([TEST_KEY_ID]);
    expect(keys.get(TEST_KEY_ID)?.label).toBe("ACME Corp production signer"); // informative only
  });
  void createPublicKey;
});

describe("trusted-keys documents are strict", () => {
  const ok = { format: "authority-trusted-keys/v1", keys: [{ jwk: TEST_PUBLIC_JWK }] };
  const parse = (o: unknown) => parseTrustedKeys(JSON.stringify(o));
  it("accepts windows and revocation as canonical instants or ALWAYS", () => {
    const keys = parse({ ...ok, keys: [{ jwk: TEST_PUBLIC_JWK, not_before: "2025-01-01T00:00:00.000Z", not_after: "2026-01-01T00:00:00.000Z", revoked_from: "2025-06-01T00:00:00.000Z" }] });
    expect(keys.get(TEST_KEY_ID)).toMatchObject({ notBefore: "2025-01-01T00:00:00.000Z", notAfter: "2026-01-01T00:00:00.000Z", revokedFrom: "2025-06-01T00:00:00.000Z" });
    expect(parse({ ...ok, keys: [{ jwk: TEST_PUBLIC_JWK, revoked_from: "ALWAYS" }] }).get(TEST_KEY_ID)?.revokedFrom).toBe("ALWAYS");
  });
  it.each([
    [{ ...ok, extra: 1 }, "unknown top-level member"],
    [{ ...ok, format: "authority-trusted-keys/v2" }, "wrong format"],
    [{ ...ok, keys: [{ jwk: TEST_PUBLIC_JWK, trust_level: "high" }] }, "unknown key member"],
    [{ ...ok, keys: [{ jwk: TEST_PUBLIC_JWK }, { jwk: TEST_PUBLIC_JWK }] }, "duplicate key"],
    [{ ...ok, keys: [{ jwk: TEST_PUBLIC_JWK, not_before: "2025-01-01" }] }, "non-canonical instant"],
    [{ ...ok, keys: [{ jwk: TEST_PUBLIC_JWK, revoked_from: "NEVER" }] }, "bad revocation"],
    [{ ...ok, keys: [{ jwk: TEST_PRIVATE_JWK }] }, "a private key where a public one is expected"],
    [{ ...ok, keys: [{ jwk: TEST_PUBLIC_JWK, label: 5 }] }, "non-string label"],
  ])("refuses %j (%s)", (doc: unknown, _why: unknown) => expect(() => parse(doc)).toThrow(KeyFormatError));
  it("refuses duplicate keys at the JSON level", () => {
    expect(() => parseTrustedKeys('{"format":"authority-trusted-keys/v1","keys":[],"keys":[]}')).toThrow();
  });
});
