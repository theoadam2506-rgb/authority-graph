/** RFC 8785 boundary for arguments observed at a tool call. */
import { createHash } from "node:crypto";
import { canonicalizeEx } from "json-canonicalize";
import type { ArgumentsDigest } from "./types.js";

const MAX_ARGUMENT_DEPTH = 64;

function assertJsonValue(value: unknown, depth = 0, seen: Set<object> = new Set()): void {
  if (depth > MAX_ARGUMENT_DEPTH) throw new Error("Tool arguments exceed the maximum JSON nesting depth");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Object.is(value, -0)) throw new Error("Tool arguments must not contain -0");
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new Error("Tool arguments must contain only finite, safely represented JSON numbers");
    }
    return;
  }
  if (typeof value !== "object" || value === undefined) throw new Error("Tool arguments must be JSON values; non-JSON types are forbidden");
  if (seen.has(value)) throw new Error("Tool arguments must not contain circular references");
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error("Tool arguments must not contain symbol keys");
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error("Tool argument arrays must not contain holes, accessors or hidden entries");
      }
      assertJsonValue(descriptor.value, depth + 1, seen);
    }
    for (const key of Object.keys(descriptors)) {
      if (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)) throw new Error("Tool argument arrays must not contain extra properties");
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Tool arguments must use plain JSON objects");
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor) || !descriptor.enumerable) throw new Error(`Tool argument ${key} must be an enumerable data property`);
      assertJsonValue(descriptor.value, depth + 1, seen);
    }
  }
  seen.delete(value);
}

/** Returns one immutable snapshot, then its RFC 8785/JCS representation. */
export function canonicalizeToolArguments(argumentsValue: unknown): string {
  assertJsonValue(argumentsValue);
  let snapshot: unknown;
  try {
    snapshot = structuredClone(argumentsValue);
  } catch {
    throw new Error("Tool arguments must be cloneable plain JSON data");
  }
  assertJsonValue(snapshot);
  return canonicalizeEx(snapshot, { strictUndefined: true, allowCircular: false });
}

export function argumentsDigest(argumentsValue: unknown): ArgumentsDigest {
  return createHash("sha256").update(canonicalizeToolArguments(argumentsValue), "utf8").digest("hex") as ArgumentsDigest;
}
