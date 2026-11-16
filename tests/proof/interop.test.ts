/**
 * Interoperability: the published vectors are checked by implementations that
 * share no code with this repository. OpenSSL (a different Ed25519 and a
 * different codebase) verifies the signatures over the exact published signing
 * input; Python's standard library (hashlib + json, no third-party package)
 * recomputes the RFC 8785 form, the signing input, the key_id and the whole
 * journal hash chain from the published journal. Skipped, and reported as
 * skipped, only if the tool is not installed.
 */
import { spawnSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_PUBLIC_JWK } from "./fixture.js";

const V = "proof/vectors";
const has = (cmd: string, args: string[]): boolean => spawnSync(cmd, args, { encoding: "utf8" }).status === 0;
const hasOpenssl = has("openssl", ["version"]);
const hasPython = has("python3", ["--version"]);

describe.skipIf(!hasOpenssl)("OpenSSL verifies the published signatures (an independent Ed25519 implementation)", () => {
  const dir = mkdtempSync(join(tmpdir(), "attest-interop-"));
  const pem = join(dir, "pub.pem");
  writeFileSync(pem, createPublicKey({ key: { ...TEST_PUBLIC_JWK }, format: "jwk" }).export({ type: "spki", format: "pem" }));
  const verify = (message: Buffer, signature: Buffer): { ok: boolean; out: string } => {
    writeFileSync(join(dir, "m.bin"), message);
    writeFileSync(join(dir, "s.bin"), signature);
    const r = spawnSync("openssl", ["pkeyutl", "-verify", "-pubin", "-inkey", pem, "-rawin", "-in", join(dir, "m.bin"), "-sigfile", join(dir, "s.bin")], { encoding: "utf8" });
    return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
  };

  it.each(["issuance", "redemption"])("the %s signature verifies over the published signing input", (name) => {
    const att = JSON.parse(readFileSync(join(V, `${name}.json`), "utf8")) as { signature: { sig: string } };
    const r = verify(readFileSync(join(V, `${name}.signing-input.txt`)), Buffer.from(att.signature.sig, "base64url"));
    expect(r.out).toMatch(/Signature Verified Successfully/);
    expect(r.ok).toBe(true);
  });

  it("a one-byte change to the signing input, or one bit of the signature, makes OpenSSL refuse it too", () => {
    const att = JSON.parse(readFileSync(join(V, "redemption.json"), "utf8")) as { signature: { sig: string } };
    const input = readFileSync(join(V, "redemption.signing-input.txt"));
    const sig = Buffer.from(att.signature.sig, "base64url");
    const tamperedInput = Buffer.from(input);
    tamperedInput[40] = (tamperedInput[40] ?? 0) ^ 1;
    expect(verify(tamperedInput, sig).ok).toBe(false);
    const tamperedSig = Buffer.from(sig);
    tamperedSig[5] = (tamperedSig[5] ?? 0) ^ 1;
    expect(verify(input, tamperedSig).ok).toBe(false);
  });

  it("the signing input starts with the domain-separation prefix", () => {
    expect(readFileSync(join(V, "redemption.signing-input.txt"), "utf8").startsWith("authority-attestation/v1\n{")).toBe(true);
  });
});

describe.skipIf(!hasPython)("Python (standard library only) recomputes the published values from scratch", () => {
  const script = String.raw`
import json, hashlib, base64, sys
V = sys.argv[1]
def canon(o):
    # RFC 8785 for the subset used here: strings, integers, arrays, objects (no floats)
    return json.dumps(o, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
def sha(*parts):
    h = hashlib.sha256()
    for p in parts: h.update(p)
    return h.digest()
def b64u(b): return base64.urlsafe_b64encode(b).rstrip(b'=').decode()
out = {}
# 1. journal hash chain, all prefixes
events = json.load(open(V + '/journal.json', encoding='utf-8'))
heads = json.load(open(V + '/journal.head.json', encoding='utf-8'))
h = sha(b'authority-journal-chain/v1')
chain = []
for e in events:
    h = sha(h, sha(b'authority-journal-event/v1\n' + canon(e).encode('utf-8')))
    chain.append({'head_sequence': e['sequence'], 'head_hash': h.hex()})
out['chain_matches'] = chain == heads['prefix_heads']
out['head_matches'] = chain[-1] == {'head_sequence': heads['head_sequence'], 'head_hash': heads['head_hash']}
# 2. signing input and key_id for both attestations
key = json.load(open(V + '/test-key.json', encoding='utf-8'))
raw = base64.urlsafe_b64decode(key['public_jwk']['x'] + '==')
out['key_id_matches'] = b64u(hashlib.sha256(raw).digest()) == key['key_id']
for name in ('issuance', 'redemption'):
    a = json.load(open(V + '/' + name + '.json', encoding='utf-8'))
    unsigned = dict(a); unsigned['signature'] = {'alg': a['signature']['alg'], 'key_id': a['signature']['key_id']}
    mine = 'authority-attestation/v1\n' + canon(unsigned)
    theirs = open(V + '/' + name + '.signing-input.txt', 'rb').read().decode('utf-8')
    out[name + '_signing_input_matches'] = mine == theirs
    out[name + '_key_id_in_attestation'] = a['signature']['key_id'] == key['key_id']
    out[name + '_head_is_a_journal_prefix'] = {'head_sequence': a['journal']['head_sequence'], 'head_hash': a['journal']['head_hash']} in heads['prefix_heads']
print(json.dumps(out))
`;
  const run = (): Record<string, boolean> => {
    const r = spawnSync("python3", ["-I", "-c", script, V], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`python failed: ${r.stderr}`);
    return JSON.parse(r.stdout) as Record<string, boolean>;
  };

  it("the journal hash chain, every prefix head, the key_id and both signing inputs agree with an independent implementation", () => {
    const out = run();
    expect(out).toEqual({
      chain_matches: true, head_matches: true, key_id_matches: true,
      issuance_signing_input_matches: true, issuance_key_id_in_attestation: true, issuance_head_is_a_journal_prefix: true,
      redemption_signing_input_matches: true, redemption_key_id_in_attestation: true, redemption_head_is_a_journal_prefix: true,
    });
  });
});
