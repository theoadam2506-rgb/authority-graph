import { describe, expect, it } from "vitest";
import { DEFAULT_STRICT_JSON_LIMITS, StrictJsonError, parseStrictJson, parseStrictJsonBytes, type StrictJsonErrorCode } from "../../src/proof/strictJson.js";

const code = (text: string): StrictJsonErrorCode | undefined => {
  try {
    parseStrictJson(text);
    return undefined;
  } catch (e) {
    return e instanceof StrictJsonError ? e.code : ("OTHER" as never);
  }
};

describe("strict JSON: what it accepts", () => {
  it("parses ordinary documents to plain data", () => {
    expect(parseStrictJson(' {"a":[1,2,{"b":null}],"c":"x\\u00e9\\n","d":true,"e":-5,"f":0} ')).toEqual({ a: [1, 2, { b: null }], c: "xé\n", d: true, e: -5, f: 0 });
  });
  it("accepts astral characters, written raw or as an escaped pair", () => {
    expect(parseStrictJson('"\u{1F600}"')).toBe("\u{1F600}");
    expect(parseStrictJson('"\\ud83d\\ude00"')).toBe("\u{1F600}");
  });
});

describe("strict JSON: duplicate keys are an error, never a choice", () => {
  it.each([
    ['{"a":1,"a":2}', "plain duplicate"],
    ['{"a":1,"\\u0061":2}', "duplicate after unescaping"],
    ['{"x":{"k":1,"k":1}}', "nested duplicate, even with equal values"],
    ['[{"k":1,"k":2}]', "duplicate inside an array"],
  ])("%s (%s)", (text) => expect(code(text)).toBe("DUPLICATE_KEY"));

  it("JSON.parse would silently keep the last value: the very ambiguity this reader exists to refuse", () => {
    expect(JSON.parse('{"a":1,"a":2}')).toEqual({ a: 2 });
  });
  it("a key named __proto__ is an ordinary own property and never touches the prototype", () => {
    const o = parseStrictJson('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(Object.getPrototypeOf(o)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(o)).toEqual(["__proto__"]);
  });
});

describe("strict JSON: numbers that are not exactly an integer are refused", () => {
  it.each([
    ["1.0", "fraction"], ["1.5", "fraction"], ["1e2", "exponent"], ["1E2", "exponent"], ["1e400", "overflow exponent"], ["-0", "negative zero"],
    ["01", "leading zero"], ["-01", "leading zero"], ["9007199254740992", "2^53, not a safe integer"], ["9007199254740993", "not representable"],
    ["12345678901234567890", "far beyond double precision"], ["-9007199254740993", "negative unsafe"],
  ])("%s (%s)", (text) => expect(code(text)).toBe("NUMBER_NOT_EXACT_INTEGER"));

  it.each(["+1", "NaN", "Infinity", "-Infinity", ".5", "0x10", "1_000"])("%s is not even JSON", (text) => expect(["SYNTAX", "TRAILING_DATA"]).toContain(code(text)));

  it("the largest exactly representable integer is accepted", () => {
    expect(parseStrictJson("9007199254740991")).toBe(9007199254740991);
    expect(parseStrictJson("-9007199254740991")).toBe(-9007199254740991);
  });
});

describe("strict JSON: text-level ambiguities", () => {
  it("lone surrogates are refused whether raw or escaped", () => {
    expect(code('"\\ud800"')).toBe("LONE_SURROGATE");
    expect(code('"\\udc00"')).toBe("LONE_SURROGATE");
    expect(code('"\\ud800x"')).toBe("LONE_SURROGATE");
    expect(code(`"${String.fromCharCode(0xd800)}"`)).toBe("LONE_SURROGATE");
  });
  it("a byte-order mark, trailing data, comments, trailing commas and raw control characters are refused", () => {
    expect(code('﻿{"a":1}')).toBe("BYTE_ORDER_MARK");
    expect(code('{"a":1} x')).toBe("TRAILING_DATA");
    expect(code('{"a":1}{"b":2}')).toBe("TRAILING_DATA");
    expect(code('{"a":1 /* c */}')).toBe("SYNTAX");
    expect(code('{"a":1,}')).toBe("SYNTAX");
    expect(code("[1,]")).toBe("SYNTAX");
    expect(code('"a\tb"')).toBe("SYNTAX");
    expect(code("{'a':1}")).toBe("SYNTAX");
    expect(code("")).toBe("SYNTAX");
  });
  it("invalid UTF-8 is an error rather than U+FFFD, and a decoded BOM is refused too", () => {
    expect(() => parseStrictJsonBytes(new Uint8Array([0x22, 0xff, 0x22]))).toThrow(/INVALID_UTF8/);
    expect(() => parseStrictJsonBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))).toThrow(/BYTE_ORDER_MARK/);
    expect(parseStrictJsonBytes(new TextEncoder().encode('{"é":1}'))).toEqual({ "é": 1 });
  });
  it("an invalid escape is refused", () => {
    expect(code('"\\x41"')).toBe("SYNTAX");
    expect(code('"\\u12G4"')).toBe("SYNTAX");
  });
});

describe("strict JSON: size and shape bounds (denial-of-service, not semantics)", () => {
  it("rejects nesting deeper than the limit", () => {
    expect(code("[".repeat(DEFAULT_STRICT_JSON_LIMITS.maxDepth + 2) + "]".repeat(DEFAULT_STRICT_JSON_LIMITS.maxDepth + 2))).toBe("TOO_DEEP");
    expect(code("[".repeat(DEFAULT_STRICT_JSON_LIMITS.maxDepth) + "]".repeat(DEFAULT_STRICT_JSON_LIMITS.maxDepth))).toBeUndefined();
  });
  it("rejects oversized input, strings, arrays and objects", () => {
    expect(code(`"${"a".repeat(DEFAULT_STRICT_JSON_LIMITS.maxBytes)}"`)).toBe("INPUT_TOO_LARGE");
    expect(code(`"${"a".repeat(DEFAULT_STRICT_JSON_LIMITS.maxStringLength + 1)}"`)).toBe("TOO_LONG");
    expect(code(`[${Array.from({ length: DEFAULT_STRICT_JSON_LIMITS.maxArrayLength + 1 }, () => "0").join(",")}]`)).toBe("TOO_LONG");
    expect(code(`{${Array.from({ length: DEFAULT_STRICT_JSON_LIMITS.maxObjectProperties + 1 }, (_v, i) => `"k${i}":0`).join(",")}}`)).toBe("TOO_LONG");
  });
});
