/**
 * Ingestion core — I3/I8: turns source-authored drafts into canonical events,
 * assigning sequence/authority_time/recorded_at (never supplied by a
 * source), deduplicating by event_id (I8), rejecting business-id collisions
 * and ingestion-time-provable I12/I13/I14 violations into the security log —
 * never into the canonical store (SPEC.md, "Séparation store canonique /
 * journal de sécurité").
 *
 * Pure: no I/O, no Date.now(), no global state, no mutation of its inputs.
 *
 * TRUSTED CLOCK (PROMPT 3b): `authority_time` is never derived from
 * `occurred_at`. `occurred_at` is source-declared and untrustworthy by
 * construction (I4) — deriving a decisional clock from it, even "just for
 * test determinism", reintroduces exactly the backdating risk I4 exists to
 * prevent. Instead, the trusted clock is an explicit dependency the caller
 * supplies (`clock.authorityTime`): in production, the admission layer
 * reads its own trusted source and calls this with the result; in tests,
 * fixed values are injected.
 *
 * TWO CONSUMERS, ONE CORE (PROMPT 4): `processDraft` is the actual per-draft
 * decision (I8 dedup, schema/PII rejection, business-id collision,
 * I12/I13/I14) applied to an `IngestionState`. `ingestAll` below is the
 * original stateless test helper (PROMPT 3b, point 6) — it still exists
 * unchanged in behavior and signature, folding `processDraft` over a batch
 * starting from `EMPTY_INGESTION_STATE` every call, restarting sequence
 * numbering at 1 each time. `src/storage/eventStore.ts` is the *other*
 * consumer: it keeps an `IngestionState` alive across many `append()` calls
 * (or rebuilds one from persisted rows, via `rebuildIngestionState`), so the
 * exact same I8/I12/I13/I14 logic enforces uniqueness against the *whole*
 * history rather than one batch, and sequence numbers continue rather than
 * restart. Neither consumer duplicates this logic.
 */
import { createHash } from "node:crypto";
import { toDraft, type AuthorityEvent, type CanonicalStore, type DraftAuthorityEvent } from "../domain/events.js";
import {
  CURRENT_SCHEMA_VERSION,
  iso8601,
  sequenceNumber,
  type ActionId,
  type DelegationId,
  type IngestOutcome,
  type IngestRejectionCode,
  type Iso8601,
  type SecurityLogEntry,
} from "../domain/types.js";

type DelegationLikeEvent = Extract<AuthorityEvent, { readonly event_type: "DELEGATION_CREATED" | "SUBDELEGATION_CREATED" }>;
type EventBody = AuthorityEvent | DraftAuthorityEvent;

/**
 * The trusted-clock dependency (PROMPT 3b). Called once per draft, in batch
 * order, with the draft itself and its index — a real admission layer would
 * ignore both arguments and simply return its own current trusted reading;
 * tests may vary the value per index to model time passing between events.
 */
export interface IngestionClock {
  readonly authorityTime: (draft: DraftAuthorityEvent, index: number) => Iso8601;
}

function hashDraft(draft: DraftAuthorityEvent): string {
  return createHash("sha256").update(JSON.stringify(draft), "utf8").digest("hex");
}

function looksLikeEmail(value: string): boolean {
  return value.includes("@");
}

type BusinessId = { readonly kind: "delegation_id" | "action_id" | "approval_id"; readonly value: string };

function businessIdOf(event: EventBody): BusinessId | undefined {
  if (event.event_type === "DELEGATION_CREATED" || event.event_type === "SUBDELEGATION_CREATED") {
    return { kind: "delegation_id", value: event.payload.delegation_id };
  }
  if (event.event_type === "ACTION_REQUESTED") {
    return { kind: "action_id", value: event.payload.action_id };
  }
  if (event.event_type === "APPROVAL_REQUESTED") {
    return { kind: "approval_id", value: event.payload.approval_id };
  }
  return undefined;
}

function businessIdKey(id: BusinessId): string {
  return `${id.kind}:${id.value}`;
}

function findDelegation(id: DelegationId, store: readonly AuthorityEvent[]): DelegationLikeEvent | undefined {
  for (const event of store) {
    if (
      (event.event_type === "DELEGATION_CREATED" || event.event_type === "SUBDELEGATION_CREATED") &&
      event.payload.delegation_id === id
    ) {
      return event;
    }
  }
  return undefined;
}

function findRootGrantor(id: DelegationId, store: readonly AuthorityEvent[]): AuthorityEvent["principal_id"] | undefined {
  const visited = new Set<DelegationId>();
  let current = findDelegation(id, store);
  while (current !== undefined && current.event_type === "SUBDELEGATION_CREATED") {
    if (visited.has(current.payload.delegation_id)) {
      return undefined;
    }
    visited.add(current.payload.delegation_id);
    current = findDelegation(current.payload.parent_delegation_id, store);
  }
  return current?.payload.grantor_principal_id;
}

function findActionRequested(id: ActionId, store: readonly AuthorityEvent[]) {
  for (const event of store) {
    if (event.event_type === "ACTION_REQUESTED" && event.payload.action_id === id) {
      return event;
    }
  }
  return undefined;
}

/**
 * Best-effort I12/I13/I14 check using only the canonical store as currently
 * known. A definitive, provable violation is rejected outright (never
 * reaches the canonical store — it never acquires a canonical sequence). A
 * structurally valid event whose authority cannot yet be judged (its
 * referenced delegation/action has not arrived yet — out-of-order delivery,
 * A5) is accepted without prejudice: the resolver (validateChain)
 * revalidates it independently at every resolution regardless of what
 * ingestion concluded.
 */
function ingestionAuthorityFailure(draft: DraftAuthorityEvent, store: readonly AuthorityEvent[]): IngestRejectionCode | undefined {
  if (draft.event_type === "SUBDELEGATION_CREATED") {
    const parent = findDelegation(draft.payload.parent_delegation_id, store);
    if (parent === undefined) {
      return undefined;
    }
    const parentGrantee = parent.payload.grantee_principal_id;
    const authorized =
      draft.principal_id === parentGrantee && draft.payload.grantor_principal_id === parentGrantee && parent.payload.can_delegate === true;
    return authorized ? undefined : "UNAUTHORIZED_SUBDELEGATION";
  }
  if (draft.event_type === "DELEGATION_REVOKED") {
    const target = findDelegation(draft.payload.delegation_id, store);
    if (target === undefined) {
      return undefined;
    }
    const directGrantor = target.payload.grantor_principal_id;
    const rootGrantor = findRootGrantor(draft.payload.delegation_id, store);
    const authorized = draft.principal_id === directGrantor || (rootGrantor !== undefined && draft.principal_id === rootGrantor);
    return authorized ? undefined : "UNAUTHORIZED_REVOCATION";
  }
  if (draft.event_type === "APPROVAL_GRANTED" || draft.event_type === "APPROVAL_DENIED") {
    const request = findActionRequested(draft.payload.action_id, store);
    if (request === undefined) {
      return undefined;
    }
    const delegation = findDelegation(request.payload.delegation_id, store);
    if (delegation === undefined) {
      return undefined;
    }
    const habilitatedGrantor = delegation.payload.grantor_principal_id;
    const decider = draft.event_type === "APPROVAL_GRANTED" ? draft.payload.approving_principal_id : draft.payload.denying_principal_id;
    const authorized = draft.principal_id === habilitatedGrantor && decider === habilitatedGrantor;
    return authorized ? undefined : "UNAUTHORIZED_APPROVAL_DECISION";
  }
  return undefined;
}

function buildIngestedEvent(draft: DraftAuthorityEvent, sequence: number, trustedTimeIso: string, recordedAtIso: string): AuthorityEvent {
  return {
    ...draft,
    sequence: sequenceNumber(sequence),
    authority_time: iso8601(trustedTimeIso),
    recorded_at: iso8601(recordedAtIso),
    assurance_level: "ASSERTED_UNVERIFIED",
  };
}

// ---------------------------------------------------------------------------
// Shared ingestion state and per-draft core (PROMPT 4)
// ---------------------------------------------------------------------------

export interface IngestionState {
  readonly canonicalStore: CanonicalStore;
  readonly seenByEventId: ReadonlyMap<string, { readonly draft: DraftAuthorityEvent; readonly sequence: number }>;
  readonly seenBusinessIds: ReadonlySet<string>;
}

export const EMPTY_INGESTION_STATE: IngestionState = {
  canonicalStore: [],
  seenByEventId: new Map(),
  seenBusinessIds: new Set(),
};

/** Rebuilds an `IngestionState` from already-accepted, persisted events (PROMPT 4: used by EventStore backends that reload history rather than keep it resident). */
export function rebuildIngestionState(events: CanonicalStore): IngestionState {
  const seenByEventId = new Map<string, { readonly draft: DraftAuthorityEvent; readonly sequence: number }>();
  const seenBusinessIds = new Set<string>();
  for (const event of events) {
    seenByEventId.set(event.event_id, { draft: toDraft(event), sequence: event.sequence });
    const businessId = businessIdOf(event);
    if (businessId !== undefined) {
      seenBusinessIds.add(businessIdKey(businessId));
    }
  }
  return { canonicalStore: events, seenByEventId, seenBusinessIds };
}

export interface DraftProcessingResult {
  readonly outcome: IngestOutcome;
  readonly securityLogEntry?: SecurityLogEntry;
  readonly nextState: IngestionState;
}

/**
 * The single per-draft decision: I8 dedup, schema/PII rejection, business-id
 * collision, then I12/I13/I14 (`ingestionAuthorityFailure`). `trustedTimeIso`
 * is expected to already be resolved (and, for callers folding a batch,
 * clamped monotone — see `advanceTrustedTime`) by the caller: this function
 * itself does not know about "the previous draft in the batch".
 *
 * `recordedAtIso` is a separate infrastructure-clock reading for
 * `recorded_at` (diagnostic only, never decisional — I4). It defaults to
 * `trustedTimeIso` so `ingestAll` (which has no infrastructure clock of its
 * own to read) keeps its exact existing behavior; `EventStore` backends pass
 * their own genuine reading instead.
 */
export function processDraft(
  state: IngestionState,
  draft: DraftAuthorityEvent,
  trustedTimeIso: string,
  recordedAtIso: string = trustedTimeIso,
): DraftProcessingResult {
  const rejected = (reasonCode: IngestRejectionCode): DraftProcessingResult => ({
    outcome: { accepted: false, reasonCode },
    securityLogEntry: {
      eventId: draft.event_id,
      payloadHash: hashDraft(draft),
      reasonCode,
      recordedAt: iso8601(recordedAtIso),
    },
    nextState: state,
  });

  const alreadySeen = state.seenByEventId.get(draft.event_id);
  if (alreadySeen !== undefined) {
    if (hashDraft(alreadySeen.draft) === hashDraft(draft)) {
      return { outcome: { accepted: true, sequence: sequenceNumber(alreadySeen.sequence) }, nextState: state };
    }
    return rejected("EVENT_ID_CONFLICT");
  }

  if (draft.schema_version !== CURRENT_SCHEMA_VERSION) {
    return rejected("UNKNOWN_SCHEMA_VERSION");
  }

  // I11: reject recognizable PII shapes at the door. This is not, and cannot
  // be, a guarantee that no PII reaches the graph (I17 honesty) — only a
  // rejection of explicitly-recognized forms (SPEC.md I11).
  if (looksLikeEmail(draft.principal_id)) {
    return rejected("UNKNOWN_SCHEMA_VERSION");
  }

  const businessId = businessIdOf(draft);
  if (businessId !== undefined && state.seenBusinessIds.has(businessIdKey(businessId))) {
    return rejected("BUSINESS_ID_COLLISION");
  }

  const authorityFailure = ingestionAuthorityFailure(draft, state.canonicalStore);
  if (authorityFailure !== undefined) {
    return rejected(authorityFailure);
  }

  const sequence = state.canonicalStore.length + 1;
  const newEvent = buildIngestedEvent(draft, sequence, trustedTimeIso, recordedAtIso);
  const nextSeenByEventId = new Map(state.seenByEventId);
  nextSeenByEventId.set(draft.event_id, { draft, sequence });
  const nextSeenBusinessIds = businessId === undefined ? state.seenBusinessIds : new Set(state.seenBusinessIds).add(businessIdKey(businessId));

  return {
    outcome: { accepted: true, sequence: sequenceNumber(sequence) },
    nextState: {
      canonicalStore: [...state.canonicalStore, newEvent],
      seenByEventId: nextSeenByEventId,
      seenBusinessIds: nextSeenBusinessIds,
    },
  };
}

/**
 * Clamps a freshly-supplied trusted-time reading against the last one
 * assigned, guaranteeing the EVENT_MODEL.md monotone-non-decreasing
 * property regardless of what the clock dependency itself returns.
 */
export function advanceTrustedTime(lastMs: number | undefined, suppliedIso: string): { readonly ms: number; readonly iso: string } {
  const suppliedMs = Date.parse(suppliedIso);
  const ms = lastMs === undefined ? suppliedMs : Math.max(suppliedMs, lastMs);
  return { ms, iso: new Date(ms).toISOString() };
}

// ---------------------------------------------------------------------------
// ingestAll — stateless test helper (PROMPT 3b, point 6; kept verbatim in
// behavior and signature for PROMPT 4: the 88 pre-existing tests depend on
// it). Not the EventStore — see src/storage/eventStore.ts.
// ---------------------------------------------------------------------------

export interface IngestionResult {
  readonly outcomes: readonly IngestOutcome[];
  readonly canonicalStore: CanonicalStore;
  readonly securityLog: readonly SecurityLogEntry[];
}

export function ingestAll(drafts: readonly DraftAuthorityEvent[], clock: IngestionClock): IngestionResult {
  let state: IngestionState = EMPTY_INGESTION_STATE;
  const outcomes: IngestOutcome[] = [];
  const securityLog: SecurityLogEntry[] = [];
  let lastTrustedTimeMs: number | undefined;

  for (const [index, draft] of drafts.entries()) {
    const advanced = advanceTrustedTime(lastTrustedTimeMs, clock.authorityTime(draft, index));
    lastTrustedTimeMs = advanced.ms;

    const result = processDraft(state, draft, advanced.iso);
    outcomes.push(result.outcome);
    if (result.securityLogEntry !== undefined) {
      securityLog.push(result.securityLogEntry);
    }
    state = result.nextState;
  }

  return { outcomes, canonicalStore: state.canonicalStore, securityLog };
}
