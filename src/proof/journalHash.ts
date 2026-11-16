/**
 * Journal hash chain (Authority Proof, PR 3). Format, frozen for `v1`:
 *
 *   scheme   = "authority-journal-chain/v1"
 *   digest_i = SHA-256( utf8("authority-journal-event/v1\n") || utf8(JCS(event_i)) )
 *   h_0      = SHA-256( utf8("authority-journal-chain/v1") )
 *   h_i      = SHA-256( h_{i-1} || digest_i )            (both 32 raw bytes)
 *   head     = (head_sequence = i, head_hash = lowercase hex of h_i)
 *
 * `event_i` is the COMPLETE canonical event exactly as ingested and exported
 * (envelope and payload: event_id, schema_version, occurred_at, principal_id,
 * sequence, authority_time, recorded_at, assurance_level, event_type, payload),
 * serialized with RFC 8785 (JCS) through the repository's existing strict
 * canonicalizer. `recorded_at` is therefore committed too: the hash binds the
 * exact export, and any re-export that changes any byte of any field changes
 * the head. The events must be sequence 1..n, contiguous and in order.
 *
 * What the head establishes: this exact sequence of events, in this order,
 * hashes to this value. It does not establish that the events are true (they
 * are asserted, I17), that the journal is complete, or that nobody holds a
 * different journal with a different history.
 */
import { createHash } from "node:crypto";
import { canonicalizeToolArguments } from "../domain/canonicalJson.js";
import type { AuthorityEvent, CanonicalStore } from "../domain/events.js";

export const JOURNAL_HASH_SCHEME = "authority-journal-chain/v1";
const EVENT_DOMAIN = "authority-journal-event/v1\n";

export class JournalFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JournalFormatError";
  }
}

export interface JournalHead {
  readonly head_sequence: number;
  readonly head_hash: string;
}

const sha256 = (...parts: (Buffer | string)[]): Buffer => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};

export const JOURNAL_GENESIS: Buffer = sha256(Buffer.from(JOURNAL_HASH_SCHEME, "utf8"));

export function journalEventDigest(event: AuthorityEvent): Buffer {
  return sha256(Buffer.from(EVENT_DOMAIN, "utf8"), Buffer.from(canonicalizeToolArguments(event), "utf8"));
}

/** Head of the chain over events 1..`upToSequence` (default: all). Throws JournalFormatError on a non-contiguous or unordered journal. */
export function journalHead(events: CanonicalStore, upToSequence?: number): JournalHead {
  const limit = upToSequence ?? events.length;
  if (!Number.isInteger(limit) || limit < 0 || limit > events.length) throw new JournalFormatError(`upToSequence ${String(upToSequence)} is outside 0..${events.length}`);
  let h = JOURNAL_GENESIS;
  for (let i = 0; i < limit; i += 1) {
    const event = events[i] as AuthorityEvent;
    if (Number(event.sequence) !== i + 1) throw new JournalFormatError(`event at index ${i} has sequence ${String(event.sequence)}, expected ${i + 1}: the journal must be 1..n, contiguous and in order`);
    h = sha256(h, journalEventDigest(event));
  }
  return { head_sequence: limit, head_hash: h.toString("hex") };
}
