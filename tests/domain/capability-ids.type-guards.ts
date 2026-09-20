/**
 * Compile-time-only proof that the new branded identifiers are mutually
 * distinct, and distinct from the existing identifiers they are most likely
 * to be confused with. Branding is erased at runtime, so this property has
 * no runtime test — it is checked exclusively by `tsc --noEmit` (this file
 * deliberately does not end in `.test.ts`, so vitest's `tests/**\/*.test.ts`
 * include pattern never tries to execute it as a test suite; tsconfig.json's
 * broad `"tests"` include still type-checks it on every `npm run typecheck`).
 *
 * Every `@ts-expect-error` below asserts that an assignment must fail to
 * compile. If a future change to src/domain/types.ts silently widens one of
 * these branded types (e.g. by aliasing it to `string` or to another
 * existing brand), the corresponding `@ts-expect-error` becomes unused and
 * `tsc --noEmit` fails on it — the same enforcement mechanism the TypeScript
 * compiler already provides, not a custom one.
 */
import {
  capabilityId,
  clientIdempotencyKey,
  delegationId,
  enforcementPointId,
  principalId,
  type CapabilityId,
  type ClientIdempotencyKey,
  type DelegationId,
  type EnforcementPointId,
  type PrincipalId,
} from "../../src/domain/types.js";

const cap: CapabilityId = capabilityId("cap-1");
const del: DelegationId = delegationId("d-1");
const ep: EnforcementPointId = enforcementPointId("ep-1");
const principal: PrincipalId = principalId("p-1");
const key: ClientIdempotencyKey = clientIdempotencyKey("key-1");

// CapabilityId is not a DelegationId: a capability is not a delegation.
// @ts-expect-error CapabilityId must not be assignable to DelegationId
const capAsDelegation: DelegationId = cap;
// @ts-expect-error DelegationId must not be assignable to CapabilityId
const delAsCapability: CapabilityId = del;

// EnforcementPointId is not a PrincipalId: an enforcement point is not
// simply another kind of principal.
// @ts-expect-error EnforcementPointId must not be assignable to PrincipalId
const epAsPrincipal: PrincipalId = ep;
// @ts-expect-error PrincipalId must not be assignable to EnforcementPointId
const principalAsEp: EnforcementPointId = principal;

// ClientIdempotencyKey is not a CapabilityId: a caller-supplied retry key
// must never stand in for an Authority-issued identity.
// @ts-expect-error ClientIdempotencyKey must not be assignable to CapabilityId
const keyAsCapability: CapabilityId = key;
// @ts-expect-error CapabilityId must not be assignable to ClientIdempotencyKey
const capAsKey: ClientIdempotencyKey = cap;

// Referenced only to keep every declared binding "used" under this
// project's lint/typecheck configuration — none of these values carry any
// runtime assertion; the assignments above are the actual test.
void [capAsDelegation, delAsCapability, epAsPrincipal, principalAsEp, keyAsCapability, capAsKey];
