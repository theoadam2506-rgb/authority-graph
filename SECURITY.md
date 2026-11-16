# Security policy

Authority reconstructs who authorized an agent's action from an ordered event
history. A flaw that lets an action be reported `AUTHORIZED` when it should
not be, lets a budget or approval be consumed by the wrong action, or lets
history change a past decision is a security issue for anyone relying on
that answer.

## Do not report exploitable vulnerabilities in public

Do not open a public issue, pull request or discussion for a vulnerability
that is exploitable and not yet fixed. Report it privately instead:

1. **GitHub private vulnerability reporting (primary channel).** Where it is
   enabled for this repository, the **Security** tab shows a **Report a
   vulnerability** button. Use it. If the button is not there, private
   reporting is not enabled yet: use the fallback below.
2. **Fallback while private reporting is not enabled.** Open a public issue
   titled "Security contact request" that contains **no technical detail**
   (no description of the flaw, no reproduction, no affected component). The
   maintainer will reply there to arrange a private channel. No email address
   is published as a security channel because none is confirmed to be
   monitored.

## What to include

- **Description**: what is wrong, in one or two sentences.
- **Impact**: what a caller relying on Authority's answer would wrongly
  conclude, or what an attacker could make it conclude.
- **Reproducible scenario**: the minimal ordered event sequence (or a failing
  test) and the query that exposes the problem, with the expected and the
  observed result.
- **Version**: the commit SHA you tested. The project has no releases; only
  the current `main` branch is supported.
- **Proposed fix**, if you have one.

## What happens next

You will get an acknowledgement as soon as reasonably possible. This is a
small project maintained by one person, so no fixed response time is
promised. Once the issue is confirmed, the fix and its regression test are
developed privately where needed, then merged publicly. With your
agreement, you are credited by name in the fix's commit or pull request.

There is no bug bounty and no financial reward.

### Coordinated disclosure

We ask reporters to keep a confirmed, unfixed vulnerability private while it
is being fixed. The **indicative** disclosure delay is **90 days** from the
report. It is a target, not a promise: it can be shorter when the issue is
fixed and verified earlier, or when it is already public, and longer or
shorter by agreement depending on severity and on how hard a fix is for a
single maintainer. We do not promise a fix date. A reporter who wants to
publish sooner, or who sees no progress after 90 days, may publish; we ask
for a heads-up so the documentation can state the limit at the same time.

## Review status

Authority, including Authority Proof (attestations, `authority proof
verify`), has **not been independently reviewed or audited**. Our own tests,
mutation checks and AI-assisted reviews are internal verification, not an
audit. An independent cryptographic review is planned (decision D9,
[`docs/v1/D9_REVIEW_PACK.md`](./docs/v1/D9_REVIEW_PACK.md)); until it is
done and its findings are resolved or published, nothing here should be read
as a security guarantee. If a review is completed, this section will name the
reviewer, the commit reviewed and the date, and link the report.

## What can be discussed in public

Theoretical scenarios, questions about whether a behavior is intended, and
counterexamples that do not describe an unfixed exploitable flaw are welcome
in public: see [`CONTRIBUTING.md`](./CONTRIBUTING.md). If you are unsure
which side of that line a report falls on, report it privately first.

## Scope

In scope: the engine and its storage backends in this repository, **Authority
Proof** (`src/proof/`, the formats in
[`docs/v1/ATTESTATIONS.md`](./docs/v1/ATTESTATIONS.md), the `authority proof`
commands, the published vectors), and any divergence between their behavior and [`SPEC.md`](./SPEC.md),
[`EVENT_MODEL.md`](./EVENT_MODEL.md) or [`THREAT_MODEL.md`](./THREAT_MODEL.md).

Already documented as out of V0 scope, and therefore not vulnerabilities in
themselves: the absence of signatures and verified identity (every event is
`ASSERTED_UNVERIFIED`), compromise of the event store outside the ingestion
API, and the other items listed in
[`THREAT_MODEL.md`, "Attacks out of V0 scope"](./THREAT_MODEL.md#attacks-out-of-v0-scope-documented-not-addressed)
and [`README.md`, "What it doesn't do"](./README.md#what-it-doesnt-do).
A report showing that one of these limits has consequences the
documentation does not describe is in scope.

Also documented, and not vulnerabilities in themselves, for Authority Proof:
the journal's authenticity and completeness are not established by L3; the
independence of a trusted anchor is not verified; a key identifier names a key,
not a person; the signing instant is the signer's claim; there is no
timestamping, non-repudiation or certification. A report showing that a result
word, flag or message **overstates** one of these is in scope and welcome:
for example a `CONSISTENT_*` result for a document that should be rejected,
two meanings for one signing input, or a second accepted text for one value.
