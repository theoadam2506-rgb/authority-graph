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
  it("runs end to end and the tool placed and confirmed exactly the four orders that were authorized, redeemed once", async () => {
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

  it("7b: the target received one attempt with the idempotency key, the ticket is consumed, the SDK never retries and never calls it a success", async () => {
    const report = await runAgentDemo();
    const { facts } = report;
    // The target system itself received the call, with the ticket id as idempotency key.
    expect(facts["unknown:effect:attemptsAtTarget"]).toBe(1);
    expect(report.unconfirmed).toHaveLength(1);
    expect(report.unconfirmed[0]).toMatchObject({ orderId: "po-7002", amountEur: 700, targetState: "completed, reply lost" });
    expect(report.unconfirmed[0]?.idempotencyKey).toMatch(/^cap-demo-\d+$/);
    // The SDK result describes what it observed, and the ticket is consumed.
    expect(facts["unknown:effect"]).toBe("EFFECT_FAILED");
    expect(facts["unknown:effect:ticketConsumed"]).toBe(true);
    expect(facts["unknown:effect:redeemAgain"]).toBe("ALREADY_REDEEMED");
    // The journal separates the attempt from the absence of a confirmed success, and never says EXECUTED.
    expect(facts["unknown:effect:journal"]).toBe("ACTION_REQUESTED,CAPABILITY_ISSUED,CAPABILITY_REDEEMED,ACTION_EXECUTED:EFFECT_FAILED");
    // No confirmed order exists for it: the caller never saw a result.
    expect(report.orders.map((o) => o.orderId)).not.toContain("po-7002");
    // The documentation says what EFFECT_FAILED does and does not mean.
    const doc = readFileSync(join(ROOT, "docs", "v1", "AGENT_DEMO.md"), "utf8");
    expect(doc).toMatch(/not proof that the external effect did not happen/);
  });

  it("the I32 bypass is documented as deliberate, in the code and in the guide", () => {
    const code = readFileSync(join(DEMO_DIR, "scenarios.ts"), "utf8");
    expect(code).toMatch(/DELIBERATE BYPASS of the typed builders/);
    expect(code).toMatch(/not a pattern to use/);
    const doc = readFileSync(join(ROOT, "docs", "v1", "AGENT_DEMO.md"), "utf8");
    expect(doc).toMatch(/deliberate attempt to bypass the typed\s+builders/);
    expect(doc).toMatch(/not a pattern to use/);
  });

  it("an unknown outcome is never reported as executed or as a success in the output", async () => {
    const text = formatDemo(await runAgentDemo());
    const seven = text.slice(text.indexOf("7. An unknown outcome"), text.indexOf("Orders the sandbox tool"));
    expect(seven).toMatch(/UNKNOWN_OUTCOME/);
    expect(seven).toMatch(/EFFECT_FAILED/);
    // "never EXECUTED" is the explanation; any other bare EXECUTED, REDEEMED or "ran once" would be a success claim.
    expect(seven).not.toMatch(/(?<!never )\bEXECUTED\b|ran once|\bREDEEMED\b/);
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
