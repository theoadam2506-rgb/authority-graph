import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as sdk from "../../src/sdk/index.js";

const SDK_DIR = join(__dirname, "..", "..", "src", "sdk");

describe("SDK public surface", () => {
  it("exports exactly the documented names, and never authorityAt (a discovery view, not a guard)", () => {
    expect(Object.keys(sdk).sort()).toEqual(["AuthorityConfigError", "AuthorityInputError", "ClockError", "createAuthority", "memoryBackend", "postgresBackend", "systemClock"]);
    expect("authorityAt" in sdk).toBe(false);
  });

  it("reads no clock and no randomness outside the explicit places", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(SDK_DIR).filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(join(SDK_DIR, file), "utf8");
      if (file !== "clock.ts" && /Date\.now\(|new Date\(\)/.test(text)) offenders.push(`${file}: reads the system clock`);
      if (/Math\.random\(/.test(text)) offenders.push(`${file}: Math.random`);
    }
    expect(offenders).toEqual([]);
  });

  it("writes nothing and opens no connection of its own: no console, no process output, no network", () => {
    for (const file of readdirSync(SDK_DIR).filter((f) => f.endsWith(".ts"))) {
      expect(readFileSync(join(SDK_DIR, file), "utf8"), file).not.toMatch(/\bconsole\.|process\.(stdout|stderr)|\bfetch\(|node:(http|https|net|tls|dgram)/);
    }
  });

  it("no public result type carries an error: `cause` / `error: unknown` appear only in the operator-only Diagnostic", () => {
    const types = readFileSync(join(SDK_DIR, "types.ts"), "utf8");
    const outsideDiagnostic = types.replace(/export interface Diagnostic \{[\s\S]*?\n\}/, "");
    expect(outsideDiagnostic).not.toMatch(/\b(cause|error)\??\s*:\s*unknown/);
    expect(types).toMatch(/export interface Diagnostic/);
  });

  it("does not import the engine's discovery entry point", () => {
    for (const file of readdirSync(SDK_DIR).filter((f) => f.endsWith(".ts"))) {
      expect(readFileSync(join(SDK_DIR, file), "utf8")).not.toMatch(/import[^;]*\bauthorityAt\b/);
    }
  });
});
