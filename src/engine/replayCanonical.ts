/**
 * Re-ingests a purported canonical event stream. This proves only internal
 * consistency with an asserted journal, never authorship or completeness.
 */
import { canonicalizeToolArguments } from "../domain/canonicalJson.js";
import { toDraft, type AuthorityEvent, type CanonicalStore } from "../domain/events.js";
import { EMPTY_INGESTION_STATE, advanceTrustedTime, processDraft } from "./ingest.js";

export type CanonicalReplayResult =
  | { readonly ok: true; readonly canonicalStore: CanonicalStore }
  | { readonly ok: false; readonly reason: "REPLAY_MALFORMED" | "REPLAY_REJECTED" | "REPLAY_MISMATCH"; readonly atIndex: number };

const KNOWN_EVENT_TYPES = new Set([
  "DELEGATION_CREATED", "DELEGATION_REVOKED", "SUBDELEGATION_CREATED", "ACTION_REQUESTED",
  "APPROVAL_REQUESTED", "APPROVAL_GRANTED", "APPROVAL_DENIED", "ACTION_EXECUTED", "CAPABILITY_ISSUED",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

function isReplayableEvent(value: unknown): value is AuthorityEvent {
  if (!isRecord(value)) return false;
  const sequence = value.sequence;
  return typeof value.event_id === "string"
    && typeof value.schema_version === "number"
    && typeof value.occurred_at === "string"
    && typeof value.principal_id === "string"
    && typeof value.event_type === "string"
    && KNOWN_EVENT_TYPES.has(value.event_type)
    && isRecord(value.payload)
    && typeof sequence === "number"
    && Number.isSafeInteger(sequence)
    && sequence >= 1
    && isCanonicalIso(value.authority_time)
    && isCanonicalIso(value.recorded_at)
    && value.assurance_level === "ASSERTED_UNVERIFIED";
}

/** Never throws for hostile evidence: callers can map every failure to indeterminate. */
export function replayCanonicalStore(events: unknown): CanonicalReplayResult {
  if (!Array.isArray(events)) return { ok: false, reason: "REPLAY_MALFORMED", atIndex: 0 };
  let state = EMPTY_INGESTION_STATE;
  let lastTrustedTimeMs: number | undefined;
  for (const [index, candidate] of events.entries()) {
    if (!isReplayableEvent(candidate)) return { ok: false, reason: "REPLAY_MALFORMED", atIndex: index };
    try {
      const advanced = advanceTrustedTime(lastTrustedTimeMs, candidate.authority_time);
      lastTrustedTimeMs = advanced.ms;
      if (advanced.iso !== candidate.authority_time) return { ok: false, reason: "REPLAY_MISMATCH", atIndex: index };
      const result = processDraft(state, toDraft(candidate), advanced.iso, candidate.recorded_at);
      if (!result.outcome.accepted) return { ok: false, reason: "REPLAY_REJECTED", atIndex: index };
      // A duplicate event_id is an ingestion no-op; a purported canonical
      // stream must instead append exactly one event at every input index.
      if (result.nextState.canonicalStore.length !== index + 1) return { ok: false, reason: "REPLAY_MISMATCH", atIndex: index };
      const actual = result.nextState.canonicalStore.at(-1);
      if (actual === undefined || canonicalizeToolArguments(actual) !== canonicalizeToolArguments(candidate)) {
        return { ok: false, reason: "REPLAY_MISMATCH", atIndex: index };
      }
      state = result.nextState;
    } catch {
      return { ok: false, reason: "REPLAY_MALFORMED", atIndex: index };
    }
  }
  return { ok: true, canonicalStore: state.canonicalStore };
}
