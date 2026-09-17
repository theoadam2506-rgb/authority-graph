/**
 * PROMPT 4, point 6: tests for the EventStore contract itself (not the
 * authority engine, which never changes) — sequence continuity across
 * separate `append()` calls, uniqueness checked against the *complete*
 * history rather than one batch, and the absence of any mutative operation
 * on the `EventSource` interface.
 */
import { describe, expect, it } from "vitest";
import { toDraft } from "../../src/domain/events.js";
import { sequenceNumber } from "../../src/domain/types.js";
import { InMemoryEventStore } from "../../src/storage/eventStore.js";
import {
  AGENT_A,
  AGENT_B,
  MALLORY,
  PURCHASE_ORDER_CREATE,
  THEO,
  actionRequest,
  rootDelegation,
  sequentialClock,
  subDelegation,
} from "../fixtures/scenarios.js";

const seq = sequenceNumber;

describe("InMemoryEventStore — sequence continuity", () => {
  it("numbers a second append() batch continuing from the first, never restarting at 1", async () => {
    const store = new InMemoryEventStore(sequentialClock);

    const first = await store.append([
      toDraft(rootDelegation({ sequence: 1, id: "d-root-cont", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT_A, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: true })),
      toDraft(subDelegation({ sequence: 2, id: "d-sub-cont", parentId: "d-root-cont", grantor: AGENT_A, grantee: AGENT_B, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false })),
    ]);
    expect(first.outcomes).toEqual([
      { accepted: true, sequence: seq(1) },
      { accepted: true, sequence: seq(2) },
    ]);

    const second = await store.append([
      toDraft(actionRequest({ sequence: 3, id: "a-cont-1", requester: AGENT_B, delegationId: "d-sub-cont" })),
      toDraft(actionRequest({ sequence: 4, id: "a-cont-2", requester: AGENT_B, delegationId: "d-sub-cont" })),
    ]);
    expect(second.outcomes).toEqual([
      { accepted: true, sequence: seq(3) },
      { accepted: true, sequence: seq(4) },
    ]);

    const all = await store.getEvents();
    expect(all.map((e) => e.sequence)).toEqual([seq(1), seq(2), seq(3), seq(4)]);
  });

  it("continues numbering from a store rebuilt from persisted history (simulating a process restart)", async () => {
    const store = new InMemoryEventStore(sequentialClock);
    await store.append([
      toDraft(rootDelegation({ sequence: 1, id: "d-root-restart", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT_A, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false })),
    ]);
    const persisted = await store.getEvents();

    const { rebuildIngestionState } = await import("../../src/engine/ingest.js");
    const restarted = new InMemoryEventStore(sequentialClock, rebuildIngestionState(persisted));
    const result = await restarted.append([
      toDraft(actionRequest({ sequence: 2, id: "a-restart-1", requester: AGENT_A, delegationId: "d-root-restart" })),
    ]);
    expect(result.outcomes).toEqual([{ accepted: true, sequence: seq(2) }]);
  });
});

describe("InMemoryEventStore — uniqueness against the complete history", () => {
  it("rejects a business-id collision introduced in a later, separate append() call", async () => {
    const store = new InMemoryEventStore(sequentialClock);
    await store.append([
      toDraft(rootDelegation({ sequence: 1, id: "d-dup-across-batches", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT_A, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false })),
    ]);

    // Mallory references the SAME delegation_id in a completely separate append() call.
    const second = await store.append([
      toDraft(
        rootDelegation({
          sequence: 2,
          id: "d-dup-across-batches",
          grantor: MALLORY,
          grantorType: "AGENT",
          grantee: AGENT_B,
          capabilities: [PURCHASE_ORDER_CREATE],
          canDelegate: false,
        }),
      ),
    ]);
    expect(second.outcomes).toEqual([{ accepted: false, reasonCode: "BUSINESS_ID_COLLISION" }]);
    const all = await store.getEvents();
    expect(all).toHaveLength(1);
  });

  it("treats a byte-identical re-append of the same event_id (I8) as idempotent across separate calls, without growing the store", async () => {
    const store = new InMemoryEventStore(sequentialClock);
    const draft = toDraft(
      rootDelegation({ sequence: 1, id: "d-idempotent", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT_A, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false }),
    );

    const first = await store.append([draft]);
    expect(first.outcomes).toEqual([{ accepted: true, sequence: seq(1) }]);

    const second = await store.append([draft]);
    expect(second.outcomes).toEqual([{ accepted: true, sequence: seq(1) }]);

    const all = await store.getEvents();
    expect(all).toHaveLength(1);
  });
});

describe("EventSource — no mutative operation", () => {
  it("exposes only append/getEvents/getBySequence (the EventSource contract) plus getSecurityLog (a separate read-only capability), and nothing named update/delete/remove/replace/set", () => {
    const store = new InMemoryEventStore(sequentialClock);
    const methodNames = new Set<string>();
    let proto: object | null = Object.getPrototypeOf(store) as object | null;
    while (proto !== null && proto !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        methodNames.add(name);
      }
      proto = Object.getPrototypeOf(proto) as object | null;
    }
    methodNames.delete("constructor");

    // getSecurityLog is intentionally not part of EventSource itself — see
    // src/storage/eventStore.ts's field docstring — but it is still a
    // read-only introspection method, not a mutation, so it belongs here.
    expect([...methodNames].sort()).toEqual(["append", "getBySequence", "getEvents", "getSecurityLog"]);
    for (const forbidden of ["update", "delete", "remove", "replace", "set", "patch", "overwrite"]) {
      expect(methodNames.has(forbidden)).toBe(false);
    }
  });

  it("never hands out a live reference into its own storage — mutating a returned array does not affect the store", async () => {
    const store = new InMemoryEventStore(sequentialClock);
    await store.append([
      toDraft(rootDelegation({ sequence: 1, id: "d-frozen", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT_A, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false })),
    ]);

    const events = await store.getEvents();
    (events as unknown[]).push({});

    const again = await store.getEvents();
    expect(again).toHaveLength(1);
  });
});
