import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizeToolArguments } from "../../src/domain/canonicalJson.js";
import type { AuthorityEvent } from "../../src/domain/events.js";
import { sequenceNumber, iso8601 } from "../../src/domain/types.js";
import { JOURNAL_GENESIS, JOURNAL_HASH_SCHEME, JournalFormatError, journalEventDigest, journalHead } from "../../src/proof/journalHash.js";
import { buildFixture } from "./fixture.js";

const sha = (...p: (Buffer | string)[]) => { const h = createHash("sha256"); for (const x of p) h.update(x); return h.digest(); };

describe("journal hash chain: the frozen format, recomputed independently", () => {
  it("matches a from-scratch implementation of the documented formula", async () => {
    const { events } = await buildFixture();
    let h = sha(Buffer.from("authority-journal-chain/v1", "utf8"));
    for (const e of events) h = sha(h, sha(Buffer.from("authority-journal-event/v1\n", "utf8"), Buffer.from(canonicalizeToolArguments(e), "utf8")));
    expect(journalHead(events)).toEqual({ head_sequence: events.length, head_hash: h.toString("hex") });
    expect(JOURNAL_HASH_SCHEME).toBe("authority-journal-chain/v1");
    expect(JOURNAL_GENESIS.toString("hex")).toBe(sha(Buffer.from("authority-journal-chain/v1")).toString("hex"));
  });

  it("an empty journal has the genesis head", () => {
    expect(journalHead([])).toEqual({ head_sequence: 0, head_hash: JOURNAL_GENESIS.toString("hex") });
  });

  it("a prefix has its own head, and the head of a longer journal extends it", async () => {
    const { events } = await buildFixture();
    const prefixes = events.map((_e, i) => journalHead(events, i + 1).head_hash);
    expect(new Set(prefixes).size).toBe(events.length); // all distinct
    expect(journalHead(events.slice(0, 3))).toEqual(journalHead(events, 3));
  });

  it("is deterministic across calls", async () => {
    const a = (await buildFixture()).events;
    const b = (await buildFixture()).events;
    expect(journalHead(a)).toEqual(journalHead(b));
  });
});

describe("journal hash chain: any change to the journal changes the head", () => {
  it("modifying ANY field of ANY event, including recorded_at, changes the head", async () => {
    const { events } = await buildFixture();
    const base = journalHead(events).head_hash;
    for (const [i, e] of events.entries()) {
      const variants: AuthorityEvent[] = [
        { ...e, recorded_at: iso8601("2030-01-01T00:00:00.000Z") },
        { ...e, authority_time: iso8601("2030-01-01T00:00:00.000Z") },
        { ...e, occurred_at: iso8601("2030-01-01T00:00:00.000Z") },
        { ...e, principal_id: "someone-else" as never },
        { ...e, event_id: "other-id" as never },
        { ...e, payload: { ...(e.payload as object), tamper: 1 } } as unknown as AuthorityEvent,
      ];
      for (const v of variants) {
        const changed = events.map((x, k) => (k === i ? v : x));
        expect(journalHead(changed).head_hash, `event ${i + 1}`).not.toBe(base);
      }
    }
  });

  it("removing, appending, duplicating or swapping events changes the head or is refused", async () => {
    const { events } = await buildFixture();
    const base = journalHead(events).head_hash;
    expect(journalHead(events.slice(0, -1)).head_hash).not.toBe(base); // truncation
    expect(() => journalHead([events[1]!, events[0]!, ...events.slice(2)])).toThrow(JournalFormatError); // reordered
    expect(() => journalHead([...events.slice(0, 2), ...events.slice(3)])).toThrow(JournalFormatError); // removed from the middle
    expect(() => journalHead([...events, events[0]!])).toThrow(JournalFormatError); // appended duplicate
    const extra = { ...events[events.length - 1]!, sequence: sequenceNumber(events.length + 1), event_id: "extra" as never } as AuthorityEvent;
    expect(journalHead([...events, extra]).head_hash).not.toBe(base); // extension
  });

  it("is domain separated: the digest of an event is not a plain SHA-256 of its JCS", async () => {
    const { events } = await buildFixture();
    const e = events[0]!;
    expect(journalEventDigest(e).toString("hex")).not.toBe(sha(Buffer.from(canonicalizeToolArguments(e), "utf8")).toString("hex"));
  });

  it("refuses a journal that does not start at sequence 1, and a bad upper bound", async () => {
    const { events } = await buildFixture();
    expect(() => journalHead(events.slice(1))).toThrow(JournalFormatError);
    expect(() => journalHead(events, events.length + 1)).toThrow(JournalFormatError);
    expect(() => journalHead(events, -1)).toThrow(JournalFormatError);
  });
});
