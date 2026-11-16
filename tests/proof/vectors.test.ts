/**
 * The published vectors (proof/vectors/) and the JSON Schema (proof/attestation.schema.json):
 * reproducible, verified by the real verifier, and kept in step with the code.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generate, type VectorCase } from "../../scripts/generate-proof-vectors.js";
import { FORMAT_FIELDS } from "../../src/proof/attestation.js";
import { parseTrustedKeys } from "../../src/proof/keys.js";
import { verifyAttestation, type ExpectedContext } from "../../src/proof/verify.js";

const ROOT = "proof/vectors";
const read = (name: string) => readFileSync(join(ROOT, name), "utf8");

describe("published vectors are reproducible", () => {
  it("the committed files are exactly what the deterministic generator produces", async () => {
    const files = await generate();
    expect(files.size).toBeGreaterThanOrEqual(20);
    for (const [name, content] of files) expect(read(name), name).toBe(content);
  });
  it("generating twice gives identical bytes", async () => {
    const a = await generate();
    const b = await generate();
    expect([...a.entries()]).toEqual([...b.entries()]);
  });
});

describe("every published case is verified by the real verifier with the stated outcome", () => {
  const expectedDoc = JSON.parse(read("expected.json")) as { trusted_keys: string; cases: VectorCase[] };
  const keys = parseTrustedKeys(read(expectedDoc.trusted_keys));

  it.each(expectedDoc.cases.map((c) => [c.file, c] as const))("%s", (_file, c) => {
    const r = verifyAttestation(read(c.file), { keys, ...(c.expected_context !== undefined ? { expected: c.expected_context as ExpectedContext } : {}) });
    expect(r.result).toBe(c.expected_result);
    if (c.failing_check !== undefined) expect(r.checks.find((k) => k.status === "FAIL")?.id).toBe(c.failing_check);
    else expect(r.checks.some((k) => k.status === "FAIL")).toBe(false);
  });

  it("the cases cover both kinds, every refusal family and the 'validly signed lie' that no level of L0-L2 catches", () => {
    const failing = new Set(expectedDoc.cases.map((c) => c.failing_check).filter(Boolean));
    for (const id of ["L0.JSON_STRICT", "L0.SCHEMA", "L1.KEY_KNOWN", "L1.SIGNATURE", "L2.CONTEXT"]) expect(failing.has(id), id).toBe(true);
    expect(expectedDoc.cases.find((c) => c.file.endsWith("validly-signed-lie.json"))?.expected_result).toBe("CONSISTENT_L2");
  });
});

describe("the JSON Schema matches the code", () => {
  const schema = JSON.parse(readFileSync("proof/attestation.schema.json", "utf8")) as { $defs: Record<string, { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean }> };
  const members = (name: string) => Object.keys(schema.$defs[name]!.properties).sort();
  const closed = (name: string) => schema.$defs[name]!.additionalProperties === false && [...schema.$defs[name]!.required].sort().join() === members(name).join();

  it.each([
    ["engine", FORMAT_FIELDS.engine], ["journal", FORMAT_FIELDS.journal], ["signature", FORMAT_FIELDS.signature], ["event", FORMAT_FIELDS.event],
    ["chainDelegation", FORMAT_FIELDS.chainDelegation], ["chainApproval", FORMAT_FIELDS.chainApproval],
    ["issuance", FORMAT_FIELDS.attestation], ["redemption", FORMAT_FIELDS.attestation],
    ["redemptionStatement", FORMAT_FIELDS.statementCommon], ["issuanceStatement", [...FORMAT_FIELDS.statementCommon, ...FORMAT_FIELDS.issuanceOnly]],
  ] as const)("%s has exactly the members of the code and is closed with every member required", (name, fields) => {
    expect(members(name)).toEqual([...fields].sort());
    expect(closed(name)).toBe(true);
  });
});
