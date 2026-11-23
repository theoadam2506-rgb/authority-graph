# Agent demo: an AI agent, a guarded tool, seven scenarios (experimental)

> **Status: experimental, not published to npm, not independently reviewed.**
> A teaching demo, not a security product. Read [What this demo does not show](#what-this-demo-does-not-show).

A scripted "agent" proposes tool calls. A sandbox "tool" only appends to an
in-memory list. Authority Graph sits between them. **No API key, no account, no
database, no network, no LLM**: you can read the whole thing and run it in a few
seconds.

## Run it

Needs Node.js 20 or 22 and a clone of this repository.

```
npm ci
npm run demo:agent
```

(`tsx examples/agent-demo/run.ts`.) The output is deterministic: the demo uses a
fixed clock and fixed ids, so you should see **exactly** the text below. The
script checks every expectation itself and exits with an error if one fails.

## What you are looking at

- [`examples/agent-demo/scenarios.ts`](../../examples/agent-demo/scenarios.ts):
  the seven scenarios (about 300 lines, commented).
- [`examples/agent-demo/run.ts`](../../examples/agent-demo/run.ts): prints them.
- It imports **only the public SDK entry point** (`createAuthority`,
  `createEventBuilders`, `memoryBackend`): the same imports an outside project
  has after `npm run sdk:package` (see [`SDK_QUICKSTART.md`](./SDK_QUICKSTART.md)).
  A test enforces it.

The setup: a human, `alice`, delegates to `procurement-agent` the right to create
purchase orders, up to **2,000 EUR on its own**, **up to 5,000 EUR with a human
approval**, nothing above, until the end of 2026.

## The seven scenarios

| # | What the agent tries | What Authority does | Why it matters |
|---|---|---|---|
| 1 | An allowed call; a capability never delegated; a delegation that is not its own; 9,000 EUR | Allows the first, **denies** the others with a fixed reason; the tool never runs on a denial | The decision comes from the delegation, not from the agent's say-so |
| 2 | 3,500 EUR (above the automatic limit) | `REQUIRES_APPROVAL`: blocked. The agent approves itself: **the engine refuses**. Alice approves that action: it runs. A second 3,500 EUR action: blocked again | An approval is human, and covers one exact action |
| 3 | Redeem the same ticket twice | The second redemption is `ALREADY_REDEEMED`; `guard` on the same action runs nothing | A ticket is single use |
| 4 | After authorization, change the amount, the recipient, the tool arguments or the action id | `ARGUMENTS_MISMATCH` / `ACTION_ID_MISMATCH`: refused, **and the ticket is not burned**: the honest call still works | The ticket is bound to the exact call (RFC 8785 digest of the arguments) |
| 5 | A ticket was issued, then Alice revokes the delegation | Redemption is `AUTHORITY_NO_LONGER_VALID`; new actions are `DENIED`. The agent cannot revoke its own delegation | Authority is re-checked at the last moment |
| 6 | Ask for the same action again, after redemption and expiry, with other arguments; someone writes a second ticket by hand | Same ticket every time; the reuse is `DENIED`; the hand-written second ticket is refused at ingestion (`BUSINESS_ID_COLLISION`); the journal holds **one** ticket | I32: at most one ticket per action, definitively |
| 7 | (a) the redemption's acknowledgement is lost; (b) the tool call times out after redemption | (a) `UNKNOWN_OUTCOME`: the tool does not run. (b) `EFFECT_FAILED`: the journal records `EFFECT_FAILED`, never `EXECUTED` | An unknown result is never presented as a confirmed success |

### Expected output

<!-- agent-demo-output -->
```
1. Authorize or refuse, from the delegation
  - An allowed action
      agent asks : po-1001: 1200 EUR to vendor-1
      Authority  : AUTHORIZED, REDEEMED
      tool       : ran once
  - Refused: a capability that was never delegated
      agent asks : po-1002: 100 EUR to vendor-1
      Authority  : DENIED (C11_CAPABILITY_NOT_COVERED)
      tool       : did not run
  - Refused: a delegation that belongs to someone else
      agent asks : po-1003: 100 EUR to vendor-1
      Authority  : DENIED (INVOKED_DELEGATION_NOT_OWNED_BY_REQUESTER)
      tool       : did not run
  - Refused: an amount above the approval ceiling
      agent asks : po-1004: 9000 EUR to vendor-1
      Authority  : DENIED (C8_AMOUNT_EXCEEDS_APPROVAL_CEILING)
      tool       : did not run

2. An action that needs a human approval
  - Needs a human: blocked
      agent asks : po-2001: 3500 EUR to vendor-1
      Authority  : REQUIRES_APPROVAL
      tool       : did not run
  - The agent approves itself
      agent asks : po-2001: 3500 EUR to vendor-1
      Authority  : approval refused by the engine (UNAUTHORIZED_APPROVAL_DECISION); still REQUIRES_APPROVAL
      tool       : did not run
  - The human approves
      agent asks : po-2001: 3500 EUR to vendor-1
      Authority  : approval accepted; AUTHORIZED, REDEEMED
      tool       : ran once
  - Another action of the same size
      agent asks : po-2002: 3500 EUR to vendor-1
      Authority  : REQUIRES_APPROVAL (the approval was for po-2001 only)
      tool       : did not run

3. A ticket works once
  - A ticket works once
      agent asks : po-3001: 800 EUR to vendor-1
      Authority  : first redeem: REDEEMED; second redeem: REFUSED (ALREADY_REDEEMED)
      tool       : ran once, not twice

4. Arguments substituted after authorization
  - Substitution: a larger amount
      agent asks : po-4001: 1900 EUR instead of 1200 (authorized: po-4001: 1200 EUR to vendor-1)
      Authority  : REFUSED (ARGUMENTS_MISMATCH)
      tool       : did not run
  - Substitution: another recipient
      agent asks : po-4001: recipient attacker-account instead of vendor-1 (authorized: po-4001: 1200 EUR to vendor-1)
      Authority  : REFUSED (ARGUMENTS_MISMATCH)
      tool       : did not run
  - Substitution: other tool arguments
      agent asks : po-4001: qty 300 instead of 3 (authorized: po-4001: 1200 EUR to vendor-1)
      Authority  : REFUSED (ARGUMENTS_MISMATCH)
      tool       : did not run
  - Substitution: another action id
      agent asks : po-9999 presented with po-4001's ticket (authorized: po-4001: 1200 EUR to vendor-1)
      Authority  : REFUSED (ACTION_ID_MISMATCH)
      tool       : did not run
  - The unchanged call
      agent asks : po-4001: 1200 EUR to vendor-1
      Authority  : REDEEMED (a refused substitution does not consume the ticket)
      tool       : ran once

5. Revocation
  - Revocation between authorize and redeem
      agent asks : po-5001: 1500 EUR to vendor-1
      Authority  : ticket issued, then the owner revoked: REFUSED (AUTHORITY_NO_LONGER_VALID)
      tool       : did not run
  - A new action after the revocation
      agent asks : po-5002: 100 EUR to vendor-1
      Authority  : DENIED (C12_DELEGATION_REVOKED)
      tool       : did not run

6. One ticket per action (I32)
  - One ticket per action (I32)
      agent asks : po-6001: 600 EUR to vendor-1
      Authority  : asking again: same ticket; after redemption and expiry: same ticket; other arguments under the same id: DENIED (ACTION_ID_REUSED_WITH_DIFFERENT_CALL); a hand-written second ticket: refused (BUSINESS_ID_COLLISION)
      tool       : journal holds 1 ticket for the action

7. An unknown outcome is not a success
  - The redemption's outcome is unknown
      agent asks : po-7001: 400 EUR to vendor-1
      Authority  : UNKNOWN_OUTCOME (OUTCOME_UNCERTAIN); a retry would report ALREADY_REDEEMED either way
      tool       : did not run: NOT a success, NOT a confirmed failure
  - The tool call times out after redemption
      agent asks : po-7002: 700 EUR to vendor-1
      Authority  : EFFECT_FAILED (ticket consumed, never retried); journal says EFFECT_FAILED; check the target with the idempotency key
      tool       : outcome UNKNOWN: not a confirmed success

Orders the sandbox tool actually placed: 4
  - po-1001: 1200 EUR to vendor-1 (idempotency key cap-demo-1)
  - po-2001: 3500 EUR to vendor-1 (idempotency key cap-demo-2)
  - po-3001: 800 EUR to vendor-1 (idempotency key cap-demo-3)
  - po-4001: 1200 EUR to vendor-1 (idempotency key cap-demo-4)

Every expectation held. This demo does not show exactly-once execution of the external effect, identity verification or an independent audit: see docs/v1/AGENT_DEMO.md.
```

Read it as: *the agent asks*, *Authority answers*, *the tool did or did not run*.
Four orders were placed in total (`po-1001`, `po-2001`, `po-3001`, `po-4001`);
everything else was stopped or is of unknown outcome. The `idempotency key` is
the ticket id: **pass it to the real target system** so that it can deduplicate.
Authority cannot.

## On scenario 6 and the four layers of I32

Through the SDK, asking again for the same action returns the **same** ticket
(one fixed idempotency key per action), so the SDK path never even tries to issue
a second ticket. What the demo shows is what happens when someone writes around
it: a hand-made second `CAPABILITY_ISSUED` for the same action is refused by
ingestion. I32 has four layers (issuance kernel, ingestion, issuance transactions,
PostgreSQL unique index); this demo exercises the ingestion layer on the
in-memory backend. The kernel refusal (`ACTION_ALREADY_TICKETED`), the
transactions and the PostgreSQL index are covered by the engine and PostgreSQL
test suites, not by this demo.

## What this demo does not show

- **No exactly-once execution.** Authority bounds *authorization*: one successful
  redemption per ticket. It never performs the action. Only your target system
  can deduplicate or confirm it, which is why scenario 7 refuses to call an
  unknown result a success, and why you pass the idempotency key on.
- **No identity verification.** Principals are asserted by your code (`agentId`,
  `alice`). Authority does not authenticate them; anyone who can call the SDK as
  `alice` can approve.
- **In-memory only.** Everything is lost when the process ends. The PostgreSQL
  backend exists and is tested separately; this demo does not use it.
- **A trusted clock.** The demo uses a fixed clock you control; a real deployment
  trusts its own.
- **Scripted, not an LLM.** It shows the guard, not how an agent reasons. A
  prompt-injected real agent would still be stopped by the same checks, but this
  demo does not prove that.
- **Experimental, not independently reviewed, not for real payments.** No
  security guarantee is claimed.

See also [`SDK.md`](./SDK.md) (every result and what to do with it) and
[`SDK_QUICKSTART.md`](./SDK_QUICKSTART.md) (install the SDK in your own project).
