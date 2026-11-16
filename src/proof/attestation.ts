/**
 * Attestations (Authority Proof, PR 3): format, signing input, builders.
 *
 * FORMAT `authority-attestation/v1` (frozen; every object is closed: an unknown
 * member at ANY level is an error, never ignored):
 *
 *   {
 *     "proof_version": "authority-attestation/v1",
 *     "kind": "ISSUANCE" | "REDEMPTION",
 *     "engine":  { "id": "authority-graph", "protocol_version": 1, "event_schema_version": 1 },
 *     "statement": {                       // see IssuanceStatement / RedemptionStatement
 *       "event": { "sequence", "event_id", "authority_time" },
 *       "capability_id", "action_id", "action_fingerprint", "principal_id",
 *       "decision_sequence", "enforcement_point_id",
 *       // ISSUANCE only: "granted_chain_ref": [..], "expires_at"
 *     },
 *     "journal": { "scheme": "authority-journal-chain/v1", "head_sequence", "head_hash" },
 *     "signature": { "alg": "Ed25519", "key_id", "sig" }   // sig: unpadded base64url, 64 bytes
 *   }
 *
 * SIGNING INPUT (frozen):
 *   bytes = utf8("authority-attestation/v1\n") || utf8(JCS(attestation with
 *           signature = { "alg", "key_id" } only))
 * i.e. everything is signed, including `alg` and `key_id`, with a domain
 * separation prefix so the signature cannot be replayed in another protocol.
 * JCS is RFC 8785, through the repository's strict canonicalizer.
 *
 * WHAT A SIGNATURE ON THIS STATEMENT MEANS: the holder of the key asserts that
 * the described event is in the journal whose head is `journal`, and that the
 * Authority engine's own validator accepted it when the attestation was built.
 * It is not a proof that the decision was right, that the journal's events are
 * true or complete, or that the effect happened (docs/v1/ATTESTATIONS.md).
 *
 * The builders refuse to attest an event the engine's validators reject
 * (`validateAndSelectGrant` for issuance, `validateRedemptionEvent` for
 * redemption), so an attestation never vouches for a ticket or redemption that
 * fails the engine's own checks.
 */
import type { CanonicalStore } from "../domain/events.js";
import { CURRENT_SCHEMA_VERSION } from "../domain/types.js";
import { validateAndSelectGrant } from "../engine/grantValidation.js";
import { validateRedemptionEvent } from "../engine/redeemCapability.js";
import { base64urlDecodeExact, base64urlEncode, isCanonicalInstant, isLowerHex64 } from "./encoding.js";
import { canonicalizeToolArguments } from "../domain/canonicalJson.js";
import { JOURNAL_HASH_SCHEME, journalHead } from "./journalHash.js";
import type { ProofSigner } from "./keys.js";

export const ATTESTATION_VERSION = "authority-attestation/v1";
export const SIGNING_PREFIX = "authority-attestation/v1\n";
export const ENGINE_ID = "authority-graph";
export const PROTOCOL_VERSION = 1;
export const EVENT_SCHEMA_VERSION = Number(CURRENT_SCHEMA_VERSION);
export const SIGNATURE_ALG = "Ed25519";

export type AttestationKind = "ISSUANCE" | "REDEMPTION";
export type ChainLink = { readonly kind: "delegation"; readonly delegation_id: string } | { readonly kind: "approval"; readonly approval_id: string };

export interface EventRef {
  readonly sequence: number;
  readonly event_id: string;
  readonly authority_time: string;
}

interface StatementBase {
  readonly event: EventRef;
  readonly capability_id: string;
  readonly action_id: string;
  readonly action_fingerprint: string;
  /** The envelope principal of the event: an ASSERTION by the caller (I17), not a verified identity. */
  readonly principal_id: string;
  readonly decision_sequence: number;
  readonly enforcement_point_id: string;
}
export interface IssuanceStatement extends StatementBase {
  readonly granted_chain_ref: readonly ChainLink[];
  readonly expires_at: string;
}
export type RedemptionStatement = StatementBase;

interface AttestationBase {
  readonly proof_version: typeof ATTESTATION_VERSION;
  readonly engine: { readonly id: typeof ENGINE_ID; readonly protocol_version: number; readonly event_schema_version: number };
  readonly journal: { readonly scheme: typeof JOURNAL_HASH_SCHEME; readonly head_sequence: number; readonly head_hash: string };
  readonly signature: { readonly alg: typeof SIGNATURE_ALG; readonly key_id: string; readonly sig: string };
}
export type IssuanceAttestation = AttestationBase & { readonly kind: "ISSUANCE"; readonly statement: IssuanceStatement };
export type RedemptionAttestation = AttestationBase & { readonly kind: "REDEMPTION"; readonly statement: RedemptionStatement };
export type Attestation = IssuanceAttestation | RedemptionAttestation;

/** The exact set of members of every object of the format. The JSON Schema file is tested against this. */
export const FORMAT_FIELDS = {
  attestation: ["proof_version", "kind", "engine", "statement", "journal", "signature"],
  engine: ["id", "protocol_version", "event_schema_version"],
  journal: ["scheme", "head_sequence", "head_hash"],
  signature: ["alg", "key_id", "sig"],
  event: ["sequence", "event_id", "authority_time"],
  statementCommon: ["event", "capability_id", "action_id", "action_fingerprint", "principal_id", "decision_sequence", "enforcement_point_id"],
  issuanceOnly: ["granted_chain_ref", "expires_at"],
  chainDelegation: ["kind", "delegation_id"],
  chainApproval: ["kind", "approval_id"],
} as const;

export const MAX_CHAIN_LINKS = 64;

// ---------------------------------------------------------------------------
// Strict structural validation (L0). No semantics beyond the shape.
// ---------------------------------------------------------------------------

const isIdentifier = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= 256 && !/[\u0000-\u001f\u007f]/.test(v);
const isNonNegInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function closedObject(value: unknown, fields: readonly string[], path: string, problems: string[]): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    problems.push(`${path}: expected an object`);
    return undefined;
  }
  const o = value as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!fields.includes(k)) problems.push(`${path}: unknown member ${JSON.stringify(k)}`);
  for (const k of fields) if (!(k in o)) problems.push(`${path}: missing member ${JSON.stringify(k)}`);
  return o;
}

export type StructureResult = { readonly ok: true; readonly attestation: Attestation } | { readonly ok: false; readonly problems: readonly string[] };

export function validateAttestationStructure(value: unknown): StructureResult {
  const problems: string[] = [];
  const top = closedObject(value, FORMAT_FIELDS.attestation, "attestation", problems);
  if (top === undefined) return { ok: false, problems };
  if (top.proof_version !== ATTESTATION_VERSION) problems.push(`attestation.proof_version: must be ${JSON.stringify(ATTESTATION_VERSION)}`);
  const kind = top.kind;
  if (kind !== "ISSUANCE" && kind !== "REDEMPTION") problems.push(`attestation.kind: must be "ISSUANCE" or "REDEMPTION"`);

  const engine = closedObject(top.engine, FORMAT_FIELDS.engine, "attestation.engine", problems);
  if (engine !== undefined) {
    if (engine.id !== ENGINE_ID) problems.push(`attestation.engine.id: must be ${JSON.stringify(ENGINE_ID)}`);
    if (engine.protocol_version !== PROTOCOL_VERSION) problems.push(`attestation.engine.protocol_version: must be ${PROTOCOL_VERSION}`);
    if (engine.event_schema_version !== EVENT_SCHEMA_VERSION) problems.push(`attestation.engine.event_schema_version: must be ${EVENT_SCHEMA_VERSION}`);
  }

  const journal = closedObject(top.journal, FORMAT_FIELDS.journal, "attestation.journal", problems);
  if (journal !== undefined) {
    if (journal.scheme !== JOURNAL_HASH_SCHEME) problems.push(`attestation.journal.scheme: must be ${JSON.stringify(JOURNAL_HASH_SCHEME)}`);
    if (!isNonNegInt(journal.head_sequence) || (journal.head_sequence as number) < 1) problems.push("attestation.journal.head_sequence: must be an integer >= 1");
    if (typeof journal.head_hash !== "string" || !isLowerHex64(journal.head_hash)) problems.push("attestation.journal.head_hash: must be 64 lowercase hex characters");
  }

  const signature = closedObject(top.signature, FORMAT_FIELDS.signature, "attestation.signature", problems);
  if (signature !== undefined) {
    if (signature.alg !== SIGNATURE_ALG) problems.push(`attestation.signature.alg: must be ${JSON.stringify(SIGNATURE_ALG)}`);
    if (typeof signature.key_id !== "string" || base64urlDecodeExact(signature.key_id, 32) === undefined) problems.push("attestation.signature.key_id: must be canonical unpadded base64url of 32 bytes");
    if (typeof signature.sig !== "string" || base64urlDecodeExact(signature.sig, 64) === undefined) problems.push("attestation.signature.sig: must be canonical unpadded base64url of 64 bytes");
  }

  if (kind === "ISSUANCE" || kind === "REDEMPTION") {
    const fields = kind === "ISSUANCE" ? [...FORMAT_FIELDS.statementCommon, ...FORMAT_FIELDS.issuanceOnly] : FORMAT_FIELDS.statementCommon;
    const st = closedObject(top.statement, fields, "attestation.statement", problems);
    if (st !== undefined) {
      const ev = closedObject(st.event, FORMAT_FIELDS.event, "attestation.statement.event", problems);
      if (ev !== undefined) {
        if (!isNonNegInt(ev.sequence) || (ev.sequence as number) < 1) problems.push("attestation.statement.event.sequence: must be an integer >= 1");
        if (!isIdentifier(ev.event_id)) problems.push("attestation.statement.event.event_id: must be an identifier (1 to 256 characters, no control characters)");
        if (typeof ev.authority_time !== "string" || !isCanonicalInstant(ev.authority_time)) problems.push("attestation.statement.event.authority_time: must be a UTC instant YYYY-MM-DDTHH:mm:ss.sssZ");
      }
      for (const k of ["capability_id", "action_id", "principal_id", "enforcement_point_id"]) if (!isIdentifier(st[k])) problems.push(`attestation.statement.${k}: must be an identifier (1 to 256 characters, no control characters)`);
      if (typeof st.action_fingerprint !== "string" || !isLowerHex64(st.action_fingerprint)) problems.push("attestation.statement.action_fingerprint: must be 64 lowercase hex characters");
      if (!isNonNegInt(st.decision_sequence)) problems.push("attestation.statement.decision_sequence: must be an integer >= 0");
      if (kind === "ISSUANCE") {
        if (typeof st.expires_at !== "string" || !isCanonicalInstant(st.expires_at)) problems.push("attestation.statement.expires_at: must be a UTC instant YYYY-MM-DDTHH:mm:ss.sssZ");
        const chain = st.granted_chain_ref;
        if (!Array.isArray(chain) || chain.length < 1 || chain.length > MAX_CHAIN_LINKS) problems.push(`attestation.statement.granted_chain_ref: must be an array of 1 to ${MAX_CHAIN_LINKS} links`);
        else {
          chain.forEach((link: unknown, i: number) => {
            const path = `attestation.statement.granted_chain_ref[${i}]`;
            const kindOf = typeof link === "object" && link !== null ? (link as Record<string, unknown>).kind : undefined;
            if (kindOf === "delegation") {
              const l = closedObject(link, FORMAT_FIELDS.chainDelegation, path, problems);
              if (l !== undefined && !isIdentifier(l.delegation_id)) problems.push(`${path}.delegation_id: must be an identifier`);
            } else if (kindOf === "approval") {
              const l = closedObject(link, FORMAT_FIELDS.chainApproval, path, problems);
              if (l !== undefined && !isIdentifier(l.approval_id)) problems.push(`${path}.approval_id: must be an identifier`);
            } else problems.push(`${path}.kind: must be "delegation" or "approval"`);
          });
        }
      }
    }
  }
  return problems.length === 0 ? { ok: true, attestation: value as Attestation } : { ok: false, problems };
}

// ---------------------------------------------------------------------------
// Signing input
// ---------------------------------------------------------------------------

/** The exact bytes that are signed (see the module doc). `signature.sig` is excluded; `alg` and `key_id` are included. */
export function signingBytes(attestation: Attestation | (Omit<Attestation, "signature"> & { readonly signature: { readonly alg: string; readonly key_id: string } })): Uint8Array {
  const { signature, ...rest } = attestation as unknown as { signature: { alg: string; key_id: string } } & Record<string, unknown>;
  const body = canonicalizeToolArguments({ ...rest, signature: { alg: signature.alg, key_id: signature.key_id } });
  return Buffer.from(SIGNING_PREFIX + body, "utf8");
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export type AttestationRefusalCode = "CAPABILITY_NOT_FOUND" | "ISSUANCE_NOT_VALID" | "REDEMPTION_NOT_FOUND" | "REDEMPTION_NOT_VALID" | "JOURNAL_NOT_CONTIGUOUS";

export class AttestationRefusedError extends Error {
  readonly code: AttestationRefusalCode;
  readonly detail: string | undefined;
  constructor(code: AttestationRefusalCode, detail?: string) {
    super(`attestation refused: ${code}${detail !== undefined ? ` (${detail})` : ""}`);
    this.name = "AttestationRefusedError";
    this.code = code;
    this.detail = detail;
  }
}


type IssuedEvent = Extract<CanonicalStore[number], { readonly event_type: "CAPABILITY_ISSUED" }>;
type RedeemedEvent = Extract<CanonicalStore[number], { readonly event_type: "CAPABILITY_REDEEMED" }>;

/** The statement an attestation makes about an issuance event. Shared by the builder and by L3, so they cannot drift. */
export function issuanceStatementOf(event: IssuedEvent): IssuanceStatement {
  return {
    event: { sequence: Number(event.sequence), event_id: String(event.event_id), authority_time: String(event.authority_time) },
    capability_id: String(event.payload.capability_id),
    action_id: String(event.payload.action_id),
    action_fingerprint: String(event.payload.action_fingerprint),
    principal_id: String(event.principal_id),
    decision_sequence: Number(event.payload.decision_sequence),
    enforcement_point_id: String(event.payload.enforcement_point_id),
    granted_chain_ref: event.payload.granted_chain_ref.map((l): ChainLink => (l.kind === "delegation" ? { kind: "delegation", delegation_id: String(l.delegation_id) } : { kind: "approval", approval_id: String(l.approval_id) })),
    expires_at: String(event.payload.expires_at),
  };
}

/** The statement an attestation makes about a redemption event. */
export function redemptionStatementOf(event: RedeemedEvent): RedemptionStatement {
  return {
    event: { sequence: Number(event.sequence), event_id: String(event.event_id), authority_time: String(event.authority_time) },
    capability_id: String(event.payload.capability_id),
    action_id: String(event.payload.action_id),
    action_fingerprint: String(event.payload.action_fingerprint),
    principal_id: String(event.principal_id),
    decision_sequence: Number(event.payload.decision_sequence),
    enforcement_point_id: String(event.payload.enforcement_point_id),
  };
}

function headOf(store: CanonicalStore) {
  try {
    return journalHead(store);
  } catch (err) {
    throw new AttestationRefusedError("JOURNAL_NOT_CONTIGUOUS", (err as Error).message);
  }
}

async function signAndSeal(unsigned: Omit<Attestation, "signature">, signer: ProofSigner): Promise<Attestation> {
  const withSlot = { ...unsigned, signature: { alg: SIGNATURE_ALG, key_id: signer.keyId } } as Attestation & { signature: { alg: string; key_id: string } };
  const sig = await signer.sign(signingBytes(withSlot));
  if (sig.byteLength !== 64) throw new Error("the signer must return a raw 64-byte Ed25519 signature");
  const sealed = { ...unsigned, signature: { alg: SIGNATURE_ALG, key_id: signer.keyId, sig: base64urlEncode(sig) } } as Attestation;
  const check = validateAttestationStructure(sealed);
  if (!check.ok) throw new Error(`internal error: the built attestation is malformed: ${check.problems.join("; ")}`);
  return sealed;
}

const engineIdentity = { id: ENGINE_ID, protocol_version: PROTOCOL_VERSION, event_schema_version: EVENT_SCHEMA_VERSION } as const;

/** Attests that the capability was issued, over the WHOLE journal `store` (head = its last event). */
export async function attestIssuance(store: CanonicalStore, capabilityId: string, signer: ProofSigner): Promise<IssuanceAttestation> {
  const event = store.find((e) => e.event_type === "CAPABILITY_ISSUED" && e.payload.capability_id === capabilityId);
  if (event === undefined || event.event_type !== "CAPABILITY_ISSUED") throw new AttestationRefusedError("CAPABILITY_NOT_FOUND");
  const grant = validateAndSelectGrant(store, event);
  if (!grant.ok) throw new AttestationRefusedError("ISSUANCE_NOT_VALID", grant.reason);
  const head = headOf(store);
  const unsigned = {
    proof_version: ATTESTATION_VERSION,
    kind: "ISSUANCE",
    engine: engineIdentity,
    statement: issuanceStatementOf(event),
    journal: { scheme: JOURNAL_HASH_SCHEME, head_sequence: head.head_sequence, head_hash: head.head_hash },
  } as const;
  return (await signAndSeal(unsigned as unknown as Omit<Attestation, "signature">, signer)) as IssuanceAttestation;
}

/** Attests that the capability was redeemed, over the WHOLE journal `store`. Refuses a redemption that fails `validateRedemptionEvent` (I31). */
export async function attestRedemption(store: CanonicalStore, capabilityId: string, signer: ProofSigner): Promise<RedemptionAttestation> {
  const event = store.find((e) => e.event_type === "CAPABILITY_REDEEMED" && e.payload.capability_id === capabilityId);
  if (event === undefined || event.event_type !== "CAPABILITY_REDEEMED") throw new AttestationRefusedError("REDEMPTION_NOT_FOUND");
  const valid = validateRedemptionEvent(store, event);
  if (!valid.ok) throw new AttestationRefusedError("REDEMPTION_NOT_VALID", valid.reason);
  const head = headOf(store);
  const unsigned = {
    proof_version: ATTESTATION_VERSION,
    kind: "REDEMPTION",
    engine: engineIdentity,
    statement: redemptionStatementOf(event),
    journal: { scheme: JOURNAL_HASH_SCHEME, head_sequence: head.head_sequence, head_hash: head.head_hash },
  } as const;
  return (await signAndSeal(unsigned as unknown as Omit<Attestation, "signature">, signer)) as RedemptionAttestation;
}
