/**
 * `authority proof ...` (Authority Proof, PR 4): offline verification of
 * attestations from the command line. A thin layer: every decision is made by
 * `verifyAttestationL3` / `journalHead`; this file reads files (bounded, regular
 * files only), builds the options, and prints. It performs no network access, no
 * clock read, no key generation and no signing: it never touches a private key.
 *
 *   authority proof verify <attestation.json> --keys <trusted-keys.json>
 *       [--journal <journal.json>] [--trusted-heads <heads.json>]
 *       [--scope full|prefix] [--max-events N]
 *       [--expect-kind K] [--expect-capability-id X] [--expect-action-id X]
 *       [--expect-fingerprint H] [--expect-principal X] [--expect-enforcement-point X]
 *       [--expect-head-hash H] [--expect-head-sequence N] [--at <instant>] [--json]
 *   authority proof head <journal.json> [--up-to N] [--max-events N] [--replay] [--json]
 *
 * Exit codes: 0 every requested level passed (CONSISTENT_*); 1 REJECTED;
 * 2 an input file could not be read or is malformed (keys, heads, journal file
 * missing); 64 usage error. A result of 0 is NEVER a statement that the decision
 * is right or that the journal is authentic or complete: the output always lists
 * what is not established.
 */
import { promises as fs } from "node:fs";
import { replayCanonicalStore } from "../engine/replayCanonical.js";
import type { CanonicalStore } from "../domain/events.js";
import { parseTrustedHeads, TrustedHeadsFormatError } from "./heads.js";
import { JOURNAL_HASH_SCHEME, JournalFormatError, journalHead } from "./journalHash.js";
import { KeyFormatError, parseTrustedKeys } from "./keys.js";
import { DEFAULT_MAX_JOURNAL_BYTES, DEFAULT_MAX_REPLAY_EVENTS, NOT_ESTABLISHED_L3, verifyAttestationL3, type L3Options, type ReplayScope, type VerifyReport } from "./replay.js";
import { stableStringify } from "./stableJson.js";
import { DEFAULT_STRICT_JSON_LIMITS, parseStrictJson, StrictJsonError } from "./strictJson.js";
import type { ExpectedContext } from "./verify.js";

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const USAGE = `Usage:
  authority proof verify <attestation.json> --keys <trusted-keys.json> [--journal <journal.json>]
        [--trusted-heads <heads.json>] [--scope full|prefix] [--max-events N]
        [--expect-kind ISSUANCE|REDEMPTION] [--expect-capability-id X] [--expect-action-id X]
        [--expect-fingerprint HEX] [--expect-principal X] [--expect-enforcement-point X]
        [--expect-head-hash HEX] [--expect-head-sequence N] [--at <UTC instant, ms precision>] [--json]
  authority proof head <journal.json> [--up-to N] [--max-events N] [--replay] [--json]
Exit codes: 0 consistent, 1 rejected, 2 unreadable or malformed input file, 64 usage.
`;

class UsageError extends Error {}
class InputError extends Error {}

const BOOLEAN_FLAGS = new Set(["--json", "--replay"]);
const VERIFY_FLAGS = new Set(["--keys", "--journal", "--trusted-heads", "--scope", "--max-events", "--json", "--at", "--expect-kind", "--expect-capability-id", "--expect-action-id", "--expect-fingerprint", "--expect-principal", "--expect-enforcement-point", "--expect-head-hash", "--expect-head-sequence"]);
const HEAD_FLAGS = new Set(["--up-to", "--max-events", "--replay", "--json"]);

function parseArgs(argv: readonly string[], allowed: ReadonlySet<string>): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    if (!allowed.has(a)) throw new UsageError(`unknown option ${a}`);
    if (flags.has(a)) throw new UsageError(`option ${a} given twice`);
    if (BOOLEAN_FLAGS.has(a)) {
      flags.set(a, true);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`option ${a} needs a value`);
    flags.set(a, value);
    i += 1;
  }
  return { positional, flags };
}

const flag = (f: Map<string, string | true>, name: string): string | undefined => {
  const v = f.get(name);
  return typeof v === "string" ? v : undefined;
};

function positiveInt(name: string, value: string): number {
  if (!/^[1-9][0-9]{0,8}$/.test(value)) throw new UsageError(`${name} must be a positive integer`);
  return Number(value);
}

async function readBounded(path: string, maxBytes: number, what: string): Promise<Buffer> {
  let st;
  try {
    st = await fs.stat(path);
  } catch {
    throw new InputError(`${what}: cannot read ${path}`);
  }
  if (!st.isFile()) throw new InputError(`${what}: ${path} is not a regular file`);
  if (st.size > maxBytes) throw new InputError(`${what}: ${path} is ${st.size} bytes, above the limit of ${maxBytes}`);
  try {
    return await fs.readFile(path);
  } catch {
    throw new InputError(`${what}: cannot read ${path}`);
  }
}

const utf8 = (b: Buffer, what: string): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b);
  } catch {
    throw new InputError(`${what}: not valid UTF-8`);
  }
};

function renderReport(r: VerifyReport): string {
  const lines: string[] = [];
  lines.push(`result: ${r.result}`);
  lines.push(`levels: L0 ${r.levels.L0} | L1 ${r.levels.L1} | L2 ${r.levels.L2} | L3 ${r.levels.L3}`);
  if (r.attestation !== null) lines.push(`attestation: ${r.attestation.kind} capability ${r.attestation.capability_id} at ${r.attestation.enforcement_point_id}, journal head ${r.attestation.journal_head.head_sequence}:${r.attestation.journal_head.head_hash}`);
  if (r.key !== null) lines.push(`key_id: ${r.key.key_id} (a public key, not an identity)`);
  lines.push("checks:");
  for (const c of r.checks) lines.push(`  ${c.status.padEnd(11)} ${c.id}${c.detail !== undefined ? `  ${c.detail}` : ""}`);
  if (r.journal !== null) {
    lines.push(`scope: ${r.scope}`);
    lines.push(`  ${r.journal.scope_explanation}`);
    lines.push(`attested prefix (events 1 to ${r.journal.attested_prefix.head_sequence}): replay ${r.journal.attested_prefix.replay}, head ${r.journal.attested_prefix.head_hash_matches}, statement ${r.journal.attested_prefix.statement_matches_event}, decision re-derived ${r.journal.attested_prefix.decision_rederived}`);
    lines.push(`full journal provided (${r.journal.events_provided ?? "?"} events, ${r.journal.full_journal.events_after_attested_head ?? "?"} after the attested head): replay ${r.journal.full_journal.replay}`);
  }
  if (r.anchor !== null) {
    lines.push(`anchored: ${r.anchored ? "YES" : "NO"} (${r.anchor.status}; ${r.anchor.matched} of ${r.anchor.supplied} supplied anchors match; provenance ${r.anchor.provenance}; independence ${r.anchor.independence})`);
    lines.push(`  ${r.anchor.explanation}`);
  }
  if (r.later_revocations !== null) {
    lines.push(`later revocations on the attested chain (information only): ${r.later_revocations.count}`);
    for (const l of r.later_revocations.listed) lines.push(`  sequence ${l.sequence}: ${l.delegation_id} revoked by ${l.revoked_by_principal_id} (${l.reason_code})`);
  }
  lines.push("NOT ESTABLISHED by this result:");
  for (const n of r.not_established) lines.push(`  - ${n}`);
  return lines.join("\n") + "\n";
}

async function verifyCommand(argv: readonly string[]): Promise<CliResult> {
  const { positional, flags } = parseArgs(argv, VERIFY_FLAGS);
  if (positional.length !== 1) throw new UsageError("exactly one attestation file is required");
  const keysPath = flag(flags, "--keys");
  if (keysPath === undefined) throw new UsageError("--keys is required: a verifier trusts keys it chose, never the attestation's own claims");
  const journalPath = flag(flags, "--journal");
  const headsPath = flag(flags, "--trusted-heads");
  for (const dependent of ["--trusted-heads", "--scope", "--max-events"]) if (flags.has(dependent) && journalPath === undefined) throw new UsageError(`${dependent} requires --journal`);
  const scopeFlag = flag(flags, "--scope");
  if (scopeFlag !== undefined && scopeFlag !== "full" && scopeFlag !== "prefix") throw new UsageError('--scope must be "full" or "prefix"');
  const maxEvents = flag(flags, "--max-events") !== undefined ? positiveInt("--max-events", flag(flags, "--max-events") as string) : undefined;

  const expected: Record<string, string | number> = {};
  const map: [string, keyof ExpectedContext][] = [["--expect-kind", "kind"], ["--expect-capability-id", "capability_id"], ["--expect-action-id", "action_id"], ["--expect-fingerprint", "action_fingerprint"], ["--expect-principal", "principal_id"], ["--expect-enforcement-point", "enforcement_point_id"], ["--expect-head-hash", "journal_head_hash"], ["--at", "at"]];
  for (const [f, k] of map) {
    const v = flag(flags, f);
    if (v !== undefined) expected[k] = v;
  }
  const seq = flag(flags, "--expect-head-sequence");
  if (seq !== undefined) expected.journal_head_sequence = positiveInt("--expect-head-sequence", seq);

  const attestationText = utf8(await readBounded(positional[0] as string, DEFAULT_STRICT_JSON_LIMITS.maxBytes, "attestation"), "attestation");
  let keys;
  try {
    keys = parseTrustedKeys(utf8(await readBounded(keysPath, DEFAULT_STRICT_JSON_LIMITS.maxBytes, "keys"), "keys file"));
  } catch (e) {
    if (e instanceof InputError) throw e;
    if (e instanceof KeyFormatError || e instanceof StrictJsonError) throw new InputError(`keys file: ${e.message}`);
    throw e;
  }
  let trustedHeads;
  if (headsPath !== undefined) {
    try {
      trustedHeads = parseTrustedHeads(utf8(await readBounded(headsPath, DEFAULT_STRICT_JSON_LIMITS.maxBytes, "trusted heads"), "trusted heads file"));
    } catch (e) {
      if (e instanceof InputError) throw e;
      if (e instanceof TrustedHeadsFormatError || e instanceof StrictJsonError) throw new InputError(`trusted heads file: ${e.message}`);
      throw e;
    }
  }
  const journal = journalPath !== undefined ? await readBounded(journalPath, DEFAULT_MAX_JOURNAL_BYTES, "journal") : undefined;

  const options: L3Options = {
    keys,
    ...(Object.keys(expected).length > 0 ? { expected: expected as unknown as ExpectedContext } : {}),
    ...(journal !== undefined ? { journal: new Uint8Array(journal) } : {}),
    ...(trustedHeads !== undefined ? { trustedHeads } : {}),
    ...(scopeFlag !== undefined ? { scope: (scopeFlag === "prefix" ? "ATTESTED_PREFIX_ONLY" : "FULL_JOURNAL") as ReplayScope } : {}),
    ...(maxEvents !== undefined ? { maxEvents } : {}),
  };
  const report = verifyAttestationL3(attestationText, options);
  const out = flags.has("--json") ? stableStringify(report) : renderReport(report);
  return { exitCode: report.result === "REJECTED" ? 1 : 0, stdout: out, stderr: "" };
}

async function headCommand(argv: readonly string[]): Promise<CliResult> {
  const { positional, flags } = parseArgs(argv, HEAD_FLAGS);
  if (positional.length !== 1) throw new UsageError("exactly one journal file is required");
  const maxEvents = flag(flags, "--max-events") !== undefined ? positiveInt("--max-events", flag(flags, "--max-events") as string) : DEFAULT_MAX_REPLAY_EVENTS;
  const upTo = flag(flags, "--up-to") !== undefined ? positiveInt("--up-to", flag(flags, "--up-to") as string) : undefined;
  const text = utf8(await readBounded(positional[0] as string, DEFAULT_MAX_JOURNAL_BYTES, "journal"), "journal");
  let raw: unknown;
  try {
    raw = parseStrictJson(text, { maxBytes: DEFAULT_MAX_JOURNAL_BYTES, maxDepth: 16, maxStringLength: 4096, maxArrayLength: maxEvents + 1, maxObjectProperties: 64 });
  } catch (e) {
    throw new InputError(`journal: ${e instanceof StrictJsonError ? e.message : "unreadable"}`);
  }
  if (!Array.isArray(raw)) throw new InputError("journal: must be a JSON array of events");
  if (raw.length > maxEvents) throw new InputError(`journal: ${raw.length} events, above the replay limit of ${maxEvents} (measured ceiling, docs/v1/ATTESTATIONS.md; override with --max-events)`);
  let head;
  try {
    head = journalHead(raw as unknown as CanonicalStore, upTo);
  } catch (e) {
    if (e instanceof JournalFormatError) return { exitCode: 1, stdout: "", stderr: `error: ${e.message}\n` };
    throw e;
  }
  let replay: string = "NOT_CHECKED";
  if (flags.has("--replay")) {
    const r = replayCanonicalStore(upTo === undefined ? raw : raw.slice(0, upTo));
    replay = r.ok ? "PASS" : `FAIL (${r.reason} at index ${r.atIndex})`;
  }
  const doc = { report_version: "authority-proof-head-report/v1", scheme: JOURNAL_HASH_SCHEME, events_in_file: raw.length, head_sequence: head.head_sequence, head_hash: head.head_hash, replay, note: "This hashes the events as exported. It does not authenticate them, does not prove the journal is complete, and, unless --replay is given, does not replay them. A head you compute yourself from a journal you obtained from the same place proves nothing about its independence." };
  const out = flags.has("--json") ? stableStringify(doc) : `scheme: ${doc.scheme}\nevents in file: ${doc.events_in_file}\nhead_sequence: ${doc.head_sequence}\nhead_hash: ${doc.head_hash}\nreplay: ${doc.replay}\nnote: ${doc.note}\n`;
  return { exitCode: replay.startsWith("FAIL") ? 1 : 0, stdout: out, stderr: "" };
}

export async function runProofCli(argv: readonly string[]): Promise<CliResult> {
  try {
    const [sub, ...rest] = argv;
    if (sub === "verify") return await verifyCommand(rest);
    if (sub === "head") return await headCommand(rest);
    if (sub === undefined || sub === "--help" || sub === "-h") return { exitCode: sub === undefined ? 64 : 0, stdout: sub === undefined ? "" : USAGE, stderr: sub === undefined ? USAGE : "" };
    throw new UsageError(`unknown proof command ${JSON.stringify(sub)}`);
  } catch (e) {
    if (e instanceof UsageError) return { exitCode: 64, stdout: "", stderr: `error: ${e.message}\n${USAGE}` };
    if (e instanceof InputError) return { exitCode: 2, stdout: "", stderr: `error: ${e.message}\n` };
    throw e;
  }
}

export { NOT_ESTABLISHED_L3 };
