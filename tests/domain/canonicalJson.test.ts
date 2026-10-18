import { describe, expect, it } from "vitest";
import { argumentsDigest, canonicalizeToolArguments } from "../../src/domain/canonicalJson.js";
import { computeActionFingerprint } from "../../src/domain/events.js";
import { capability, money, monetaryParameters, nonMonetaryParameters } from "../../src/domain/types.js";

describe("RFC 8785 tool arguments", () => {
  it("has one digest regardless of object-key insertion order", () => {
    expect(argumentsDigest({ nested: { enabled: true }, role: "viewer", user: "u-42" })).toBe(
      argumentsDigest({ user: "u-42", role: "viewer", nested: { enabled: true } }),
    );
  });

  it("binds arguments and currency in fingerprint scheme V2", () => {
    const changeRole = capability("role", "change");
    const viewer = nonMonetaryParameters(undefined, argumentsDigest({ role: "viewer", user: "u-42" }));
    const admin = nonMonetaryParameters(undefined, argumentsDigest({ role: "admin", user: "u-42" }));
    expect(viewer.fingerprint_scheme_version).toBe(2);
    expect(computeActionFingerprint(changeRole, viewer)).not.toBe(computeActionFingerprint(changeRole, admin));
    expect(
      computeActionFingerprint(capability("payment", "send"), monetaryParameters(money(5, "EUR"), undefined, argumentsDigest({ id: "p" }))),
    ).not.toBe(
      computeActionFingerprint(capability("payment", "send"), monetaryParameters(money(5, "USD"), undefined, argumentsDigest({ id: "p" }))),
    );
  });

  it("rejects non-deterministic or non-JSON input", () => {
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "value", { enumerable: true, get: () => 1 });
    expect(() => canonicalizeToolArguments({ value: undefined })).toThrow(/JSON values/);
    expect(() => canonicalizeToolArguments({ value: Number.NaN })).toThrow(/finite/);
    expect(() => canonicalizeToolArguments({ value: -0 })).toThrow(/-0/);
    expect(() => canonicalizeToolArguments({ value: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/safely represented/);
    expect(() => canonicalizeToolArguments([, 1])).toThrow(/holes/);
    expect(() => canonicalizeToolArguments(accessor)).toThrow(/data property/);
  });
});
