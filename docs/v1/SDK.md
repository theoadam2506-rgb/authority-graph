# Authority SDK (experimental)

> **Status: experimental, not published to npm, not independently reviewed.**
> Do not use it for real payments or sensitive production actions. To install it
> in your own project from a local tarball, see
> [`SDK_QUICKSTART.md`](./SDK_QUICKSTART.md). A scripted demo is a separate,
> later pull request.

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
| `report(ticket, { resultCode })` | Records `ACTION_EXECUTED` for a redeemed ticket, built from the journal (see below). An assertion by the enforcement point, not proof that the effect happened. |
| `guard(call, effect)` | `authorize`, `redeem`, run `effect` only if redeemed, then `report`. Never retries the effect. |
| `record(events)` | Appends delegations, approvals, revocations through the engine's ingestion rules. Build the events with `createEventBuilders({ clock })` (see below). |
| `events()` | Read-only journal. |

Decisions are **results**, never exceptions. Malformed input or configuration
throws (`AuthorityInputError`, `AuthorityConfigError`) before anything runs.

| `authorize` | Meaning |
|---|---|
| `AUTHORIZED` | A ticket was issued (or the same ticket is returned on retry). |
| `REQUIRES_APPROVAL` | A human approval for this exact action is missing. |
| `DENIED` / `UNKNOWN` | The engine refused, or could not decide. Both mean "do not run". |
| `UNAVAILABLE` | Store or clock failed (`code` says which kind, see below). Never "allowed". Retrying is safe. |

| `redeem` | Meaning |
|---|---|
| `REDEEMED` | The only status after which an effect may start. |
| `REFUSED` | A reason such as `ALREADY_REDEEMED`, `ARGUMENTS_MISMATCH`, `AUTHORITY_NO_LONGER_VALID`, `EXPIRED`, `WRONG_ENFORCEMENT_POINT`. |
| `UNKNOWN_OUTCOME` | The call failed in a way that does not say whether the redemption was written (`code: "OUTCOME_UNCERTAIN"`). **Do not run the effect.** |
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
is still `EXECUTED` with `report: { status: "UNAVAILABLE", ... }`.

## Errors and diagnostics: public results never contain a raw error

A raw error can carry a host name, a user, a connection URL, a password or a
path. So **no public result contains one**: a result is plain, JSON-safe data
(statuses, fixed codes, ids that Authority chose) that can be logged,
serialised or handed to an agent as it is.

| Result | Fields about the failure |
|---|---|
| `UNAVAILABLE` (authorize, redeem, report, record) | `code`, `diagnosticId` |
| `UNKNOWN_OUTCOME` (redeem) | `code: "OUTCOME_UNCERTAIN"`, `diagnosticId` |
| `EFFECT_FAILED` (guard) | `code: "EFFECT_THREW"`, `diagnosticId`, `ticketConsumed: true`; **not** the thrown value |

`code` for `UNAVAILABLE` is one of `CLOCK_INVALID`, `BACKEND_UNREACHABLE`
(connection refused, timeout, DNS, server shutdown), `BACKEND_ERROR`,
`SCHEMA_NOT_READY` and `INTERNAL_ERROR`. It is chosen from the error's **type and
code**, never copied from, or decided by, its message. The three families stay
distinct: a failure (`UNAVAILABLE`, nothing written), a refusal (`REFUSED`,
`DENIED`, `REQUIRES_APPROVAL`) and an uncertain outcome (`UNKNOWN_OUTCOME`). No
error is ever reported as `AUTHORIZED`, `REDEEMED` or `EXECUTED`, and an
uncertain redemption is never downgraded to a plain failure or hidden.

**Operator diagnostics.** The detail goes to one place, an explicit hook:

```ts
const authority = createAuthority({
  // ...
  onDiagnostic: (d) => ownerLogger.error({ id: d.id, operation: d.operation, code: d.code, actionId: d.actionId }, d.cause),
});
```

`diagnostic.id` is the `diagnosticId` of the public result, so an operator can
find the raw error for a result an agent saw. `diagnostic.cause` is the raw
error, by reference, and is **non-enumerable**, so `JSON.stringify(diagnostic)`
or a spread leaves it out: read it explicitly, and only in an operator log.
Rules: send diagnostics to your own log, **never** to an agent or a client; the
hook is called synchronously and best effort; an exception or a rejected
promise from it is swallowed and never changes a result; without a hook the
detail is dropped (the results still carry a code and a `diagnosticId`). The SDK
itself writes nothing: no console, no process output, no network.

An effect's own error is treated the same way: it is not in `EFFECT_FAILED`. To
handle it in your code, catch inside the effect; the operator gets it through
`onDiagnostic` (`operation: "guard.effect"`).

**Precautions that stay in force.**

- `onDiagnostic` is **trusted operator code**. It receives raw errors, which can
  hold credentials. Give it only code you control: never a callback taken from
  an agent, a plugin, a prompt or user configuration, and never one that writes
  to a model, a tool result or an HTTP response.
- The SDK sends **no raw diagnostic to an agent**, and nothing in your integration
  should either. Pass an agent the public result (status, code, `diagnosticId`) at
  most.
- **Programming errors and business outcomes are two separate channels.** Malformed
  configuration or input (`AuthorityConfigError`, `AuthorityInputError`) is
  **thrown** before anything runs: treat it as a bug to fix, not as an outcome,
  and do not forward its message. Decisions and failures of a dependency are
  **returned** as results and never thrown: `REFUSED`, `DENIED`,
  `REQUIRES_APPROVAL`, `UNAVAILABLE`, `UNKNOWN_OUTCOME`. Handle both: a
  `try/catch` for the first, a switch on `status` for the second.

What remains outside this protection: exceptions the SDK **throws** are for the
developer, not for an agent. `AuthorityInputError` can quote an invalid value
you passed (for example an amount); `ClockError` has a fixed message and keeps
the clock's own error in its (non-enumerable) `cause`. And `events()` returns
the journal, which is data, not diagnostics. Tests: `tests/sdk/diagnostics.test.ts`
(errors with a fictitious internal host, user, connection URL and password,
thrown from every layer, in several shapes; JSON, `util.inspect`, a deep
property walk and `structuredClone`; hook failures; a property over random
faults) and the static checks in `tests/sdk/surface.test.ts`.

## What `report` checks

The `Ticket` is a plain object the caller can alter, so `report` never trusts
it. It looks the capability up in the journal and records nothing unless the
journal and the ticket agree on every one of: the action, the requester's
identity, the fingerprint, the issuance decision sequence, the granted chain
and the enforcement point. The recorded event is built from the journal's
values (requester, fingerprint, decision sequence, granted chain), never from
the ticket. It also requires, in this order: the capability was issued; it was
redeemed; the redemption was made at **this** enforcement point; the redemption
is one the engine accepts as having authorized the action
(`validateRedemptionEvent`: first redemption, decision sequence immediately
before it, within the ticket's lifetime, authority valid at that point). A
redemption that was only a burned ticket (a forged event, or a concurrent write
detected) cannot be reported.

`resultCode` must match `^[A-Z0-9_]{1,64}$`: a short code, never free text or
data. The first report wins; a later one answers `ALREADY_REPORTED` and the
journal keeps the first code. Concurrent identical reports write one event; a
caller may be told `REPORTED` with the same sequence as another. Tests:
`tests/sdk/report.test.ts` (alterations of each field, the capability of another
action, another enforcement point, a forged redemption, concurrency, and the
engine's own explanation of a journal written by `guard`).

Limits of `report`:

- It is an **assertion** by the enforcement point. The SDK cannot know that the
  effect really happened, nor that it ran with the redeemed arguments.
- `record()` is trusted ingress. A forged `ACTION_EXECUTED` written around the
  SDK is accepted by the engine's ingestion; `explainAction` then exposes it
  (for example `C6_ACTION_FINGERPRINT_MISMATCH`), but nothing prevents it.
- The decision sequence recorded is the issuance's, not the redemption's.

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
   keys, is **not protected**. Documenting this is not considered enough: a
   separate engine correction is proposed in its own document and is **not part
   of this change**. Until it is merged and released, do not issue tickets
   around the SDK.

## Typed event builders

`createEventBuilders({ clock })` returns `delegation`, `subdelegation`,
`revocation`, `approvalRequest`, `approvalGranted` and `approvalDenied`. Each takes
a plain object and returns a draft for `record()`. They are strict: exact keys only
(an unknown key, a getter, a symbol key or a non-plain object is refused), whole
integer amounts, one currency per delegation (I25, never converted), an approval
band that is ordered, exact capabilities (a lone `*` is refused, I9), an explicit
`expiresAt` (`null` means "never"; there is no default), an explicit `canDelegate`,
canonical instants, short reason codes (`^[A-Z0-9_]{1,64}$`) and opaque ids of 1 to
256 characters without control characters. The time comes from the clock you pass
(D34). A refusal throws `AuthorityInputError` before anything reaches the engine.

They add no authority. The engine still decides at ingestion who may delegate,
revoke or approve: an event it refuses comes back as `accepted: false` from
`record()`. There is no builder for the events Authority writes itself (action
requests, tickets, redemptions, reports).

## Packaging

`npm run sdk:package` builds the package (`.sdk-package/`: compiled ESM, `.d.ts`,
`sql/`, licence) and packs it with `npm pack`. `npm run sdk:package:check` installs
that tarball in a throwaway project outside the repository, type-checks and runs
the quickstart under two TypeScript module settings, and checks the exports. The
generated package is `"private": true` and is not published. It has one public
entry point; deep imports are closed by the `exports` map; the SDK compiles only
`domain`, `engine`, `storage` and `sdk` (no CLI, no conformance lab, no proof
tooling). `pg` is an optional peer dependency used only by `postgresBackend`.

## Not in this change

npm publication, a scripted agent demo, Authority Proof signing from the SDK, an
HTTP service.
