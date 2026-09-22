# EVENT_MODEL: authority-graph

## Common envelope

Every event, whatever its type, carries the following envelope. Envelope
fields are never optional. Their absence makes the event invalid at
ingestion (rejection, not a default value; see I1).

| Field | Type | Assigned by | Description |
|---|---|---|---|
| `event_id` | opaque identifier (UUID) | the source | Idempotency key (I8). |
| `event_type` | enum | the source | One of the 9 types listed below. |
| `occurred_at` | ISO 8601 timestamp | the source | Declarative, untrusted, never decision-enforcing (I4). Kept for audit; flagged if it drifts too far from `authority_time`. |
| `recorded_at` | ISO 8601 timestamp | Authority, at ingestion | Infrastructure clock at the moment the store saw the event. Operational diagnostic only, never decision-enforcing. |
| `authority_time` | ISO 8601 timestamp | Authority, at ingestion | Decision-enforcing clock, guaranteed non-decreasing with respect to `sequence`. The only clock used to evaluate `expires_at` (I4). |
| `sequence` | strictly increasing integer | Authority, at ingestion | Causal order only. Assigned atomically at append, never recomputed. The only order used to determine the graph's state "at instant T" and for I7 (I4, I3). |
| `principal_id` | opaque identifier | the source | The principal issuing the event. Opaque, with no PII (I11). This is the field, and the only one, checked against issuance-right verifications (I12, I13, I14). |
| `assurance_level` | enum, single value in V0 | Authority, at ingestion | Always `ASSERTED_UNVERIFIED` in V0 (I17): no signature, no cryptographically verified identity. A reminder that `principal_id` is a transport-level assertion, not proof. |
| `payload` | object typed by `event_type` | the source | See sections below. No untyped free-form field. |

## Semantics of authority_time / sequence / occurred_at / recorded_at

- **`sequence`** answers "which event comes before which." A single
  counter, strictly monotonic, assigned atomically by Authority at append,
  independent of any clock. This is the canonical causal order: it
  determines which events are visible for a given evaluation, and from
  when a revocation (I7) or a consumption (I16) takes effect.
- **`authority_time`** answers "is a delegation expired now." It is a
  clock, not an order: Authority assigns it at ingestion, guaranteeing it
  never decreases as `sequence` increases (if the system clock moved
  backward, `authority_time` would stay equal to the previous value rather
  than moving backward). It is the only quantity compared against
  `expires_at`. It is never supplied by the source.
- **`occurred_at`** answers "when does the source claim this happened." An
  untrusted declaration by construction (a late, poorly synchronized, or
  malicious source). It plays no part in any decision branch. If
  `|authority_time − occurred_at|` exceeds `CLOCK_DRIFT_THRESHOLD` (a
  named, configured constant), `explain()` reports
  `LATE_OR_BACKDATED_EVENT_OBSERVED` for that event: an audit signal,
  never an input to the decision calculation.
- **`recorded_at`** answers "when did the infrastructure physically see
  this event go by." Useful for ingestion monitoring (latency,
  chronically late sources). Distinct from `authority_time`: `recorded_at`
  is a raw reading of the infrastructure clock and offers no monotonicity
  guarantee. `authority_time` is the canonical value, corrected to be
  monotonic, that the decision engine can safely use.

## Ingestion: canonical store versus security log

There are two distinct logs:

1. **The canonical store**, the only one read by `authorityAt()` /
   `explain()`. It contains only events whose ingestion succeeded.
2. **The security log**, never read by `authorityAt()`. It records
   rejected ingestion attempts: a conflicting `event_id` (I8), a business
   ID collision (see below), a proven violation of I12/I13/I14 against the
   canonical state already known at ingestion time. Each entry carries:
   the attempted `event_id`, the hash of the payload or payloads involved,
   a `reason_code`, and `recorded_at` (no `sequence`: these attempts never
   enter the canonical causal order).

A rejected ingestion attempt never modifies the canonical store and
therefore has no bearing on any future resolution: this is not an
exception to I3 (append-only), it is the absence of a write. The `UNKNOWN`
response to a conflicting ingestion attempt (I8) is a synchronous response
to that call, not a promise that future resolutions will remain `UNKNOWN`
because of that event_id.

A structurally valid event whose ingestion cannot yet judge authority (a
reference to a link that has not arrived yet, out-of-order delivery)
does, however, enter the canonical store without a final authority
verdict. It is resolution, with all the information available at its own
`sequence`, that decides (I5, I12, I13, I14 are therefore checked at
ingestion **and** rechecked at every resolution: the resolver never
trusts the ingestion verdict).

## Business identifier uniqueness

`delegation_id`, `action_id`, and `approval_id` are business identifiers
distinct from `event_id`. Each must be unique across every instance of
its creating event type:

| Business ID | Unique among | On collision (same ID, different content, different `event_id`) |
|---|---|---|
| `delegation_id` | all `DELEGATION_CREATED` and `SUBDELEGATION_CREATED` events ever ingested | The second event is rejected at ingestion, logged (security log), never inserted into the canonical store. |
| `action_id` | all `ACTION_REQUESTED` events ever ingested | Same. |
| `approval_id` | all `APPROVAL_REQUESTED` events ever ingested | Same. |

This rule is distinct from I8 (which deduplicates by `event_id`): two
events with different `event_id` values could attempt to reuse the same
business ID with different content (for example, passing off a
high-amount action as the already-approved low-amount action). Business
ID uniqueness closes exactly this case, independently of I8.

## Canonical action fingerprint (`action_fingerprint`, I15)

Computed by Authority, never taken as-is from the source without
verification. Inputs, in this exact order, each converted to a UTF-8
string (an absent field is represented by the literal sentinel `∅`, an
integer by its decimal representation with no leading zero and no
insignificant sign):

1. `capability.resource`
2. `capability.action`
3. `parameters.amount` (or `∅`)
4. `parameters.recipient` (or `∅`)

The four segments are joined with the U+001F separator (unit separator)
into a single string, then hashed with SHA-256 and encoded in lowercase
hexadecimal. The result is `action_fingerprint`. This function is pure
and deterministic (I2): the same inputs always produce the same
fingerprint.

## The 9 event types

### 1. `DELEGATION_CREATED`

An authority creates a root delegation. `parent_delegation_id` is
mandatorily `null` for this type.

| Payload field | Type | Description |
|---|---|---|
| `delegation_id` | opaque identifier | Unique (see business ID uniqueness). |
| `grantor_principal_id` | opaque identifier | The principal granting. |
| `grantor_type` | `HUMAN_ROOT` \| `AGENT` | Mandatory for a root delegation. `AUTHORIZED` requires `HUMAN_ROOT` at the top of the chain (trust anchor). |
| `grantee_principal_id` | opaque identifier | The principal receiving. |
| `capabilities` | list of exact `{resource, action}` pairs | No wildcard (I9). |
| `can_delegate` | boolean, mandatory | The right to subdelegate (I12). Absence means `UNKNOWN` for any resolution that depends on it. A delegation always confers execution of the listed capabilities; it confers re-delegation only if `can_delegate: true`. |
| `expires_at` | timestamp **or** `{no_expiry: true}` | Mandatory. Never an implicit null (I1). Compared against `authority_time`, never against `occurred_at`/`recorded_at` (I4). |
| `max_amount` | optional `{value: integer, currency}` | Structural per-action cap, used to bound subdelegations (I5). Absence means unlimited (+∞) for this comparison. |
| `total_budget` | optional `{value: integer, currency}` | Aggregate cap: at no `sequence` may the sum of `parameters.amount` across every `ACTION_EXECUTED` whose `authority_chain_ref` passes through this delegation or one of its descendants exceed this value. Absence means unlimited (+∞). Debited at the level of **every** bounded ancestor of a chain, not only at the terminal delegation invoked (see `SPEC.md`, "total_budget semantics"). V0 guarantees an honest, deterministic calculation of this cap at resolution time, not its reservation before execution (see A24, `THREAT_MODEL.md`). |
| `automatic_max_amount` | integer, mandatory if `max_amount` or any amount-bearing action is invoked on this delegation | Below this threshold: no approval required. |
| `approval_max_amount` | integer, same condition | Between `automatic_max_amount` (excluded) and this threshold (included): approval required. Beyond it: `DENIED`. Must satisfy `automatic_max_amount ≤ approval_max_amount ≤ max_amount` (`max_amount` treated as +∞ if absent). If the order is violated, the delegation is malformed and `UNKNOWN` for any resolution that depends on it. |
| `parent_delegation_id` | `null` (fixed for this type) | Marks a root delegation. |

### 2. `DELEGATION_REVOKED`

Revokes an existing delegation. Never means it was wrong from the start
(see "Revocation is not invalidation" in `SPEC.md`). `EVENT_INVALIDATED`
would be the appropriate type for that second case, not implemented in
V0.

| Payload field | Type | Description |
|---|---|---|
| `delegation_id` | opaque identifier | The targeted delegation (must exist in the canonical store). |
| `revoked_by_principal_id` | opaque identifier | Must equal the envelope's `principal_id` (the issuer). |
| `reason_code` | opaque enum | No free text, no PII. |

Authorized (I13) only if the issuer (`principal_id`) is the
`grantor_principal_id` of the targeted delegation, or the
`grantor_principal_id` of that chain's root delegation. Otherwise:
ignored for the decision, logged as an attempt. If authorized, effective
from its own `sequence` (I4, I7) for this link and all descendants that
exclusively depend on it.

### 3. `SUBDELEGATION_CREATED`

Structurally identical to `DELEGATION_CREATED` (same constraint fields),
without `grantor_type` (the grantor of a subdelegation is by construction
an `AGENT`, the parent's grantee), with `parent_delegation_id` mandatory
and non-null.

| Payload field | Type | Description |
|---|---|---|
| `delegation_id` | opaque identifier | Unique (see business ID uniqueness). |
| `parent_delegation_id` | opaque identifier, mandatory | The delegation this one derives from. |
| `grantor_principal_id` | opaque identifier | Must equal the envelope's `principal_id` **and** the parent's `grantee_principal_id` (I12). |
| `grantee_principal_id` | opaque identifier | The principal receiving. |
| `capabilities` | list of exact `{resource, action}` pairs | Exact subset of the parent's capabilities. |
| `can_delegate` | boolean, mandatory | Same as I12. |
| `expires_at` | timestamp **or** `{no_expiry: true}` | ≤ the parent's `expires_at` (`no_expiry` treated as +∞). |
| `max_amount`, `total_budget`, `automatic_max_amount`, `approval_max_amount` | same types as `DELEGATION_CREATED` | Each ≤ the parent's corresponding value. For `total_budget`, ≤ the parent's **remainder** at the resolution `sequence` (the parent's declared `total_budget` minus the sum of `parameters.amount` across every authorized `ACTION_EXECUTED` whose `authority_chain_ref` passes through the parent or one of its descendants, at `sequence` ≤ the one being evaluated). |

Valid (I12) only if the issuer is the parent's grantee and the parent
carries `can_delegate: true`. Checked at ingestion against the canonical
state known at that time, rechecked at every resolution (the parent may
have been revoked, or its remaining budget may have decreased, since).

### 4. `ACTION_REQUESTED`

| Payload field | Type | Description |
|---|---|---|
| `action_id` | opaque identifier | Unique (see business ID uniqueness). |
| `requesting_principal_id` | opaque identifier | The principal requesting to act. |
| `delegation_id` | opaque identifier | The delegation or subdelegation invoked. |
| `capability_requested` | exact `{resource, action}` | Exact capability required. |
| `parameters` | `{amount?: integer, currency?, recipient?: opaque identifier}` | Only `amount`, `currency`, and `recipient` are typed and enter `action_fingerprint` (I15). No other business field is interpreted by the engine in V0. |

### 5. `APPROVAL_REQUESTED`

Purely informational in V0: the engine itself computes `REQUIRES_APPROVAL`
from the invoked delegation's thresholds and `parameters.amount`. This
event documents or routes the request to a human but is not consulted by
the decision.

| Payload field | Type | Description |
|---|---|---|
| `approval_id` | opaque identifier | Unique (see business ID uniqueness). |
| `action_id` | opaque identifier | The action concerned. |
| `requested_from_principal_id` | opaque identifier | Informational only. Confers no authority (I14). |
| `policy_reason_code` | opaque enum | Informational reason (for example `AMOUNT_BAND_APPROVAL`). |

### 6. `APPROVAL_GRANTED`

| Payload field | Type | Description |
|---|---|---|
| `approval_id` | opaque identifier | Must reference an existing `APPROVAL_REQUESTED`. |
| `action_id` | opaque identifier | Must match the request's `action_id`. |
| `approving_principal_id` | opaque identifier | Must equal the envelope's `principal_id` **and** the `grantor_principal_id` of the delegation whose thresholds produced `REQUIRES_APPROVAL` (I14). |

There is no `granted_scope` field: the canonical fingerprint of the
referenced `ACTION_REQUESTED` (I15) *is* the exact scope covered. No
additional structure is needed. Fixed semantics (I6, I16): single use,
bound to `action_id` and to `action_fingerprint`, with no effect on the
delegation's own state.

### 7. `APPROVAL_DENIED`

| Payload field | Type | Description |
|---|---|---|
| `approval_id` | opaque identifier | Must reference an existing `APPROVAL_REQUESTED`. |
| `action_id` | opaque identifier | The action concerned. |
| `denying_principal_id` | opaque identifier | Must equal the envelope's `principal_id` **and** the entitled `grantor_principal_id` (the same I14 rule as for `APPROVAL_GRANTED`, to prevent an unentitled third party from blocking an action with a false denial). |
| `reason_code` | opaque enum | Reason for the denial. |

Scope of the denial: it targets exclusively the `approval_id` it cites
(and therefore the `ACTION_REQUESTED` with the same `action_id`), never
the `action_fingerprint` on a permanent basis. A new `APPROVAL_REQUESTED`,
with a new `approval_id`, for an action with an identical
`action_fingerprint` (same capability, same amount, same recipient), is
admissible and is evaluated independently of this denial.
`action_fingerprint` is never used as a persistent blacklist key. That
would be business policy, outside V0's deterministic scope.

### 8. `ACTION_EXECUTED`

Records the actual execution of an action, after the engine has returned
`AUTHORIZED` for it.

| Payload field | Type | Description |
|---|---|---|
| `action_id` | opaque identifier | The action executed (must reference an existing `ACTION_REQUESTED`, `AUTHORIZED` at its execution `sequence`). |
| `executed_by_principal_id` | opaque identifier | The executing principal. |
| `action_fingerprint` | hexadecimal string | Canonical fingerprint (I15) of the parameters actually executed, computed identically to that of the `ACTION_REQUESTED`. Must be strictly equal to the fingerprint of the `ACTION_REQUESTED` with the same `action_id`, otherwise `DENIED`. |
| `decision_sequence` | integer | The `sequence` at which the `AUTHORIZED` decision was computed. |
| `authority_chain_ref` | ordered list of `delegation_id` values (plus `approval_id` where applicable) | The exact, unique chain, fully valid at `decision_sequence`, used for the decision. Fixed at execution, never recomputed or reassigned (I3): only this chain debits the `total_budget`-bounded ancestors it contains. The resolver may know of other valid chains toward the same principal (multi-path rule). An agent cannot invoke a different one afterward on the grounds that it would have more remaining budget. |
| `execution_result` | opaque enum | Execution status, with no business detail and no PII. |

Consumption of an `approval_id` (I16): if `authority_chain_ref`
references an `approval_id`, this `ACTION_EXECUTED` becomes its only
valid consumption if it has the smallest `sequence` among every
`ACTION_EXECUTED` referencing that same `approval_id`. Any other is
`DENIED`.

An `ACTION_EXECUTED` with no demonstrable `AUTHORIZED` decision at
`decision_sequence`, or whose `action_fingerprint` does not match, is a
violation detected by the resolver, not a case silently accepted by the
schema.

### 9. `CAPABILITY_ISSUED`

Produced only by the capacity issuance command
(`issueCapability`/`issueCapabilityIdempotently`, PR3 through PR4B-5A;
see `SPEC.md`, I21 through I24), never through the
`authorityAt`/`explainAction` ingestion path described above. Unlike the
eight preceding types, this event is never supplied by an external
source: it is self-produced by Authority itself, at the moment the
command decides to accept the issuance.

| Payload field | Type | Description |
|---|---|---|
| `capability_id` | opaque identifier | Protected business identifier of the issued capability. A collision (a forced or defective generator) is rejected fail-closed (I24), never silently accepted. |
| `action_id` | opaque identifier | The `ACTION_REQUESTED` the command derives from. |
| `action_fingerprint` | hexadecimal string | Canonical fingerprint (I15) of the resolved action, computed identically to the other types. |
| `decision_sequence` | integer | The `snapshotSequence` at decision time: a causal order, never derived from time (I21). |
| `granted_chain_ref` | ordered list of links | The canonical GRANTED chain resolved for the invoked delegation. |
| `enforcement_point_id` | opaque identifier | The enforcement point requested by the command. Copied as-is if the issuance succeeds, never checked against an authorization registry (no such registry exists in V0). |
| `expires_at` | timestamp | Supplied by an injected policy (a command dependency), anchored on the same explicit `authorityTime` as the decision. Never a reconstructed or live-read instant. |

Envelope fields, specifics for this type:

- **`occurred_at`**: equal to `authorityTime`, the explicit instant at
  which the decision was made and the capability constructed (I21). This
  equality **never** represents the instant at which the write was
  physically made durable. See `recorded_at` below for that distinct
  notion.
- **`recorded_at`**: read separately from the infrastructure clock at the
  moment the store actually sees the event go by, exactly as for any
  other type. No absolute ordering relationship between `recorded_at` and
  `occurred_at` is guaranteed for `CAPABILITY_ISSUED`: these are two
  clocks of a different nature, never compared against each other by the
  engine.
- **`authority_time`**: equal to `authorityTime`, the explicit trust
  instant supplied to the command. Never reconstructed from the store.
- **`principal_id`**: a mandatory envelope field (as for every event),
  here populated with the authenticated requester's identity
  (`AuthenticatedPrincipal`). It must **not** be read as designating a
  human author or an agent personally performing the act of issuance: no
  participant in the delegation graph "grants" this event the way a
  `grantor_principal_id`/`approving_principal_id` does elsewhere. It is a
  field kept for the common envelope's structural consistency, not an
  attribution of authority and not proof of identity.

A `CAPABILITY_ISSUED` is produced **only** on an accepted decision. Any
refused command, including for `STALE_AUTHORITY_TIME` (I22), never writes
this event, regardless of the number of attempts under the same
idempotency key. See `SPEC.md`, I22 and I24, for the normative detail.
`STALE_AUTHORITY_TIME` is not an event type: it is a refusal result of
the command itself, never logged data in the sense of this document.

An idempotent replay (`REPLAYED`, under the same key) never creates a
second `CAPABILITY_ISSUED`: the result returned is that of the original
execution, with no new event and no new evaluation.
