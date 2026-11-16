import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runProofCli } from "../../src/proof/cli.js";
import { verifyAttestationL3, REPORT_FIELDS } from "../../src/proof/replay.js";
import { parseTrustedKeys } from "../../src/proof/keys.js";
import { parseTrustedHeads } from "../../src/proof/heads.js";
import { parseStrictJson } from "../../src/proof/strictJson.js";

const V = resolve("proof/vectors");
const p = (f: string) => join(V, f);
const cases = (JSON.parse(readFileSync(p("expected-l3.json"), "utf8")) as { cases: Array<Record<string, any>> }).cases;

const argsFor = (c: Record<string, any>): string[] => {
  const a = ["verify", p(c.attestation), "--keys", p(c.trusted_keys), "--journal", p(c.journal), "--json"];
  if (c.trusted_heads) a.push("--trusted-heads", p(c.trusted_heads));
  if (c.scope) a.push("--scope", c.scope);
  return a;
};

describe("L3 vectors, through the library and the CLI", () => {
  for (const c of cases) {
    it(`${c.name}`, async () => {
      const read = (f: string) => readFileSync(p(f), "utf8");
      const lib = verifyAttestationL3(read(c.attestation), {
        keys: parseTrustedKeys(read(c.trusted_keys)),
        journal: read(c.journal),
        ...(c.trusted_heads ? { trustedHeads: parseTrustedHeads(read(c.trusted_heads)) } : {}),
        ...(c.scope ? { scope: c.scope } : {}),
      } as any);
      expect(lib.result).toBe(c.expected_result);
      expect(lib.anchored).toBe(c.anchored);
      if (c.anchor_status) expect(lib.anchor?.status).toBe(c.anchor_status);
      const cli = await runProofCli(argsFor(c));
      const report = JSON.parse(cli.stdout);
      expect(report.result).toBe(c.expected_result);
      expect(report.anchored).toBe(c.anchored);
      expect(cli.exitCode).toBe(c.expected_result === "REJECTED" ? 1 : 0);
      expect(cli.stdout).toBe((await runProofCli(argsFor(c))).stdout); // deterministic
      if (c.failing_check) expect(report.checks.find((k: any) => k.status === "FAIL")?.id).toBe(c.failing_check);
    });
  }
});

describe("report shape matches the closed schema", () => {
  it("every object carries exactly the documented members and the JSON schema lists the same", async () => {
    const cli = await runProofCli(argsFor(cases[0] as Record<string, any>));
    const r = JSON.parse(cli.stdout);
    expect(Object.keys(r).sort()).toEqual([...REPORT_FIELDS.report].sort());
    expect(Object.keys(r.levels).sort()).toEqual([...REPORT_FIELDS.levels].sort());
    for (const c of r.checks) expect(Object.keys(c).filter((k) => k !== "detail").sort()).toEqual(["id", "level", "status"]);
    expect(Object.keys(r.journal.attested_prefix).sort()).toEqual([...REPORT_FIELDS.attestedPrefix].sort());
    expect(Object.keys(r.journal.full_journal).sort()).toEqual([...REPORT_FIELDS.fullJournal].sort());
    const schema = JSON.parse(readFileSync("proof/verify-report.schema.json", "utf8"));
    expect([...schema.required].sort()).toEqual([...REPORT_FIELDS.report].sort());
    expect(Object.keys(schema.properties).sort()).toEqual([...REPORT_FIELDS.report].sort());
    expect(schema.properties.report_version.const).toBe(r.report_version);
    expect(r.not_established.length).toBeGreaterThan(0);
  });
});

describe("CLI usage and input errors", () => {
  const ok = argsFor(cases[0] as Record<string, any>);
  it("no subcommand and unknown subcommand: usage, 64", async () => {
    expect((await runProofCli([])).exitCode).toBe(64);
    expect((await runProofCli(["frobnicate"])).exitCode).toBe(64);
  });
  it("unknown option, repeated option, missing value, missing attestation, missing --keys: 64", async () => {
    for (const a of [[...ok, "--bogus", "1"], [...ok, "--json"], ["verify", p("redemption.json"), "--keys"], ["verify", "--keys", p("trusted-keys.json")], ["verify", p("redemption.json")]]) {
      expect((await runProofCli(a)).exitCode, a.join(" ")).toBe(64);
    }
  });
  it("a missing or non-regular file: 2, never a verdict", async () => {
    const r = await runProofCli(["verify", p("nope.json"), "--keys", p("trusted-keys.json")]);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).not.toMatch(/CONSISTENT/);
    expect((await runProofCli(["verify", V, "--keys", p("trusted-keys.json")])).exitCode).toBe(2);
  });
  it("a malformed trusted-heads or keys file: 2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "proofcli-"));
    writeFileSync(join(dir, "bad.json"), "{");
    expect((await runProofCli(["verify", p("redemption.json"), "--keys", join(dir, "bad.json")])).exitCode).toBe(2);
    expect((await runProofCli(["verify", p("redemption.json"), "--keys", p("trusted-keys.json"), "--journal", p("journal.json"), "--trusted-heads", join(dir, "bad.json")])).exitCode).toBe(2);
  });
  it("a journal over --max-events is refused, not truncated", async () => {
    const r = await runProofCli([...ok, "--max-events", "2"]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).result).toBe("REJECTED");
  });
  it("a revoked-ALWAYS key stays rejected through the CLI", async () => {
    const r = await runProofCli(["verify", p("redemption.json"), "--keys", p("trusted-keys-revoked-always.json"), "--journal", p("journals/journal.json"), "--json"]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).levels.L3).toBe("NOT_CHECKED");
  });
  it("text output states what is not established and never says verified/proven", async () => {
    const a = ok.filter((x) => x !== "--json");
    const r = await runProofCli(a);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/NOT ESTABLISHED/i);
    expect(r.stdout).not.toMatch(/\b(proven|certified|non-repudiation)\b/i);
  });
  it("head: prints the journal head, with an optional replay", async () => {
    const r = await runProofCli(["head", p("journals/journal.json"), "--replay", "--json"]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).head_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("integration through the real entry point", () => {
  it("authority proof verify exits 0 and prints a stable report", () => {
    const run = () => spawnSync("npx", ["tsx", "src/cli/authority.ts", ...argsFor(cases[0] as Record<string, any>).map((x, i) => (i === 0 ? "proof" : x)).flatMap((x, i) => (i === 0 ? ["proof", "verify"] : [x]))], { encoding: "utf8" });
    const a = run();
    expect(a.status).toBe(0);
    expect(JSON.parse(a.stdout).result).toBe("CONSISTENT_L3");
    expect(run().stdout).toBe(a.stdout);
  }, 60000);
});

describe("no network, no clock, no signing in the proof CLI", () => {
  it("static check of the modules the CLI loads", () => {
    const dir = resolve("src/proof");
    for (const f of ["cli.ts", "replay.ts", "heads.ts", "stableJson.ts"]) {
      const src = readFileSync(join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(src, f).not.toMatch(/node:(http|https|net|dns|tls|dgram)|\bfetch\(|new Date\(\)|Date\.now|generateKeyPair|createPrivateKey|\bsign\(/);
    }
    expect(readdirSync(dir)).toContain("cli.ts");
    void parseStrictJson;
  });
});
