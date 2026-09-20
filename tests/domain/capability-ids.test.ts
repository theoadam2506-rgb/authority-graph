/**
 * Runtime behavior of the new branded identifiers introduced ahead of the
 * capability model (CapabilityId, EnforcementPointId, ClientIdempotencyKey).
 * These constructors carry no resolution logic — only the same
 * non-empty-string validation every other identifier in src/domain/types.ts
 * already enforces. The nominal-typing distinction between them (a
 * CapabilityId is not a DelegationId, etc.) is a compile-time property,
 * checked separately in capability-ids.type-guards.ts via `tsc --noEmit`
 * rather than at runtime, since branding is erased at runtime.
 */
import { describe, expect, it } from "vitest";
import { capabilityId, clientIdempotencyKey, enforcementPointId } from "../../src/domain/types.js";

describe("CapabilityId", () => {
  it("accepts a non-empty string", () => {
    expect(capabilityId("cap-1")).toBe("cap-1");
  });

  it("rejects an empty string", () => {
    expect(() => capabilityId("")).toThrow(/CapabilityId must not be empty/);
  });
});

describe("EnforcementPointId", () => {
  it("accepts a non-empty string", () => {
    expect(enforcementPointId("ep-1")).toBe("ep-1");
  });

  it("rejects an empty string", () => {
    expect(() => enforcementPointId("")).toThrow(/EnforcementPointId must not be empty/);
  });
});

describe("ClientIdempotencyKey", () => {
  it("accepts a non-empty string", () => {
    expect(clientIdempotencyKey("key-1")).toBe("key-1");
  });

  it("rejects an empty string", () => {
    expect(() => clientIdempotencyKey("")).toThrow(/ClientIdempotencyKey must not be empty/);
  });
});
