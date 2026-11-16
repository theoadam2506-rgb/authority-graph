/**
 * Keys for attestations (Authority Proof, PR 3). Ed25519 only, JWK only (RFC 8037
 * representation), through `node:crypto`: no dependency, deterministic signatures.
 *
 * A `key_id` names a PUBLIC KEY and nothing else: it is the unpadded base64url
 * SHA-256 of the 32 raw public-key bytes. It is not the identity of a person,
 * a service or an organization. A trusted-keys file may carry a free-text
 * `label` for humans; verification never reads it, and it proves nothing.
 *
 * Key custody is out of scope: the deployment supplies a `ProofSigner`
 * (in-process key, KMS, HSM). This module offers an in-process signer built
 * from a private JWK, and a development key generator that must not be used for
 * anything real.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify, type KeyObject } from "node:crypto";
import { base64urlDecodeExact, base64urlEncode, isCanonicalInstant } from "./encoding.js";
import { parseStrictJson } from "./strictJson.js";

export interface Ed25519PublicJwk {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
}
export interface Ed25519PrivateJwk extends Ed25519PublicJwk {
  readonly d: string;
}

export class KeyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyFormatError";
  }
}

function strictJwk(value: unknown, allowed: readonly string[], required: readonly string[], what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new KeyFormatError(`${what}: expected an object`);
  const o = value as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new KeyFormatError(`${what}: unknown member ${JSON.stringify(k)}`);
  for (const k of required) if (!(k in o)) throw new KeyFormatError(`${what}: missing member ${JSON.stringify(k)}`);
  if (o.kty !== "OKP" || o.crv !== "Ed25519") throw new KeyFormatError(`${what}: only {"kty":"OKP","crv":"Ed25519"} is supported`);
  for (const k of ["x", "d"]) if (k in o && (typeof o[k] !== "string" || base64urlDecodeExact(o[k] as string, 32) === undefined)) throw new KeyFormatError(`${what}: "${k}" must be canonical unpadded base64url of 32 bytes`);
  return o;
}

export function parsePublicJwk(value: unknown): Ed25519PublicJwk {
  const o = strictJwk(value, ["kty", "crv", "x"], ["kty", "crv", "x"], "public JWK"); // a "d" member is refused: never accept private material here
  return { kty: "OKP", crv: "Ed25519", x: o.x as string };
}

export function parsePrivateJwk(value: unknown): Ed25519PrivateJwk {
  const o = strictJwk(value, ["kty", "crv", "x", "d"], ["kty", "crv", "x", "d"], "private JWK");
  return { kty: "OKP", crv: "Ed25519", x: o.x as string, d: o.d as string };
}

/** `key_id`: base64url(SHA-256(raw 32-byte public key)). Names a key, never an organization. */
export function keyIdOf(publicKey: Ed25519PublicJwk): string {
  const raw = base64urlDecodeExact(publicKey.x, 32);
  if (raw === undefined) throw new KeyFormatError("invalid public key");
  return base64urlEncode(createHash("sha256").update(raw).digest());
}

export function publicKeyObject(publicKey: Ed25519PublicJwk): KeyObject {
  try {
    return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey.x }, format: "jwk" });
  } catch {
    throw new KeyFormatError("not a valid Ed25519 public key");
  }
}

/** Verifies a raw 64-byte Ed25519 signature. Never throws: any malformation is `false`. */
export function verifyEd25519(message: Uint8Array, signature: Uint8Array, publicKey: Ed25519PublicJwk): boolean {
  try {
    if (signature.byteLength !== 64) return false;
    return nodeVerify(null, message, publicKeyObject(publicKey), signature);
  } catch {
    return false;
  }
}

export interface ProofSigner {
  readonly keyId: string;
  /** Signs exactly the bytes given (already domain-separated by the caller) and returns the raw 64-byte signature. */
  sign(message: Uint8Array): Promise<Uint8Array>;
}

/** In-process signer from a private JWK. The JWK's `x` must match its `d`. */
export function createEd25519Signer(privateJwk: unknown): ProofSigner {
  const jwk = parsePrivateJwk(privateJwk);
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d }, format: "jwk" });
  } catch {
    throw new KeyFormatError("not a valid Ed25519 private key");
  }
  const derived = createPublicKey(key).export({ format: "jwk" }) as { x?: string };
  if (derived.x !== jwk.x) throw new KeyFormatError("the private JWK's public part does not match its private part");
  return {
    keyId: keyIdOf(jwk),
    sign: (message) => Promise.resolve(new Uint8Array(nodeSign(null, message, key))),
  };
}

/**
 * DEVELOPMENT AND TESTS ONLY. Generates a random key pair. Nothing here
 * protects the private key; do not use it for any real attestation.
 */
export function generateDevelopmentKeyPair(): { readonly privateJwk: Ed25519PrivateJwk; readonly publicJwk: Ed25519PublicJwk } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" }) as { x: string; d: string };
  return { privateJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d }, publicJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x } };
}

// ---------------------------------------------------------------------------
// Trusted keys: what a VERIFIER decides to trust. Supplied by the verifier,
// never taken from the attestation.
// ---------------------------------------------------------------------------

export interface TrustedKey {
  readonly publicKey: Ed25519PublicJwk;
  /** Informative only. Not an identity, never read by verification. */
  readonly label?: string;
  /** Attestations whose CLAIMED time is before this are refused. */
  readonly notBefore?: string;
  /** Attestations whose CLAIMED time is after this are refused. */
  readonly notAfter?: string;
  /**
   * "ALWAYS": every attestation by this key is refused (the safe answer to a
   * compromise). An instant: attestations whose CLAIMED time is at or after it
   * are refused. Either way, the claimed time is the signer's own assertion; see
   * docs/v1/ATTESTATIONS.md for what this does and does not protect against.
   */
  readonly revokedFrom?: string | "ALWAYS";
}

export type TrustedKeys = ReadonlyMap<string, TrustedKey>;

export const TRUSTED_KEYS_FORMAT = "authority-trusted-keys/v1";

/** Strict parser for a trusted-keys document: {"format":"authority-trusted-keys/v1","keys":[{"jwk":{...},"label"?,"not_before"?,"not_after"?,"revoked_from"?}]}. */
export function parseTrustedKeys(text: string): TrustedKeys {
  const doc = parseStrictJson(text) as Record<string, unknown>;
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new KeyFormatError("trusted keys: expected an object");
  for (const k of Object.keys(doc)) if (k !== "format" && k !== "keys") throw new KeyFormatError(`trusted keys: unknown member ${JSON.stringify(k)}`);
  if (doc.format !== TRUSTED_KEYS_FORMAT) throw new KeyFormatError(`trusted keys: format must be ${JSON.stringify(TRUSTED_KEYS_FORMAT)}`);
  if (!Array.isArray(doc.keys)) throw new KeyFormatError("trusted keys: \"keys\" must be an array");
  const out = new Map<string, TrustedKey>();
  for (const [index, entry] of doc.keys.entries()) {
    const where = `trusted keys[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new KeyFormatError(`${where}: expected an object`);
    const e = entry as Record<string, unknown>;
    for (const k of Object.keys(e)) if (!["jwk", "label", "not_before", "not_after", "revoked_from"].includes(k)) throw new KeyFormatError(`${where}: unknown member ${JSON.stringify(k)}`);
    const publicKey = parsePublicJwk(e.jwk);
    publicKeyObject(publicKey); // must be a usable key
    const id = keyIdOf(publicKey);
    if (out.has(id)) throw new KeyFormatError(`${where}: duplicate key ${id}`);
    const instant = (name: string): string | undefined => {
      if (!(name in e)) return undefined;
      const v = e[name];
      if (typeof v !== "string" || !isCanonicalInstant(v)) throw new KeyFormatError(`${where}.${name}: expected a UTC instant YYYY-MM-DDTHH:mm:ss.sssZ`);
      return v;
    };
    if ("label" in e && typeof e.label !== "string") throw new KeyFormatError(`${where}.label: expected a string`);
    let revokedFrom: string | undefined;
    if ("revoked_from" in e) {
      revokedFrom = e.revoked_from === "ALWAYS" ? "ALWAYS" : instant("revoked_from");
    }
    const notBefore = instant("not_before");
    const notAfter = instant("not_after");
    out.set(id, {
      publicKey,
      ...(typeof e.label === "string" ? { label: e.label } : {}),
      ...(notBefore !== undefined ? { notBefore } : {}),
      ...(notAfter !== undefined ? { notAfter } : {}),
      ...(revokedFrom !== undefined ? { revokedFrom } : {}),
    });
  }
  return out;
}
