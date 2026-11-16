/**
 * Strict JSON reader for attestations (Authority Proof, PR 3).
 *
 * `JSON.parse` is not a safe front door for a signed document: it silently
 * keeps the LAST of two duplicate keys (so two parsers can read two different
 * documents from the same bytes), accepts lone surrogates (which later encode
 * to different UTF-8 than the signer saw), and turns `1e400` or `9007199254740993`
 * into values that are not what the text says. This reader refuses all of that
 * instead of choosing:
 *
 *  - duplicate object keys, compared AFTER unescaping (`"a"` and `"a"` clash);
 *  - any number that is not an integer written as `0` or `-?[1-9][0-9]*` that is
 *    exactly representable (a safe integer): no fraction, no exponent, no `-0`,
 *    no leading zeros, no `+`, no NaN or Infinity;
 *  - lone surrogates, raw control characters, a byte-order mark, trailing data,
 *    comments, trailing commas;
 *  - input larger than `maxBytes`, nested deeper than `maxDepth`, strings, arrays
 *    or objects over their limits (a denial-of-service bound, not a semantic one);
 *  - invalid UTF-8 when reading bytes.
 *
 * It returns plain data and never executes or interprets anything.
 */

export interface StrictJsonLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxStringLength: number;
  readonly maxArrayLength: number;
  readonly maxObjectProperties: number;
}

export const DEFAULT_STRICT_JSON_LIMITS: StrictJsonLimits = {
  maxBytes: 64 * 1024,
  maxDepth: 12,
  maxStringLength: 1024,
  maxArrayLength: 256,
  maxObjectProperties: 64,
};

export type StrictJsonErrorCode =
  | "INPUT_TOO_LARGE"
  | "INVALID_UTF8"
  | "BYTE_ORDER_MARK"
  | "SYNTAX"
  | "DUPLICATE_KEY"
  | "NUMBER_NOT_EXACT_INTEGER"
  | "LONE_SURROGATE"
  | "TOO_DEEP"
  | "TOO_LONG"
  | "TRAILING_DATA";

export class StrictJsonError extends Error {
  readonly code: StrictJsonErrorCode;
  readonly offset: number;
  constructor(code: StrictJsonErrorCode, offset: number, message: string) {
    super(`${code} at offset ${offset}: ${message}`);
    this.name = "StrictJsonError";
    this.code = code;
    this.offset = offset;
  }
}

/** Decodes UTF-8 strictly (invalid sequences are an error, never U+FFFD) and parses. */
export function parseStrictJsonBytes(bytes: Uint8Array, limits: StrictJsonLimits = DEFAULT_STRICT_JSON_LIMITS): unknown {
  if (bytes.byteLength > limits.maxBytes) throw new StrictJsonError("INPUT_TOO_LARGE", 0, `${bytes.byteLength} bytes exceeds ${limits.maxBytes}`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new StrictJsonError("INVALID_UTF8", 0, "input is not valid UTF-8");
  }
  return parseStrictJson(text, limits);
}

export function parseStrictJson(text: string, limits: StrictJsonLimits = DEFAULT_STRICT_JSON_LIMITS): unknown {
  if (Buffer.byteLength(text, "utf8") > limits.maxBytes) throw new StrictJsonError("INPUT_TOO_LARGE", 0, `input exceeds ${limits.maxBytes} bytes`);
  if (text.charCodeAt(0) === 0xfeff) throw new StrictJsonError("BYTE_ORDER_MARK", 0, "a byte-order mark is not accepted");
  let i = 0;

  const fail = (code: StrictJsonErrorCode, message: string, at: number = i): never => {
    throw new StrictJsonError(code, at, message);
  };
  const skipWhitespace = (): void => {
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i += 1;
      else break;
    }
  };

  function parseValue(depth: number): unknown {
    if (depth > limits.maxDepth) fail("TOO_DEEP", `nesting deeper than ${limits.maxDepth}`);
    skipWhitespace();
    const c = text[i];
    if (c === "{") return parseObject(depth);
    if (c === "[") return parseArray(depth);
    if (c === '"') return parseString();
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return parseNumber();
    if (text.startsWith("true", i)) return (i += 4), true;
    if (text.startsWith("false", i)) return (i += 5), false;
    if (text.startsWith("null", i)) return (i += 4), null;
    return fail("SYNTAX", c === undefined ? "unexpected end of input" : `unexpected character ${JSON.stringify(c)}`);
  }

  function parseNumber(): number {
    const start = i;
    if (text[i] === "-") i += 1;
    const first = text[i];
    if (first === undefined || first < "0" || first > "9") fail("SYNTAX", "a digit was expected");
    if (first === "0") {
      i += 1;
      const next = text[i];
      if (next !== undefined && next >= "0" && next <= "9") fail("NUMBER_NOT_EXACT_INTEGER", "leading zeros are not accepted", start);
    } else {
      while (i < text.length && text[i]! >= "0" && text[i]! <= "9") i += 1;
    }
    const after = text[i];
    if (after === "." || after === "e" || after === "E") fail("NUMBER_NOT_EXACT_INTEGER", "fractions and exponents are not accepted", start);
    const token = text.slice(start, i);
    if (token === "-0") fail("NUMBER_NOT_EXACT_INTEGER", "-0 is not accepted", start);
    const value = Number(token);
    if (!Number.isSafeInteger(value)) fail("NUMBER_NOT_EXACT_INTEGER", `${token} is not exactly representable`, start);
    return value;
  }

  function parseString(): string {
    const start = i;
    i += 1; // opening quote
    let out = "";
    for (;;) {
      if (i >= text.length) fail("SYNTAX", "unterminated string", start);
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i += 1;
        break;
      }
      if (c < 0x20) fail("SYNTAX", "raw control character in string");
      if (c !== 0x5c) {
        // Copy the whole run of ordinary characters at once (same result as one by one, much cheaper on large inputs).
        let j = i + 1;
        while (j < text.length) {
          const d = text.charCodeAt(j);
          if (d === 0x22 || d === 0x5c || d < 0x20) break;
          j += 1;
        }
        out += text.slice(i, j);
        i = j;
        if (out.length > limits.maxStringLength) fail("TOO_LONG", `string longer than ${limits.maxStringLength}`, start);
        continue;
      }
      if (c === 0x5c) {
        const e = text[i + 1];
        i += 2;
        switch (e) {
          case '"': out += '"'; break;
          case "\\": out += "\\"; break;
          case "/": out += "/"; break;
          case "b": out += "\b"; break;
          case "f": out += "\f"; break;
          case "n": out += "\n"; break;
          case "r": out += "\r"; break;
          case "t": out += "\t"; break;
          case "u": {
            const hex = text.slice(i, i + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("SYNTAX", "invalid \\u escape", i - 2);
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
            break;
          }
          default:
            fail("SYNTAX", "invalid escape", i - 2);
        }
      }
      if (out.length > limits.maxStringLength) fail("TOO_LONG", `string longer than ${limits.maxStringLength}`, start);
    }
    // Well-formedness: no lone surrogates, whether written raw or escaped.
    for (let k = 0; k < out.length; k += 1) {
      const u = out.charCodeAt(k);
      if (u >= 0xd800 && u <= 0xdbff) {
        const n = out.charCodeAt(k + 1);
        if (!(n >= 0xdc00 && n <= 0xdfff)) fail("LONE_SURROGATE", "lone high surrogate", start);
        k += 1;
      } else if (u >= 0xdc00 && u <= 0xdfff) {
        fail("LONE_SURROGATE", "lone low surrogate", start);
      }
    }
    return out;
  }

  function parseArray(depth: number): unknown[] {
    i += 1;
    const out: unknown[] = [];
    skipWhitespace();
    if (text[i] === "]") return (i += 1), out;
    for (;;) {
      out.push(parseValue(depth + 1));
      if (out.length > limits.maxArrayLength) fail("TOO_LONG", `array longer than ${limits.maxArrayLength}`);
      skipWhitespace();
      const c = text[i];
      if (c === ",") i += 1;
      else if (c === "]") return (i += 1), out;
      else fail("SYNTAX", "',' or ']' expected");
    }
  }

  function parseObject(depth: number): Record<string, unknown> {
    i += 1;
    const out: Record<string, unknown> = {};
    const seen = new Set<string>();
    skipWhitespace();
    if (text[i] === "}") return (i += 1), out;
    for (;;) {
      skipWhitespace();
      if (text[i] !== '"') fail("SYNTAX", "an object key (string) was expected");
      const keyAt = i;
      const key = parseString();
      if (seen.has(key)) fail("DUPLICATE_KEY", `duplicate key ${JSON.stringify(key)}`, keyAt);
      seen.add(key);
      if (seen.size > limits.maxObjectProperties) fail("TOO_LONG", `object with more than ${limits.maxObjectProperties} properties`, keyAt);
      skipWhitespace();
      if (text[i] !== ":") fail("SYNTAX", "':' expected");
      i += 1;
      // defineProperty: a key named "__proto__" becomes an ordinary own property, never the prototype.
      Object.defineProperty(out, key, { value: parseValue(depth + 1), enumerable: true, writable: true, configurable: true });
      skipWhitespace();
      const c = text[i];
      if (c === ",") i += 1;
      else if (c === "}") return (i += 1), out;
      else fail("SYNTAX", "',' or '}' expected");
    }
  }

  const value = parseValue(0);
  skipWhitespace();
  if (i < text.length) fail("TRAILING_DATA", "data after the JSON value");
  return value;
}
