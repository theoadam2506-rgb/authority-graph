/**
 * Re-ingests a purported canonical event stream using the authority_time and
 * recorded_at values it carries. This validates internal canonicality only;
 * it cannot turn asserted events into signed or independently authentic data.
 */
import { canonicalizeToolArguments } from "../domain/canonicalJson.js";
import { toDraft, type CanonicalStore } from "../domain/events.js";
import { EMPTY_INGESTION_STATE, advanceTrustedTime, processDraft } from "./ingest.js";

export type CanonicalReplayResult =
  | { readonly ok: true; readonly canonicalStore: CanonicalStore }
  | { readonly ok: false; readonly reason: "REPLAY_REJECTED" | "REPLAY_MISMATCH"; readonly atIndex: number };

/**
 * Rejects streams whose event sequence cannot have been produced by the
 * current ingestion rules. No output from this function is a trust claim
 * about where the events originally came from.
 */
export function replayCanonicalStore(events: CanonicalStore): CanonicalReplayResult {
  let state = EMPTY_INGESTION_STATE;
  let lastTrustedTimeMs: number | undefined;
  for (const [index, expected] of events.entries()) {
    const advanced = advanceTrustedTime(lastTrustedTimeMs, expected.authority_time);
    lastTrustedTimeMs = advanced.ms;
    if (advanced.iso !== expected.authority_time) {
      return { ok: false, reason: "REPLAY_MISMATCH", atIndex: index };
    }
    const result = processDraft(state, toDraft(expected), advanced.iso, expected.recorded_at);
    if (!result.outcome.accepted) {
      return { ok: false, reason: "REPLAY_REJECTED", atIndex: index };
    }
    const actual = result.nextState.canonicalStore.at(-1);
    if (actual === undefined || canonicalizeToolArguments(actual) !== canonicalizeToolArguments(expected)) {
      return { ok: false, reason: "REPLAY_MISMATCH", atIndex: index };
    }
    state = result.nextState;
  }
  return { ok: true, canonicalStore: state.canonicalStore };
}
