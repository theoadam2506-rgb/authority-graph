/**
 * The reference engine in tests/oracle/engine must stay IDENTICAL to src/engine at commit b6046ec (the commit before the
 * O1 change), apart from the one import-path rewrite (`../domain/` -> `../../../src/domain/`). The SHA-256 of each file is
 * pinned here; the values were computed from `git show b6046ec:src/engine/<file>` with that rewrite applied.
 * Editing the oracle to make a test pass changes its hash and fails this test: that is the point.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FROZEN: Record<string, string> = {
  "authority.ts": "5a741b467f15bc8f9e665181f403cb1864c8766cedf02c15b4734efff9df2873",
  "authorityAt.ts": "c1c8ece7d34be9edbd104281fef39b524e6a7b2454b81d5ad1ee8eb18a836da6",
  "capacity.ts": "be9ef93c4880f1f65c557da7f79140d6b27e107ade87a01a5036a176ce06bd6c",
  "causality.ts": "51f74acf8597781002cffd494a3f9b2b8423cf700976a2eac47681f139d8fb9f",
  "evaluateConstraints.ts": "a52449cb51695e5ac097782292854bab6d9e126567507b38624610148f9ee47e",
  "explainAction.ts": "20ca0c56b11547108a0727934922b4e168c652892330a84aeddf0f3a7abfdfa8",
  "grantValidation.ts": "188c008e21b7dde4350f17249a5aa82c89604bbf5496593d86a53dd8614b396d",
  "ingest.ts": "0361ed9eb7f38ed73690d2e3f302c739235df20d0da8c63fa5c5e94710de4e15",
  "issueCapability.ts": "2c448f33dce3aeaca0af62fa72c5f2871685d39b8ee06a7f0eb6f62a5f0a0068",
  "issueCapabilityIdempotency.ts": "0238a2ea01e684346abc8cc176491107d5e215b0c8f837a2f9984f4562b4b396",
  "provenance.ts": "dfc9492caaa974e3658eb1382811bd689db019dbc746ddf54e6ca5f4f15626e2",
  "redeemCapability.ts": "d306595bc8102021f5a96a5cfde8531a9f9fcdd3db8746ac2e2b6748b9432af0",
  "replayCanonical.ts": "27b95a51b81f1258aca1bc7dbf1988b1d1e6e553630492bbdabaa1de8c706c3c",
  "validateChain.ts": "bdb8e026ff3dcd8903aeb27e414c4b594667b1d341201dee4c610b1396138fe0",
};

const DIR = new URL("../oracle/engine/", import.meta.url);

describe("the frozen reference engine", () => {
  it("contains exactly the pinned files, byte for byte", () => {
    const actual = readdirSync(DIR).sort();
    expect(actual).toEqual(Object.keys(FROZEN).sort());
    for (const name of actual) {
      const sha = createHash("sha256").update(readFileSync(new URL(name, DIR))).digest("hex");
      expect({ name, sha }).toEqual({ name, sha: FROZEN[name] });
    }
  });
});
