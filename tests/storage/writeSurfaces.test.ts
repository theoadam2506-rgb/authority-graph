/**
 * PR4B-1 — runtime behavior of the narrow public command surface
 * (src/storage/writeSurfaces.ts). The type-level guarantee (a
 * CAPABILITY_ISSUED draft cannot even be passed to `submitExternalEvents`)
 * is checked separately, at compile time, in
 * tests/domain/eventClassification.type-guards.ts. This file only proves
 * that for an ordinary external draft, `submitExternalEvents` behaves
 * exactly like calling `store.append()` directly — it is a thin,
 * behavior-preserving delegation, not a new decision path.
 */
import { describe, expect, it } from "vitest";
import { InMemoryEventStore } from "../../src/storage/eventStore.js";
import { submitExternalEvents } from "../../src/storage/writeSurfaces.js";
import { isEventType, toDraft } from "../../src/domain/events.js";
import { iso8601 } from "../../src/domain/types.js";
import { PURCHASE_ORDER_CREATE, THEO, rootDelegation } from "../fixtures/scenarios.js";
import { principal } from "../fixtures/ids.js";

describe("submitExternalEvents", () => {
  it("delegates to EventSource.append and produces the exact same accepted outcome and canonical history", () => {
    const clock = { authorityTime: () => iso8601("2025-01-01T00:00:00.000Z") };
    const rootEvent = rootDelegation({
      sequence: 1,
      id: "d-root",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: principal("agent"),
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
    });
    if (!isEventType(rootEvent, "DELEGATION_CREATED")) {
      throw new Error("fixture returned an unexpected event_type");
    }
    // toDraft() now preserves the narrowed event_type (PR4B-2 ergonomics
    // fix) — no second guard needed here to satisfy
    // submitExternalEvents' ExternalDraftAuthorityEvent[] parameter.
    const draft = toDraft(rootEvent);

    const store = new InMemoryEventStore(clock);
    const result = submitExternalEvents(store, [draft]);

    return result.then(async (appendResult) => {
      expect(appendResult.outcomes).toEqual([{ accepted: true, sequence: 1 }]);
      const history = await store.getEvents();
      expect(history).toHaveLength(1);
      expect(history[0]?.event_type).toBe("DELEGATION_CREATED");
    });
  });
});
