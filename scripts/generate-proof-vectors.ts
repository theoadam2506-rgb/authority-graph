/**
 * Regenerates (or, with --check, verifies) the published attestation test
 * vectors in proof/vectors/. Everything is deterministic: a fixed TEST key (RFC
 * 8032 test vector 1, whose private key is public knowledge and protects
 * nothing), a fixed journal, no clock and no randomness. Two runs give
 * identical bytes; the test suite fails if the committed files drift.
 *
 *   npx tsx scripts/generate-proof-vectors.ts          # write
 *   npx tsx scripts/generate-proof-vectors.ts --check  # compare, exit 1 on any difference
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { attestIssuance, attestRedemption, signingBytes } from "../src/proof/attestation.js";
import { base64urlEncode } from "../src/proof/encoding.js";
import { createEd25519Signer, keyIdOf } from "../src/proof/keys.js";
import { journalHead } from "../src/proof/journalHash.js";
import { verifyAttestation } from "../src/proof/verify.js";
import { EP, RFC8032_TEST1, TEST_KEY_ID, TEST_PRIVATE_JWK, TEST_PUBLIC_JWK, buildFixture, testKeys, testSigner } from "../tests/proof/fixture.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "proof", "vectors");
const pretty = (v: unknown): string => JSON.stringify(v, null, 2) + "\n";

export interface VectorCase {
  readonly file: string;
  readonly description: string;
  readonly expected_context?: Record<string, unknown>;
  readonly expected_result: "REJECTED" | "CONSISTENT_L1" | "CONSISTENT_L2";
  readonly failing_check?: string;
}

export async function generate(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const f = await buildFixture();
  const issuance = await attestIssuance(f.events, f.capabilityId, testSigner());
  const redemption = await attestRedemption(f.events, f.capabilityId, testSigner());
  const trustedKeys = { format: "authority-trusted-keys/v1", keys: [{ jwk: TEST_PUBLIC_JWK, label: "RFC 8032 test vector 1 (TEST ONLY: its private key is public)" }] };

  files.set("test-key.json", pretty({ note: "RFC 8032 section 7.1 TEST 1. The private key is public knowledge: this key protects nothing and must never be trusted for real attestations.", private_jwk: TEST_PRIVATE_JWK, public_jwk: TEST_PUBLIC_JWK, key_id: TEST_KEY_ID, seed_hex: RFC8032_TEST1.seedHex, public_hex: RFC8032_TEST1.publicHex }));
  files.set("trusted-keys.json", pretty(trustedKeys));
  files.set("journal.json", pretty(f.events));
  files.set("journal.head.json", pretty({ scheme: "authority-journal-chain/v1", ...journalHead(f.events), prefix_heads: f.events.map((_e, i) => ({ ...journalHead(f.events, i + 1) })) }));
  files.set("issuance.json", pretty(issuance));
  files.set("redemption.json", pretty(redemption));
  files.set("redemption.signing-input.txt", Buffer.from(signingBytes(redemption)).toString("utf8"));
  files.set("issuance.signing-input.txt", Buffer.from(signingBytes(issuance)).toString("utf8"));

  const clone = <T,>(v: T): T => structuredClone(v);
  const resign = async (doc: Record<string, any>): Promise<string> => {
    doc.signature.sig = base64urlEncode(await testSigner().sign(signingBytes({ ...doc, signature: { alg: doc.signature.alg, key_id: doc.signature.key_id } } as never)));
    return pretty(doc);
  };
  const flipSigBit = (a: typeof redemption): typeof redemption => {
    const sig = Buffer.from(a.signature.sig, "base64url");
    sig[10] = (sig[10] ?? 0) ^ 1;
    return { ...a, signature: { ...a.signature, sig: sig.toString("base64url") } };
  };
  const other = createEd25519Signer({ kty: "OKP", crv: "Ed25519", d: base64urlEncode(Buffer.from("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb", "hex")), x: base64urlEncode(Buffer.from("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "hex")) });

  const cases: VectorCase[] = [];
  const addCase = (c: VectorCase, content: string): void => {
    files.set(`${c.file}`, content);
    cases.push(c);
  };
  const ctxRed = { enforcement_point_id: EP, capability_id: f.capabilityId, kind: "REDEMPTION" };
  const ctxIss = { enforcement_point_id: EP, capability_id: f.capabilityId, kind: "ISSUANCE", at: "2025-01-01T09:11:00.000Z" };

  addCase({ file: "issuance.json", description: "A genuine issuance attestation, verified at L2 with the expected context.", expected_context: ctxIss, expected_result: "CONSISTENT_L2" }, files.get("issuance.json")!);
  addCase({ file: "redemption.json", description: "A genuine redemption attestation, verified at L2 with the expected context.", expected_context: ctxRed, expected_result: "CONSISTENT_L2" }, files.get("redemption.json")!);
  files.set("redemption.json", files.get("redemption.json")!);

  const neg = (name: string, description: string, content: string, expected: Pick<VectorCase, "expected_result" | "failing_check">, ctx?: Record<string, unknown>) =>
    addCase({ file: `negative/${name}.json`, description, expected_result: expected.expected_result, ...(expected.failing_check !== undefined ? { failing_check: expected.failing_check } : {}), ...(ctx !== undefined ? { expected_context: ctx } : {}) }, content);

  const rText = pretty(redemption);
  neg("duplicate-key", "A duplicate object key: refused, never resolved by 'last one wins'.", rText.replace('"kind": "REDEMPTION"', '"kind": "REDEMPTION",\n  "kind": "ISSUANCE"'), { expected_result: "REJECTED", failing_check: "L0.JSON_STRICT" });
  neg("number-fraction", "head_sequence written as 5.0: not an exact integer.", rText.replace(/"head_sequence": (\d+)/, '"head_sequence": $1.0'), { expected_result: "REJECTED", failing_check: "L0.JSON_STRICT" });
  neg("number-unsafe", "head_sequence beyond 2^53: not exactly representable.", rText.replace(/"head_sequence": (\d+)/, '"head_sequence": 9007199254740993'), { expected_result: "REJECTED", failing_check: "L0.JSON_STRICT" });
  const unknownTop = clone(redemption) as unknown as Record<string, unknown>;
  unknownTop.extra = "x";
  neg("unknown-member-top", "An unknown member at the top level: refused at every level of the envelope.", pretty(unknownTop), { expected_result: "REJECTED", failing_check: "L0.SCHEMA" });
  const unknownStatement = clone(redemption) as unknown as Record<string, any>;
  unknownStatement.statement.note = "x";
  neg("unknown-member-statement", "An unknown member inside the statement.", pretty(unknownStatement), { expected_result: "REJECTED", failing_check: "L0.SCHEMA" });
  const algNone = clone(redemption) as unknown as Record<string, any>;
  algNone.signature.alg = "none";
  neg("alg-none", "alg is fixed: 'none' is refused.", pretty(algNone), { expected_result: "REJECTED", failing_check: "L0.SCHEMA" });
  const tamperedField = clone(redemption) as unknown as Record<string, any>;
  tamperedField.statement.capability_id = "cap-tampered";
  neg("tampered-capability-id", "A well-formed edit of a signed field: the signature no longer verifies.", pretty(tamperedField), { expected_result: "REJECTED", failing_check: "L1.SIGNATURE" });
  neg("tampered-signature-bit", "One bit of the signature flipped.", pretty(flipSigBit(redemption)), { expected_result: "REJECTED", failing_check: "L1.SIGNATURE" });
  const swapped = clone(issuance) as unknown as Record<string, any>;
  swapped.kind = "REDEMPTION";
  neg("kind-swapped", "An ISSUANCE relabelled REDEMPTION: refused (closed schema per kind).", pretty(swapped), { expected_result: "REJECTED", failing_check: "L0.SCHEMA" });
  const byStranger = await attestRedemption(f.events, f.capabilityId, other);
  neg("unknown-key", "Signed by a key the verifier does not trust (RFC 8032 test 2 key).", pretty(byStranger), { expected_result: "REJECTED", failing_check: "L1.KEY_KNOWN" });
  const wrongEp = clone(redemption);
  neg("wrong-enforcement-point", "Genuine redemption, but the verifier expects another enforcement point: refused at L2.", pretty(wrongEp), { expected_result: "REJECTED", failing_check: "L2.CONTEXT" }, { ...ctxRed, enforcement_point_id: "ep-other" });
  neg("redemption-without-expected-enforcement-point", "A REDEMPTION cannot be verified at L2 without the expected enforcement point.", pretty(redemption), { expected_result: "REJECTED", failing_check: "L2.CONTEXT" }, { capability_id: f.capabilityId });
  const lie = clone(redemption) as unknown as Record<string, any>;
  lie.statement.principal_id = "someone-who-never-acted";
  lie.journal.head_hash = "ab".repeat(32);
  neg("validly-signed-lie", "NOT A VALIDATION: the key holder signed a statement no journal supports. It is consistent with itself and with the expected context, so L1 and L2 pass. L0-L2 never validate the decision (L3, a later change, re-derives it).", await resign(lie), { expected_result: "CONSISTENT_L2" }, { ...ctxRed, principal_id: "someone-who-never-acted" });

  files.set("expected.json", pretty({
    format: "authority-attestation-vectors/v1",
    trusted_keys: "trusted-keys.json",
    note: "Every case is verified with verifyAttestation(text, { keys, expected }). `expected_result` and `failing_check` are what a conforming verifier must report. validly-signed-lie passes by design: see its description.",
    cases,
  }));
  files.set("README.md", `# Attestation test vectors (authority-attestation/v1)

Reproducible vectors for implementers of an independent verifier. **Test material only.**

- \`test-key.json\`: RFC 8032 section 7.1 TEST 1. Its private key is public knowledge: it protects nothing and must never be trusted for a real attestation.
- \`trusted-keys.json\`: the verifier's trusted-keys document ("authority-trusted-keys/v1").
- \`journal.json\` / \`journal.head.json\`: a 5-event journal and its hash chain ("authority-journal-chain/v1"), with the head after every prefix.
- \`issuance.json\`, \`redemption.json\`: genuine attestations over that journal.
- \`*.signing-input.txt\`: the exact bytes that were signed (UTF-8): \`authority-attestation/v1\\n\` followed by the RFC 8785 (JCS) form of the attestation with \`signature = { alg, key_id }\`.
- \`negative/\`: documents a verifier must refuse (or, for \`validly-signed-lie\`, must accept at L2 and say nothing more about).
- \`expected.json\`: for every case, the expected result and failing check.

What these vectors establish: a verifier reads the format strictly, checks an Ed25519 signature over the frozen signing input, and compares an expected context. They say nothing about whether a decision was correct, whether the events are authentic or complete, or who the key belongs to.

Regenerate or check: \`npx tsx scripts/generate-proof-vectors.ts [--check]\` (deterministic; the test suite fails if these files drift).
`);
  void verifyAttestation; void testKeys; void keyIdOf;
  return files;
}

async function main(): Promise<number> {
  const files = await generate();
  const check = process.argv.includes("--check");
  let differences = 0;
  for (const [name, content] of files) {
    const path = join(ROOT, name);
    if (check) {
      const existing = existsSync(path) ? readFileSync(path, "utf8") : undefined;
      if (existing !== content) {
        console.error(`DIFFERS: proof/vectors/${name}`);
        differences += 1;
      }
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
  }
  console.log(check ? (differences === 0 ? `proof vectors up to date (${files.size} files)` : `${differences} file(s) differ`) : `wrote ${files.size} files to proof/vectors/`);
  return differences === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
}
