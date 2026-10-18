/**
 * Canonical JSON boundary for tool arguments.
 *
 * The engine receives only the resulting digest, never the full argument
 * object. We reject JavaScript values that are not valid, deterministic JSON
 * before delegating serialization to json-canonicalize's RFC 8785 support.
 */
import { createHash } from "node:crypto";
import { canonicalizeEx } from "json-canonicalize";
import type { ArgumentsDigest } from "./types.js";

function assertJsonValue(value: unknown, seen: Set<object> = new Set()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (Object.is(value, -0)) {
      throw new Error("Tool arguments must not contain -0 because it has no distinct canonical JSON representation");
    }
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new Error("Tool arguments must contain only finite, safely represented JSON numbers");
    }
    return;
  }
  if (typeof value === "undefined" || typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new Error("Tool arguments must be JSON values; undefined and non-JSON types are forbidden");
  }
  if (typeof value !== "object") {
    throw new Error("Tool arguments must be JSON values");
  }
  if (seen.has(value)) {
    throw new Error("Tool arguments must not contain circular references");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      assertJsonValue(item, seen);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Tool arguments must use plain JSON objects");
    }
    for (const item of Object.values(value)) {
      assertJsonValue(item, seen);
    }
  }
  seen.delete(value);
}

/** Returns the RFC 8785/JCS representation after rejecting non-JSON inputs. */
export function canonicalizeToolArguments(argumentsValue: unknown): string {
  assertJsonValue(argumentsValue);
  return canonicalizeEx(argumentsValue, { strictUndefined: true, allowCircular: false });
}

/** Stable SHA-256 digest of every argument passed to a tool. */
export function argumentsDigest(argumentsValue: unknown): ArgumentsDigest {
  return createHash("sha256").update(canonicalizeToolArguments(argumentsValue), "utf8").digest("hex") as ArgumentsDigest;
}
