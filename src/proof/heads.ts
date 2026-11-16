/**
 * Trusted heads ("anchors"), format `authority-trusted-heads/v1` (frozen):
 *
 *   { "format": "authority-trusted-heads/v1",
 *     "heads": [ { "head_sequence": 12, "head_hash": "<64 lowercase hex>", "label": "optional text" } ] }
 *
 * An anchor is a (head_sequence, head_hash) pair of the journal chain
 * (docs/v1/ATTESTATIONS.md) that THE VERIFIER chose to trust. The file has no
 * date, no signature and no source field on purpose: nothing in it can make an
 * anchor look independent, recent or authoritative. A `label` is free text for
 * humans and is never read by verification.
 *
 * What an anchor can establish, and what it cannot, is stated in the report
 * every time (see `ANCHOR_EXPLANATION`): that the journal prefix you were given
 * hashes to the pair you supplied. Whether the pair was recorded by a system
 * independent of the signer, and before a compromise, is a fact about where YOU
 * got it from, which no tool can check.
 */
import { isLowerHex64 } from "./encoding.js";
import { parseStrictJson } from "./strictJson.js";

export const TRUSTED_HEADS_FORMAT = "authority-trusted-heads/v1";
export const MAX_TRUSTED_HEADS = 256;

export interface TrustedHead {
  readonly head_sequence: number;
  readonly head_hash: string;
  readonly label?: string;
}
export type TrustedHeads = readonly TrustedHead[];

export class TrustedHeadsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustedHeadsFormatError";
  }
}

export function parseTrustedHeads(text: string): TrustedHeads {
  const doc = parseStrictJson(text) as Record<string, unknown>;
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new TrustedHeadsFormatError("trusted heads: expected an object");
  for (const k of Object.keys(doc)) if (k !== "format" && k !== "heads") throw new TrustedHeadsFormatError(`trusted heads: unknown member ${JSON.stringify(k)}`);
  if (doc.format !== TRUSTED_HEADS_FORMAT) throw new TrustedHeadsFormatError(`trusted heads: format must be ${JSON.stringify(TRUSTED_HEADS_FORMAT)}`);
  if (!Array.isArray(doc.heads)) throw new TrustedHeadsFormatError('trusted heads: "heads" must be an array');
  if (doc.heads.length > MAX_TRUSTED_HEADS) throw new TrustedHeadsFormatError(`trusted heads: more than ${MAX_TRUSTED_HEADS} heads`);
  const out: TrustedHead[] = [];
  const seen = new Set<number>();
  for (const [i, entry] of doc.heads.entries()) {
    const where = `trusted heads[${i}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new TrustedHeadsFormatError(`${where}: expected an object`);
    const e = entry as Record<string, unknown>;
    for (const k of Object.keys(e)) if (!["head_sequence", "head_hash", "label"].includes(k)) throw new TrustedHeadsFormatError(`${where}: unknown member ${JSON.stringify(k)}`);
    if (typeof e.head_sequence !== "number" || !Number.isSafeInteger(e.head_sequence) || e.head_sequence < 1) throw new TrustedHeadsFormatError(`${where}.head_sequence: must be an integer >= 1`);
    if (typeof e.head_hash !== "string" || !isLowerHex64(e.head_hash)) throw new TrustedHeadsFormatError(`${where}.head_hash: must be 64 lowercase hex characters`);
    if ("label" in e && (typeof e.label !== "string" || e.label.length > 256)) throw new TrustedHeadsFormatError(`${where}.label: must be a string of at most 256 characters`);
    // Two anchors at one sequence are refused even if equal: the file would otherwise be able to contradict itself silently.
    if (seen.has(e.head_sequence)) throw new TrustedHeadsFormatError(`${where}: duplicate head_sequence ${e.head_sequence}`);
    seen.add(e.head_sequence);
    out.push({ head_sequence: e.head_sequence, head_hash: e.head_hash, ...(typeof e.label === "string" ? { label: e.label } : {}) });
  }
  return out;
}

export const ANCHOR_EXPLANATION = {
  none:
    "No anchor was supplied. The journal is checked only for internal consistency: a journal invented together with its attestation, and self-consistent, would pass. Nothing ties the journal to the system that produced the attestation.",
  below:
    "The anchors you supplied match the journal, but all of them are earlier than the attested head: they cover only part of the attested prefix. The events after the last matching anchor are checked for internal consistency only.",
  covers:
    "An anchor is a (head_sequence, head_hash) pair that YOU supplied. 'Anchored' means exactly this: the first N events of the journal you provided hash to that pair, with N at least the attested head, so the attested prefix lies inside an anchored prefix. It does NOT mean the anchor is independent of the signer, recent, or genuine: this tool cannot know where you got it, and a file on the same machine proves nothing about its own independence. If your anchor was recorded by a system independent of the signer, before any relevant compromise, then the covered events have not been rewritten since; that 'if' is a fact about your anchor's provenance, not something verified here. Events after the anchor are not covered.",
} as const;
