# Proposal (not applied): a specific `UNAVAILABLE` code for the grant-evaluation limits

Status: **proposal only.** The public API is not modified by this document or by PR #45. Needs the owner's decision.

## Problem
With the operational limit of B1 (`maxWork` / `deadlineMs`, off by default) the historical grant loop stops with `GrantEvaluationLimitExceeded`.
The SDK already turns any exception into `UNAVAILABLE`, but `classify()` (`src/sdk/authority.ts`) only knows `CLOCK_INVALID`, `SCHEMA_NOT_READY` and the
connection codes, so the caller receives `code: "BACKEND_ERROR"`: a time-out of Authority's own computation is reported as a store failure. The cause
(`GRANT_EVALUATION_WORK_LIMIT` / `GRANT_EVALUATION_DEADLINE`) is visible to the operator only, through `onDiagnostic`.

## Proposed change (for a later PR, after approval)
Add one member to `UnavailableCode` (`src/sdk/types.ts`): **`"EVALUATION_LIMIT"`** — *"Authority stopped a computation that exceeded an operator-configured limit; nothing was decided and nothing was written beyond the request already being recorded."*
* `classify(cause)`: `cause instanceof GrantEvaluationLimitExceeded` → `"EVALUATION_LIMIT"`. The class is checked by `instanceof` (never by message), then by its fixed `code` field ∈ {`GRANT_EVALUATION_WORK_LIMIT`, `GRANT_EVALUATION_DEADLINE`}; any other thrown value keeps today's mapping. A hostile `code` getter stays contained by the existing `try/catch` (→ `INTERNAL_ERROR`).
* The public result still carries only `{ status: "UNAVAILABLE", code, diagnosticId }`: **no counts, no limit values, no grant numbers** (they would reveal journal size). The two precise causes stay in `Diagnostic.cause`.
* `Diagnostic.code` widens with the same member (it is `UnavailableCode | UncertainCode | "EFFECT_THREW"`).
* Naming alternatives considered: `GRANT_EVALUATION_LIMIT` (more specific, ties the public API to B1's vocabulary), `COMPUTE_LIMIT` (generic, reusable for future limits). `EVALUATION_LIMIT` is proposed as the generic, non-leaking middle.

## Compatibility
* **Wire/JSON:** a new string value of an existing field; producers are unaffected.
* **TypeScript consumers:** `UnavailableCode` is an exported string union. A consumer with an exhaustive `switch` + `never` check stops compiling until it handles the new member; a consumer with a `default` branch is unaffected. This is a **source-breaking change for exhaustive switches**, so it belongs in a minor version only if the project's compatibility policy treats union widening as non-breaking; otherwise a major. The owner decides the policy.
* **Semantics:** `UNAVAILABLE` already means "retrying `authorize` is safe"; for this code a retry is only useful after the operator lifted or raised the limit or the journal shrank — documented, not enforced.
* **Documentation:** `docs/v1/SDK.md` (the list of `UNAVAILABLE` codes), `docs/v1/B1_EQUIVALENCE.md` §6.
* **Package check:** `scripts/check-sdk-package.mjs` exports/type surface expectations updated in the same PR.

## Tests needed
1. `classify` unit: the limit exception (both codes) → `EVALUATION_LIMIT`; a plain `Error` with `code: "GRANT_EVALUATION_WORK_LIMIT"` (spoof) → **not** mapped (instanceof required); a throwing-getter error → `INTERNAL_ERROR`.
2. SDK: `tests/sdk/b1BoundedFallback.test.ts` expects `code: "EVALUATION_LIMIT"` for both limits; no leak of counts/limits (`JSON.stringify`, `util.inspect`, deep walk, `structuredClone`: same harness as `diagnostics.test.ts`).
3. Journal: no refusal / grant event written by the failed call (already tested); retry succeeds once the limit is lifted.
4. Type-level: a compile-time test that an exhaustive switch over `UnavailableCode` requires the new member (`tests/sdk/*.type-guards.ts` style).
5. `surface.test.ts` / package check: the public type surface changed exactly by this member.
6. Docs example in `SDK.md` compiled by the package check (`sdk:package:check`).
