import { describe, expect, it } from "vitest";
import { toDraft } from "../../src/domain/events.js";
import { iso8601 } from "../../src/domain/types.js";
import { ingestAll } from "../../src/engine/ingest.js";
import { replayCanonicalStore } from "../../src/engine/replayCanonical.js";
import { AGENT_A, PURCHASE_ORDER_CREATE, THEO, actionRequest, rootDelegation, sequentialClock, timeAt } from "../fixtures/scenarios.js";

function canonicalRoot(id: string) {
  return ingestAll(
    [toDraft(rootDelegation({ sequence: 1, id, grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT_A, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false }))],
    sequentialClock,
  ).canonicalStore;
}

describe("replayCanonicalStore", () => {
  it("replays a canonical stream exactly", () => {
    const events = canonicalRoot("d-replay");
    expect(replayCanonicalStore(events)).toEqual({ ok: true, canonicalStore: events });
  });

  it("rejects duplicate canonical events instead of accepting an ingestion no-op", () => {
    const events = canonicalRoot("d-replay-duplicate");
    expect(replayCanonicalStore([...events, ...events])).toEqual({ ok: false, reason: "REPLAY_MISMATCH", atIndex: 1 });
  });

  it("rejects malformed evidence and a backwards trusted clock without throwing", () => {
    expect(replayCanonicalStore([null])).toEqual({ ok: false, reason: "REPLAY_MALFORMED", atIndex: 0 });
    const ingested = ingestAll(
      [
        toDraft(rootDelegation({ sequence: 1, id: "d-replay-clock", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT_A, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false })),
        toDraft(actionRequest({ sequence: 2, id: "a-replay-clock", requester: AGENT_A, delegationId: "d-replay-clock" })),
      ],
      sequentialClock,
    );
    const second = ingested.canonicalStore[1];
    if (second === undefined) throw new Error("fixture must contain two events");
    expect(replayCanonicalStore([{ ...ingested.canonicalStore[0]! }, { ...second, authority_time: iso8601(timeAt(-1)) }])).toEqual({
      ok: false,
      reason: "REPLAY_MISMATCH",
      atIndex: 1,
    });
  });
});
