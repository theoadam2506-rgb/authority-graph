import { describe, expect, it } from "vitest";
import { toDraft } from "../../src/domain/events.js";
import { iso8601, sequenceNumber } from "../../src/domain/types.js";
import { ingestAll } from "../../src/engine/ingest.js";
import { replayCanonicalStore } from "../../src/engine/replayCanonical.js";
import { AGENT_A, PURCHASE_ORDER_CREATE, THEO, actionRequest, rootDelegation, sequentialClock, timeAt } from "../fixtures/scenarios.js";

describe("replayCanonicalStore", () => {
  it("replays an internally canonical stream exactly", () => {
    const ingested = ingestAll(
      [
        toDraft(
          rootDelegation({
            sequence: 1,
            id: "d-replay",
            grantor: THEO,
            grantorType: "HUMAN_ROOT",
            grantee: AGENT_A,
            capabilities: [PURCHASE_ORDER_CREATE],
            canDelegate: false,
          }),
        ),
      ],
      sequentialClock,
    );

    const replay = replayCanonicalStore(ingested.canonicalStore);
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.canonicalStore).toEqual(ingested.canonicalStore);
    }
  });

  it("rejects an event stream with a forged canonical sequence", () => {
    const ingested = ingestAll(
      [
        toDraft(
          rootDelegation({
            sequence: 1,
            id: "d-replay-forged",
            grantor: THEO,
            grantorType: "HUMAN_ROOT",
            grantee: AGENT_A,
            capabilities: [PURCHASE_ORDER_CREATE],
            canDelegate: false,
          }),
        ),
      ],
      sequentialClock,
    );
    const event = ingested.canonicalStore[0];
    if (event === undefined) {
      throw new Error("fixture must contain one event");
    }
    const replay = replayCanonicalStore([{ ...event, sequence: sequenceNumber(99) }]);
    expect(replay).toEqual({ ok: false, reason: "REPLAY_MISMATCH", atIndex: 0 });
  });

  it("rejects a stream whose trusted clock goes backwards", () => {
    const ingested = ingestAll(
      [
        toDraft(
          rootDelegation({
            sequence: 1,
            id: "d-replay-clock",
            grantor: THEO,
            grantorType: "HUMAN_ROOT",
            grantee: AGENT_A,
            capabilities: [PURCHASE_ORDER_CREATE],
            canDelegate: false,
          }),
        ),
        toDraft(actionRequest({ sequence: 2, id: "a-replay-clock", requester: AGENT_A, delegationId: "d-replay-clock" })),
      ],
      sequentialClock,
    );
    const second = ingested.canonicalStore[1];
    if (second === undefined) {
      throw new Error("fixture must contain two events");
    }
    const replay = replayCanonicalStore([{ ...ingested.canonicalStore[0]! }, { ...second, authority_time: iso8601(timeAt(-1)) }]);
    expect(replay).toEqual({ ok: false, reason: "REPLAY_MISMATCH", atIndex: 1 });
  });
});
