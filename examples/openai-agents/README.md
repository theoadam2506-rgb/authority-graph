# Authority Graph with the OpenAI Agents SDK: architecture A (experimental)

> **Status: experimental, not published to npm, not independently reviewed.** Do not use it for real payments or
> sensitive production actions. No security guarantee is claimed, and nothing here guarantees that an external effect
> happens exactly once.

This example puts `authority.guard()` in front of one external effect, a simulated supplier order, inside the
`execute` of an [OpenAI Agents SDK](https://github.com/openai/openai-agents-js) function tool. The model is
**scripted** (`ScriptedModel`): no API key, no network, no call to OpenAI.

## What this is, and what it is not

This is **architecture A**: the thinnest possible layer. The tool calls `authority.guard()`, which authorizes, redeems a
single-use ticket, runs the effect only if redemption succeeded, and reports. Authority is the only gate in front of the
effect.

It is **not** a demonstration of architecture B. There is **no native pause and resume** of human approvals: the tool
does not set `needsApproval`, the run is never interrupted, `RunState` is not used, and `interruptions` is always
empty. When a human must approve an order, the model is *told* to wait, the host records the human's decision
**outside** the Agents SDK, and the model asks again in a later run. Bridging the Agents SDK's interruptions to
Authority's approvals is the separate, later work (architecture B), and is not done here.

## Requirements

- Node.js **22** (`>=22.18.0 <23`; verified on 22.23). CI runs this example on Node 22 only.
- Pinned exactly, with a lockfile of its own: `@openai/agents` **0.22.0** (a pre-1.0 release), `zod` 4.6.7, `tsx`,
  `typescript`. Nothing is added to the root package.
- The Authority SDK, from a tarball you build yourself (it is not published, and its package is `"private": true`).

## Reproduce

From a clone of this repository:

```
npm ci                     # root: installs what the SDK build needs
npm run sdk:package        # writes authority-graph-sdk-0.0.0.tgz at the repository root (nothing is uploaded)
cd examples/openai-agents
npm ci                     # installs the pinned dependencies and the SDK tarball
npm run typecheck
npm test                   # 19 tests
npm run demo               # prints the scenarios; compare with expected-output.txt
```

No environment variable is needed. `expected-output.txt` is what `npm run demo` prints, identically on every run (a
fixed clock, nothing random printed); a test enforces it.

If `npm ci` stops with an integrity error on `authority-graph-sdk`, the tarball you built differs byte for byte from the
one recorded in `package-lock.json` (for example a different Node or npm version compressed it differently). Run
`npm install` in this directory to record yours; do not commit that change without reviewing it.

## How it works

```
model ──tool call──▶ Agents SDK (validates the arguments with zod)
                         │
                         ▼
                 execute(input)  ── adapter ──▶ authority.guard(call, effect)
                                                  1. authorize   ─ DENIED / REQUIRES_APPROVAL ─▶ the effect does not run
                                                  2. redeem      ─ REFUSED / UNKNOWN_OUTCOME   ─▶ the effect does not run
                                                  3. effect(idempotencyKey = ticket id)        ─▶ the simulated supplier
                                                  4. report      ─ ACTION_EXECUTED (EXECUTED or EFFECT_FAILED)
                         ◀── a small JSON string for the model (no raw error, no diagnostic id)
```

The adapter is [`src/authorityTool.ts`](./src/authorityTool.ts) (about 150 lines with its comments):

- `authorityTool({ authority, name, description, parameters, principal, describeAction, effect })` returns a function
  tool.
- `principal` (`agentId`, `delegationId`) is given by the **host** when the tool is built. The model's arguments cannot
  change it; keys the model adds that the schema does not know are dropped.
- `describeAction(input)` maps the validated arguments to the action Authority evaluates. Its `actionId` must come from a
  **business reference**, never from the model's tool-call id (see below). **In this example that reference, `orderRef`,
  is one of the model's own arguments**: zod validates its format, not its legitimacy, and nothing ties it to an order
  the host registered (see "Where the order reference comes from").
- `effect(input, { idempotencyKey })` runs only after a successful redemption.
- `toModelResult` turns every `GuardResult` into one of four answers for the model. It never contains a raw error: the
  operator receives that through `onDiagnostic`.

| The model is told | When |
|---|---|
| `EXECUTED` (with `recorded`) | The effect returned. `recorded: false` means the journal write failed afterwards. |
| `APPROVAL_REQUIRED` | A human must approve this exact order. The tool did not run. |
| `NOT_EXECUTED` + a fixed `reason` | Refused or blocked: `C9_TOTAL_BUDGET_EXCEEDED`, `C12_DELEGATION_REVOKED`, `ACTION_ID_REUSED_WITH_DIFFERENT_CALL`, `C7_APPROVAL_ALREADY_CONSUMED`, `ALREADY_REDEEMED`, `OUTCOME_UNCERTAIN`, … The effect did not run. |
| `OUTCOME_UNKNOWN` | The effect started and then failed (`EFFECT_FAILED`): the supplier may have completed it. |

## The scenarios, and what each one covers

Each scenario is in [`src/scenarios.ts`](./src/scenarios.ts), asserted in
[`test/scenarios.test.ts`](./test/scenarios.test.ts), and printed by `npm run demo`.

| # | Scenario | Covered by architecture A | Not covered |
|---|---|---|---|
| 1 | An order of 1,800 EUR (automatic limit 2,000) | Authorized, redeemed once, placed once, reported | |
| 2 | An order of 9,000 EUR | Refused (`C9_TOTAL_BUDGET_EXCEEDED`); no ticket; the supplier is never called | |
| 3 | 3,500 EUR (needs a human) | `APPROVAL_REQUIRED`; the host records alice's approval; the same order then runs once | No native pause/resume: that is B |
| 4 | After the approval, the same order reference with another amount, sku or supplier | Refused (`ACTION_ID_REUSED_WITH_DIFFERENT_CALL`); the honest request still runs; the supplier got the approved amount | The ticket-level `ARGUMENTS_MISMATCH` check is not reachable through this adapter (it builds the call from one input); it is in Authority's own agent demo |
| 5 | The delegation is revoked after the approval | The order, and any new one, is refused (`C12_DELEGATION_REVOKED`); the supplier is never called | A revocation **between** authorization and redemption: `guard()` does both back to back. The re-check at the instant of redemption needs B2 |
| 6 | The same order is asked for again | Never rerun: `ALREADY_REDEEMED`, or `C7_APPROVAL_ALREADY_CONSUMED` for an approved order; also when the journal write after the effect failed | |
| 7 | The supplier completes the order and its reply is lost (7a), the model retries under another reference (7b), the supplier refuses cleanly (7c), the redemption's acknowledgement is lost (7d) | `OUTCOME_UNKNOWN` journaled `EFFECT_FAILED`, never rerun; a refusal and a lost reply look the same to the model; a lost redemption acknowledgement is `OUTCOME_UNCERTAIN` and the supplier is never called | 7b: the duplicate is **not** prevented (below); the reference is a model argument |

What the scripted model cannot show: how a language model reacts to these messages, whether it follows
"do not send it again", or resistance to prompt injection.

## Idempotency, and the risk of duplication between two distinct actions

`effect` receives `idempotencyKey`, which is **the Authority ticket id**. Pass it to the target system. Understand what
it can and cannot do:

- The same action always has the same ticket, and `guard()` never runs an action's effect twice. So the key never
  deduplicates a retry made by `guard()`: there is none. It identifies *this attempt*, which helps you ask your target
  "what happened for key K?".
- After an `OUTCOME_UNKNOWN`, the only way to try again is a **new action**: a new order reference, so a new ticket and
  a **different** key. If the first attempt did complete, the supplier receives a second, different request and may
  place the order twice. **Authority cannot prevent that** and cannot see that the two orders are the same purchase.
  Scenario 7b shows it: two orders at the supplier, one business purchase, two keys.
- Below the automatic limit a new action needs no approval, so nothing human stands in the way of that duplicate.
  Above it, a new action needs its own approval and spends budget of its own.
- What protects you is a stable business key that **your application** issues (not one the model is free to invent) and
  that your target deduplicates on, plus checking with the target before retrying. Keep the model's tool-call id out of the action id: it changes each
  time the model asks, so the same order would look like a new action.

## Where the order reference comes from: not the host, in this example

Two different things must not be confused:

| | Comes from | Protected by this example? |
|---|---|---|
| `agentId`, `delegationId` | The **host**, given when the tool is built | Yes: the model cannot change them (a test checks it) |
| `orderRef`, which becomes the Authority action id | The **model's arguments** | **No** |

`orderRef` is validated by zod as a non-empty string of at most 64 characters. That is a format check. It does not say
that the order exists, that the host issued the reference, or that the model is entitled to place it. Consequences:

- The model can invent a reference that was never registered, and the order runs if the delegation allows it
  (a test shows this).
- The model can use a **new** reference to retry an operation whose outcome is uncertain. That is a new action with a
  new ticket, so Authority treats it as a different order (scenario 7b).
- Authority never sees that two references are the same purchase.

**In a real application the host must do this, and the example does not:** issue the order reference itself (or check
it against an order it recorded) before calling the tool, bind it to the order's arguments, and refuse new references
for the retry of an operation that may already have happened. Without that, the protection of "the same order is never
run twice" holds only for the same reference.

## What the host must provide

Authority does not provide, and this example only simulates:

- **Identity.** `agentId`, `delegationId` and the human (`alice`) are asserted by host code. Anyone who can call the SDK
  as `alice` can approve. Authority authenticates nobody.
- **The clock.** A fixed one here.
- **The business reference of each order, and its legitimacy.** In this example the model writes it and only its format
  is checked. A real host must issue it or bind it to a registered order, and prevent arbitrary new references from
  being used to retry an uncertain operation. The example does not do this.
- **Recording the human's decision**, outside the Agents SDK, in this architecture.
- **A trusted, durable journal.** The in-memory backend is lost with the process. The journal is trusted, not
  authenticated, and its completeness is not established.
- **Deduplication and confirmation at the target.** No exactly-once guarantee exists anywhere in this example.

## Limits

- The order reference is a model argument whose legitimacy nothing checks (see above): the example does not stop a
  model from retrying an uncertain operation under a new reference.
- Architecture A only: no `needsApproval`, no interruptions, no `RunState`. Do not read these results as a demonstration
  of the approval bridge.
- `@openai/agents` is pinned at 0.22.0, a pre-1.0 release; upgrading it means re-running the tests. The Authority SDK
  is a local tarball, experimental and not independently reviewed.
- A tool-level `timeoutMs` on the Agents SDK side is **not** used and was not tested with this adapter: it could return a
  timeout message to the model while `guard()` is still running the effect.
- The simulated supplier is a list in memory. No real service, payment or network is involved.

## Files

| File | Role |
|---|---|
| `src/authorityTool.ts` | The adapter (`authorityTool`, `toModelResult`) |
| `src/host.ts` | The host: delegation, identity, clock, approval, revocation, fault injection |
| `src/supplier.ts` | The simulated supplier |
| `src/scripted.ts` | Runs the real Agents SDK loop with `ScriptedModel` |
| `src/scenarios.ts`, `src/demo.ts` | The scenarios as data, and the printer |
| `test/*.test.ts` | 19 tests (`node:test`) |
| `expected-output.txt` | What `npm run demo` prints |
