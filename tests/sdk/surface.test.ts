import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as sdk from "../../src/sdk/index.js";

const SDK_DIR = join(__dirname, "..", "..", "src", "sdk");

describe("SDK public surface", () => {
  it("exports exactly the documented names, and never authorityAt (a discovery view, not a guard)", () => {
    expect(Object.keys(sdk).sort()).toEqual(["AuthorityConfigError", "AuthorityInputError", "ClockError", "createAuthority", "createEventBuilders", "memoryBackend", "postgresBackend", "systemClock"]);
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

  it("the SDK's import closure stays inside the engine: no CLI, conformance lab, proof tooling or demo is packaged", () => {
    const root = join(__dirname, "..", "..", "src");
    const seen = new Set<string>();
    const queue = [join(SDK_DIR, "index.ts")];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const match of readFileSync(file, "utf8").matchAll(/from\s+"(\.[^"]+)\.js"/g)) queue.push(join(file, "..", `${match[1]}.ts`));
    }
    const dirs = new Set([...seen].map((f) => f.slice(root.length + 1).split("/")[0]));
    expect([...dirs].sort()).toEqual(["domain", "engine", "sdk", "storage"]);
  });

  it("the package build script keeps the generated package private and free of a runtime database driver", () => {
    const script = readFileSync(join(__dirname, "..", "..", "scripts", "build-sdk-package.mjs"), "utf8");
    expect(script).toMatch(/private: true/);
    expect(script).toMatch(/peerDependenciesMeta: \{ pg: \{ optional: true \} \}/);
    expect(script).not.toMatch(/npm["']?,\s*\[?["']publish/);
  });
});
