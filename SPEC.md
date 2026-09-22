# SPEC: authority-graph

## The problem

An AI agent executes an action. A human must be able to answer, months later,
the question: *what authority exactly covered this action, at instant T,
and why?* Today this authority is scattered across application logs,
Slack messages, approval tickets, and people's memory. Nothing is
replayable, nothing is verifiable, and no one can prove after the fact that a
delegation was not extended, backdated, reused outside its scope, or issued
by someone who did not have the right to issue it. authority-graph reconstructs this
authority chain deterministically from an append-only event stream:
root human anchor to delegation to subdelegation to one-time approval to
the agent's action. The engine never judges the intent or the content of
the action itself: it verifies that the formal authority chain, valid at
the ingestion sequence under consideration, covers exactly the requested capability, and that
each link of that chain was issued by a principal who actually had
the right to issue it. Any structural uncertainty must block, never
authorize by default.

## The engine's two operations

The engine exposes exactly two operations. There is no single entry point
fixed on an `ACTION_REQUESTED`: an earlier version of this spec
described only one; the adversarial audit showed that this made the engine
structurally dependent on a historical event to answer a
question about the current state of authority, and conflated two questions of
a different nature. The four outputs in the following section are produced
by one or the other of these two operations, never by a third path.

### `authorityAt(events, query, { atSequence, authorityTime })`: prospective question

Answers: *would this action be authorized, in this state?* The request is

```
{ agentId, principalId, capability, parameters }
```

The third parameter is no longer a simple `atSequence` (PROMPT
3b correction): it is an explicit pair `{ atSequence, authorityTime }`.

- `atSequence` answers "which events are visible" (I4, causal order).
- `authorityTime` answers "is a given `expires_at` already past"
  (I4, clock). This is the trusted clock **at the moment of the call**,
  supplied explicitly by the caller. It is never derived from `occurred_at`
  (declarative, untrustworthy by construction: deriving it into a
  decisional clock, even "only for test determinism,"
  reintroduces exactly the backdating risk that I4 exists to
  prevent), and it is never read from a live wall clock (`Date.now()`
  is forbidden throughout the engine, which remains a pure function). It is also
  not `max(authority_time of the visible events)`: time
  passing does not necessarily produce an event, and without a new event
  for three hours, this derivation would make a delegation that expired three hours
  ago look valid forever. In production, the
  admission layer supplies `authorityTime` from its own trusted
  clock. In tests, fixed values are injected.

- `agentId`: the principal who would exercise the capability, the evaluated delegatee.
- `principalId`: the `HUMAN_ROOT` that the caller expects to be responsible for
  this authority. `authorityAt` does not answer only "is `agentId`
  authorized by *some* human," but "is `agentId` authorized,
  specifically under the authority of `principalId`." A chain that is otherwise
  entirely valid but rooted in a `HUMAN_ROOT` *different* from the one
  asserted here is `DENIED` for this specific pair (positive proof that this
  pair does not have authority), never accepted under the wrong human, and never
  `UNKNOWN` either.

`authorityAt` **never requires and never reads a preexisting
`ACTION_REQUESTED`**: the engine must not be structurally dependent on a
historical event to answer a question about the state of authority at
a given instant. Direct consequence for the approval band: a
valid and **unconsumed** `APPROVAL_GRANTED`, whose fingerprint (I15)
corresponds exactly to `(capability, parameters)` of the request, is sufficient to
produce `AUTHORIZED`. An `APPROVAL_DENIED`, on its own, **can never**
turn a prospective question into `DENIED`: a denial targets a specific past
request, identified by its `approval_id` (see "Scope of a
denial" below). It has no power over a general question that is
not anchored to that request. Only a *consumed* approval (I16) produces
`DENIED` for a prospective question bearing on the same fingerprint. In
the absence of any approval, valid or not, the answer is
`REQUIRES_APPROVAL`, never `DENIED` on the sole strength of an unrelated past
denial.

### `explainAction(events, { actionId }, { atSequence, authorityTime })`: historical question

Answers: *what happened for this specific action, and why?*
Retrieves the immutable `ACTION_REQUESTED` referenced by `actionId`. Its
`agentId` (`requesting_principal_id`), its capability, and its parameters, and therefore its
canonical fingerprint (I15), never change afterward. It then calls the
same evaluation as `authorityAt`, with two differences:

- **this** action's own history (its own `APPROVAL_REQUESTED` and
  the decision concerning it, if any) is the priority source for
  explaining what happened to it, including a denial that targets it directly,
  whereas `authorityAt` can never take a denial into account, for lack
  of an action to attach it to;
- if an `ACTION_EXECUTED` exists for this `actionId`, authority is *also*
  resolved at its `decision_sequence` ("was this authorized at the moment of the
  decision?"), and the fingerprint actually executed (`action_fingerprint`) is
  compared to the immutable fingerprint of the request (I15). Any divergence is
  `DENIED` at that decision point, regardless of what the current state otherwise says.

`explainAction` **never uses the current time**. The `{
atSequence, authorityTime }` pair of the request only anchors `currentAuthority`.
Authority at the `decision_sequence` of the execution is evaluated with a **reconstructed**
clock, never read live: the greatest `authority_time` among
the events visible at that `decision_sequence`, each of these
`authority_time` values having itself already been assigned at ingestion by the same
trusted clock, never by `occurred_at`. Reconstructing in this way a
**past and fixed** point is legitimate (there is no risk of "time passing without
an event" for an instant already fully logged), whereas this would be
insufficient to represent *now* in an `authorityAt` request.

`explainAction` therefore produces a composite output, for example:

```
ACTION_EXECUTED at sequence 152
authority at decision sequence 151: AUTHORIZED
approval consumed by execution 152
current authority at sequence 190: DENIED
```

An execution historically authorized remains so forever at its
`decision_sequence`. I3 forbids rewriting this conclusion, even when
`currentAuthority` (authority for the same fingerprint, reevaluated at the
`sequence` of the request) now reads `DENIED` because the single-use
approval that covered it has since been consumed (I6, I16).

## The engine's 4 outputs

Whether it is produced by `authorityAt` (prospective) or by `explainAction`
(historical, via the `ACTION_REQUESTED` it resolves), every evaluation
returns exactly one of the following four values:

1. **AUTHORIZED**: An unbroken delegation chain exists, where each
   link (delegation, subdelegation, approval where applicable) was issued
   by a principal who actually had the right to issue it (I12, I13, I14),
   not expired (in the `authority_time` sense, see Blocker 2), not revoked by a
   revocation that is itself authorized, respecting the maximum depth, where each
   link covers at least the requested capability and constraints,
   up to the specific expected `HUMAN_ROOT` (trust anchor, see below). If the action carries
   an amount, it must fall under `automatic_max_amount` (or be
   covered by a valid, unconsumed `APPROVAL_GRANTED`, bound by
   exact fingerprint, I15). No ambiguity was encountered during
   resolution.
2. **DENIED**: The authority chain is entirely known and unambiguous, and
   it positively demonstrates the absence of authority for the specific request:
   active and authorized revocation, expiration, capability outside the exact
   granted scope, amount beyond `approval_max_amount`, aggregate budget exhausted, or
   an already consumed approval grant (I16). This last case is the only one through
   which a **prospective** question (`authorityAt`) can be `DENIED` within
   the approval band. An explicit and authorized denial (`APPROVAL_DENIED`)
   or an action fingerprint different from the approved one (I15) can
   produce `DENIED` only within the **historical** scope of `explainAction`, for
   the specific action they concern.
3. **REQUIRES_APPROVAL**: The delegation chain to the requesting principal
   is valid and covers the requested capability, the amount falls strictly
   between `automatic_max_amount` and `approval_max_amount`, and no
   valid and unconsumed `APPROVAL_GRANTED`, bound by exact fingerprint, exists
   for this fingerprint.
4. **UNKNOWN**: Any other situation: missing data, partial chain,
   conflicting event, detected cycle, exceeded depth (see I10 for the exact
   count), a chain going back to an `AGENT` with no human anchor, an authorization
   field (`can_delegate`, amount thresholds) absent where it is required
   to decide, an unknown `schema_version` on an event that the resolution
   depends on, or any condition not explicitly covered by the three cases
   above and by the exhaustive table below. `UNKNOWN` is the engine's default
   output: it does not need to be "chosen." It is what
   remains when no positive proof of `AUTHORIZED`, `DENIED`, or
   `REQUIRES_APPROVAL` has been established. An unknown `schema_version` only
   contaminates resolutions that actually depend on the event
   concerned (see I1), never an independent resolution elsewhere in the
   graph.

## Security invariants

Each invariant is formulated as a testable assertion. They are non-negotiable
and must not be weakened or reworded as implementation proceeds.

1. **I1: Fail-closed.** For any input that is ambiguous, incomplete, or not resolved by
   the engine's explicit rules, the output is `UNKNOWN`. There is no path in the
   engine's code where the absence of data or an unforeseen branch leads to
   `AUTHORIZED`. Test: for any random mutation of a valid fixture
   that removes or corrupts a required field, the output must never be
   `AUTHORIZED`.
2. **I2: No LLM in the decision path.** The decision function is pure:
   the same events as input (same list, same `sequence` order) always yield the same output,
   on every execution, with no network call, no inference, no
   non-deterministic component. Test: running the same evaluation 1000 times offline must
   produce a strictly identical result.
3. **I3: Strict append-only.** No engine operation modifies or
   deletes an event already accepted into the canonical store. Any error
   correction happens through a new compensating event, never through mutation or
   deletion. An event whose ingestion fails (`event_id` conflict, business-ID
   collision, proven violation of I12/I13/I14) is, by contrast, never accepted
   into the canonical store. Refusing it at the door is not a mutation, it is
   the absence of a write (see `EVENT_MODEL.md`, security log). Test: the
   canonical store exposes no `update`/`delete` operation on an event
   already persisted; any attempt is rejected.
4. **I4: Strict separation of ordering and clock (corrected).** Three distinct notions,
   never conflated:
   - `sequence`: causal order only, assigned by Authority at ingestion,
     strictly increasing, never falsifiable by the source. Answers "which
     event before which." It is the only order used to determine the state
     of the graph "at instant T" and to apply I7 (a revocation only affects
     evaluations at `sequence` ≥ its own).
   - `authority_time`: clock assigned by Authority at ingestion, guaranteed
     non-decreasing with respect to `sequence`. It is the only clock
     used to compare against `expires_at` and to evaluate whether a delegation has
     expired. Never supplied by the source, and **never derived from `occurred_at`
     by the engine itself** (PROMPT 3b correction: an earlier
     implementation derived `authority_time` from `occurred_at` "for
     test determinism." That was a regression that put an
     attackable timestamp back into the decision path). The raw value
     comes from an **explicit dependency** that the caller of `ingestAll`
     supplies (a trusted clock), which Authority merely clamps
     to guarantee the monotonicity above. It never invents it from
     another field of the event.
   - **Expiration convention (exclusive):** `authorityTime < expires_at` means
     still valid; `authorityTime >= expires_at` means expired. The boundary itself
     counts as expired.
   - `occurred_at`: timestamp declared by the source, never decisional, never
     used to order events or to evaluate expiration. Kept for audit purposes.
     If the gap `|authority_time - occurred_at|` exceeds a named and explicit threshold
     (`CLOCK_DRIFT_THRESHOLD`), `explain()` must display
     `LATE_OR_BACKDATED_EVENT_OBSERVED` for that event. This signal never affects
     `AUTHORIZED`/`DENIED`/`REQUIRES_APPROVAL`/`UNKNOWN`. It affects only
     the explanation.
   - `recorded_at`: infrastructure clock at the moment the store physically
     saw the event. Operational diagnostics only, never decisional, never
     used to evaluate expiration (it is not `authority_time`).
   `authorityAt` and `explainAction` receive this "now" as an
   explicit pair `{ atSequence, authorityTime }` (see "The engine's two
   operations"), never computed internally as `max(authority_time of the
   visible events)`: time passing does not necessarily produce an
   event, and this derivation would make a delegation that expired hours
   ago look valid forever, for lack of a more recent event to
   reveal it. Test: an event whose `occurred_at` predates all
   events already present, but which receives a later `sequence` and
   `authority_time`, must never change a decision already
   rendered for an evaluation at a `sequence` earlier than its insertion.
   An expiration must never be evaluated by comparison against `occurred_at`
   or `recorded_at`. At an identical `atSequence` and graph, two values
   of `authorityTime` on either side of an `expires_at` must produce two
   different decisions.
5. **I5: Strict bounding of subdelegations.** For every `SUBDELEGATION_CREATED`,
   on each dimension independently (`capabilities`, `can_delegate`,
   `expires_at`, `max_amount`, `automatic_max_amount`, `approval_max_amount`,
   `total_budget`), the child's value is a subset of or a strict restriction of
   the parent's, treating any dimension absent on the parent
   as unlimited (+∞) and any dimension absent on the child while the
   parent bounds it as a widening attempt (therefore invalid). For
   `total_budget` specifically, the parent bound to consider is its **remaining**
   value at the resolution `sequence` (declared `total_budget` minus what has already been
   spent by authorized `ACTION_EXECUTED` events attached to this parent or one of
   its descendants, see `EVENT_MODEL.md`), not its raw declared value. This
   bounding is rechecked at every resolution, not only at creation (see
   revalidation note below). Test: any subdelegation that widens a
   single dimension relative to the parent's current remainder is treated as
   invalid (never silently truncated). The deterministic result is
   `DENIED` if both compared values are known, `UNKNOWN` if either one
   is not.
6. **I6: No widening of the mandate through approval.** An `APPROVAL_GRANTED` neither
   creates nor modifies a permanent delegation: it covers exactly the action
   that requested it, identified by its `action_id` **and** by its exact
   `action_fingerprint` (I15), a single time (I16), and has no effect on
   a future action even an identical one. Test: after consumption of an
   `APPROVAL_GRANTED` by its `ACTION_EXECUTED`, a second, identical
   `ACTION_REQUESTED` cannot be `AUTHORIZED` on the basis of that same approval.
7. **I7: Propagation of revocation.** An **authorized** `DELEGATION_REVOKED`
   (I13) invalidates, from its `sequence` onward, every delegation and subdelegation
   that depends exclusively on the revoked delegation as its sole authority
   chain. A descendant with a second, otherwise valid, independent authority
   chain remains `AUTHORIZED` through that second chain. Each
   chain relied upon must be demonstrated fully valid over its entire length
   (see "multi-path rule" below; "there exists a second path" alone never
   suffices). An **unauthorized** `DELEGATION_REVOKED` has no effect on the
   decision (see I13). Test: revoking a parent delegation through an
   authorized event turns all its single-chained descendants to `DENIED` (known
   chain, positive proof of absence of authority) without affecting an otherwise
   valid multi-chained descendant. An unauthorized revocation changes
   no decision.
8. **I8: Event idempotence (deduplication at ingestion).** Two
   events carrying the same `event_id` and strictly identical content produce
   only one effect on the state (the second is a silent no-op on the canonical
   state). Two events carrying the same `event_id` with different
   content are never both accepted into the canonical store:
   ingestion of the second fails and returns `UNKNOWN` **as the direct response to
   this ingestion attempt**. The rejected event never enters the canonical
   store and can therefore never affect any future `authorityAt()` evaluation
   (see the separation between canonical store and security log). Test: replaying the same
   event N times does not change the state. Injecting a duplicate `event_id` with a
   different payload must produce `UNKNOWN` for the ingestion call, never a
   silent overwrite, and must have no effect on subsequent resolutions
   concerning other event_ids.
9. **I9: Exact capabilities only (V0).** A capability is an exact pair
   `(resource, action)`. No wildcard, no regular expression,
   no implicit scope inheritance is interpreted as covering a
   more specific capability. Test: a requested capability that has no
   exact, character-for-character match in an otherwise fully
   known chain is `DENIED`. If the chain itself is incomplete, it is `UNKNOWN`
   (never `AUTHORIZED` by fuzzy matching in either case).
10. **I10: Cycle and depth protection.** The engine applies an explicit,
    configured chain depth limit: `MAX_CHAIN_DEPTH = 32`.
    This limit is counted in **delegation edges traversed** (each
    `DELEGATION_CREATED`/`SUBDELEGATION_CREATED` link taken while going back
    toward the root counts as one edge), **never in nodes or in distinct
    principals**: the same principal can appear multiple times along
    a chain without changing the count. It is the number of links the
    resolver must traverse and revalidate (I5, I12), not the number of
    distinct identities present, that determines the resolution cost. This is a
    resolution limit for **one path**, never a reason to turn the whole
    graph to `UNKNOWN`: a branch that exceeds the limit must never
    poison an independent and valid chain toward the same agent (multi-path
    rule, below). Any chain whose resolution would exceed 32
    edges, or in which a delegation cycle is detected, returns
    `UNKNOWN` with the code `MAX_CHAIN_DEPTH_EXCEEDED` (depth) or
    `C18_CYCLE_DETECTED` (cycle). Test: a chain of exactly 32 edges is
    resolved normally (no special handling at the exact limit). A
    chain of 33 edges returns `UNKNOWN`/`MAX_CHAIN_DEPTH_EXCEEDED`. A
    graph built with an explicit cycle returns `UNKNOWN` with no infinite
    loop and no stack overflow. A branch of 33 edges coexisting with
    an independent chain of 3 edges toward the same agent must degrade
    only the first, never the second.
11. **I11: No secrets or PII in the graph.** All `principal_id` values are
    opaque identifiers with no interpretable structure. No event field
    carries a secret or identifying personal data. Detection of
    forbidden patterns at ingestion (for example, a `principal_id` that takes
    the recognizable form of an email address) **rejects explicitly
    prohibited forms**. It never guarantees the **absence** of any PII in
    the graph. Absence of detection is not proof of absence, consistent
    with I17 (honesty of the assurance level): `explain()` must never
    imply that the graph is certified free of PII, only that
    recognized forms have been refused at the door. Test: a scan of event
    schemas and fixtures must find no field matching an
    email pattern, a full name, or a secret. An ingestion test must
    show that at least one recognized form (email) is rejected, never
    claiming that this list is exhaustive.
12. **I12: Right to delegate.** Each delegation (`DELEGATION_CREATED` or
    `SUBDELEGATION_CREATED`) carries an explicit boolean `can_delegate`, whose
    absence makes any resolution that depends on it `UNKNOWN` (never interpreted
    as `true` nor as `false` by default). A `SUBDELEGATION_CREATED` is
    valid only if (a) its issuing `principal_id` is exactly the
    `grantee_principal_id` of the referenced parent delegation, and (b) that
    parent delegation carries `can_delegate: true`. A delegation, by
    construction, always confers the right to execute the capabilities it lists
    (`can_execute` is implicit to holding a valid delegation). It confers
    the right to subdelegate only if `can_delegate: true` is explicit.
    Test: a `SUBDELEGATION_CREATED` whose issuer differs from the parent's grantee,
    or whose parent carries `can_delegate: false`, is `DENIED` (known fact). If
    `can_delegate` is absent from the parent, it is `UNKNOWN`.
13. **I13: Right to revoke.** A `DELEGATION_REVOKED` is authorized only if its
    issuing `principal_id` is either (a) the `grantor_principal_id` of the
    targeted delegation, or (b) the `grantor_principal_id` of the root delegation
    (`parent_delegation_id: null`) at the top of the chain to which the
    targeted delegation belongs. Any other issuance of `DELEGATION_REVOKED` is **ignored
    for the decision** (it invalidates nothing) and logged as an unauthorized
    attempt in the security log, so that a third party cannot
    use I7 as a denial-of-service weapon against a legitimate chain. Test:
    a revocation issued by a principal other than the direct grantor or the chain
    root must have strictly no effect on `authorityAt()`.
14. **I14: Right to decide an approval.** An `APPROVAL_GRANTED` or an
    `APPROVAL_DENIED` is authorized only if its issuing `principal_id` is
    exactly the `grantor_principal_id` of the delegation whose amount
    thresholds produced `REQUIRES_APPROVAL` for the action concerned. The
    `requested_from_principal_id` carried by the corresponding `APPROVAL_REQUESTED`
    confers no authority. It is purely informational (routing), otherwise
    an attacker would choose their own approver. An approval decision issued
    by an unentitled issuer is ignored for the decision and logged as an
    unauthorized attempt. Test: an `APPROVAL_GRANTED` whose issuer differs
    from the entitled grantor must never turn an action from
    `REQUIRES_APPROVAL` into `AUTHORIZED`.
15. **I15: Binding by action fingerprint.** Every approval decision implicitly
    bears on the canonical fingerprint (`action_fingerprint`, see
    `EVENT_MODEL.md`) of the `ACTION_REQUESTED` it targets, computed from
    `capability_requested.resource`, `capability_requested.action`,
    `parameters.amount`, and `parameters.recipient`, in that exact order. An
    `ACTION_EXECUTED` whose declared `action_fingerprint` differs from the fingerprint of
    the `ACTION_REQUESTED` with the same `action_id` is `DENIED`, even if `action_id` and
    `approval_id` otherwise match. Test: varying `parameters` (the
    amount or the recipient) between the approved `ACTION_REQUESTED` and
    the `ACTION_EXECUTED` must produce `DENIED`, never `AUTHORIZED` through mere
    `action_id` matching.
16. **I16: Single-use consumption (clarified: PROMPT 6d, finding #3).**
    A given `approval_id` can be consumed by only one
    `ACTION_EXECUTED`, regardless of the number of distinct events (by
    `event_id`) that attempt to consume it. If several
    `ACTION_EXECUTED` events reference the same `approval_id`, only the one with the
    smallest `sequence` is valid. Any other is `DENIED`. I8 deduplicates
    identical events; I16 deduplicates a business effect, including across
    distinct events that do not conflict in the I8 sense.

    **The missing precision, revealed by the audit.** "Referencing the same
    `approval_id`" is not enough to qualify an `ACTION_EXECUTED` as
    consuming it. I6 already says so ("covers exactly the action that
    requested it, identified by its `action_id` **and** its exact
    `action_fingerprint`, I15"), but this was verified nowhere in the code: an
    `ACTION_EXECUTED` of an **unrelated** action B could cite the `approval_id`
    of an action A in its `authority_chain_ref` and count A's approval
    as consumed, even though action A itself had never been
    executed. Anyone could thereby "burn" someone else's approval
    without ever executing anything for their own account: a
    denial of service against a legitimate approval, the exact counterpart of I20
    (which closes the same gap for the debit of `total_budget`) applied to
    consumption. No new building block is needed: I6/I15 already state the
    missing condition, which only needed to be applied to
    the consumption check itself. Formally, an `ACTION_EXECUTED`
    E consumes the `approval_id` it cites in `authority_chain_ref` only
    if `E.action_id` is exactly the `action_id` carried by the corresponding
    `APPROVAL_GRANTED` for that `approval_id`, the same `action_id` binding I6
    already requires for an approval to apply to an action. This
    check compares only two already immutable fields already present
    on already ingested events (the grant's `action_id`, the candidate
    execution's `action_id`): structural, non-recursive, no call to the
    resolver. `action_id` values are unique in the canonical store (I8,
    business ID uniqueness), so the comparison is unambiguous.

    Test: two `ACTION_EXECUTED` events with different `event_id` values, referencing the same
    valid `approval_id` and carrying the **same** `action_id` that it
    covers, must never produce two `AUTHORIZED` results (the existing test,
    unchanged). An `ACTION_EXECUTED` whose `action_id` **differs**
    from the one covered by the `approval_id` it cites never consumes that
    approval, even if its `action_fingerprint`, or that of the
    actually approved action, otherwise coincides (two distinct actions
    can legitimately share the same fingerprint). A fresh question
    bearing on the actually approved fingerprint must remain `AUTHORIZED` as long
    as no execution of **that** specific action has consumed the grant.
17. **I17: Honesty of the assurance level.** V0 verifies neither signature nor
    cryptographic identity: every event carries an `assurance_level` fixed at
    `ASSERTED_UNVERIFIED`. `explain()` must never assert that a fact has been
    *proven*. It must phrase its conclusions as "the log contains an
    event asserting that X granted Y," never "X proved that it granted
    Y." Test: an audit of the text produced by `explain()` must contain no
    wording implying cryptographic proof or strong identity
    verification.
18. **I18: `decision_sequence` can never exceed its own `sequence`
    (PROMPT 6a, finding #4).** `decision_sequence`, carried by an
    `ACTION_EXECUTED`, is a self-declared field from the issuer of
    the event, exactly like `occurred_at` (I4), and nothing at ingestion
    constrains it against real causal order: the engine must therefore
    constrain it itself, at resolution time. A `sequence` only exists once
    the event carrying it has been accepted into the canonical store. A decision
    point can therefore never be located at a `sequence` later than **or
    equal to** that of the `ACTION_EXECUTED` that cites it. A `decision_sequence`
    equal to the `sequence` of its own execution makes no more causal sense
    than a strictly future `decision_sequence`, since an event can
    never serve as proof of itself. Formally, for any
    `ACTION_EXECUTED` with `sequence` S: `decision_sequence < S` is required.
    A violation of this constraint is never positive proof
    of absence of authority (it is not what the link *says*, it is that the
    question itself makes no causal sense): the output is `UNKNOWN`,
    never `DENIED`, decided, not "depending on context," consistent with I1
    (a malformed question blocks, it does not rule on the substance in its
    place). This rule applies to `execution.authorityAtDecision`
    only (`explainAction`). It is moot for `authorityAt`, which
    knows no `decision_sequence`. Test: an `ACTION_EXECUTED` with
    `sequence` S whose `decision_sequence >= S` must produce `UNKNOWN` for
    `execution.authorityAtDecision`, even if an otherwise valid authority
    actually exists at that claimed `decision_sequence` (that is, even if
    the attack, carried out slightly differently, could have succeeded). The rejection bears
    on the causal form of the citation, not on the content of the authority
    cited.
19. **I19: Causal legitimacy of "claim" references by ID
    (PROMPT 6b, common root: scope revised after empirical verification,
    see note below).** I18 was only one instance of a general pattern:
    several event fields cite another event by a
    business identifier, and until now the resolver checked this citation
    only by ID match, never by causal order. The rule, stated
    once: **a reference by ID is legitimate only if the cited event
    exists in the canonical store and its `sequence` is never
    strictly later than that of the citing event** (equality
    tolerated, see "Note on sequence equality" below; this is
    deliberately more permissive than I18, which forbids equality for the
    opposite reason: I18 compares a field of an event to the `sequence` of
    that **same** event, which makes equality inherently absurd,
    whereas I19 compares two **distinct** events).

    Fields concerned, and the **real scope** of the rule for each (they do not
    all receive the same treatment, see the distinction with A5
    below, which explains why):
    - `APPROVAL_GRANTED.action_id` and `APPROVAL_GRANTED.approval_id`;
    - `APPROVAL_DENIED.action_id` and `APPROVAL_DENIED.approval_id`;
      for these two events, I19 applies in full: existence **and**
      causal order.
    - `APPROVAL_REQUESTED.action_id`: covered by the same rule in
      principle. V0 today has no decision path that depends on it
      (a purely informational field: routing), so nothing to
      apply concretely for now.
    - `ACTION_EXECUTED.authority_chain_ref` (each `delegation_id`/
      `approval_id` it contains): covered in principle (a cited link cannot
      exist causally after the execution that claims to rely
      on it). Not applied in code in this pass, for lack of a
      demonstrated need (see "Restricted scope" below).
    - `SUBDELEGATION_CREATED.parent_delegation_id`: **excluded from the "causal
      order" half of I19.** See "Distinction from out-of-order
      delivery" below: this field remains governed solely by the
      "existence" half (already in place before I19, via C10), never by
      the order of `sequence` values between parent and child.

    **Distinction from out-of-order delivery (A5, already handled), and
    why `parent_delegation_id` is not ordered by I19.** I19 concerns
    only the causal relationship once **both** events are present
    in the store, never the temporary absence of one of the two. An
    event whose referenced predecessor has not yet arrived at the
    moment of ingestion (A5) is a legitimate situation, already covered (the
    canonical store accepts it without a final authority judgment, and the
    resolution remains `UNKNOWN` while the predecessor is missing). This is
    **not** an I19 violation. But A5, for delegations
    specifically, goes further than "the absence is temporary": once
    the parent has *arrived*, it does not matter what relative `sequence` order
    parent and child were **ingested** in. Only the question
    "do both exist at the evaluation `sequence`?" matters. This is a
    design choice already specified and already tested (the parent can carry a
    `sequence` greater than that of the child that references it, and the chain
    becomes fully valid as soon as both are visible), because
    a delegation chain is evaluated as a **snapshot** of the
    graph at `atSequence`, never as proof that a specific
    claim relied on evidence already present at the exact instant of its
    issuance. It is this second category of field, a claim about
    a specific instant ("I am answering, now, this
    already-filed approval request"; "I executed relying on
    this already-granted approval"), that I19 constrains through causal order.
    `parent_delegation_id` is not part of it: it is a structural pointer in a
    graph resolved by snapshot, not a temporal claim.
    Conflating it with the first two would break A5, which remains
    intended behavior, not a flaw.

    **Note on sequence equality.** The real ingestion system
    (`src/engine/ingest.ts`) assigns a strictly increasing and unique
    `sequence` to each accepted event, one at a time: two distinct
    events can never, in practice, share the same `sequence`.
    Two test events built directly as an `AuthorityEvent` already
    "ingested" (outside any real ingestion), by contrast, can share a
    `sequence` value by test-writing convention (for example to
    represent "the same logical step"). I19 tolerates this equality (it can never
    occur through real ingestion anyway, so tolerating it opens no
    observable gap). Only a **strictly greater** `sequence`, an
    event that, demonstrably, did not yet exist, constitutes a violation.

    **Output, decided.** A reference violating I19 is treated exactly
    **as if the cited event did not exist**, never as if it existed
    with a more permissive meaning. This is not a new, ad hoc output
    value per field: it is the direct application of the semantics already
    specified for "this event does not exist," specific to each
    field concerned, and therefore already deterministic: for `APPROVAL_GRANTED`/
    `APPROVAL_DENIED`, the approval decision is ignored, exactly
    as if it had never been issued (see C16 for I14, same
    treatment). A monetary decision in the approval band with
    no valid and unconsumed approval decision remains
    `REQUIRES_APPROVAL` (C4). It never becomes `AUTHORIZED` on the
    strength of a causally impossible citation.

    Test: an `APPROVAL_GRANTED` (or `APPROVAL_DENIED`) whose `approval_id`
    matches no `APPROVAL_REQUESTED` that is present and not causally
    later must never turn a question into `AUTHORIZED`
    (or into `DENIED` for a denial) on the sole strength of this citation. A
    `SUBDELEGATION_CREATED` whose parent arrives, in the store, at a
    `sequence` greater than that of the child that references it must remain
    resolved normally as soon as both are visible (A5, not concerned by
    the "order" half of I19).
20. **I20: Who can debit a `total_budget` (PROMPT 6b, finding #2;
    completed by PROMPT 6e, intermediate links: incomplete protection
    while this addition was not yet written, not an accepted limitation
    like A24).**
    `remainingBudget` (`src/engine/evaluateConstraints.ts`) sums, for a
    delegation D bounded by `total_budget`, every visible `ACTION_EXECUTED`
    whose `authority_chain_ref` passes through D, but until now without
    ever checking that the counted execution had a demonstrable relationship
    with the identity that actually held that chain.
    Anyone can submit an `ACTION_EXECUTED` citing a third party's delegation
    in its `authority_chain_ref`. I3 accepts it without an authority
    judgment (ingestion does not validate the authority of an execution, see
    I18), and until now this write, once in the store, debited that
    third party's budget without any `AUTHORIZED` decision ever having been
    demonstrated for it: a denial of service through budget exhaustion against
    an otherwise perfectly legitimate chain.

    **Why not a full re-resolution (recursion risk).**
    `remainingBudget` is called from `evaluateConstraints`
    (`budgetExceeded`) and from `validateChain` (`totalBudgetBoundOk`),
    both **on the decision path** of `resolveAuthority` itself.
    Requiring, for every `ACTION_EXECUTED` summed, complete proof
    that it *would have been* `AUTHORIZED` at its `decision_sequence` would force
    `remainingBudget` to call back into `resolveAuthority` for each one, and if
    the chain of THAT execution itself passes through a delegation bounded by
    `total_budget`, that call would call back into `remainingBudget`, which
    would potentially call back into `resolveAuthority`, and so on: a
    circular dependency, with no termination guarantee comparable to I10 (I10 bounds
    the depth of **one** delegation chain. Nothing here bounds the number
    of nested historical executions). I20 deliberately excludes
    this path: it **never** asks the resolver again whether a
    past execution would have been authorized.

    **The rule, non-recursive.** An `ACTION_EXECUTED` counts against the
    `total_budget` of none of the delegations in its `authority_chain_ref`, neither the
    directly invoked delegation, nor an ancestor bounded further up in the
    same chain, unless the following three conditions, purely
    structural and already immutable in the store, are satisfied:
    - `executed_by_principal_id` of the `ACTION_EXECUTED` is exactly
      `requesting_principal_id` of the `ACTION_REQUESTED` with the same `action_id`
      (whoever executed is whoever requested, not a third party
      claiming the execution of someone else's request);
    - the last delegation-type link in `authority_chain_ref` (the
      terminal link, the one the executor claims to have exercised) has
      `grantee_principal_id` exactly equal to `executed_by_principal_id` (the
      cited chain actually terminates at the executor, not at a
      third party whose delegation identifier the executor merely
      copies);
    - **(PROMPT 6e)** each delegation link cited in
      `authority_chain_ref`, not only the terminal link, is either
      the terminal link itself, or one of its **real** ancestors,
      reachable by walking up `parent_delegation_id` from the terminal. A
      cited `delegation_id` that is not on this path, even if it is real
      and causally earlier (I19 does not reject it: I19 validates
      the existence and causal order of a reference, never
      that it belongs to the correct chain), is not a legitimate link of
      **this** chain: it is excluded from the debit for the delegation it
      designates, exactly as if it did not appear in the table. The
      first two conditions check *who* executed and *where* the chain
      terminates. This one checks that the rest of the table describes a
      single coherent chain up to that terminal, not a list
      of real but unrelated identifiers.

    The first two checks consult only fields already
    present and immutable on already ingested events (I3): no call
    to `resolveAuthority`/`validateChain`, no recursion. The third
    requires walking up `parent_delegation_id` from the terminal link:
    a structural walk-up already exists (`walkUpChain`,
    `src/engine/validateChain.ts`), but it lives on the decision path
    of `resolveAuthority` itself (and `validateChain.ts` already imports
    `remainingBudget` from `evaluateConstraints.ts` for the I5 bounding of
    `total_budget`. Importing `walkUpChain` in the reverse direction would create
    a circular dependency between the two modules). It also does
    more than necessary here (`schema_version` checks,
    `can_delegate`, I10 semantics designed for an authorization decision,
    not for a simple question of structural membership). The walk-up
    used here is therefore a local, minimal, distinct function: it only
    follows the `parent_delegation_id` pointers up to a root
    or a missing link, without revalidating anything else, with the
    same anti-cycle protection as I10 (depth bound, set of
    already visited identifiers) so as never to loop indefinitely on a
    maliciously constructed graph. Like the first two
    conditions, it never calls back into `resolveAuthority` or
    `evaluateConstraints`: the same asymptotic cost class as the
    already existing `remainingBudget` reads, no recursion.

    **Consistency with A5 (out-of-order delivery): do not reintroduce a
    `sequence` order.** This local walk-up compares **no** `sequence`
    between a link and its parent: it only follows
    `parent_delegation_id` by identifier match, exactly as
    `walkUpChain` already does for normal resolution (see I19,
    "Distinction from out-of-order delivery": a parent can carry a
    `sequence` greater than that of its child, and this remains perfectly
    valid). Adding an order constraint here that the rest of the engine
    imposes nowhere else would break this consistency for no reason: the
    question asked is only "is this `delegation_id` structurally
    on the path to the terminal," never "in what order did these
    events arrive."

    **What I20 does not guarantee.** These three conditions are necessary,
    not sufficient: they do not revalidate expiration, revocation,
    capability coverage, or the amount thresholds of the cited chain.
    Only a full resolution would do that, and that is precisely
    what I20 refuses to ask for again to avoid the recursion above. I20
    closes the vector "a third party wholly unrelated to the chain cites
    someone else's `delegation_id`," whether that third party is the claimed
    terminal link (PROMPT 6b) or an intermediate link slipped into an
    otherwise legitimate table (PROMPT 6e). An execution that fails
    one of these three checks is excluded from the debit **for the
    delegation concerned**, exactly as if the link at issue
    did not appear in `authority_chain_ref`. This is not a
    new output value, it is a corrected count that feeds C1 through C9
    normally.

    **Consistency with A24 (budget TOCTOU): I20 changes nothing about A24.**
    A24 documents that two individually `AUTHORIZED` decisions, made
    by the same legitimate holder, can together exceed `total_budget`
    for lack of reservation: this is a question of **timing** (two honest
    decisions, never reconciled before execution). I20 is a question
    of **identity** (a dishonest execution, never legitimately attached
    to the chain it cites). I20's two conditions are trivially
    satisfied in the A24 scenario (the same legitimate principal requests and
    executes, through their own delegation): I20 does not block, detect, or
    correct the A24 overrun, which remains an honest overrun between two
    executions that are each otherwise compliant with I20. The two invariants
    concern independent axes and do not contradict each other.

    Test: an `ACTION_EXECUTED` whose `executed_by_principal_id` differs
    from the `requesting_principal_id` of the `ACTION_REQUESTED` it cites, or
    whose terminal link in `authority_chain_ref` has a
    `grantee_principal_id` different from its own `executed_by_principal_id`,
    must never reduce the remaining `total_budget` of any delegation in
    this chain: an otherwise legitimate request within its actual holder's
    automatic band remains `AUTHORIZED`. An otherwise entirely
    legitimate `ACTION_EXECUTED` (executor equals requester, chain
    terminating correctly at them), but whose `authority_chain_ref` additionally
    cites the `delegation_id` of a real, causally earlier third party but
    **with no real ancestry link** to the terminal link, must never
    reduce that third party's `total_budget`: a legitimate request from that
    third party, within their own band, remains `AUTHORIZED`.

The following four invariants (I21 through I24) concern a distinct surface:
**capability issuance** (`issueCapability`/`issueCapabilityIdempotently`,
PR3 through PR4B-5A), an explicit command, COMMAND -> DECISION -> EVENT
DATA, rather than a question asked about the current state. It does
not introduce a third read operation: `authorityAt` and
`explainAction` remain the only two operations that answer a
question. `issueCapability` is a separate write path, which reuses
the same invoked-delegation resolution and the same capability model,
but which, on success, writes a `CAPABILITY_ISSUED` event fixing
this decision permanently.

21. **I21: The evaluation instant of an issuance command is explicit,
    never reconstructed.** `issueCapability` receives `authorityTime` as a
    separate, mandatory parameter, never a field of `IssueCapabilityCommand`,
    never a value derived from the last `authority_time` visible in the
    store. Reconstructing this instant from the log was a real defect:
    time can pass without any new event being logged, and
    this reconstruction made a delegation expired long ago
    look valid indefinitely, for lack of a later event to
    reveal it. `authorityTime` (the explicit trust instant) and
    `snapshotSequence` (causality: which events are visible)
    remain two independent axes, never conflated, on the same model
    as the `{atSequence, authorityTime}` pair of `authorityAt`.
    On an accepted issuance: `decision_sequence = snapshotSequence` (
    never derived from time); `authority_time = authorityTime`; and,
    since the `CAPABILITY_ISSUED` event is self-produced by Authority itself
    (the source of this event is the transaction's code, not an
    external system), `occurred_at = authorityTime` as well. This value
    represents the logical instant at which Authority made the decision and constructed
    the capability, never the instant at which the write was physically made
    durable. `recorded_at` remains the infrastructure clock, read separately,
    at the moment the store actually sees the event go by. No
    absolute ordering relationship between `recorded_at` and `occurred_at` is
    guaranteed. These are two clocks of a different nature, never compared
    against each other by the engine.

22. **I22: An issuance command refuses an explicit instant earlier than
    the trust boundary the transaction must preserve.** This is
    **not** an authority verdict: the agent may hold perfectly valid
    authority at that exact instant. It is a temporal consistency precondition
    of the command itself, distinct from the `LATE_OR_BACKDATED_EVENT_OBSERVED`
    diagnostic (I4), which never blocks any decision. This one
    blocks, deterministically, every time it applies. The public rule:
    - an issuance is refused with `STALE_AUTHORITY_TIME` when
      `authorityTime` is earlier than the trust time boundary that
      the issuance transaction (InMemory or PostgreSQL) must preserve for
      that store;
    - **at minimum**, this boundary can never be lower than the maximum
      of the `authority_time` values already canonically visible in the store,
      but this floor is not an exhaustive definition: the transaction remains
      free to preserve a stricter trust boundary than this sole
      canonical maximum (a transaction must never accept a value
      that it knows, by whatever means available to it, to already be
      exceeded);
    - a value equal to the applicable boundary is accepted, never refused;
    - a store with no canonical event has no maximum, so nothing
      in it is ever `STALE_AUTHORITY_TIME`;
    - no accepted issuance can result from a silent clamp of
      `authorityTime`: either the explicit value supplied is used
      as-is for `authority_time`/`occurred_at`/the expiration
      evaluation, or the issuance is refused. There is never a third
      path that would silently substitute another value;
    - no `CAPABILITY_ISSUED` is ever written for a command refused with
      `STALE_AUTHORITY_TIME`, exactly as for any other refusal (I24).
    Both backends (InMemory and PostgreSQL) enforce this guarantee at
    their own transactional boundary. See `THREAT_MODEL.md` for the
    corresponding defense.

23. **I23: Scope and permanence of an issuance command's idempotence.**
    The idempotency key is the triple `(authenticated_requester_id,
    operation, client_idempotency_key)`, never the raw key supplied by
    the caller alone, since two different authenticated callers
    could otherwise present the same raw key and collide.
    The first execution under a given key fixes the result of that key
    permanently, **including a refusal** (`STALE_AUTHORITY_TIME`
    or any other): this is the result that any later replay
    under the same key must reproduce identically. A new attempt
    under the same key, at a different `authorityTime`, never reevaluates anything.
    It replays the original result. `authorityTime` enters neither
    the comparison of commands, nor the scoping key itself,
    precisely so that a different `authorityTime` alone can never
    turn a legitimate replay into a conflict. A caller who genuinely wants
    a new decision must use a new key. The same
    key reused with a different command (a different `action_id` and/or
    `enforcement_point_id`) is an `IDEMPOTENCY_CONFLICT`: neither
    the old nor the new result is returned as if it were fine.
    The caller must resolve the conflict itself.

24. **I24: A capability issuance is visible only whole, never
    partial.** A success (canonical `CAPABILITY_ISSUED`) and its
    associated idempotency record become visible together, or
    neither does. A refusal, whatever the reason, never writes a
    `CAPABILITY_ISSUED`. `capability_id` is a protected business
    identifier: a collision (a forced or defective generator) is rejected
    fail-closed, and no success record is ever kept for an
    issuance thus rejected. This joint-visibility guarantee is qualified
    differently depending on the backend: PostgreSQL obtains it through a real
    ACID transaction (`BEGIN`/`COMMIT`/`ROLLBACK`). The InMemory
    implementation obtains it through strict serialization of calls
    on a single instance (a promise-queued mutex), with no
    crash-atomicity guarantee beyond what the in-memory model already implies.
    The two backends must never be presented as offering the same
    strength of guarantee at rest, only the same observable sequence of
    results in the absence of a crash.

## Additional application rules

These rules are not additional numbered invariants. They clarify
how the invariants above apply concretely, to eliminate any
gray area.

- **Trust anchor.** Every root `DELEGATION_CREATED`
  (`parent_delegation_id: null`) carries a `grantor_type` field valued
  `HUMAN_ROOT` or `AGENT`. `AUTHORIZED` requires the chain to go back to a root
  whose `grantor_type = HUMAN_ROOT`. A chain whose root is `AGENT` cannot
  be completed further up (a root's `parent_delegation_id` is always `null`
  by construction): it is a chain whose human provenance can never
  be established, so `UNKNOWN`, never `DENIED` (absence of authority is not
  proven, absence of proof of its presence is observed, cf. I1). For
  `authorityAt`, this `HUMAN_ROOT` must in addition be exactly the one asserted by
  `principalId` in the request: a valid `HUMAN_ROOT` root but different
  from `principalId` is `DENIED` for this specific request (positive proof that
  this `(agentId, principalId)` pair does not have authority), not `UNKNOWN`.
- **Systematic revalidation (I5, I12, I13, I14).** The resolver never
  assumes that ingestion correctly validated an event: at every
  `authorityAt()` call, it reevaluates I5, I12, I13, and I14 itself from
  the sole content of the canonical store up to the evaluation `sequence`. Ingestion may
  reject an event whose violation is provable with the canonical state
  known at the time of ingestion (it then never enters the canonical
  store, see the separation below). But an event that is structurally
  valid but references a link not yet known at ingestion time (out-of-order
  delivery, A5) enters the canonical store with no final authority judgment,
  and it is resolution that decides, with all information available at its
  own `sequence`.
- **Separation of canonical store and security log (refines I3 and I8).**
  `authorityAt()` never reads anything but the canonical store. An event whose
  ingestion provably fails (`event_id` conflict: I8; business-ID
  collision; proven violation of I12/I13/I14 with the canonical state already
  known) is **never** written to the canonical store: it is written only to the
  security log (see `EVENT_MODEL.md`), which is never consulted by
  `authorityAt()`. This withdraws the earlier, inconsistent promise that
  "any evaluation involving this `event_id` returns `UNKNOWN`" persistently:
  only the synchronous response to the conflicting ingestion attempt is `UNKNOWN`.
  Future resolutions, which never see the rejected event, have no reason
  to be `UNKNOWN` because of it.
- **`ingestAll` is a stateless test helper, not the event store**
  (PROMPT 3b). It demonstrates the behavior of ingestion boundaries (I8,
  business ID uniqueness, I12/I13/I14, schema/PII rejection) one batch at a time,
  always restarting from `sequence = 1`. This is not the persistence
  the architecture targets. A future prompt's `EventStore` will have: the
  next `sequence` counter, continuous across successive
  appends (a store that has already accepted sequences 1..50 numbers a
  new append 51..80, never restarting at 1); `recorded_at` from
  its own infrastructure clock; `authority_time` from the
  same trusted-clock dependency, applied over the store's entire
  lifetime rather than a single batch; `event_id` and business ID
  uniqueness checked against the full history, not just the current batch.
  See `src/engine/ingest.ts` for the detailed contract of this clock
  dependency.
- **Multi-path rule.** If several distinct delegation chains lead to the
  same requesting principal, it suffices that **only one** of them be
  fully valid (every link authorized, not expired, not revoked, capability
  covered, depth respected) for the decision to be `AUTHORIZED`. The
  presence of other corrupted, revoked, cyclic, or too-deep chains
  does not affect this result. This prevents an attacker from neutralizing legitimate
  authority by injecting a parasitic chain to trigger `UNKNOWN` through
  fail-closed. In exchange, no chain is ever relied upon on the basis of
  "there probably exists another path": the chain relied upon must be
  demonstrated valid over its entire length, under the same rules as if it were
  unique.
- **Semantics of `total_budget` (non-exceedance, not reservation).** Targeted
  property: at no `sequence` S does the sum of `parameters.amount` across all
  `ACTION_EXECUTED` events attributable to a delegation D and all its descendants
  (those whose `authority_chain_ref` passes through D) exceed `D.total_budget`,
  when `D.total_budget` is declared. Each execution is counted against
  **all** bounded ancestors of its chain that declare a `total_budget`, not
  only the terminal delegation directly invoked by the `ACTION_REQUESTED`.
  V0 provides **no capacity reservation guarantee**: two concurrent
  evaluations bearing on the same canonical state, before either
  execution is recorded, can each be individually
  `AUTHORIZED` and exceed `total_budget` once combined (budget TOCTOU,
  see A24 in `THREAT_MODEL.md`). What V0 guarantees is that `remaining(D, S)`
  remains always computable deterministically and honestly from the sole
  canonical store, including negative (observed overrun), and that this
  overrun, once observed, is reported by `explain()` without being
  concealed or past decisions rewritten (I3): V0 identifies the inconsistency
  after ingestion of the executions, it does not prevent it beforehand.
- **Budget debiting and fixedness of `authority_chain_ref`.** The resolver can
  discover several valid chains toward the same principal (multi-path rule,
  above), but an `ACTION_EXECUTED` references one concrete and unique chain
  in `authority_chain_ref`, fully valid at `decision_sequence`. It is
  exclusively that chain, and the bounded ancestors it contains, that are
  debited for `total_budget`. `authority_chain_ref` is fixed at the moment of
  execution and is never recomputed or reassigned afterward (I3): an agent
  cannot invoke a different valid chain toward the same principal on the sole
  grounds that it would have more budget remaining.
- **Scope of a denial (`APPROVAL_DENIED`).** A denial targets a specific
  `APPROVAL_REQUESTED`, identified by its `approval_id`, never an
  `action_fingerprint` on a permanent basis. A new `APPROVAL_REQUESTED` carrying a
  different `approval_id`, even for an action with an identical
  `action_fingerprint` (same capability, same amount, same recipient), is
  admissible and is evaluated independently (a new instance of C4).
  `action_fingerprint` is never a permanent blacklist: making it one would
  amount to inventing a business policy (block duration, scope, exceptions) that V0
  does not specify. It is precisely for this reason that `authorityAt`
  (prospective, with no `actionId`) never consults `APPROVAL_DENIED`: a
  denial only makes sense attached to the specific action it concerns, and
  only `explainAction` has that action in hand.
- **Revocation is not invalidation.** `DELEGATION_REVOKED` means "this delegation
  was valid and ceases to be so from this `sequence` onward." It never
  means "this delegation should never have existed" (issuance error,
  compromise at the moment of creation). This second case, retroactive
  invalidation of an event erroneous from the start, is **not implemented in V0**
  and would require a distinct event type (`EVENT_INVALIDATED`, an unspecified
  future extension). V0 claims to handle only revocation.

## Exhaustive condition to output table

No condition below produces "DENIED or UNKNOWN depending on context":
each row has a single deterministic output. Unless stated otherwise, each
row applies to `authorityAt` (a prospective question on a fingerprint). C5
and C6 are by nature questions about a specific, already requested action and
belong to `explainAction`. Their `DENIED` is to be read as `currentAuthority`
or `execution.authorityAtDecision` for that action, never as a response
that `authorityAt` could produce from the fingerprint alone (an
`APPROVAL_DENIED` never turns a prospective question into
`DENIED`: see "`authorityAt`: prospective question" above).

| # | Condition | Output |
|---|---|---|
| C1 | Complete chain, all links authorized (I12/I13/I14), not expired (`authority_time`), not revoked by an authorized revocation, capability covered exactly, precise expected `HUMAN_ROOT` root, no amount involved | `AUTHORIZED` |
| C2 | Same as C1, with amount ≤ `automatic_max_amount` of the invoked link | `AUTHORIZED` |
| C3 | Same as C1, amount between `automatic_max_amount` (excluded) and `approval_max_amount` (included), a valid `APPROVAL_GRANTED` (I14) exists whose fingerprint corresponds exactly (I15) to `(capability, parameters)` and which is not already consumed (I16) | `AUTHORIZED` |
| C4 | Same as C3, but no valid, unconsumed `APPROVAL_GRANTED` exists for this fingerprint (whether or not there was, separately, an `APPROVAL_DENIED` for a different action carrying the same fingerprint, see "eternal blacklist") | `REQUIRES_APPROVAL` |
| C5 *(explainAction)* | The specific action being explained received, for its own `APPROVAL_REQUESTED`, a valid `APPROVAL_DENIED` (I14), and no valid, unconsumed `APPROVAL_GRANTED` otherwise covers its fingerprint | `DENIED` (for `currentAuthority` of this action) |
| C6 *(explainAction)* | The `ACTION_EXECUTED` of the explained action carries an `action_fingerprint` different from the immutable fingerprint of its `ACTION_REQUESTED` (I15) | `DENIED` (for `execution.authorityAtDecision`, regardless of authority for the actually executed fingerprint otherwise) |
| C7 | A valid `APPROVAL_GRANTED` with the correct fingerprint exists for `(capability, parameters)`, but it is already consumed by an `ACTION_EXECUTED` with an equal or lower `sequence` (I16), and no other valid, unconsumed approval covers the same fingerprint | `DENIED` |
| C8 | Amount > `approval_max_amount` of the invoked link | `DENIED` |
| C9 | `total_budget` declared on one or more bounded ancestors of the invoked chain (not only the terminal delegation), and requested amount > available remainder of at least one of these ancestors, computed independently for each, at the evaluation `sequence` | `DENIED` |
| C10 | A link in the chain references a `delegation_id` absent from the canonical store at the evaluation `sequence` | `UNKNOWN` |
| C11 | Complete and known chain, but no capability in the chain matches the requested capability exactly | `DENIED` |
| C12 | Authorized `DELEGATION_REVOKED` (I13) with `sequence` ≤ that of the evaluation, targeting a link on which the chain depends exclusively | `DENIED` |
| C13 | `DELEGATION_REVOKED` whose issuer is neither the direct grantor nor the chain root (I13 not satisfied) | No effect: the chain is evaluated as if this revocation did not exist |
| C14 | `SUBDELEGATION_CREATED` whose issuer != the parent's grantee, or whose parent has a known `can_delegate: false` (I12) | `DENIED` |
| C15 | `SUBDELEGATION_CREATED` whose parent carries no `can_delegate` field (absent) | `UNKNOWN` |
| C16 | `APPROVAL_GRANTED`/`APPROVAL_DENIED` whose issuer != entitled grantor (I14) | No effect: treated as if no approval decision existed |
| C17 | Chain root (`parent_delegation_id: null`) with `grantor_type: AGENT` | `UNKNOWN` |
| C18 | Cycle detected in the `delegation_id` chain | `UNKNOWN` (`C18_CYCLE_DETECTED`) |
| C19 | Chain depth > `MAX_CHAIN_DEPTH` (32 delegation edges, see I10) | `UNKNOWN` (`MAX_CHAIN_DEPTH_EXCEEDED`); a chain of exactly 32 edges is **not** concerned by this row and resolves normally |
| C20 | `event_id` conflict detected at ingestion (I8) | `UNKNOWN` as a direct response to this ingestion attempt; no effect on later resolutions |
| C21 | Business ID collision (`delegation_id`/`action_id`/`approval_id` already used by different content) | The colliding event is rejected at ingestion; `UNKNOWN` in response to this attempt, with no effect on later resolutions |
| C22 | Unknown or unrecognized constraint type present in a delegation payload, or unknown `schema_version` carried by an event | `UNKNOWN`, but **only** for any resolution that actually depends on this specific event; an unrelated event with an unknown `schema_version` elsewhere in the store does not affect any independent resolution |
| C23 | Several distinct chains toward the same principal, at least one fully valid under C1 through C9 | The output of the valid chain applies (the other chains, even corrupted or cyclic, never lower this result) |
| C24 | None of the chains leading to the principal is fully valid and known | `UNKNOWN` (or `DENIED` if at least one chain is fully known and positively proves the absence of authority, per C11/C12) |
| C25 *(explainAction, I18)* | `ACTION_EXECUTED` with `sequence` S carrying `decision_sequence >= S` (causally impossible citation of a future or simultaneous decision point) | `UNKNOWN` (for `execution.authorityAtDecision`; `C25_FUTURE_DECISION_SEQUENCE`), regardless of authority otherwise available at the claimed `decision_sequence` |
| C26 *(I19)* | `APPROVAL_GRANTED`/`APPROVAL_DENIED` whose referenced `action_id` or `approval_id` does not exist in the canonical store, or exists there with a `sequence` strictly greater than that of the approval decision itself (equality tolerated: this can never occur through real ingestion anyway, see I19, "Note on sequence equality") | Treated as if the cited event did not exist: the approval decision is ignored (as with C16). `REQUIRES_APPROVAL` (C4) remains the output in the absence of any other valid approval decision. **Does not apply** to `SUBDELEGATION_CREATED.parent_delegation_id`: this field remains governed by C10 alone (A5, see I19 for the distinction) |
| C27 *(I20)* | `ACTION_EXECUTED` whose `executed_by_principal_id` differs from the `requesting_principal_id` of the `ACTION_REQUESTED` with the same `action_id`; or whose terminal delegation link in `authority_chain_ref` has a `grantee_principal_id` different from its own `executed_by_principal_id`; or citing a delegation link D in `authority_chain_ref` that is neither the terminal link nor one of its real ancestors reachable by walking up `parent_delegation_id` from the terminal (PROMPT 6e) | For the first and second conditions: the entire execution is excluded from the computation of `remaining(D', S)` for every delegation D' in its chain. For the third: only the link D at issue is excluded from the computation of `remaining(D, S)`, counted as if this specific link did not appear in `authority_chain_ref`, without affecting the debit of the other links of the same chain that are, themselves, real ancestors of the terminal. Affects no output other than the amount of remaining budget, which then feeds C9 normally |
| C28 *(I16, clarified)* | `ACTION_EXECUTED` referencing a valid `approval_id` in `authority_chain_ref`, but whose own `action_id` differs from the one carried by the corresponding `APPROVAL_GRANTED` | Never consumes this `approval_id`: treated as if it did not reference it in its chain. A fresh question on the actually approved fingerprint remains `AUTHORIZED` (C3) as long as no execution of the action actually covered has consumed the grant |
