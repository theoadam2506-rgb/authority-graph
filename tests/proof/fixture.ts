/**
 * Deterministic fixture for the attestation tests and the published vectors:
 * a 4-event journal (delegation, action, issued capability, redemption), a
 * fixed TEST key (RFC 8032, test vector 1: its private key is public, so it
 * protects nothing), and nothing that reads a clock or draws a random number.
 */
import { argumentsDigest } from "../../src/domain/canonicalJson.js";
import { toDraft, type CanonicalStore } from "../../src/domain/events.js";
import { actionId, capability, capabilityId, clientIdempotencyKey, enforcementPointId, iso8601, monetaryParameters, noExpiry, thresholds } from "../../src/domain/types.js";
import { InMemoryEventStore } from "../../src/storage/eventStore.js";
import { InMemoryCapabilityIssuanceTransaction } from "../../src/storage/capabilityIssuanceTransaction.js";
import { InMemoryCapabilityRedemptionTransaction } from "../../src/storage/capabilityRedemptionTransaction.js";
import { base64urlEncode } from "../../src/proof/encoding.js";
import { createEd25519Signer, keyIdOf, parsePublicJwk, type Ed25519PrivateJwk, type Ed25519PublicJwk, type ProofSigner, type TrustedKeys } from "../../src/proof/keys.js";
import { buildCapabilityRedeemedDraft } from "../../src/storage/capabilityRedemptionTransaction.js";
import { EUR, PURCHASE_ORDER_CREATE, THEO, actionRequest, revokeDelegation, rootDelegation } from "../fixtures/scenarios.js";

/** RFC 8032 section 7.1, TEST 1. Public knowledge: never a real key. */
export const RFC8032_TEST1 = {
  seedHex: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
  publicHex: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
  signatureOfEmptyHex: "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
} as const;

export const TEST_PRIVATE_JWK: Ed25519PrivateJwk = {
  kty: "OKP",
  crv: "Ed25519",
  x: base64urlEncode(Buffer.from(RFC8032_TEST1.publicHex, "hex")),
  d: base64urlEncode(Buffer.from(RFC8032_TEST1.seedHex, "hex")),
};
export const TEST_PUBLIC_JWK: Ed25519PublicJwk = parsePublicJwk({ kty: "OKP", crv: "Ed25519", x: TEST_PRIVATE_JWK.x });
export const TEST_KEY_ID = keyIdOf(TEST_PUBLIC_JWK);

export const testSigner = (): ProofSigner => createEd25519Signer(TEST_PRIVATE_JWK);
export const testKeys = (extra: Partial<{ notBefore: string; notAfter: string; revokedFrom: string; label: string }> = {}): TrustedKeys => new Map([[TEST_KEY_ID, { publicKey: TEST_PUBLIC_JWK, ...extra }]]);

const T = (hhmmss: string) => iso8601(`2025-01-01T${hhmmss}.000Z`);
export const TOOL_ARGS = { to: "vendor-1", sku: "A-100", qty: 3 };
export const AGENT = "agent-a";
export const EP = "ep-proof-1";

export interface ProofFixture {
  readonly events: CanonicalStore;
  readonly capabilityId: string;
  readonly redeemedCapabilityId: string;
  readonly unredeemedCapabilityId: string;
}

/** Journal: 1 delegation, 2 action, 3 issued (cap-proof-1), 4 redeemed (cap-proof-1), 5 issued (cap-proof-2, never redeemed). */
export interface FixtureOptions {
  /** Appends, after event 5, a revocation of the delegation by its grantor (event 6, 09:14:00). */
  readonly revocation?: boolean;
  /** Also appends a coherent-looking redemption of cap-proof-2 AFTER the revocation (event 7): forged, written around the transaction. Implies revocation. */
  readonly forgedRedemptionAfterRevocation?: boolean;
  /** Replaces the action amount (a different, still valid history of the same length). */
  readonly amount?: number;
}

export async function buildFixture(options: FixtureOptions = {}): Promise<ProofFixture> {
  let seedTime = T("09:00:00");
  let recorded = 0;
  const store = new InMemoryEventStore({ authorityTime: () => seedTime }, undefined, () => new Date(Date.parse("2025-01-01T12:00:00.000Z") + 1000 * recorded++).toISOString());
  const params = monetaryParameters(EUR(options.amount ?? 1800), undefined, argumentsDigest(TOOL_ARGS));
  const seed = await store.append([
    toDraft(rootDelegation({ sequence: 1, id: "d-proof", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT as never, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false, expires: noExpiry, amountThresholds: thresholds(EUR(2000), EUR(2000)) })),
    toDraft(actionRequest({ sequence: 2, id: "act-proof", requester: AGENT as never, delegationId: "d-proof", parameters: params })),
  ]);
  if (!seed.outcomes.every((o) => o.accepted)) throw new Error("fixture seed rejected");
  seedTime = T("09:05:00");
  const issuance = new InMemoryCapabilityIssuanceTransaction(store);
  const redemption = new InMemoryCapabilityRedemptionTransaction(store, { nextAttemptId: () => 1 });
  let n = 0;
  const deps = () => ({ nextCapabilityId: () => capabilityId(`cap-proof-${++n}`), expiresAt: (t: string) => iso8601(new Date(Date.parse(t) + 5 * 60_000).toISOString()) });
  const issue = async (key: string, at: string) => {
    const out = await issuance.issue({ principalId: AGENT as never }, clientIdempotencyKey(key), { action_id: actionId("act-proof"), enforcement_point_id: enforcementPointId(EP) }, deps(), T(at));
    if (out.outcome !== "EXECUTED" || !out.result.ok) throw new Error(`fixture issuance failed: ${JSON.stringify(out)}`);
    return out.result.capability.capability_id;
  };
  const first = await issue("k1", "09:10:00");
  const redeemed = await redemption.redeem({ principalId: AGENT as never }, { capability_id: first, enforcement_point_id: enforcementPointId(EP), observed_capability: capability("purchase_order", "create"), observed_parameters: params }, T("09:12:00"));
  if (!redeemed.ok) throw new Error(`fixture redemption failed: ${JSON.stringify(redeemed)}`);
  const second = await issue("k2", "09:13:00");
  if (options.revocation === true || options.forgedRedemptionAfterRevocation === true) {
    const r = await store.append([toDraft(revokeDelegation({ sequence: 99, targetId: "d-proof", issuedBy: THEO }))], T("09:14:00"));
    if (!r.outcomes[0]?.accepted) throw new Error("fixture revocation rejected");
  }
  if (options.forgedRedemptionAfterRevocation === true) {
    const events = await store.getEvents();
    const issued = events.find((e) => e.event_type === "CAPABILITY_ISSUED" && e.payload.capability_id === second);
    if (issued === undefined || issued.event_type !== "CAPABILITY_ISSUED") throw new Error("fixture: second ticket missing");
    const forged = buildCapabilityRedeemedDraft({ principalId: AGENT as never }, T("09:15:00"), { capability_id: second, action_id: issued.payload.action_id, action_fingerprint: issued.payload.action_fingerprint, decision_sequence: events.length as never, enforcement_point_id: issued.payload.enforcement_point_id }, "forged");
    const w = await store.append([forged], T("09:15:00"));
    if (!w.outcomes[0]?.accepted) throw new Error("fixture forged redemption rejected");
  }
  return { events: await store.getEvents(), capabilityId: first, redeemedCapabilityId: first, unredeemedCapabilityId: second };
}
