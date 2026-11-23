# Authority SDK (experimental)

> **Status: experimental, not published to npm, not independently reviewed.**
> Do not use it for real payments or sensitive production actions. Packaging,
> event builders and a scripted demo are separate, later pull requests.

`src/sdk` is a thin in-process layer over the existing engine, stores and
transactions. It adds no authority logic and changes no event format. It gives
you four calls and one rule: **the effect starts only after a successful
redemption.**

```ts
import { createAuthority, memoryBackend, systemClock } from "./src/sdk/index.js";

const authority = createAuthority({ backend: memoryBackend(), clock: systemClock, enforcementPointId: "purchase-gateway" });

const result = await authority.guard(call, async ({ idempotencyKey }) => placeOrder(call, idempotencyKey));
```

Run the complete, checked example with `npm run sdk:example`
([`examples/sdk-guard.ts`](../../examples/sdk-guard.ts)). For a database, use
`postgresBackend(pool)` after applying `src/storage/schema.sql` (and
`roles.sql`); the pool and its `error` listener stay yours.

## The calls

| Call | What it does |
|---|---|
| `authorize(call)` | Records the call (`ACTION_REQUESTED`), evaluates it for this exact action, and if authorized issues a single-use `Ticket` (`CAPABILITY_ISSUED`). |
| `redeem(ticket, observed)` | One atomic step, immediately before the effect: ticket exists, not expired, not redeemed, this enforcement point, same arguments, authority **still valid now**. Writes `CAPABILITY_REDEEMED`. |
| `report(ticket, { resultCode })` | Records `ACTION_EXECUTED` for a redeemed ticket. An assertion by the enforcement point, not proof that the effect happened. |
| `guard(call, effect)` | `authorize`, `redeem`, run `effect` only if redeemed, then `report`. Never retries the effect. |
| `record(events)` | Appends delegations, approvals, revocations through the engine's ingestion rules. |
| `events()` | Read-only journal. |

Decisions are **results**, never exceptions. Malformed input or configuration
throws (`AuthorityInputError`, `AuthorityConfigError`) before anything runs.

| `authorize` | Meaning |
|---|---|
| `AUTHORIZED` | A ticket was issued (or the same ticket is returned on retry). |
| `REQUIRES_APPROVAL` | A human approval for this exact action is missing. |
| `DENIED` / `UNKNOWN` | The engine refused, or could not decide. Both mean "do not run". |
| `UNAVAILABLE` | Store or clock failed. Never "allowed". Retrying is safe. |

| `redeem` | Meaning |
|---|---|
| `REDEEMED` | The only status after which an effect may start. |
| `REFUSED` | A reason such as `ALREADY_REDEEMED`, `ARGUMENTS_MISMATCH`, `AUTHORITY_NO_LONGER_VALID`, `EXPIRED`, `WRONG_ENFORCEMENT_POINT`. |
| `UNKNOWN_OUTCOME` | The call failed in a way that does not say whether the redemption was written. **Do not run the effect.** |
| `UNAVAILABLE` | A failure before anything could have been written. |

## Uncertain outcomes

If `redeem` throws after the database committed (a lost acknowledgement), the
ticket may be consumed without you knowing. The SDK reports `UNKNOWN_OUTCOME`
and `guard` does not start the effect. A retry answers `ALREADY_REDEEMED`
whether or not your first attempt wrote the row, so it cannot tell you either:
look at the journal. The price of this choice is that an effect can be
**lost** (not run although authorized), never duplicated by this path. Tests:
`tests/sdk/authority.test.ts` and, on PostgreSQL, `tests/sdk/authority.postgres.test.ts`.

If the effect throws, the ticket stays consumed, the failure is reported
(`EFFECT_FAILED`) and the effect is not retried. If `report` fails, the result
is still `EXECUTED` with `report: { status: "UNAVAILABLE" }`.

## Guarantees, and where they stop

Demonstrated by tests (including a seeded random fault-injection property, 150
runs, and mutation checks):

- The effect never starts without a recorded redemption of its ticket.
- A ticket is redeemed at most once, across concurrent callers and across
  independent PostgreSQL pools.
- Changed arguments, amount, currency or recipient are refused at redemption.
- A revocation written between `authorize` and `redeem` is honoured.
- A thrown error, an unreadable store or a bad clock never ends in "allowed".

Not guaranteed:

- **The external effect happens at most once.** Only the target can dedupe;
  `guard` hands it `idempotencyKey` for that reason.
- **Identity.** `agentId` is asserted by the caller; Authority does not verify it.
- **The clock.** It is injected, with no default, and whoever controls it
  controls expiry and revocation timing. `systemClock` is an explicit opt-in.
- **Anyone who can write to the journal around the SDK.** Such a writer can
  burn a ticket, and can issue extra tickets (below).
- **Throughput.** Writes share one PostgreSQL writer lock; not measured.
- **Independent review.** None.

Tool arguments must be plain JSON; amounts are whole, non-negative integers.

## Engine behaviour the SDK works around (found while building it)

Both were observed on `main` at `397ba8c`; neither is changed here.

1. **A refused issuance is cached under its idempotency key and replayed**, even
   after the missing approval was granted. The SDK therefore evaluates the
   action read-only first and calls the issuance transaction only when the
   action is currently authorized, so refusals are never cached by the SDK.
2. **The engine does not limit tickets per action.** With different idempotency
   keys, one approved action can obtain two tickets, and both can be redeemed;
   the approval is consumed only by `ACTION_EXECUTED` (`report`). Through the
   SDK there is exactly one ticket per action (a fixed idempotency key makes the
   issuance atomic), but a caller that issues tickets directly, with its own
   keys, is not protected. Whether the engine should enforce "one live ticket
   per action" is a separate decision.

## Not in this change

Event builders, packaging (`dist`, subpath exports), npm publication, a scripted
agent demo, Authority Proof signing from the SDK, an HTTP service.
