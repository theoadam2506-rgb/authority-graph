# Security policy

Authority reconstructs who authorized an agent's action from an ordered event
history. A flaw that lets an action be reported `AUTHORIZED` when it should
not be, lets a budget or approval be consumed by the wrong action, or lets
history change a past decision is a security issue for anyone relying on
that answer.

## Do not report exploitable vulnerabilities in public

Do not open a public issue, pull request or discussion for a vulnerability
that is exploitable and not yet fixed. Report it privately instead:

1. **GitHub private vulnerability reporting (preferred).** If it is enabled
   for this repository, the **Security** tab shows a **Report a
   vulnerability** button. Use it.
2. **Email.** Otherwise, write to `security@authority-graph.com`.

## What to include

- **Description**: what is wrong, in one or two sentences.
- **Impact**: what a caller relying on Authority's answer would wrongly
  conclude, or what an attacker could make it conclude.
- **Reproducible scenario**: the minimal ordered event sequence (or a failing
  test) and the query that exposes the problem, with the expected and the
  observed result.
- **Version**: the commit SHA you tested. The project is V0 and has no
  releases; only the current `main` branch is supported.
- **Proposed fix**, if you have one.

## What happens next

You will get an acknowledgement as soon as reasonably possible. This is a
small project maintained by one person, so no fixed response time is
promised. Once the issue is confirmed, the fix and its regression test are
developed privately where needed, then merged publicly. With your
agreement, you are credited by name in the fix's commit or pull request.

There is no bug bounty and no financial reward.

## What can be discussed in public

Theoretical scenarios, questions about whether a behavior is intended, and
counterexamples that do not describe an unfixed exploitable flaw are welcome
in public: see [`CONTRIBUTING.md`](./CONTRIBUTING.md). If you are unsure
which side of that line a report falls on, report it privately first.

## Scope

In scope: the engine and its storage backends in this repository, and any
divergence between their behavior and [`SPEC.md`](./SPEC.md),
[`EVENT_MODEL.md`](./EVENT_MODEL.md) or [`THREAT_MODEL.md`](./THREAT_MODEL.md).

Already documented as out of V0 scope, and therefore not vulnerabilities in
themselves: the absence of signatures and verified identity (every event is
`ASSERTED_UNVERIFIED`), compromise of the event store outside the ingestion
API, and the other items listed in
[`THREAT_MODEL.md`, "Attacks out of V0 scope"](./THREAT_MODEL.md#attacks-out-of-v0-scope-documented-not-addressed)
and [`README.md`, "What it doesn't do"](./README.md#what-it-doesnt-do).
A report showing that one of these limits has consequences the
documentation does not describe is in scope.
