# Authority Conformance Lab V0

A reproducible, local check of whether an authorization system gives the same
allow/deny answers as the Authority engine on two delegation scenarios.

**What it is.** A command that (1) replays a declarative scenario through the
existing engine (`authorityAt`) to get the *expected* decision, (2) asks a
target system the same question over HTTP, (3) compares, and (4) writes a
deterministic JSON report with the evidence.

**What it is not.** Not a security audit of any product, not a certification,
not a claim of conformance to WIMSE or any other standard, not a vulnerability
scanner. A FAIL against a *simulated* target is the lab working as designed,
never a vulnerability in a real system.

## Scenarios (`conformance/scenarios/`)

| Id | Question | Probes |
|---|---|---|
| `revocation-after-valid-grant` | After a valid delegation is revoked, are later attempts refused? | before revocation (allow), at the revocation instant (deny), after (deny) |
| `excessive-delegation-escalation` | Can a sub-agent exceed what its delegator could do? | within limits (allow), amount above the delegator's ceiling (deny), capability the delegator never held (deny) |

Each scenario file states its assumptions (time model, exact capability
match, no expiry), the expected policy, the denial conditions and its limits.
The file contains **no expected result**: it is computed by the engine, so the
expectation cannot drift from the engine's semantics. Temporal model: the
authority time of every event and question is explicit in the file; a
revocation takes effect for every question that sees it in the log.

Engine semantics worth knowing (observed, see the report evidence): a
sub-delegation that exceeds its parent (higher limit or extra capability)
confers *no* authority at all, it is not narrowed to the intersection. The
probes were chosen so that a target that narrows instead of rejecting still
passes; the lab does not probe that difference.

## Decision mapping

| Engine outcome | Compared as |
|---|---|
| `AUTHORIZED` | `ALLOW` |
| `DENIED` | `DENY` |
| `REQUIRES_APPROVAL`, `UNKNOWN` | not comparable, probe is `INCONCLUSIVE` |

A target that is unreachable, answers with an HTTP error, a malformed body, or
an undefined policy decision yields `INCONCLUSIVE`, never `FAIL`.
`PASS` / `FAIL` is only issued when both sides produced a clean allow/deny.
Scenario and overall result: any FAIL gives FAIL; otherwise any INCONCLUSIVE
gives INCONCLUSIVE; otherwise PASS.

## Reproduce

Requirements: Node >= 20 (22 recommended, tested on 22), `npm ci`. No database, no
network, no API key for the simulated targets.

```bash
npm ci
```

Simulated targets (in-process, written by this project; no real product involved):

```bash
npm run conformance -- --target simulated:compliant            # expect PASS, exit 0
npm run conformance -- --target simulated:faulty-revocation    # expect FAIL on the revocation scenario, exit 1
npm run conformance -- --target simulated:faulty-delegation    # expect FAIL on the excessive-delegation scenario, exit 1
```

Real target: Open Policy Agent, queried over its HTTP API. Download an OPA
binary yourself (the lab was run with v1.4.2, Linux amd64; any platform
works) from https://github.com/open-policy-agent/opa/releases and pass its
path:

```bash
npm run conformance -- --target opa --opa-bin /path/to/opa --out report.json
```

The lab starts `opa run --server` on an ephemeral localhost port, loads
`conformance/opa/policy.rego`, queries `POST /v1/data/authority_conformance/decision`,
and stops OPA afterwards. To use an OPA server you started yourself (load the
same policy), pass `--opa-url http://127.0.0.1:8181` instead; the report then
says that OPA's version and loaded policy are not verified by the lab.

```bash
opa run --server --addr 127.0.0.1:8181 conformance/opa/policy.rego &
npm run conformance -- --target opa --opa-url http://127.0.0.1:8181 --out report.json
```

Exit codes: `0` all PASS, `1` at least one FAIL, `2` no FAIL but some
INCONCLUSIVE, `64` usage or scenario error.

Tests (`OPA_BIN` is optional; without it the two real-OPA tests are skipped
and reported as skipped):

```bash
npm test
OPA_BIN=/path/to/opa npm test
```

## About the OPA run

`conformance/opa/policy.rego` was **written by the Authority Graph project** to
express these two scenarios. A PASS means: a real OPA process running *our*
policy returns the same allow/deny as the engine on these six probes. It is not
an independent validation of OPA, not an assessment of any production policy,
and OPA itself is not shown to be secure or insecure by it. The mutation test
(`OPA_BIN=... npm test`) removes the revocation rule from the policy and checks
that the lab then reports FAIL on real OPA, showing that the checks can fail.

## Report (`authority-conformance-report/v0`)

Keys are sorted, there are no timestamps or random ids: same scenarios and same
target answers give identical bytes. Top level: `report_version`, `reference`,
`target` (`kind`: `simulated` or `real-system`, name, details such as OPA
version and policy sha256), `summary`, `scenarios[]`, `limits[]`.
Each scenario: `scenario_id`, `config`, `assumptions`, `expected_policy`,
`denial_conditions`, `result`, `probes[]`, `limits`, `scenario_sha256`.
Each probe: `question`, `expected` (decision, engine decision with reason code),
`observed`, `result`, `diff`, `evidence` (request sent, HTTP status, raw
response body). Examples: `conformance/examples/`.

## Known limits

- The reference is the Authority engine on scenarios written by this project; it is a consistent reference, not independent ground truth.
- Only the listed probes are compared; PASS says nothing about other inputs.
- The target is handed a neutral log prefix and decides itself; how it would ingest the same facts through its own production integration is not tested.
- No concurrency, propagation latency, approvals, expiry or deep chains.
- Events are asserted and unauthenticated; no cryptography is involved.
