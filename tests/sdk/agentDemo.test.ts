/**
 * The agent demo (examples/agent-demo) is also a test: the scenarios run, the
 * public-API-only rule holds, the output is deterministic and matches what the
 * documentation shows, and the negative scenarios really leave the tool idle.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatDemo, runAgentDemo } from "../../examples/agent-demo/scenarios.js";

const ROOT = join(__dirname, "..", "..");
const DEMO_DIR = join(ROOT, "examples", "agent-demo");

describe("agent demo", () => {
  it("runs end to end and the tool placed exactly the four orders that were authorized, redeemed once", async () => {
    const report = await runAgentDemo();
    expect(report.orders.map((o) => o.orderId)).toEqual(["po-1001", "po-2001", "po-3001", "po-4001"]);
    expect(new Set(report.orders.map((o) => o.idempotencyKey)).size).toBe(4);
  });

  it("the negative scenarios carry the documented reasons", async () => {
    const { facts } = await runAgentDemo();
    expect(facts["denied:a capability that was never delegated"]).toBe("C11_CAPABILITY_NOT_COVERED");
    expect(facts["denied:a delegation that belongs to someone else"]).toBe("INVOKED_DELEGATION_NOT_OWNED_BY_REQUESTER");
    expect(facts["denied:an amount above the approval ceiling"]).toBe("C8_AMOUNT_EXCEEDS_APPROVAL_CEILING");
    expect(facts["substitution:a larger amount"]).toBe("ARGUMENTS_MISMATCH");
    expect(facts["substitution:another recipient"]).toBe("ARGUMENTS_MISMATCH");
    expect(facts["substitution:other tool arguments"]).toBe("ARGUMENTS_MISMATCH");
    expect(facts["substitution:another action id"]).toBe("ACTION_ID_MISMATCH");
    expect(facts["revocation:redeem"]).toBe("AUTHORITY_NO_LONGER_VALID");
    expect(facts["i32:ticketsForTheAction"]).toBe(1);
    expect(facts["i32:forgedSecondTicket"]).toBe("BUSINESS_ID_COLLISION");
    expect(facts["unknown:redeem"]).toBe("UNKNOWN_OUTCOME");
    expect(facts["unknown:effect"]).toBe("EFFECT_FAILED");
  });

  it("an unknown outcome is never reported as executed or as a success in the output", async () => {
    const text = formatDemo(await runAgentDemo());
    const seven = text.slice(text.indexOf("7. An unknown outcome"), text.indexOf("Orders the sandbox tool"));
    expect(seven).toMatch(/UNKNOWN_OUTCOME/);
    expect(seven).toMatch(/EFFECT_FAILED/);
    expect(seven).not.toMatch(/\bEXECUTED\b|ran once|\bREDEEMED\b/);
    expect(seven).toMatch(/NOT a success/);
  });

  it("is deterministic: two runs give the same text", async () => {
    expect(formatDemo(await runAgentDemo())).toBe(formatDemo(await runAgentDemo()));
  });

  it("the documentation shows exactly the output of the demo", async () => {
    const doc = readFileSync(join(ROOT, "docs", "v1", "AGENT_DEMO.md"), "utf8");
    const shown = doc.match(/<!-- agent-demo-output -->\s*```\n([\s\S]*?)\n```/)?.[1];
    expect(shown).toBeDefined();
    expect(shown).toBe(formatDemo(await runAgentDemo()));
  });

  it("imports only the public SDK entry point, nothing internal", () => {
    for (const file of readdirSync(DEMO_DIR).filter((f) => f.endsWith(".ts"))) {
      const imports = [...readFileSync(join(DEMO_DIR, file), "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      for (const spec of imports) expect(["../../src/sdk/index.js", "./scenarios.js"], `${file} imports ${spec}`).toContain(spec);
    }
  });

  it("reads no real clock, no randomness and no network, and needs no secret", () => {
    for (const file of readdirSync(DEMO_DIR).filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(join(DEMO_DIR, file), "utf8");
      expect(text, file).not.toMatch(/Date\.now\(|new Date\(\)|Math\.random|randomUUID|\bfetch\(|process\.env|node:(http|https|net)|API_KEY|apiKey/);
    }
  });
});
