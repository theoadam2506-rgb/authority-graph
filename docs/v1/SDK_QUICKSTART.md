# Authority Graph SDK: install it locally and use it (experimental)

> **Status: experimental, not published to npm, not independently reviewed.**
> Do not use it for real payments or sensitive production actions. There is no
> registry package: you install it from a tarball that you build yourself from
> this repository. The generated package is marked `"private": true`, so
> `npm publish` refuses it.

## What you need

- Node.js 20 or 22, and TypeScript if you want the types (the package ships
  `.d.ts` files).
- A project that uses ES modules (`"type": "module"`). The package is ESM only.
- For types and module resolution, `"moduleResolution": "NodeNext"` (with
  `"module": "NodeNext"`) or `"Bundler"`.
- PostgreSQL only if you use `postgresBackend(pool)`. Then also install `pg`
  yourself: it is an optional peer dependency, and the in-memory backend never
  loads it. Apply `sql/schema.sql` and `sql/roles.sql` (shipped in the package,
  e.g. `authority-graph-sdk/sql/schema.sql`) to the database first.

## 1. Build the tarball (in a clone of this repository)

```
npm ci
npm run sdk:package
```

This writes `authority-graph-sdk-<version>.tgz` at the repository root. Nothing
is uploaded anywhere.

## 2. Install it in your own project

```
npm install /path/to/authority-graph/authority-graph-sdk-0.0.0.tgz
```

The only runtime dependency is `json-canonicalize` (RFC 8785); `@types/pg` is a types-only dependency.

## 3. The minimal journey

One human delegation, one agent call, then: authorize, redeem the single-use
capability, run the effect, report the result. A second redemption of the same
ticket and a call with changed arguments are refused.

<!-- quickstart-code -->
```ts
import { createAuthority, createEventBuilders, memoryBackend, systemClock } from "authority-graph-sdk";

// You choose the time source and you trust it: there is no default clock.
const authority = createAuthority({ backend: memoryBackend(), clock: systemClock, enforcementPointId: "my-gateway" });
const events = createEventBuilders({ clock: systemClock });

// 1. A human grants an agent a narrow, expiring delegation.
const recorded = await authority.record([
  events.delegation({
    delegationId: "d-1",
    grantor: "alice",
    grantee: "agent-1",
    capabilities: [{ resource: "purchase_order", action: "create" }],
    canDelegate: false,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    thresholds: { automaticMax: { value: 2000, currency: "EUR" }, approvalMax: { value: 5000, currency: "EUR" } },
  }),
]);
if (recorded.status !== "RECORDED" || !recorded.outcomes.every((o) => o.accepted)) throw new Error("delegation not accepted");

// 2. The agent wants to act. Authorize: ask before acting.
const call = {
  actionId: "po-1",
  agentId: "agent-1",
  delegationId: "d-1",
  capability: { resource: "purchase_order", action: "create" },
  amount: { value: 1800, currency: "EUR" },
  args: { sku: "A-100", qty: 3 },
};
const authorized = await authority.authorize(call);
if (authorized.status !== "AUTHORIZED") throw new Error(`not authorized: ${authorized.status}`);

// 3. Redeem the single-use capability immediately before the effect.
const redeemed = await authority.redeem(authorized.ticket, call);
if (redeemed.status !== "REDEEMED") throw new Error(`not redeemed: ${redeemed.status}`); // never run the effect on anything else

// 4. Run the effect yourself, once. Pass the idempotency key to the target system: Authority cannot deduplicate it.
let effects = 0;
effects++; // placeOrder(call, authorized.ticket.capabilityId)

// 5. Report the result (an assertion by the enforcement point, not proof that the effect happened).
const reported = await authority.report(authorized.ticket, { resultCode: "EXECUTED" });
if (reported.status !== "REPORTED") throw new Error(`not reported: ${reported.status}`);

// The same ticket cannot be redeemed twice, and a changed argument is refused.
const second = await authority.redeem(authorized.ticket, call);
const other = await authority.authorize({ ...call, actionId: "po-2" });
const changed = other.status === "AUTHORIZED" ? await authority.redeem(other.ticket, { ...call, actionId: "po-2", amount: { value: 1900, currency: "EUR" } }) : undefined;
if (second.status !== "REFUSED" || changed?.status !== "REFUSED" || effects !== 1) throw new Error("unexpected outcome");
console.log("authorized, redeemed once, reported; second redemption and changed arguments refused");
```

`authority.guard(call, effect)` does steps 2 to 5 in one call and never retries
the effect. See `docs/v1/SDK.md` for every result and what to do with it.

## What the builders do and do not do

`createEventBuilders({ clock })` builds the events a human or an operator writes:
`delegation`, `subdelegation`, `revocation`, `approvalRequest`, `approvalGranted`,
`approvalDenied`. They validate strictly (exact keys only, plain objects, whole
integer amounts, one currency, exact capabilities, explicit expiry, short reason
codes) and throw `AuthorityInputError` before anything reaches the engine. They
add no authority: the engine still decides at ingestion who may delegate, revoke
or approve, and an event it refuses comes back as `accepted: false`.

There is no builder for the events Authority writes itself (action requests,
tickets, redemptions, reports).

## Limits

Not published to npm. Experimental. Not independently reviewed. Identities are
asserted by your code; Authority does not authenticate them. It never performs
the action: only your system, and only your system can deduplicate it. The
in-memory backend loses everything when the process ends.
