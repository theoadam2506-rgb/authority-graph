/** Canonical, strict encodings used by attestations. Every decoder re-encodes and compares: one text per value. */

const B64URL = /^[A-Za-z0-9_-]+$/;
const HEX64 = /^[0-9a-f]{64}$/;

export function base64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Unpadded base64url of exactly `byteLength` bytes, canonical (no padding, no stray trailing bits). Returns undefined otherwise. */
export function base64urlDecodeExact(text: string, byteLength: number): Buffer | undefined {
  if (!B64URL.test(text)) return undefined;
  const bytes = Buffer.from(text, "base64url");
  if (bytes.length !== byteLength) return undefined;
  return bytes.toString("base64url") === text ? bytes : undefined;
}

export const isLowerHex64 = (text: string): boolean => HEX64.test(text);

export const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A UTC instant with milliseconds that round-trips through Date (so 2025-02-30 is refused). */
export function isCanonicalInstant(text: string): boolean {
  if (!ISO_INSTANT.test(text)) return false;
  const ms = Date.parse(text);
  return Number.isFinite(ms) && new Date(ms).toISOString() === text;
}
