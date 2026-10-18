import { describe, expect, it } from "vitest";
import { argumentsDigest, canonicalizeToolArguments } from "../../src/domain/canonicalJson.js";
import { computeActionFingerprint } from "../../src/domain/events.js";
import { capability, nonMonetaryParameters, type ActionParameters } from "../../src/domain/types.js";

describe("tool argument canonicalization", () => {
  it("produces the same digest when object-key order differs", () => {
    const left = argumentsDigest({ user: "customer-42", role: "viewer", nested: { enabled: true } });
    const right = argumentsDigest({ nested: { enabled: true }, role: "viewer", user: "customer-42" });
    expect(left).toBe(right);
  });

  it("changes the action fingerprint when an approved tool argument changes", () => {
    const changeRole = capability("role", "change");
    const viewer = nonMonetaryParameters(undefined, argumentsDigest({ user: "customer-42", role: "viewer" }));
    const admin = nonMonetaryParameters(undefined, argumentsDigest({ user: "customer-42", role: "admin" }));
    expect(computeActionFingerprint(changeRole, viewer)).not.toBe(computeActionFingerprint(changeRole, admin));
    expect(viewer.fingerprint_scheme_version).toBe(2);
  });

  it("preserves the legacy V0 fingerprint when no arguments digest exists", () => {
    const deleteCustomer = capability("customer", "delete");
    expect(computeActionFingerprint(deleteCustomer, nonMonetaryParameters())).toBe(
      computeActionFingerprint(deleteCustomer, nonMonetaryParameters()),
    );
  });

  it("rejects non-JSON values instead of silently changing them", () => {
    expect(() => canonicalizeToolArguments({ value: undefined })).toThrow(/JSON values/);
    expect(() => canonicalizeToolArguments({ value: Number.NaN })).toThrow(/finite/);
    expect(() => canonicalizeToolArguments({ value: -0 })).toThrow(/-0/);
    expect(() => canonicalizeToolArguments({ value: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/safely represented/);
  });

  it("rejects an unversioned digest instead of silently downgrading its fingerprint", () => {
    const malformed = {
      kind: "non_monetary",
      arguments_digest: argumentsDigest({ user: "customer-42", role: "viewer" }),
    } as unknown as ActionParameters;
    expect(() => computeActionFingerprint(capability("role", "change"), malformed)).toThrow(/requires fingerprint scheme version 2/);
  });
});
