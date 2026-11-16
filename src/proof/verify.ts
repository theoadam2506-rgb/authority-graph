/**
 * Offline verification of attestations, levels L0 to L2 (Authority Proof, PR 3).
 * Needs no database, no network and no engine run: only the attestation text and
 * the verifier's own trusted keys.
 *
 *  L0  FORM        strict JSON, closed schema at every level, canonical
 *                  encodings, the statement is consistent with itself.
 *  L1  SIGNATURE   fixed algorithm, key known to THE VERIFIER, key window and
 *                  revocation, Ed25519 signature over the frozen signing input.
 *  L2  CONTEXT     the attestation says what the verifier EXPECTED it to say
 *                  (kind, capability, action, fingerprint, enforcement point,
 *                  principal, journal head, and for an issuance, freshness at
 *                  an explicit instant).
 *
 * WHAT THIS DOES NOT DO, and the result says so every time: L0 to L2 do not
 * re-derive or validate the decision, do not check that the journal's events are
 * authentic or complete, do not check that the journal head matches any journal
 * the verifier holds (that is L3, a later change), and do not identify an
 * organization: a `key_id` names a key. A result is therefore never a plain
 * "valid"; it is `REJECTED`, `CONSISTENT_L1` or `CONSISTENT_L2`, plus the list
 * of what is not established.
 */
import { SIGNING_PREFIX, signingBytes, validateAttestationStructure, type Attestation, type AttestationKind } from "./attestation.js";
import { base64urlDecodeExact, isCanonicalInstant, isLowerHex64 } from "./encoding.js";
import { keyIdOf, verifyEd25519, type TrustedKeys } from "./keys.js";
import { parseStrictJson, parseStrictJsonBytes, StrictJsonError } from "./strictJson.js";

export type CheckStatus = "PASS" | "FAIL" | "NOT_CHECKED";

export interface Check {
  readonly id: string;
  readonly level: 0 | 1 | 2;
  readonly status: CheckStatus;
  readonly detail?: string;
}

export interface ExpectedContext {
  readonly kind?: AttestationKind;
  readonly capability_id?: string;
  readonly action_id?: string;
  readonly action_fingerprint?: string;
  readonly principal_id?: string;
  /** REQUIRED when the attestation is a REDEMPTION: a redemption is only meaningful at the enforcement point it names. */
  readonly enforcement_point_id?: string;
  readonly journal_head_hash?: string;
  readonly journal_head_sequence?: number;
  /** Explicit instant (never a clock read here). ISSUANCE only: the capability must not be expired at this instant. */
  readonly at?: string;
}

export interface VerifyOptions {
  readonly keys: TrustedKeys;
  /** Without it, L2 is NOT_CHECKED and the best result is CONSISTENT_L1. */
  readonly expected?: ExpectedContext;
}

export type VerifyOutcome = "REJECTED" | "CONSISTENT_L1" | "CONSISTENT_L2";

export interface VerifyResult {
  readonly result: VerifyOutcome;
  readonly levels: { readonly L0: CheckStatus; readonly L1: CheckStatus; readonly L2: CheckStatus };
  readonly checks: readonly Check[];
  /** Present only when L0 passed. Untrusted content until L1 and L2 pass. */
  readonly attestation?: Attestation;
  readonly key?: { readonly key_id: string; readonly label?: string };
  readonly not_established: readonly string[];
}

/** Included in every result: what L0 to L2 never establish. */
export const NOT_ESTABLISHED: readonly string[] = [
  "that the decision is correct: the statement is not re-derived from a journal (L3, a later change)",
  "that the events of the journal are authentic: they are asserted and unauthenticated (I17)",
  "that the journal is complete, or that it is the only journal with this history",
  "that the journal head matches any journal the verifier holds",
  "that the signer's clock was right",
  "that the key was not compromised",
  "who the signer is: a key_id names a public key, not a person or an organization",
  "that the effect happened, or happened once",
];


const EXPECTED_FIELDS = ["kind", "capability_id", "action_id", "action_fingerprint", "principal_id", "enforcement_point_id", "journal_head_hash", "journal_head_sequence", "at"] as const;
const isExpectedIdentifier = (v: unknown): boolean => typeof v === "string" && v.length >= 1 && v.length <= 256 && !/[\u0000-\u001f\u007f]/.test(v);

/**
 * The expected context is validated as strictly as the attestation itself. A
 * verifier's own mistake must never turn into a silent pass:
 *  - an unknown member (a typo such as `enforcement_pont_id`) would bind nothing
 *    while looking like a bound context, so it is refused;
 *  - `at` must be a canonical UTC instant `YYYY-MM-DDTHH:mm:ss.sssZ` that
 *    round-trips through a date: no date-only, no offset, no missing milliseconds,
 *    no lowercase, no impossible date (2025-02-30), no 24:00, no number, no null;
 *  - hashes are 64 lowercase hex, the sequence a safe integer >= 1, identifiers
 *    1 to 256 characters without control characters.
 * Returns the problems (empty when the context is well formed).
 */
export function validateExpectedContext(expected: unknown): string[] {
  const problems: string[] = [];
  if (typeof expected !== "object" || expected === null || Array.isArray(expected)) return ["the expected context must be an object"];
  const e = expected as Record<string, unknown>;
  for (const k of Object.keys(e)) if (!(EXPECTED_FIELDS as readonly string[]).includes(k)) problems.push(`unknown expected member ${JSON.stringify(k)}`);
  for (const [k, v] of Object.entries(e)) {
    if (!(EXPECTED_FIELDS as readonly string[]).includes(k)) continue;
    if (v === undefined) continue; // an absent value binds nothing and is treated as absent
    if (k === "at") {
      if (typeof v !== "string" || !isCanonicalInstant(v)) problems.push(`expected.at must be a canonical UTC instant YYYY-MM-DDTHH:mm:ss.sssZ, got ${JSON.stringify(v)}`);
    } else if (k === "kind") {
      if (v !== "ISSUANCE" && v !== "REDEMPTION") problems.push(`expected.kind must be "ISSUANCE" or "REDEMPTION", got ${JSON.stringify(v)}`);
    } else if (k === "journal_head_hash" || k === "action_fingerprint") {
      if (typeof v !== "string" || !isLowerHex64(v)) problems.push(`expected.${k} must be 64 lowercase hex characters`);
    } else if (k === "journal_head_sequence") {
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) problems.push("expected.journal_head_sequence must be an integer >= 1");
    } else if (!isExpectedIdentifier(v)) {
      problems.push(`expected.${k} must be an identifier (1 to 256 characters, no control characters)`);
    }
  }
  return problems;
}

const instantMs = (iso: string): number => Date.parse(iso);

export function verifyAttestation(input: string | Uint8Array, options: VerifyOptions): VerifyResult {
  const checks: Check[] = [];
  const add = (id: string, level: 0 | 1 | 2, status: CheckStatus, detail?: string): boolean => {
    checks.push({ id, level, status, ...(detail !== undefined ? { detail } : {}) });
    return status === "PASS";
  };
  const finish = (levels: { L0: CheckStatus; L1: CheckStatus; L2: CheckStatus }, extra: Partial<VerifyResult> = {}): VerifyResult => {
    const result: VerifyOutcome = levels.L0 !== "PASS" || levels.L1 !== "PASS" || levels.L2 === "FAIL" ? "REJECTED" : levels.L2 === "PASS" ? "CONSISTENT_L2" : "CONSISTENT_L1";
    return { result, levels, checks, not_established: NOT_ESTABLISHED, ...extra };
  };
  const rejectedAt0 = (): VerifyResult => finish({ L0: "FAIL", L1: "NOT_CHECKED", L2: "NOT_CHECKED" });

  // ---------------- L0 ----------------
  let parsed: unknown;
  try {
    parsed = typeof input === "string" ? parseStrictJson(input) : parseStrictJsonBytes(input);
    add("L0.JSON_STRICT", 0, "PASS");
  } catch (err) {
    add("L0.JSON_STRICT", 0, "FAIL", err instanceof StrictJsonError ? err.message : "unreadable input");
    return rejectedAt0();
  }
  const structure = validateAttestationStructure(parsed);
  if (!structure.ok) {
    add("L0.SCHEMA", 0, "FAIL", structure.problems.slice(0, 8).join("; "));
    return rejectedAt0();
  }
  add("L0.SCHEMA", 0, "PASS");
  const a = structure.attestation;
  const st = a.statement;

  const consistency: string[] = [];
  if (a.journal.head_sequence < st.event.sequence) consistency.push("journal.head_sequence is before the attested event");
  if (st.decision_sequence !== st.event.sequence - 1) consistency.push("decision_sequence is not event.sequence - 1");
  if (a.kind === "ISSUANCE" && "expires_at" in st && instantMs(st.expires_at) <= instantMs(st.event.authority_time)) consistency.push("expires_at is not after the event's authority_time");
  if (consistency.length > 0) {
    add("L0.CONSISTENCY", 0, "FAIL", consistency.join("; "));
    return rejectedAt0();
  }
  add("L0.CONSISTENCY", 0, "PASS", "the statement is consistent with itself; this is not a validation of the decision");

  // ---------------- L1 ----------------
  const fail1 = (): VerifyResult => finish({ L0: "PASS", L1: "FAIL", L2: "NOT_CHECKED" }, { attestation: a });
  add("L1.ALGORITHM", 1, "PASS", "Ed25519 (fixed, not negotiable)");
  const trusted = options.keys.get(a.signature.key_id);
  if (trusted === undefined) {
    add("L1.KEY_KNOWN", 1, "FAIL", "the key_id is not among the verifier's trusted keys");
    return fail1();
  }
  add("L1.KEY_KNOWN", 1, "PASS");
  const claimed = st.event.authority_time;
  if (trusted.revokedFrom === "ALWAYS") {
    add("L1.KEY_STATUS", 1, "FAIL", "the key is revoked for every attestation");
    return fail1();
  }
  if (trusted.revokedFrom !== undefined && instantMs(claimed) >= instantMs(trusted.revokedFrom)) {
    add("L1.KEY_STATUS", 1, "FAIL", `the key is revoked from ${trusted.revokedFrom} and the attestation CLAIMS ${claimed}`);
    return fail1();
  }
  if (trusted.notBefore !== undefined && instantMs(claimed) < instantMs(trusted.notBefore)) {
    add("L1.KEY_STATUS", 1, "FAIL", `the attestation CLAIMS ${claimed}, before the key's not_before ${trusted.notBefore}`);
    return fail1();
  }
  if (trusted.notAfter !== undefined && instantMs(claimed) > instantMs(trusted.notAfter)) {
    add("L1.KEY_STATUS", 1, "FAIL", `the attestation CLAIMS ${claimed}, after the key's not_after ${trusted.notAfter}`);
    return fail1();
  }
  add("L1.KEY_STATUS", 1, "PASS", "key window and revocation evaluated on the CLAIMED time, which is the signer's own assertion");
  if (keyIdOf(trusted.publicKey) !== a.signature.key_id) {
    add("L1.KEY_BINDING", 1, "FAIL", "the trusted key does not hash to the attestation's key_id");
    return fail1();
  }
  const sig = base64urlDecodeExact(a.signature.sig, 64);
  if (sig === undefined || !verifyEd25519(signingBytes(a), sig, trusted.publicKey)) {
    add("L1.SIGNATURE", 1, "FAIL", `the signature does not verify over ${JSON.stringify(SIGNING_PREFIX)} + JCS(attestation)`);
    return fail1();
  }
  add("L1.SIGNATURE", 1, "PASS", "the holder of the key signed exactly this document; this says nothing about whether the decision is right");

  const key = { key_id: a.signature.key_id, ...(trusted.label !== undefined ? { label: trusted.label } : {}) };

  // ---------------- L2 ----------------
  const expected = options.expected;
  if (expected === undefined) {
    add("L2.EXPECTED", 2, "NOT_CHECKED", "no expected context was supplied");
    return finish({ L0: "PASS", L1: "PASS", L2: "NOT_CHECKED" }, { attestation: a, key });
  }
  const malformed = validateExpectedContext(expected);
  if (malformed.length > 0) {
    add("L2.EXPECTED_VALID", 2, "FAIL", malformed.join("; "));
    return finish({ L0: "PASS", L1: "PASS", L2: "FAIL" }, { attestation: a, key });
  }
  add("L2.EXPECTED_VALID", 2, "PASS");
  const problems: string[] = [];
  const bound = (Object.keys(expected) as (keyof ExpectedContext)[]).filter((k) => expected[k] !== undefined);
  if (bound.length === 0) problems.push("the expected context is empty: it binds nothing");
  if (a.kind === "REDEMPTION" && expected.enforcement_point_id === undefined) problems.push("a REDEMPTION requires the expected enforcement_point_id");
  const mismatch = (name: string, expectedValue: string | number | undefined, actual: string | number): void => {
    if (expectedValue !== undefined && expectedValue !== actual) problems.push(`${name}: expected ${JSON.stringify(expectedValue)}, attestation says ${JSON.stringify(actual)}`);
  };
  mismatch("kind", expected.kind, a.kind);
  mismatch("capability_id", expected.capability_id, st.capability_id);
  mismatch("action_id", expected.action_id, st.action_id);
  mismatch("action_fingerprint", expected.action_fingerprint, st.action_fingerprint);
  mismatch("principal_id", expected.principal_id, st.principal_id);
  mismatch("enforcement_point_id", expected.enforcement_point_id, st.enforcement_point_id);
  mismatch("journal_head_hash", expected.journal_head_hash, a.journal.head_hash);
  mismatch("journal_head_sequence", expected.journal_head_sequence, a.journal.head_sequence);
  if (expected.at !== undefined) {
    if (a.kind !== "ISSUANCE") problems.push("expected.at (freshness) applies to ISSUANCE only");
    else if ("expires_at" in st && !(instantMs(expected.at) < instantMs(st.expires_at))) problems.push(`the capability expired at ${st.expires_at}, not after ${expected.at}`);
  }
  if (problems.length > 0) {
    add("L2.CONTEXT", 2, "FAIL", problems.join("; "));
    return finish({ L0: "PASS", L1: "PASS", L2: "FAIL" }, { attestation: a, key });
  }
  add("L2.CONTEXT", 2, "PASS", "the attestation matches the expected context; this is not a validation of the decision");
  return finish({ L0: "PASS", L1: "PASS", L2: "PASS" }, { attestation: a, key });
}
