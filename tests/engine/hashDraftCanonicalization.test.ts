/**
 * PR4B-4 — `hashDraft` (src/engine/ingest.ts, private, not exported — no
 * change to its signature) now canonicalizes a draft's object keys
 * (recursively sorted) before `JSON.stringify`, closing the gap between
 * I8's own definition of idempotence ("contenu strictement identique",
 * SPEC.md — content equivalence, never byte-serialization equivalence)
 * and plain `JSON.stringify`'s sensitivity to JS object key insertion
 * order (which Postgres's JSONB round-trip does not preserve). This file
 * demonstrates, through `ingestAll`'s own observable outcomes (the only
 * production entry point exercised — `hashDraft`/`canonicalize` stay
 * private), that the gap is now closed (T2/T3) and that every real
 * content difference this fix must never paper over still is not (T4-T7),
 * plus the already-correct byte-identical case (T8) and the `undefined`
 * edge cases item 2 of the round required.
 *
 * Every draft pair in this file is constructed as a literal JS object with
 * a deliberately different key insertion order — TypeScript's structural
 * typing does not care about declaration order, but `JSON.stringify` does,
 * so this is a genuine, physically different serialization of logically
 * identical data, not a contrived typing trick.
 */
import { describe, expect, it } from "vitest";
import { ingestAll } from "../../src/engine/authority.js";
import { computeActionFingerprint, toDraft, type DraftAuthorityEvent } from "../../src/domain/events.js";
import { executionResultCode, nonMonetaryParameters, sequenceNumber, thresholds } from "../../src/domain/types.js";
import { EUR, PURCHASE_ORDER_CREATE, THEO, delegationLink, rootDelegation, sequentialClock } from "../fixtures/scenarios.js";
import { actionExecutedEvent } from "../fixtures/builders.js";
import { action, principal } from "../fixtures/ids.js";

const seq = sequenceNumber;
const AGENT_A = principal("hd-agent-a");

/** Deep-clones a draft's payload with every object's keys inserted in REVERSE order — values untouched, only insertion order changes. Arrays are left alone (their element order is data, not serialization noise). */
function reverseKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reverseKeyOrder);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).reverse();
    const reordered: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      reordered[k] = reverseKeyOrder(v);
    }
    return reordered;
  }
  return value;
}

function withReversedPayloadKeyOrder(draft: DraftAuthorityEvent): DraftAuthorityEvent {
  return {
    payload: reverseKeyOrder(draft.payload),
    event_type: draft.event_type,
    principal_id: draft.principal_id,
    occurred_at: draft.occurred_at,
    schema_version: draft.schema_version,
    event_id: draft.event_id,
  } as DraftAuthorityEvent;
}

describe("T2 — same event_id, same content, top-level envelope key order differs", () => {
  it("TARGET: idempotent no-op (accepted:true, same sequence). TODAY: EVENT_ID_CONFLICT, because hashDraft's JSON.stringify is key-order-sensitive", () => {
    const original = rootDelegation({ sequence: 1, id: "d-t2", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT_A, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false });
    const draft1 = toDraft(original);
    // Same fields, same values — literal object built with a REVERSED key
    // insertion order at the top level only (payload passed through as-is).
    const draft2 = {
      payload: draft1.payload,
      event_type: draft1.event_type,
      principal_id: draft1.principal_id,
      occurred_at: draft1.occurred_at,
      schema_version: draft1.schema_version,
      event_id: draft1.event_id,
    } as DraftAuthorityEvent;

    const result = ingestAll([draft1, draft2], sequentialClock);
    expect(result.outcomes[0]).toEqual({ accepted: true, sequence: seq(1) });
    expect(result.outcomes[1]).toEqual({ accepted: true, sequence: seq(1) });
  });
});

describe("T3 — same event_id, nested payload object key order differs", () => {
  it("TARGET: idempotent no-op. TODAY: EVENT_ID_CONFLICT, because the nested `thresholds` object's key order differs after a deep clone", () => {
    const original = rootDelegation({
      sequence: 1,
      id: "d-t3",
      grantor: THEO,
      grantorType: "HUMAN_ROOT",
      grantee: AGENT_A,
      capabilities: [PURCHASE_ORDER_CREATE],
      canDelegate: false,
      totalBudget: EUR(1000),
      amountThresholds: thresholds(100, 1000),
    });
    const draft1 = toDraft(original);
    const draft2 = withReversedPayloadKeyOrder(draft1);

    const result = ingestAll([draft1, draft2], sequentialClock);
    expect(result.outcomes[0]).toEqual({ accepted: true, sequence: seq(1) });
    expect(result.outcomes[1]).toEqual({ accepted: true, sequence: seq(1) });
  });
});

describe("T4 — same event_id, a real business value differs (regression lock — already correct today)", () => {
  it("stays EVENT_ID_CONFLICT: a genuinely different grantee is never treated as idempotent, key order or not", () => {
    const first = rootDelegation({ sequence: 1, id: "d-t4", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT_A, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false });
    const second = rootDelegation({ sequence: 2, id: "d-t4", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: principal("hd-agent-different"), capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false });
    const draft1: DraftAuthorityEvent = { ...toDraft(first), event_id: toDraft(first).event_id };
    const draft2: DraftAuthorityEvent = { ...toDraft(second), event_id: draft1.event_id };

    const result = ingestAll([draft1, draft2], sequentialClock);
    expect(result.outcomes[0]).toEqual({ accepted: true, sequence: seq(1) });
    expect(result.outcomes[1]).toEqual({ accepted: false, reasonCode: "EVENT_ID_CONFLICT" });
  });
});

describe("T5 — same event_id, an order-significant array differs (regression lock — already correct today, must remain so after canonicalization)", () => {
  it("stays EVENT_ID_CONFLICT: authority_chain_ref's element order is business data (root-to-terminal order), never serialization noise", () => {
    const chainForward = [delegationLink("d-root-t5"), delegationLink("d-sub-t5")];
    const chainReversed = [delegationLink("d-sub-t5"), delegationLink("d-root-t5")];
    const actionExecutedId = action("act-t5");
    const fingerprint = computeActionFingerprint(PURCHASE_ORDER_CREATE, nonMonetaryParameters());
    const resultCode = executionResultCode("SUCCESS");
    const first = actionExecutedEvent(1, AGENT_A, {
      action_id: actionExecutedId,
      executed_by_principal_id: AGENT_A,
      action_fingerprint: fingerprint,
      decision_sequence: seq(0),
      authority_chain_ref: chainForward,
      execution_result: resultCode,
    });
    const second = actionExecutedEvent(2, AGENT_A, {
      action_id: actionExecutedId,
      executed_by_principal_id: AGENT_A,
      action_fingerprint: fingerprint,
      decision_sequence: seq(0),
      authority_chain_ref: chainReversed, // same links, REVERSED order — a real content difference
      execution_result: resultCode,
    });
    const draft1 = toDraft(first);
    const draft2: DraftAuthorityEvent = { ...toDraft(second), event_id: draft1.event_id };

    const result = ingestAll([draft1, draft2], sequentialClock);
    expect(result.outcomes[0]).toEqual({ accepted: true, sequence: seq(1) });
    expect(result.outcomes[1]).toEqual({ accepted: false, reasonCode: "EVENT_ID_CONFLICT" });
  });
});

describe("T6 — null vs absent optional field (regression lock — must never become equivalent by canonicalization)", () => {
  it("stays EVENT_ID_CONFLICT: an explicit null and an absent optional field are not the same content, key order aside", () => {
    const withoutField = rootDelegation({ sequence: 1, id: "d-t6", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT_A, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false });
    const draft1 = toDraft(withoutField);
    // `max_amount` cannot be typed as `null` (Money is not nullable, and
    // exactOptionalPropertyTypes forbids assigning `undefined` to an
    // optional property) — this cast simulates a hostile/malformed draft
    // that is structurally parseable but never producible through this
    // codebase's own typed construction paths, exactly the same category
    // of boundary crossing `rowToEvent`'s own docstring already accepts
    // for a different reason (nothing at a raw-data boundary can prove
    // the shape TypeScript otherwise guarantees).
    const draft2 = {
      ...draft1,
      payload: { ...draft1.payload, max_amount: null } as unknown as DraftAuthorityEvent["payload"],
    } as DraftAuthorityEvent;

    const result = ingestAll([draft1, draft2], sequentialClock);
    expect(result.outcomes[0]).toEqual({ accepted: true, sequence: seq(1) });
    expect(result.outcomes[1]).toEqual({ accepted: false, reasonCode: "EVENT_ID_CONFLICT" });
  });
});

describe("T7 — primitive type differs, same textual content (regression lock — must never be coerced as equivalent)", () => {
  it('stays EVENT_ID_CONFLICT: can_delegate: "false" (string) is not can_delegate: false (boolean)', () => {
    const original = rootDelegation({ sequence: 1, id: "d-t7", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT_A, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false });
    const draft1 = toDraft(original);
    // Same category of deliberate, documented boundary cast as T6 — no
    // typed construction path in this codebase can produce a string here.
    const draft2 = {
      ...draft1,
      payload: { ...draft1.payload, can_delegate: "false" } as unknown as DraftAuthorityEvent["payload"],
    } as DraftAuthorityEvent;

    const result = ingestAll([draft1, draft2], sequentialClock);
    expect(result.outcomes[0]).toEqual({ accepted: true, sequence: seq(1) });
    expect(result.outcomes[1]).toEqual({ accepted: false, reasonCode: "EVENT_ID_CONFLICT" });
  });
});

describe("undefined semantics (PR4B-4 item 2) — canonicalize must not change JSON.stringify's existing undefined behavior", () => {
  it("A — an object property explicitly set to undefined is dropped by JSON.stringify exactly as before, so it stays equivalent to the key being absent entirely", () => {
    const withoutField = rootDelegation({ sequence: 1, id: "d-undef-a", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT_A, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false });
    const draft1 = toDraft(withoutField);
    // `max_amount: undefined` cannot be typed under exactOptionalPropertyTypes
    // — same documented adversarial-boundary-cast category as T6/T7. The
    // point is exactly what JSON.stringify already did with this shape:
    // drop the property, regardless of where the fix touches key order.
    const draft2 = {
      ...draft1,
      payload: { ...draft1.payload, max_amount: undefined } as unknown as DraftAuthorityEvent["payload"],
    } as DraftAuthorityEvent;

    const result = ingestAll([draft1, draft2], sequentialClock);
    expect(result.outcomes[0]).toEqual({ accepted: true, sequence: seq(1) });
    expect(result.outcomes[1]).toEqual({ accepted: true, sequence: seq(1) });
  });

  it("B — an undefined array element keeps serializing exactly like a null array element (JSON.stringify's own pre-existing quirk, neither fixed nor broken by canonicalization)", () => {
    const withNull = rootDelegation({ sequence: 1, id: "d-undef-b", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT_A, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false });
    const draft1 = toDraft(withNull);
    const draft1WithNullElement = {
      ...draft1,
      payload: { ...draft1.payload, capabilities: [PURCHASE_ORDER_CREATE, null] } as unknown as DraftAuthorityEvent["payload"],
    } as DraftAuthorityEvent;
    const draft2WithUndefinedElement = {
      ...draft1,
      payload: { ...draft1.payload, capabilities: [PURCHASE_ORDER_CREATE, undefined] } as unknown as DraftAuthorityEvent["payload"],
    } as DraftAuthorityEvent;

    // JSON.stringify([x, null]) === JSON.stringify([x, undefined]) === '[x,null]'
    // already, before any canonicalization — this test locks that
    // pre-existing quirk in place rather than letting the fix disturb it.
    const result = ingestAll([draft1WithNullElement, draft2WithUndefinedElement], sequentialClock);
    expect(result.outcomes[0]).toEqual({ accepted: true, sequence: seq(1) });
    expect(result.outcomes[1]).toEqual({ accepted: true, sequence: seq(1) });
  });

  it("C — an undefined-valued property in two different key positions produces no NEW difference caused by the sort step itself", () => {
    const original = rootDelegation({ sequence: 1, id: "d-undef-c", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT_A, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false });
    const draft1 = toDraft(original);
    const payload1 = { max_amount: undefined, ...draft1.payload } as unknown as DraftAuthorityEvent["payload"];
    const payload2 = { ...draft1.payload, max_amount: undefined } as unknown as DraftAuthorityEvent["payload"];
    const draft2 = { ...draft1, payload: payload1 } as DraftAuthorityEvent;
    const draft3 = { ...draft1, payload: payload2 } as DraftAuthorityEvent;

    const result = ingestAll([draft2, draft3], sequentialClock);
    expect(result.outcomes[0]).toEqual({ accepted: true, sequence: seq(1) });
    expect(result.outcomes[1]).toEqual({ accepted: true, sequence: seq(1) });
  });
});

describe("T8 — a genuinely byte-identical retry (no reordering at all) stays idempotent (regression lock)", () => {
  it("accepted:true with the original sequence, exactly as today", () => {
    const original = rootDelegation({ sequence: 1, id: "d-t8", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT_A, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false });
    const draft = toDraft(original);

    const result = ingestAll([draft, draft], sequentialClock);
    expect(result.outcomes[0]).toEqual({ accepted: true, sequence: seq(1) });
    expect(result.outcomes[1]).toEqual({ accepted: true, sequence: seq(1) });
  });
});
