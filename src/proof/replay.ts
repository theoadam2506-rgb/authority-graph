/**
 * L3: deterministic replay of an attestation against a journal the verifier
 * supplies (Authority Proof, PR 4), and the stable report
 * `authority-proof-verify-report/v1`.
 *
 * L3 runs only if L0 to L2 passed. A key revoked with `revoked_from: "ALWAYS"`
 * (or from an instant before the claimed time) fails L1 and the result is
 * `REJECTED` however well the statement matches a journal: L3 is NOT RUN in that
 * case, so nothing in the report can be read as acceptance of that signature.
 *
 * What L3 does, in this order (the first failure stops the run, earlier
 * statuses stay visible):
 *   L3.JOURNAL_READ    strict, bounded reading of the journal
 *   L3.PREFIX_REPLAY   the attested prefix (events 1..head_sequence) replays through
 *                      the engine's ingestion rules and is canonical
 *   L3.HEAD            the prefix hashes to the attestation's head
 *   L3.EVENT           the statement equals the statement the engine's builder
 *                      derives from the journal's event
 *   L3.DECISION        the engine's own validator accepts the event over the prefix
 *                      (`validateAndSelectGrant` / `validateRedemptionEvent`, I31)
 *   L3.FULL_REPLAY     (scope FULL_JOURNAL only) the whole journal provided replays,
 *                      suffix included
 *   L3.ANCHOR          the verifier's anchors, if any, match the journal
 *
 * Two different things are validated and kept apart in the report:
 *   - the ATTESTED PREFIX: what the signer actually vouched for;
 *   - the FULL JOURNAL PROVIDED: including events after the attested head.
 * The default scope is FULL_JOURNAL (fail closed: a journal that is invalid
 * after the head is refused, and the report says the prefix was fine).
 * ATTESTED_PREFIX_ONLY is an explicit choice, and says so.
 *
 * What L3 does NOT establish, always stated in the report: that the journal's
 * events are authentic (they are asserted, I17); that the journal is complete;
 * that it is the journal of the system that produced the attestation (only an
 * anchor from a source independent of the signer, supplied by you, could say so,
 * and this tool cannot tell whether yours is); anything about events after the
 * attested head or the anchor. Later revocations are listed for information and
 * never change the result.
 */
import { canonicalizeToolArguments } from "../domain/canonicalJson.js";
import type { AuthorityEvent, CanonicalStore } from "../domain/events.js";
import { replayCanonicalStore } from "../engine/replayCanonical.js";
import { validateAndSelectGrant } from "../engine/grantValidation.js";
import { validateRedemptionEvent } from "../engine/redeemCapability.js";
import { issuanceStatementOf, redemptionStatementOf, type Attestation } from "./attestation.js";
import { ANCHOR_EXPLANATION, type TrustedHeads } from "./heads.js";
import { journalHead, JournalFormatError } from "./journalHash.js";
import { DEFAULT_STRICT_JSON_LIMITS, parseStrictJson, parseStrictJsonBytes, StrictJsonError, type StrictJsonLimits } from "./strictJson.js";
import { NOT_ESTABLISHED, verifyAttestation, type Check, type CheckStatus, type VerifyOptions } from "./verify.js";

export const REPORT_VERSION = "authority-proof-verify-report/v1";

/**
 * PROVISIONAL default bound on the number of events replayed. The replay in the
 * engine copies its state per event (quadratic); the limit is set from
 * measurements (docs/v1/ATTESTATIONS.md, "Replay cost") and will be revisited.
 */
export const DEFAULT_MAX_REPLAY_EVENTS = 10_000;
export const DEFAULT_MAX_JOURNAL_BYTES = 128 * 1024 * 1024;

export type ReplayScope = "FULL_JOURNAL" | "ATTESTED_PREFIX_ONLY";
export type AnchorStatus = "NONE_SUPPLIED" | "BELOW_ATTESTED_HEAD" | "COVERS_ATTESTED_PREFIX";
export type ReportResult = "REJECTED" | "CONSISTENT_L1" | "CONSISTENT_L2" | "CONSISTENT_L3";

export interface L3Options extends VerifyOptions {
  /** The raw journal export (a JSON array of canonical events). Without it L3 is NOT_CHECKED. */
  readonly journal?: string | Uint8Array;
  readonly trustedHeads?: TrustedHeads;
  readonly scope?: ReplayScope;
  readonly maxEvents?: number;
  readonly maxJournalBytes?: number;
}

export interface LaterRevocation {
  readonly sequence: number;
  readonly delegation_id: string;
  readonly revoked_by_principal_id: string;
  readonly reason_code: string;
}

export interface VerifyReport {
  readonly report_version: typeof REPORT_VERSION;
  readonly result: ReportResult;
  readonly levels: { readonly L0: CheckStatus; readonly L1: CheckStatus; readonly L2: CheckStatus; readonly L3: CheckStatus };
  readonly checks: readonly Check[];
  readonly scope: ReplayScope | null;
  /** True only if a supplied anchor matches AND covers the whole attested prefix. Says nothing about the anchor's independence. */
  readonly anchored: boolean;
  readonly anchor: {
    readonly status: AnchorStatus;
    readonly supplied: number;
    readonly matched: number;
    readonly covering: { readonly head_sequence: number; readonly head_hash: string; readonly label?: string } | null;
    readonly provenance: "SUPPLIED_BY_VERIFIER";
    readonly independence: "NOT_ESTABLISHED";
    readonly explanation: string;
  } | null;
  readonly journal: {
    readonly events_provided: number | null;
    readonly attested_prefix: { readonly head_sequence: number; readonly replay: CheckStatus; readonly head_hash_matches: CheckStatus; readonly statement_matches_event: CheckStatus; readonly decision_rederived: CheckStatus };
    readonly full_journal: { readonly scope_checked: boolean; readonly replay: CheckStatus; readonly events_after_attested_head: number | null };
    readonly scope_explanation: string;
  } | null;
  readonly later_revocations: { readonly count: number; readonly listed: readonly LaterRevocation[]; readonly note: string } | null;
  readonly key: { readonly key_id: string; readonly label?: string } | null;
  readonly attestation: {
    readonly kind: string;
    readonly capability_id: string;
    readonly action_id: string;
    readonly enforcement_point_id: string;
    readonly journal_head: { readonly head_sequence: number; readonly head_hash: string };
  } | null;
  readonly not_established: readonly string[];
}

/** The exact members of every object of the frozen report format `authority-proof-verify-report/v1`. The JSON Schema and the tests are checked against it. */
export const REPORT_FIELDS = {
  report: ["report_version", "result", "levels", "checks", "scope", "anchored", "anchor", "journal", "later_revocations", "key", "attestation", "not_established"],
  levels: ["L0", "L1", "L2", "L3"],
  check: ["id", "level", "status", "detail"],
  anchor: ["status", "supplied", "matched", "covering", "provenance", "independence", "explanation"],
  covering: ["head_sequence", "head_hash", "label"],
  journal: ["events_provided", "attested_prefix", "full_journal", "scope_explanation"],
  attestedPrefix: ["head_sequence", "replay", "head_hash_matches", "statement_matches_event", "decision_rederived"],
  fullJournal: ["scope_checked", "replay", "events_after_attested_head"],
  laterRevocations: ["count", "listed", "note"],
  listed: ["sequence", "delegation_id", "revoked_by_principal_id", "reason_code"],
  key: ["key_id", "label"],
  attestation: ["kind", "capability_id", "action_id", "enforcement_point_id", "journal_head"],
  journalHead: ["head_sequence", "head_hash"],
} as const;

export const NOT_ESTABLISHED_L3: readonly string[] = [
  ...NOT_ESTABLISHED.filter((s) => !s.startsWith("that the journal head matches")),
  "that the journal you supplied is the journal of the system that produced the attestation, unless an anchor from a source independent of the signer covers it (this tool cannot tell whether your anchor is independent)",
  "anything about events after the attested head or after the last covering anchor: completeness and authenticity of the suffix are not established, and a revocation after the head is listed for information only",
];

const SCOPE_EXPLANATION: Record<ReplayScope, string> = {
  FULL_JOURNAL:
    "Both the attested prefix (events 1 to the attested head: what the signer vouched for) and the whole journal you provided (including events after the head) were replayed. A suffix that does not replay is refused, and the report says whether the prefix itself was sound.",
  ATTESTED_PREFIX_ONLY:
    "Only the attested prefix (events 1 to the attested head) was replayed. Events after the attested head were NOT validated: this is an explicit choice, and says nothing about the rest of the journal you provided.",
};

const LATER_NOTE =
  "Information only. Revocations recorded after the attested head, on delegations in the attested chain, are listed; they never change the result. The attestation speaks of the journal as of its head, not of today.";

const JOURNAL_LIMITS = (maxEvents: number): StrictJsonLimits => ({
  maxBytes: DEFAULT_MAX_JOURNAL_BYTES,
  maxDepth: 16,
  maxStringLength: DEFAULT_STRICT_JSON_LIMITS.maxStringLength * 4,
  maxArrayLength: Math.max(DEFAULT_STRICT_JSON_LIMITS.maxArrayLength, maxEvents + 1),
  maxObjectProperties: DEFAULT_STRICT_JSON_LIMITS.maxObjectProperties,
});

function emptyReport(base: ReturnType<typeof verifyAttestation>, l3: CheckStatus, scope: ReplayScope | null): VerifyReport {
  const result: ReportResult = base.result;
  return {
    report_version: REPORT_VERSION,
    result,
    levels: { ...base.levels, L3: l3 },
    checks: base.checks,
    scope,
    anchored: false,
    anchor: null,
    journal: null,
    later_revocations: null,
    key: base.key ?? null,
    attestation: summarize(base.attestation),
    not_established: base.result === "REJECTED" || scope === null ? base.not_established : NOT_ESTABLISHED_L3,
  };
}

function summarize(a: Attestation | undefined): VerifyReport["attestation"] {
  if (a === undefined) return null;
  return {
    kind: a.kind,
    capability_id: a.statement.capability_id,
    action_id: a.statement.action_id,
    enforcement_point_id: a.statement.enforcement_point_id,
    journal_head: { head_sequence: a.journal.head_sequence, head_hash: a.journal.head_hash },
  };
}

const replayWhy = (r: { reason: string; atIndex: number }): string => `${r.reason} at index ${r.atIndex} (event sequence ${r.atIndex + 1})`;

export function verifyAttestationL3(input: string | Uint8Array, options: L3Options): VerifyReport {
  const base = verifyAttestation(input, { keys: options.keys, ...(options.expected !== undefined ? { expected: options.expected } : {}) });
  const requested = options.journal !== undefined;
  const scope: ReplayScope | null = requested ? (options.scope ?? "FULL_JOURNAL") : null;

  // L3 never runs for a document that already failed: in particular a revoked key cannot be rescued by a matching journal.
  if (base.result === "REJECTED") return emptyReport(base, "NOT_CHECKED", scope);
  if (!requested || base.attestation === undefined) return emptyReport(base, "NOT_CHECKED", null);

  const a = base.attestation;
  const head = a.journal.head_sequence;
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_REPLAY_EVENTS;
  const checks: Check[] = [...base.checks];
  const st = { prefixReplay: "NOT_CHECKED" as CheckStatus, headMatches: "NOT_CHECKED" as CheckStatus, eventMatches: "NOT_CHECKED" as CheckStatus, decision: "NOT_CHECKED" as CheckStatus, fullReplay: "NOT_CHECKED" as CheckStatus };
  let eventsProvided: number | null = null;
  let eventsAfter: number | null = null;
  let anchorInfo: VerifyReport["anchor"] = null;
  let later: VerifyReport["later_revocations"] = null;
  let anchored = false;

  const add = (id: string, status: CheckStatus, detail?: string): void => {
    checks.push({ id, level: 3, status, ...(detail !== undefined ? { detail } : {}) });
  };
  const finish = (l3: CheckStatus): VerifyReport => ({
    report_version: REPORT_VERSION,
    result: l3 === "PASS" ? "CONSISTENT_L3" : "REJECTED",
    levels: { ...base.levels, L3: l3 },
    checks,
    scope,
    anchored,
    anchor: anchorInfo,
    journal: {
      events_provided: eventsProvided,
      attested_prefix: { head_sequence: head, replay: st.prefixReplay, head_hash_matches: st.headMatches, statement_matches_event: st.eventMatches, decision_rederived: st.decision },
      full_journal: { scope_checked: scope === "FULL_JOURNAL", replay: scope === "FULL_JOURNAL" ? st.fullReplay : "NOT_CHECKED", events_after_attested_head: eventsAfter },
      scope_explanation: SCOPE_EXPLANATION[scope ?? "FULL_JOURNAL"],
    },
    later_revocations: later,
    key: base.key ?? null,
    attestation: summarize(a),
    not_established: NOT_ESTABLISHED_L3,
  });
  const fail = (id: string, detail: string): VerifyReport => {
    add(id, "FAIL", detail);
    return finish("FAIL");
  };

  // ---- L3.JOURNAL_READ ----
  let raw: unknown;
  try {
    raw = typeof options.journal === "string"
      ? parseStrictJson(options.journal, { ...JOURNAL_LIMITS(maxEvents), maxBytes: options.maxJournalBytes ?? DEFAULT_MAX_JOURNAL_BYTES })
      : parseStrictJsonBytes(options.journal as Uint8Array, { ...JOURNAL_LIMITS(maxEvents), maxBytes: options.maxJournalBytes ?? DEFAULT_MAX_JOURNAL_BYTES });
  } catch (err) {
    return fail("L3.JOURNAL_READ", err instanceof StrictJsonError ? err.message : "unreadable journal");
  }
  if (!Array.isArray(raw)) return fail("L3.JOURNAL_READ", "the journal must be a JSON array of events");
  eventsProvided = raw.length;
  if (raw.length > maxEvents) return fail("L3.JOURNAL_READ", `the journal has ${raw.length} events, above the replay limit of ${maxEvents} (provisional; see docs/v1/ATTESTATIONS.md, "Replay cost")`);
  add("L3.JOURNAL_READ", "PASS", `${raw.length} events read strictly`);

  // ---- L3.PREFIX_REPLAY (and, for the full scope, the full replay it comes from) ----
  if (raw.length < head) {
    st.prefixReplay = "FAIL";
    return fail("L3.PREFIX_REPLAY", `the journal has ${raw.length} events, fewer than the attested head ${head}: it is truncated relative to the attestation`);
  }
  let prefix: CanonicalStore | undefined;
  let full: CanonicalStore | undefined;
  let fullFailure: { reason: string; atIndex: number } | undefined;
  if (scope === "FULL_JOURNAL") {
    const r = replayCanonicalStore(raw);
    if (r.ok) {
      full = r.canonicalStore;
      prefix = full.slice(0, head);
    } else {
      fullFailure = { reason: r.reason, atIndex: r.atIndex };
      if (r.atIndex >= head) {
        const p = replayCanonicalStore(raw.slice(0, head));
        if (p.ok) prefix = p.canonicalStore;
      }
    }
  } else {
    const r = replayCanonicalStore(raw.slice(0, head));
    if (r.ok) prefix = r.canonicalStore;
    if (!r.ok) {
      st.prefixReplay = "FAIL";
      return fail("L3.PREFIX_REPLAY", `the attested prefix does not replay: ${replayWhy(r)}`);
    }
  }
  if (prefix === undefined) {
    st.prefixReplay = "FAIL";
    return fail("L3.PREFIX_REPLAY", `the attested prefix does not replay: ${replayWhy(fullFailure ?? { reason: "REPLAY_MALFORMED", atIndex: 0 })}`);
  }
  st.prefixReplay = "PASS";
  add("L3.PREFIX_REPLAY", "PASS", `events 1 to ${head} replay deterministically through the engine's ingestion rules and are canonical`);

  // ---- L3.HEAD ----
  let computed: string;
  try {
    computed = journalHead(prefix, head).head_hash;
  } catch (err) {
    st.headMatches = "FAIL";
    return fail("L3.HEAD", err instanceof JournalFormatError ? err.message : "the prefix cannot be hashed");
  }
  if (computed !== a.journal.head_hash) {
    st.headMatches = "FAIL";
    return fail("L3.HEAD", "the attested prefix of this journal does not hash to the attestation's head: a different history, or a modified journal");
  }
  st.headMatches = "PASS";
  add("L3.HEAD", "PASS", `events 1 to ${head} hash to the attested head`);

  // ---- L3.EVENT ----
  const event = prefix[a.statement.event.sequence - 1] as AuthorityEvent | undefined;
  const expectedType = a.kind === "ISSUANCE" ? "CAPABILITY_ISSUED" : "CAPABILITY_REDEEMED";
  if (event === undefined || event.event_type !== expectedType) {
    st.eventMatches = "FAIL";
    return fail("L3.EVENT", `the journal has no ${expectedType} at sequence ${a.statement.event.sequence}`);
  }
  const derived = event.event_type === "CAPABILITY_ISSUED" ? issuanceStatementOf(event) : event.event_type === "CAPABILITY_REDEEMED" ? redemptionStatementOf(event) : undefined;
  if (derived === undefined || canonicalizeToolArguments(derived) !== canonicalizeToolArguments(a.statement)) {
    st.eventMatches = "FAIL";
    const differing = derived === undefined ? [] : Object.keys(derived).filter((k) => canonicalizeToolArguments((derived as unknown as Record<string, unknown>)[k]) !== canonicalizeToolArguments((a.statement as unknown as Record<string, unknown>)[k]));
    return fail("L3.EVENT", `the signed statement differs from the journal's event in: ${differing.join(", ") || "its shape"}`);
  }
  st.eventMatches = "PASS";
  add("L3.EVENT", "PASS", "the statement equals what the engine derives from the journal's event");

  // ---- L3.DECISION ----
  if (event.event_type === "CAPABILITY_ISSUED") {
    const g = validateAndSelectGrant(prefix, event);
    if (!g.ok) {
      st.decision = "FAIL";
      return fail("L3.DECISION", `the engine's validator refuses this issuance over the attested prefix: ${g.reason}`);
    }
  } else if (event.event_type === "CAPABILITY_REDEEMED") {
    const v = validateRedemptionEvent(prefix, event);
    if (!v.ok) {
      st.decision = "FAIL";
      return fail("L3.DECISION", `the engine's validator refuses this redemption over the attested prefix: ${v.reason}`);
    }
  }
  st.decision = "PASS";
  add("L3.DECISION", "PASS", "the engine's own validator accepts the event over the attested prefix, deterministically, with no clock and no network");

  // ---- L3.FULL_REPLAY ----
  if (scope === "FULL_JOURNAL") {
    if (full === undefined) {
      st.fullReplay = "FAIL";
      return fail("L3.FULL_REPLAY", `the attested prefix is sound, but the journal you provided does not replay after it: ${replayWhy(fullFailure ?? { reason: "REPLAY_MALFORMED", atIndex: head })}`);
    }
    st.fullReplay = "PASS";
    eventsAfter = full.length - head;
    add("L3.FULL_REPLAY", "PASS", `all ${full.length} events of the journal replay, ${eventsAfter} after the attested head`);
    // Later revocations on the attested chain, from the validated suffix only.
    const chain = new Set<string>();
    if (event.event_type === "CAPABILITY_ISSUED") event.payload.granted_chain_ref.forEach((l) => { if (l.kind === "delegation") chain.add(String(l.delegation_id)); });
    else {
      const issued = prefix.find((e) => e.event_type === "CAPABILITY_ISSUED" && e.payload.capability_id === (event as Extract<AuthorityEvent, { event_type: "CAPABILITY_REDEEMED" }>).payload.capability_id);
      if (issued !== undefined && issued.event_type === "CAPABILITY_ISSUED") issued.payload.granted_chain_ref.forEach((l) => { if (l.kind === "delegation") chain.add(String(l.delegation_id)); });
    }
    const listed: LaterRevocation[] = [];
    let count = 0;
    for (const e of full.slice(head)) {
      if (e.event_type === "DELEGATION_REVOKED" && chain.has(String(e.payload.delegation_id))) {
        count += 1;
        if (listed.length < 50) listed.push({ sequence: Number(e.sequence), delegation_id: String(e.payload.delegation_id), revoked_by_principal_id: String(e.payload.revoked_by_principal_id), reason_code: String(e.payload.reason_code) });
      }
    }
    later = { count, listed, note: LATER_NOTE };
  } else {
    st.fullReplay = "NOT_CHECKED";
    eventsAfter = raw.length - head;
    add("L3.FULL_REPLAY", "NOT_CHECKED", "scope ATTESTED_PREFIX_ONLY: the events after the attested head were not validated");
  }

  // ---- L3.ANCHOR ----
  const heads = options.trustedHeads ?? [];
  let matched = 0;
  let covering: { head_sequence: number; head_hash: string; label?: string } | null = null;
  for (const h of heads) {
    if (h.head_sequence > raw.length) return (anchorInfo = anchorSummary(heads.length, matched, covering), fail("L3.ANCHOR", `a trusted head is at sequence ${h.head_sequence} but the journal has only ${raw.length} events: the journal is truncated relative to your anchor`));
    let ph: string;
    try {
      ph = journalHead(raw as unknown as CanonicalStore, h.head_sequence).head_hash;
    } catch (err) {
      return (anchorInfo = anchorSummary(heads.length, matched, covering), fail("L3.ANCHOR", err instanceof JournalFormatError ? err.message : "the journal cannot be hashed up to a trusted head"));
    }
    if (ph !== h.head_hash) return (anchorInfo = anchorSummary(heads.length, matched, covering), fail("L3.ANCHOR", `the journal's first ${h.head_sequence} events do not hash to your trusted head (${h.head_hash}): a divergent or rewritten journal`));
    matched += 1;
    if (h.head_sequence >= head && (covering === null || h.head_sequence < covering.head_sequence)) covering = { head_sequence: h.head_sequence, head_hash: h.head_hash, ...(h.label !== undefined ? { label: h.label } : {}) };
  }
  anchorInfo = anchorSummary(heads.length, matched, covering);
  anchored = covering !== null;
  add("L3.ANCHOR", heads.length === 0 ? "NOT_CHECKED" : "PASS", heads.length === 0 ? "no anchor was supplied: not anchored" : `${matched} of ${heads.length} supplied anchors match the journal; ${anchored ? "one covers the whole attested prefix" : "none covers the whole attested prefix"}`);
  return finish("PASS");
}

function anchorSummary(supplied: number, matched: number, covering: { head_sequence: number; head_hash: string; label?: string } | null): NonNullable<VerifyReport["anchor"]> {
  const status: AnchorStatus = supplied === 0 ? "NONE_SUPPLIED" : covering !== null ? "COVERS_ATTESTED_PREFIX" : "BELOW_ATTESTED_HEAD";
  return {
    status,
    supplied,
    matched,
    covering,
    provenance: "SUPPLIED_BY_VERIFIER",
    independence: "NOT_ESTABLISHED",
    explanation: status === "NONE_SUPPLIED" ? ANCHOR_EXPLANATION.none : status === "COVERS_ATTESTED_PREFIX" ? ANCHOR_EXPLANATION.covers : ANCHOR_EXPLANATION.below,
  };
}
