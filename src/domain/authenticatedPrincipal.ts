/**
 * PR4B-2 — the shape a command handler expects an identity to already
 * arrive in, instead of ever authenticating anything itself.
 *
 * This is NOT an authentication mechanism, and this module builds none:
 * no JWT, no mTLS, no API key, no signature verification. There is no
 * smart constructor here that "verifies" a `PrincipalId` belongs to
 * whoever is asking — deliberately, so nothing about this file could be
 * mistaken for the authentication this project is not building yet. The
 * only legitimate way to obtain one is the external authentication
 * mechanism at the deployment boundary (JWT/mTLS/API key — not chosen
 * here), which is expected to construct this value AFTER it has already
 * done that verification, and to hand it to the command handler as a
 * precondition, never as something the handler re-derives.
 */
import type { PrincipalId } from "./types.js";

export interface AuthenticatedPrincipal {
  readonly principalId: PrincipalId;
}
