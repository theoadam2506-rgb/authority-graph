# D9: independent cryptographic review, proposal pack

Status: **proposal, nothing engaged, no money committed.** Authority, including Authority Proof, has not been independently reviewed. Our own tests, mutation checks and AI-assisted reviews are **internal verification**; they are never described as an audit or as independent.

This pack complements the reviewer brief [`CRYPTO_REVIEW.md`](./CRYPTO_REVIEW.md) (what to try to break, known weak points). Decisions: D9, D29 to D32 in [`DECISIONS.md`](./DECISIONS.md). Reporting policy: [`SECURITY.md`](../../SECURITY.md).

## 1. Scope and commits

Reference commit for both volets: **`dbd8c69ccfb33c05119bd7554ef8de596c8ff151`** (`main`, squash of PR #27). Before the review starts, a tag is cut from the then-current `main` and the SHA is frozen in the engagement letter; if `main` has moved only by documentation, the reviewed SHA stays `dbd8c69`.

| | Volet A (PR 3): signature, JCS, keys, formats | Volet B (PR 4): L3 replay, anchors, CLI |
|---|---|---|
| Source (about lines) | `src/proof/strictJson.ts` (237), `encoding.ts` (27), `journalHash.ts` (65), `keys.ts` (178), `attestation.ts` (302), `verify.ts` (239); uses `src/domain/canonicalJson.ts` and the dependency `json-canonicalize` | `src/proof/replay.ts` (396), `heads.ts` (71), `cli.ts` (240), `stableJson.ts` (11); calls engine validators `src/engine/replayCanonical.ts`, `src/engine/grantValidation.ts`, `src/engine/redeemCapability.ts` (read-only use) |
| Formats | `proof/attestation.schema.json`; strings `authority-attestation/v1`, `authority-journal-chain/v1`, `authority-trusted-keys/v1` | `proof/verify-report.schema.json`; `authority-trusted-heads/v1`, `authority-proof-verify-report/v1` |
| Normative text | `docs/v1/ATTESTATIONS.md` (Format, Signing input, Journal hash chain, Offline verification L0 to L2, Keys) | same file: L3, Anchors, Corroboration analysis, Replay cost; `THREATS.md`; `DECISIONS.md` D23 to D28 |
| Vectors and tests | `proof/vectors/` (attestation, negative, `expected.json`), `tests/proof/` (not the L3 files), `interop.test.ts` (OpenSSL, Python stdlib) | `expected-l3.json`, `journals/`, `trusted-heads*.json`, `tests/proof/replay.test.ts`, `cli.test.ts`, `trustedHeads.test.ts`, `scripts/bench-replay.ts` (bounds only) |
| Source size | about 1,050 lines | about 720 lines |

Out of scope for both: decision-engine semantics (SPEC I1 to I31, covered by its own suite), PostgreSQL storage, key custody, the SDK (not built), any deployment.

Order and coupling (D30): volet B consumes volet A's reader, key model and signing input, so B may be **prepared** in parallel (reviewer reads, builds a threat list) but its review is **not concluded** until Critical and High findings of A that affect L3 are fixed and re-tested.

Reproduce: `npm ci && npm test`, `npm run proof:vectors -- --check`, `npm run proof:bench:smoke`. Reviewer-facing facts: Node 20 and 22; no private key in the repository (the test key is RFC 8032 test vector 1, public by construction).

## 2. Reviewer profiles

Independence requirements (all must hold): not an author of this code; not an employee or contractor of the project; no equity, success fee, resale or prospect relationship; free to choose method and to publish the report; report delivered unedited (we may add a response).

| Profile | For | Must have | Nice to have |
|---|---|---|---|
| Applied cryptographer | A | Ed25519 / RFC 8032 including malleability and small-order keys; signature-input and domain-separation design; node:crypto / OpenSSL behaviour | prior review of JOSE, COSE, in-toto, Sigstore |
| Serialization / parser-differential specialist | A (and B's file readers) | RFC 8785 JCS edge cases, strict JSON, Unicode normalization traps, duplicate-key and number handling | fuzzing experience |
| Verification-protocol / transparency-log reviewer | A (hash chain) and B | equivocation, splicing, rollback, anchoring models; ability to judge what a result word lets a verifier conclude | CT / Sigstore Rekor / Merkle log work |
| Adversarial wording reviewer | B | reads reports, messages and exit codes as an attacker or a hurried integrator would | security-tool UX |

One person can hold the first three for A; two reviewers is better than one if budget allows. TypeScript fluency is useful, not required.

## 3. Budget scenarios

No spend is engaged. Figures are **planning estimates** to be replaced by real quotes; day rates for independent cryptographers vary widely and I cannot state them with confidence. Assumed range used below: 500 to 900 EUR per reviewer-day for an independent specialist (more for a firm, which is why Scenario 2 cannot buy a firm engagement).

| | Scenario 1: 0 to 500 EUR | Scenario 2: 1,500 to 3,000 EUR |
|---|---|---|
| What it buys | goodwill-based review: an academic or practitioner doing 1 to 2 days for an honorarium, a donation to their project, or reciprocity; and/or a time-boxed public review call on A only | 2 to 5 paid reviewer-days from an independent specialist, under a written scope |
| Realistic coverage | A, targeted: signing input, JCS and strict reader, key model. B only as a written Q&A on the anchor and report wording | A in full (about 3 days) plus B at reduced depth (about 1 to 2 days), or A with a second reviewer for 1 day |
| Independence | weaker (no contract, no obligation to finish, coverage uneven) | stronger (contract, fixed scope, publication terms, unedited report) |
| Deliverable | informal written findings, publication permission requested | formal report per section 4, publishable |
| Risks | no commitment on dates; may produce partial coverage; informal reviewers may decline to be named | scope may not fit B in full; a firm's rate would exceed the range |
| What we may then say | "reviewed by <name> on <date> for <scope>, informally, report linked"; never "audited" | "independently reviewed by <name>, scope and commit linked" if exit criteria in section 5 are met |
| Recommendation | start here for volet A questions and to find the right reviewer | choose this for the claim-bearing review; ask for A first, B after A's L3-affecting fixes |

Neither scenario supports the word "audited" unless the reviewer's own report uses it for a defined scope. Costs not included: our own fix time, re-test time (ask for 0.5 day of re-test in the quote), translation or legal review of the engagement letter.

## 4. Vulnerability report template

Reviewers may use their own format; this is the minimum we need. Findings are filed privately first (see `SECURITY.md`), then tracked as issues once fixed.

```
ID:            D9-A-001 (volet A or B, sequence)
Title:
Severity:      Critical | High | Medium | Low | Informational   (see section 5 for our definitions)
Component:     file(s), function(s), format string, normative text section
Commit:        SHA tested
Status:        reported | confirmed | fix in progress | fixed (commit) | re-tested | accepted limit | disputed

Description:   what is wrong, in two or three sentences.
Claim at risk: which documented property does this break (e.g. "a revoked-ALWAYS key is rejected", "one signing input has one meaning", "a result word never overstates").
Impact:        what a verifier would wrongly conclude, and under which attacker capability.
Reproduction:  minimal command or test; inputs attached (attestation, keys, journal, heads); expected vs observed result and exit code.
Attacker model: what the attacker controls (signer key, journal, anchor file, trusted-keys file, nothing).
Affects L3:    yes | no   (drives D30: A findings that affect L3 gate the conclusion of B)
Format change: needed? (yes means a new version string, never an in-place change)
Suggested fix:
References:    RFC sections, prior art, related CVEs.
Not examined:  what the reviewer did not look at around this finding.
```

Report front matter: reviewer name or pseudonym, independence statement (conflicts, payment arrangement), scope actually reviewed with commit SHA, method and tools, time spent, what was not examined, summary of findings by severity, and the reviewer's view on whether the documented limits are accurate.

## 5. Correction and re-verification plan

Severity as defined for this project, with actions. Delays are **targets, not promises** (one maintainer); the reviewer is told so.

| Severity | Definition | Action | Target |
|---|---|---|---|
| Critical | a document that is not a genuine attestation verifies as consistent; a REJECT becomes `CONSISTENT_*`; two meanings share one signing input | branch, fix, regression test, new vector, blocks any claim | aim 14 days |
| High | a second accepted text for one value; parser differential; a revoked-ALWAYS key accepted; wording that a verifier would rely on to an unsafe conclusion | fix, test, vector | aim 30 days |
| Medium | unbounded-cost input; ambiguous report field; check ordering with no accept path | fix or documented bound | aim 60 days |
| Low / Info | hardening, clarity | at discretion, recorded | next release |

Process for each finding: (1) acknowledge privately; (2) reproduce and assign severity, dispute with reasons if needed; (3) fix on a private branch where public disclosure would help an attacker, otherwise a normal Draft PR; (4) add a failing-then-passing test and, for format-visible behaviour, a vector in `proof/vectors/`; (5) mutation check that removing the fix makes the test fail; (6) full CI including the PostgreSQL no-skip guard and `proof:vectors --check`; (7) reviewer re-test of every Critical and High on the fixed commit; (8) published response per finding: fixed in commit X, accepted limit documented in Y, or disputed with reasons.

Format changes: frozen strings never change in place. A fix that changes bytes ships as `.../v2`, with v1 still verified or explicitly refused, and vectors for both.

Exit criteria per volet: no open Critical or High; every Medium fixed or documented as a limit with the reviewer's agreement; reviewer re-test on all Critical and High; the reviewed SHA, reviewer, date and report link written into `SECURITY.md` and `CRYPTO_REVIEW.md`. Only then may a security-guarantee claim be made, and only for the reviewed scope and commit.

Coordinated disclosure: report to us privately; indicative **90 days** (D31), adjustable by severity and fix difficulty; the reviewer may publish after the delay or earlier by agreement; no fix date is promised. Residual limits stay in every report and doc regardless of outcome: journal authenticity and completeness not established; anchor independence not verified; identity and signing instant not guaranteed; no timestamping, non-repudiation or certification; replay ceiling 10,000 events; `corroborate` deferred until after volet A.

## 6. Outreach strategy

Principles: contact people for the quality of their expertise, never for endorsement; say plainly that the project is unaudited and early; offer publication of their findings; never imply a relationship we do not have; do not send the code under pressure of a deadline; keep a log of whom we asked and why.

Sequence:
1. **Shortlist (3 to 6 names)** from public work: authors or implementers of JOSE/COSE/JCS libraries, RFC 8785 and RFC 8032 implementers, people who reviewed Sigstore/Rekor or in-toto, academic groups working on log integrity. Exclude anyone who has contributed to this repository, is a prospect or reseller, or would be paid by outcome.
2. **Short first message** (below), one per person, no attachment: scope, size (about 1,050 and 720 lines), what is asked, what is offered (publication, credit, fee or honorarium if any), the independence rules, a link to this pack. Ask first whether they have capacity and what they would charge or need.
3. **Quote request** to willing candidates: scope per volet, effort, availability, rate, publication terms, re-test day, independence statement.
4. **Choose** on expertise and independence, not price alone; sign a one-page engagement letter (scope, commit, delay, disclosure, unedited report, no endorsement language). Spend needs the owner's explicit approval first.
5. **Run A, fix, then B**; weekly written questions allowed, no coaching on conclusions.
6. **Complement** (optional, after A): a public, time-boxed review call limited to the format and verification code with written scope and a safe-reporting channel; it supplements but does not replace a named reviewer.

Where to look (examples of channels, not endorsements): maintainers of the libraries and RFC editors' public lists, academic security groups, security-engineering communities, and referrals from people who have commissioned such reviews. Referrals are preferred over cold outreach.

First message, draft:

> Subject: Request: independent review of a small Ed25519 / JCS attestation verifier (about 1,800 lines TypeScript)
>
> Hello <name>, I maintain Authority, an Apache-2.0 library that records who authorized an AI agent's action. It now emits Ed25519-signed attestations over RFC 8785 canonical JSON, and verifies them offline, including by replaying a journal. It has **not** been independently reviewed; our own tests and AI-assisted checks are not an audit. I am looking for an independent cryptographic reviewer for two small, well-bounded parts: (A) the signing input, canonicalization, key model and L0 to L2 verification, about 1,050 lines; (B) L3 replay, anchors and the CLI, about 720 lines. Findings would be published with your name or pseudonym, and the report would not be edited by me. I can offer <fee / honorarium / none> and a frozen commit, vectors, a threat list and known weak points. Would you be able to review this, or point me to someone who could? I would value a candid "no" or a quote. Details: <link to D9_REVIEW_PACK.md>.

## 7. Open points for the owner

1. Which scenario to pursue first (recommendation: Scenario 1 informal contacts for A questions in parallel with a quote request for Scenario 2; spend only after explicit approval).
2. GitHub private vulnerability reporting must be enabled in the repository settings by the owner (cannot be done from here). Until then `SECURITY.md` points to `security@authority-graph.com`, whose delivery the owner tested from an external mailbox on 2026-11-16.
3. Name, pseudonym or anonymity preferences for credits in findings.
4. A date after which, absent a reviewer, the public wording stays "not independently reviewed".
