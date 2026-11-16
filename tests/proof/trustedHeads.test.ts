import { describe, expect, it } from "vitest";
import { ANCHOR_EXPLANATION, MAX_TRUSTED_HEADS, TRUSTED_HEADS_FORMAT, TrustedHeadsFormatError, parseTrustedHeads } from "../../src/proof/heads.js";

const H = "ab".repeat(32);
const doc = (heads: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ format: TRUSTED_HEADS_FORMAT, heads, ...extra });

describe("authority-trusted-heads/v1 is strict", () => {
  it("accepts a well-formed file, with or without labels", () => {
    expect(parseTrustedHeads(doc([{ head_sequence: 5, head_hash: H, label: "mine" }, { head_sequence: 9, head_hash: "cd".repeat(32) }]))).toEqual([
      { head_sequence: 5, head_hash: H, label: "mine" }, { head_sequence: 9, head_hash: "cd".repeat(32) },
    ]);
    expect(parseTrustedHeads(doc([]))).toEqual([]);
  });

  it.each([
    ["an unknown top-level member", doc([], { version: 1 })],
    ["a wrong format string", JSON.stringify({ format: "authority-trusted-heads/v2", heads: [] })],
    ["a missing format", JSON.stringify({ heads: [] })],
    ["heads not an array", doc({})],
    ["an entry that is not an object", doc([5])],
    ["an unknown member in an entry (a date, a source, a signature: nothing may make an anchor look authoritative)", doc([{ head_sequence: 5, head_hash: H, recorded_at: "2025-01-01T00:00:00.000Z" }])],
    ["a source member", doc([{ head_sequence: 5, head_hash: H, source: "notary" }])],
    ["sequence zero", doc([{ head_sequence: 0, head_hash: H }])],
    ["a negative sequence", doc([{ head_sequence: -1, head_hash: H }])],
    ["a fractional sequence", '{"format":"authority-trusted-heads/v1","heads":[{"head_sequence":1.5,"head_hash":"' + H + '"}]}'],
    ["a string sequence", doc([{ head_sequence: "5", head_hash: H }])],
    ["an unsafe sequence", '{"format":"authority-trusted-heads/v1","heads":[{"head_sequence":9007199254740993,"head_hash":"' + H + '"}]}'],
    ["an uppercase hash", doc([{ head_sequence: 5, head_hash: H.toUpperCase() }])],
    ["a short hash", doc([{ head_sequence: 5, head_hash: "ab" }])],
    ["a non-hex hash", doc([{ head_sequence: 5, head_hash: "z".repeat(64) }])],
    ["a non-string label", doc([{ head_sequence: 5, head_hash: H, label: 5 }])],
    ["an over-long label", doc([{ head_sequence: 5, head_hash: H, label: "x".repeat(257) }])],
    ["two anchors at one sequence, even if identical", doc([{ head_sequence: 5, head_hash: H }, { head_sequence: 5, head_hash: H }])],
    ["two conflicting anchors at one sequence", doc([{ head_sequence: 5, head_hash: H }, { head_sequence: 5, head_hash: "cd".repeat(32) }])],
    ["too many anchors", doc(Array.from({ length: MAX_TRUSTED_HEADS + 1 }, (_v, i) => ({ head_sequence: i + 1, head_hash: H })))],
  ])("refuses %s", (_n, text) => expect(() => parseTrustedHeads(text as string)).toThrow(/trusted heads|DUPLICATE|TOO_LONG|NUMBER/));

  it("refuses duplicate keys at the JSON level", () => {
    expect(() => parseTrustedHeads('{"format":"authority-trusted-heads/v1","heads":[],"heads":[]}')).toThrow(/DUPLICATE_KEY/);
    expect(() => parseTrustedHeads(`{"format":"authority-trusted-heads/v1","heads":[{"head_sequence":1,"head_sequence":2,"head_hash":"${H}"}]}`)).toThrow(/DUPLICATE_KEY/);
  });

  it("the error class is distinct, so a CLI can tell a bad file from a bad attestation", () => {
    expect(() => parseTrustedHeads(doc({}))).toThrow(TrustedHeadsFormatError);
  });

  it("the anchor explanations never claim independence, recency or genuineness", () => {
    for (const text of Object.values(ANCHOR_EXPLANATION)) expect(text).not.toMatch(/(?<!NOT mean the anchor )\bis independent\b|\bwas recorded independently\b|\bproves independence\b/);
    expect(ANCHOR_EXPLANATION.covers).toMatch(/does NOT mean the anchor is independent/);
    expect(ANCHOR_EXPLANATION.covers).toMatch(/proves nothing about its own independence/);
    expect(ANCHOR_EXPLANATION.covers).toMatch(/Events after the anchor are not covered/);
    expect(ANCHOR_EXPLANATION.none).toMatch(/self-consistent, would pass/);
  });
});
