# Authority Graph with the OpenAI Agents SDK: architectures A and B (experimental)

> **Status: experimental, not published to npm, not independently reviewed.** Do not use it for real payments or
> sensitive production actions. No security guarantee is claimed, and nothing here guarantees that an external effect
> happens exactly once.

This example puts `authority.guard()` in front of one external effect, a simulated supplier order, inside the
`execute` of an [OpenAI Agents SDK](https://github.com/openai/openai-agents-js) function tool. The model is
**scripted** (`ScriptedModel`): no API key, no network, no call to OpenAI. The **store, the reviewer tokens and the order
registry are simulations**: nothing here is a production deployment.

## What this is, and what it is not

Two architectures live here. They are kept apart, and A keeps working unchanged.

- **Architecture A** (`npm run demo`): the thinnest layer. The tool calls `authority.guard()`, which authorizes, redeems a
  single-use ticket, runs the effect only if redemption succeeded, and reports. There is **no native pause and resume**:
  the tool sets no `needsApproval`, the run is never interrupted, and the human's decision is recorded by the host outside
  the Agents SDK, between two runs.
- **Architecture B** (`npm run demo:b`), experimental: the Agents SDK's native approvals (`needsApproval`, `interruptions`,
  `RunState`, `state.approve`, `state.reject`) are bridged to Authority by a **host-side coordinator**. The run pauses for a
  human, the reviewer is authenticated, the decision is recorded in Authority and checked, and the run resumes.

**The rule that holds in both:** the effect is decided by `authority.guard()` in the tool's `execute`, and by nothing else.
In B, `needsApproval` is only the mechanism that **pauses** the run so that a human can be asked. It is **not** an
authorization and it is not sufficient: a wrong, missing or sticky (`alwaysApprove`) SDK approval cannot make the effect run,
because `guard()` asks Authority again and refuses (scenarios B5a and B5b show it).

**B is not a production design.** In particular: the store is in memory, the reviewer authentication is a simulated
token map, snapshots are strings in memory, atomic transitions are only atomic in one event loop, the Authority journal is
in memory, and the order registry is a list. See "What a real deployment still needs" below.

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
npm test                   # 73 tests (A and B)
npm run demo               # architecture A scenarios; compare with expected-output.txt
npm run demo:b             # architecture B scenarios; compare with expected-output-b.txt
```

No environment variable is needed. `expected-output.txt` and `expected-output-b.txt` are what `npm run demo` and
`npm run demo:b` print, identically on every run (a fixed clock, deterministic ids, nothing random printed); tests enforce
them.

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
  **business reference**, never from the model's tool-call id (see below). **In architecture A that reference, `orderRef`,
  is one of the model's own arguments**: zod validates its format, not its legitimacy, and nothing ties it to an order
  the host registered. Architecture B adds an order registry (see "Where the order reference comes from").
- `buildAuthorityTool` also returns `describeInterruption`, and accepts `precheck` and `approval: "authority"` (architecture B).
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

## Architecture B: native approvals bridged to Authority (experimental)

```
 model ─tool call─▶ Agents SDK ─needsApproval─▶ precheck (registry) ─▶ authorize()
                       │                                   ├ REQUIRES_APPROVAL ─▶ true ─▶ run PAUSES (interruptions + RunState)
                       │                                   └ otherwise ─▶ false ─▶ execute ─▶ guard() (refuses, or runs the effect)
                       ▼
        coordinator.start(): for each interruption
          · describeInterruption(): re-parse the arguments with the schema, rebuild the Authority call, take the SDK's callId
          · authorize(call) must still say REQUIRES_APPROVAL, else the interruption is rejected at once (fail closed)
          · store (server side): the call, the summary, the callId, the serialized RunState; status PENDING
                       │
 reviewer ─credential─▶ coordinator.decide(approvalId, approve | reject, credential)
          1. authenticate (simulated tokens) FIRST      → NOT_AUTHENTICATED, the same answer for any id: nothing is revealed
          2. validate the decision (exact "approve" / "reject") → INVALID_DECISION, nothing claimed
          3. look the approval up; the HOST authorizes this reviewer for it → NOT_AUTHORIZED_FOR_THIS_APPROVAL
          4. claim PENDING → DECIDING with a CLAIM TOKEN that records the INTENT and the reviewer → ALREADY_DECIDED for any other decision
          5. authorize(server's copy of the call)       → UNAVAILABLE (claim released: nothing was decided),
                                                          NO_LONGER_WAITING (revoked, denied: VOID), or already AUTHORIZED
          6. write the intent to Authority and CHECK outcomes[].accepted
                                                        → refused by Authority: claim released (nothing recorded)
                                                        → outcome UNKNOWN: held DECIDING (NOT released): DECISION_UNCERTAIN
          7. persist DECIDING → APPROVED | REJECTED, presenting the claim token → PERSISTENCE_FAILED: held DECIDING
                       │
          held DECIDING: only an explicit operator action, completeStuckDecision(), moves it, with the SAME intent and reviewer
                       │
 coordinator.resume(runId): compare-and-set WAITING → RESUMING; rebuild the agent; RunState.fromString;
          for each interruption: compare the snapshot with the server's record, then state.approve / state.reject
          (never `alwaysApprove`); run; FINISHED, or FAILED (the effect MAY have run), or paused again
```

What the coordinator takes from a reviewer: an approval id, a decision and a credential. The arguments, the action id, the call
id and the snapshot come from the coordinator's own store, never from the request.

**Order of the Authority writes.** `needsApproval` asks Authority first (`ACTION_REQUESTED`), then the human decides, then the
approval is written. An approval recorded *before* the action exists does not count (Authority binds it to the action
instance), which the order above respects. `record()` answers `RECORDED` even when an outcome is refused, so every write is
checked (`recordChecked`, `outcomes[].accepted`); a refused attempt can still leave an `APPROVAL_REQUESTED` in the journal.

### The order registry (`OrderRegistry`)

In B the host registers the orders (`InMemoryOrderRegistry.register`, never called by the model). The tool refuses, **before
Authority is asked**, a reference that was never registered (`UNREGISTERED_ORDER_REFERENCE`) and arguments that differ from the
registration (`ORDER_DOES_NOT_MATCH_REGISTRATION`): nothing is journaled and no human is asked. A model can therefore no longer
invent a reference to retry an uncertain operation (scenario B8).

It does **not** know that two orders the host itself registered are the same purchase. If the host registers `ORDER-7B` for a
purchase that `ORDER-7` may already have placed, both run, the target receives two requests with two different idempotency
keys, and nothing prevents the duplicate. That is the host's responsibility, and the target's.

### Scenarios (B1 to B10, `src/bridgeScenarios.ts`, `test/bridge.test.ts`)

| # | Scenario | What is shown |
|---|---|---|
| B1 | Approval, interruption, resume, execution | The run pauses with the supplier untouched; an authenticated decision; the resume runs the effect once |
| B2 | A human rejects | No effect; the refusal is journaled; a refusal is not terminal in Authority: asking again needs a human again |
| B3 | Revocation during the wait | Revoked before the decision: the decision is not applied (`NO_LONGER_WAITING`). Revoked after: `C12_DELEGATION_REVOKED` at resume. The supplier is never called. |
| B4 | Who may decide | No credential or an unknown token: `NOT_AUTHENTICATED`, the same answer for a real and an unknown id. An authenticated reviewer the host does not authorize for the approval (`mallory`, the agent): refused by the host before anything is claimed or written. An invalid decision value is refused. With a deliberately MISCONFIGURED host that lets everyone decide, **Authority** still refuses the non-grantor and the claim is released |
| B5 | Authority and the OpenAI state disagree | SDK approved, Authority not told: `APPROVAL_REQUIRED`. Sticky `alwaysApprove`: the SDK stops asking, `guard()` still refuses the next order. Authority already holds the approval while the run is paused: the decision completes it |
| B6 | Double decision, double resume | One passes the compare-and-set; the effect runs once |
| B7 | A tampered snapshot or record | The coordinator compares what it reads with its own record; the SDK also refuses an approved invocation whose arguments changed (tested separately) |
| B8 | The order registry | Invented reference, changed arguments, the same reference after an uncertain result: refused. A second order the host registers: **not** prevented |
| B9 | Failure windows | See below (B9a to B9g) |
| B10 | A human rejection and a late concurrent decision | The late approve cannot take the claim; the operator completes the SAME intent (reject); the original slow writer is fenced; no approval is ever written; the rejected order needs a human again |

### Failure windows between the Authority write, the coordinator's persistence and the OpenAI resume

| Window | What happens | Why it is safe, and what is left |
|---|---|---|
| Authority wrote the decision, the coordinator could not persist it (B9a) | The approval stays `DECIDING` with its intent; a resume is refused; the OPPOSITE decision is refused (`ALREADY_DECIDED`); the operator's `completeStuckDecision()` applies the SAME intent and the decision completes without a second write | Nothing runs from an unpersisted decision, and a different decision can never follow. Completion is explicit: no lease exists to tell a slow worker from a dead one |
| An Authority write whose outcome is unknown (window 1b) | `DECISION_UNCERTAIN`; the approval is held `DECIDING`, **not** released | Releasing it would let a rejection follow an approval that may already be in the journal |
| Authority refuses the write explicitly (a non-grantor, with a misconfigured host) | The claim is released: nothing was recorded | A reviewer who may decide can still do so |
| Authority unreachable during the binding check (B9g) | `UNAVAILABLE`; the claim is released, the approval stays `PENDING` | A transient outage never costs the reviewer's decision. A definite refusal (revoked, denied) is `VOID` |
| A decision still in flight while another is attempted (B10) | The late decision is refused; the original writer is fenced by the claim token if an operator completed the decision meanwhile | The original writer's Authority write cannot be cancelled: it may still land a duplicate of the SAME intent (see "What cannot be established") |
| Decision persisted, process restarts before the resume (B9b) | The rebuilt coordinator resumes from the stored snapshot, once | The restart is simulated: the Authority journal here is in memory |
| A restart, then a new run (B9e) | Ids are unguessable (`randomUUID`) and the store refuses an existing id: nothing is overwritten | A deterministic generator is injected only by the demo and the tests, and its counters live in the kit, across restarts |
| The effect ran, then the next model call failed during the resume (B9c) | `FAILED`; the effect ran; `retryResume` does not rerun it, and the model is told that the order was **already processed** | A retry after a successful effect must not read as a failure |
| The effect ran, the journal write failed, the coordinator crashed before `FINISHED` (B9d) | The replay of the same snapshot is `ALREADY_REDEEMED`; the supplier holds one order | The journal has `CAPABILITY_REDEEMED` and no `ACTION_EXECUTED`: that state has no status of its own |
| The process dies in the middle of a resume (B9f) | The run stays `RESUMING`: `resume` and `retryResume` are refused. The operator's `recoverStuckRun()` marks it `FAILED`; a slow original resume can no longer finish it (resume token) | It never assumes that the effect did not run: the retry goes through `guard()` again, which refuses a second execution |

### Guarantees demonstrated by the tests, and what cannot be established

**Demonstrated (tests in `test/bridge.test.ts`, each killed by a mutation of the code it covers):**

- A human rejection cannot be bypassed by a concurrent or late decision on the same approval, and no approval is ever
  written for a rejected decision; asking again for the rejected order pauses for a human again.
- One decision, one intent, one reviewer per approval; a stale finisher cannot move a record it no longer owns (claim token);
  a resume that was recovered cannot finish the run, even while a retry is in flight (resume token).
- Ids are never reused after a restart, the store never overwrites, and a reviewer who saw one approval id decides that
  approval's action and no other.
- The reviewer is authenticated before anything is looked up, authorized by the host before anything is claimed, and
  accepted by Authority; every Authority write is checked.
- No stuck decision or stuck run is ever released automatically, and no recovery assumes that an effect did not happen.
- The effect still runs only through `authority.guard()`.

**Cannot be established in this architecture (stated, not hidden):**

- **An Authority write that is already in flight cannot be cancelled**, and Authority offers no conditional write on the
  coordinator's claim. After `completeStuckDecision`, the original writer may still land. Its write has the same intent, so it
  cannot conflict, but this example cannot prevent the duplicate (the journal then holds two refusals, or two approvals).
- **A completion re-applies an OLD intent.** `completeStuckDecision` refuses (`SUPERSEDED`) when the journal holds, after the
  claim, a decision for the same action that contradicts the intent (for example a refusal recorded out of band by the
  grantor while an approval was stuck). It cannot close the gap between that check and the write that follows, nor see a
  decision recorded somewhere Authority does not know. `completeStuckDecision` and `recoverStuckRun` are operator actions:
  restrict them to operators; this example does not authenticate their caller.
- **There is no lease and no clock**: a slow decision cannot be told from a dead one. That is why recovery is an explicit
  operator action. An automatic, time-based recovery is deliberately NOT provided: it would reopen the window above.
- **Authority approvals are per action; decisions here are per interruption.** Two interruptions for the same action can
  be decided differently by two reviewers (one rejects, one approves); the action then stays authorized. That is a human
  decision, not a bypass, but it is not prevented.
- **A rejection does not revoke an approval that already exists in Authority**; a `reject` while Authority already authorizes
  the order is refused (`ALREADY_AUTHORIZED`) rather than recorded.
- **Everything is in memory and single-process.** The compare-and-set is atomic only inside one event loop; multi-process
  safety needs a transactional store and leases, which would still not make the Authority write conditional.

### What a real deployment still needs

None of the following is provided here, and none of it is optional for real use:

- **Durable storage.** The coordinator's store and the Authority journal survive a restart only in a database. Use the
  PostgreSQL backend for the journal and a transactional store for approvals and snapshots; every transition becomes an
  atomic conditional update. An in-memory journal loses the approvals and everything asks a human again (fail closed).
- **Authentication and authorization of reviewers.** The simulated token map has no expiry, signature, revocation or
  transport security. A real application takes the reviewer from its authenticated session, never from the request body, and
  implements `authorizeReviewer` against its own rules (here: only the grantor). Authority only checks that the asserted
  approver is the delegation's grantor: it authenticates nobody.
- **Snapshot security.** A serialized `RunState` holds tool arguments, approval decisions and application context, and
  `RunState.fromString` does not authenticate it. Keep it server side, verify its integrity, bind it to the run and the user,
  and treat displayed arguments as untrusted content.
- **Concurrency across processes.** The compare-and-set here is atomic in one event loop only. Several processes need real
  transactions, and leases plus a recovery policy for claims and resumes that never finish (this example offers only the
  explicit operator actions `completeStuckDecision` and `recoverStuckRun`). A lease still cannot make the Authority write
  conditional on the claim: see "What cannot be established".
- **Idempotency at the target.** `idempotencyKey` is the ticket id and changes with a new action. After an uncertain result
  only the target can say what happened, and only the target can deduplicate. No exactly-once guarantee exists anywhere here.
- **A real order registry** (the application's order table, with its own authorization), rate limiting, audit, and the
  operational monitoring of `FAILED` resumes and stuck decisions.
- Not covered: approvals of nested agents (`agent.asTool()`), hosted or MCP tools, streaming runs, handoffs, B2 (issuing the
  ticket at decision time).

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

## Where the order reference comes from

Two different things must not be confused:

| | Comes from | Protected? |
|---|---|---|
| `agentId`, `delegationId` | The **host**, given when the tool is built | Yes: the model cannot change them (a test checks it) |
| `orderRef`, which becomes the Authority action id | **Architecture A:** the model's own arguments. **Architecture B:** the model's arguments **checked against the host's order registry** | A: **No**. B: only for references the host did not register |

`orderRef` is validated by zod as a non-empty string of at most 64 characters: a format check, not a legitimacy check.

- **Architecture A** has no registry: the model can invent a reference that was never registered, and the order runs if the
  delegation allows it (a test shows this), and it can use a **new** reference to retry an uncertain operation (scenario 7b).
- **Architecture B** adds the registry (see above): an invented reference or changed arguments are refused before Authority is
  asked. It does not protect against a second order that the host itself registers for the same purchase.
- In both, Authority never sees that two references are the same purchase.

In a real application the host must issue the order reference itself (or check it against an order it recorded) before calling
the tool, bind it to the order's arguments, and refuse new references for the retry of an operation that may already have
happened.

## What the host must provide

Authority does not provide, and this example only simulates:

- **Identity.** `agentId`, `delegationId` and the human (`alice`) are asserted by host code. Anyone who can call the SDK
  as `alice` can approve. Authority authenticates nobody.
- **The clock.** A fixed one here.
- **The business reference of each order, and its legitimacy.** Architecture A: the model writes it and only its format is
  checked. Architecture B: a registry the host fills, in memory. A real host issues the reference or binds it to an order in
  its own table, and prevents arbitrary new references from being used to retry an uncertain operation.
- **Recording the human's decision.** Architecture A: outside the Agents SDK. Architecture B: by the coordinator, with a simulated authenticator.
- **A trusted, durable journal.** The in-memory backend is lost with the process. The journal is trusted, not
  authenticated, and its completeness is not established.
- **Deduplication and confirmation at the target.** No exactly-once guarantee exists anywhere in this example.

## Limits

- **Architecture B is experimental and simulated where it matters**: in-memory store and journal, simulated token
  authentication, in-memory registry, compare-and-set atomic in one event loop only. See "What a real deployment still needs".
- Architecture A is unchanged: it has no pause and no registry. Do not read A's results as a demonstration of B.
- B does not implement B2: the ticket is issued at the resume, not at the decision, so a long wait does not consume the
  ticket's lifetime. The re-check at redemption therefore covers only the short gap inside `guard()`.
- The order registry cannot know that two orders the host registered are the same purchase.
- `@openai/agents` is pinned at 0.22.0, a pre-1.0 release; upgrading it means re-running the tests. The Authority SDK
  is a local tarball, experimental and not independently reviewed.
- A tool-level `timeoutMs` on the Agents SDK side is **not** used and was not tested with this adapter: it could return a
  timeout message to the model while `guard()` is still running the effect.
- Approvals of nested agents (`agent.asTool()`), hosted or MCP tools, streaming runs and handoffs are not covered.
- The simulated supplier is a list in memory. No real service, payment or network is involved.
- No exactly-once guarantee. Identity and the clock come from the host, the journal is trusted and not authenticated, and
  nothing here has been independently reviewed.

## Files

| File | Role |
|---|---|
| `src/authorityTool.ts` | The adapter (`authorityTool`, `buildAuthorityTool`, `toModelResult`, `describeInterruption`) |
| `src/host.ts` | The host: delegation, identity, clock, recorder (checked writes), revocation, fault injection |
| `src/supplier.ts` | The simulated supplier |
| `src/scripted.ts` | Runs the real Agents SDK loop with `ScriptedModel` |
| `src/scenarios.ts`, `src/demo.ts` | Architecture A scenarios as data, and the printer |
| `src/approval.ts` | Architecture B: the coordinator, the store (in memory), the simulated authenticator |
| `src/orderRegistry.ts` | Architecture B: the minimal order registry and its precheck |
| `src/bridgeKit.ts` | Shared setup for B: host, registry, coordinator, scripted agents, restart simulation, faulty store |
| `src/bridgeScenarios.ts`, `src/demoBridge.ts` | Architecture B scenarios B1 to B10, and the printer |
| `test/adapter.test.ts`, `test/scenarios.test.ts` | Architecture A and adapter tests |
| `test/bridge.test.ts`, `test/bridgeScenarios.test.ts` | Architecture B tests (adversarial, failure windows, registry) and the demo pin |
| `expected-output-b.txt` | What `npm run demo:b` prints |
| `expected-output.txt` | What `npm run demo` prints |
