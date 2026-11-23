-- authority-graph — Postgres schema (PROMPT 4, point 3).
--
-- This file is a JOURNAL schema, nothing else. It intentionally contains:
--   - no trigger,
--   - no view,
--   - no stored procedure,
--   - no CHECK constraint or generated column that computes or approximates
--     an authority decision (I5/I9/I10/I12/I13/I14/... all live in
--     src/engine/*.ts, in TypeScript, and nowhere else).
--
-- The only invariants enforced here are storage-level ones that have nothing
-- to do with WHO is allowed to do WHAT: event_id uniqueness, sequence
-- uniqueness/ordering, and append-only-ness (no UPDATE/DELETE statement
-- appears anywhere in this codebase against these tables — see
-- src/storage/postgresEventStore.ts).
--
-- This file creates the tables and grants nothing. Run it as a migration/
-- owner role, then run src/storage/roles.sql: that file is what stops the
-- application role from UPDATE/DELETE/TRUNCATE (P2A, ROADMAP.md). The
-- application must not connect as the owner of these tables or as a
-- superuser.

CREATE TABLE IF NOT EXISTS authority_events (
  sequence        BIGINT PRIMARY KEY,
  event_id        TEXT NOT NULL UNIQUE,
  event_type      TEXT NOT NULL,
  principal_id    TEXT NOT NULL,
  schema_version  INTEGER NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL,
  authority_time  TIMESTAMPTZ NOT NULL,
  recorded_at     TIMESTAMPTZ NOT NULL,
  assurance_level TEXT NOT NULL,
  -- The event's own payload, exactly as defined by the discriminated union
  -- in src/domain/events.ts. Stored opaquely: Postgres never inspects,
  -- indexes into, or reasons about individual payload fields for the
  -- purpose of making an authority decision.
  payload         JSONB NOT NULL
);

-- Read-path indexes only (EventSource.getEvents' two filter dimensions).
-- Neither index encodes anything about which principal may do what.
CREATE INDEX IF NOT EXISTS authority_events_event_type_idx ON authority_events (event_type);
CREATE INDEX IF NOT EXISTS authority_events_principal_id_idx ON authority_events (principal_id);

-- The security log (SPEC.md, "Séparation store canonique / journal de
-- sécurité"): drafts rejected at ingestion. A row here never carries a
-- `sequence` — a rejected draft never acquires one (I3/I8).
CREATE TABLE IF NOT EXISTS security_log (
  id            BIGSERIAL PRIMARY KEY,
  event_id      TEXT NOT NULL,
  payload_hash  TEXT NOT NULL,
  reason_code   TEXT NOT NULL,
  recorded_at   TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS security_log_event_id_idx ON security_log (event_id);

-- PR4B-3B: an independent, storage-level backstop for capability_id
-- uniqueness — computed directly from the existing JSONB payload, not a
-- denormalized column. There is therefore no second source of truth to
-- keep in sync: this index and `payload->>'capability_id'` can never
-- disagree, because the index IS that expression. This is deliberately in
-- ADDITION to, not instead of, the application-level check
-- (src/engine/ingest.ts's businessIdOf, which already treats capability_id
-- as a business id under the shared global lock and is what
-- issueCapability's transaction actually observes as the deterministic
-- CAPABILITY_ID_COLLISION business outcome). This index is the last-resort
-- guarantee for a path that bypasses that check entirely (a raw SQL
-- insert, a migration, a future code path around ingest.ts) — it would
-- surface as a raw constraint violation, not a business outcome, and is
-- not expected to ever actually fire in normal operation. A denormalized
-- `capability_id` column was considered and rejected for V0: it would add
-- a second place capability_id lives, with its own synchronization
-- invariant to maintain on every insert, for no additional guarantee this
-- expression index does not already provide.
CREATE UNIQUE INDEX IF NOT EXISTS authority_events_capability_id_uidx
  ON authority_events ((payload ->> 'capability_id'))
  WHERE event_type = 'CAPABILITY_ISSUED';

-- V1 (PR 2): at most one CAPABILITY_REDEEMED row per capability, enforced by
-- the database itself. Like the capability_id index above, it is computed from
-- the existing JSONB payload (no denormalized column, no second source of
-- truth) and is the LAST-RESORT guarantee: the redemption transaction already
-- reads the log under the writer lock and refuses a second redemption; this
-- index turns any path that bypasses both (a raw INSERT, a writer that does not
-- take the lock) into a unique violation instead of a second row. Additive and
-- idempotent: IF NOT EXISTS, no existing row is touched, and an installation
-- that holds no CAPABILITY_REDEEMED rows (every installation before V1) accepts
-- it. Re-applying this file is the migration.
CREATE UNIQUE INDEX IF NOT EXISTS authority_events_redeemed_capability_id_uidx
  ON authority_events ((payload ->> 'capability_id'))
  WHERE event_type = 'CAPABILITY_REDEEMED';

-- I32 (D36): at most one CAPABILITY_ISSUED row per action, definitively: an
-- expired or redeemed ticket does not free the action. Same design as the two
-- indexes above: computed from the existing JSONB payload, additive, idempotent
-- (IF NOT EXISTS), and the LAST-RESORT guarantee: the issuance transaction
-- already decides under the writer lock and refuses a second ticket
-- (ACTION_ALREADY_TICKETED); this index turns any path that bypasses both (a raw
-- INSERT, a writer that does not take the lock) into a unique violation.
--
-- MIGRATION: an installation written before I32 may already hold several tickets
-- for one action (the engine allowed it). The index cannot be created over such
-- rows and nothing is rewritten: this block refuses, once, with the offending
-- action ids, so that the operator decides (the journal is append-only). Nothing
-- is checked again once the index exists.
DO $$
DECLARE
  offenders text;
BEGIN
  IF to_regclass('authority_events_ticketed_action_id_uidx') IS NULL THEN
    SELECT string_agg(action_id || ' (' || n || ' tickets)', ', ' ORDER BY action_id) INTO offenders
      FROM (SELECT payload ->> 'action_id' AS action_id, count(*) AS n
              FROM authority_events
             WHERE event_type = 'CAPABILITY_ISSUED'
             GROUP BY payload ->> 'action_id'
            HAVING count(*) > 1) d;
    IF offenders IS NOT NULL THEN
      RAISE EXCEPTION 'I32: cannot create authority_events_ticketed_action_id_uidx: several CAPABILITY_ISSUED rows exist for the same action: %', offenders
        USING HINT = 'The journal is append-only and is not rewritten. See docs/v1/DECISIONS.md (D36) for the migration options.';
    END IF;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS authority_events_ticketed_action_id_uidx
  ON authority_events ((payload ->> 'action_id'))
  WHERE event_type = 'CAPABILITY_ISSUED';

-- PR4B-3B: idempotency persistence for the ISSUE_CAPABILITY command. This
-- table is NOT part of the append-only canonical journal above — it
-- records the OUTCOME of a command (successful or rejected), not an
-- authority event. `result` is the source of truth a replay returns
-- verbatim; `command` is stored so a differing retry under the same scope
-- can be detected as IDEMPOTENCY_CONFLICT (the same comparison
-- src/engine/issueCapabilityIdempotency.ts's commandsEqual already makes
-- for the InMemory model). `event_id`/`capability_id`/`sequence` are
-- nullable audit/cross-check columns only — a rejected command has none of
-- them, and even for a successful one, `result` alone is what a replay
-- reads; these three exist so an operator can join back to
-- `authority_events` without parsing JSONB. `created_at` is diagnostic
-- infrastructure only (mirrors `recorded_at`'s own role above) — it is
-- never read by any authority decision, never used as authority_time, and
-- never used to compute an expiration.
CREATE TABLE IF NOT EXISTS capability_issuance_idempotency (
  authenticated_requester_id TEXT NOT NULL,
  operation                  TEXT NOT NULL,
  client_idempotency_key     TEXT NOT NULL,
  command                    JSONB NOT NULL,
  result                     JSONB NOT NULL,
  event_id                   TEXT,
  capability_id              TEXT,
  sequence                   BIGINT,
  created_at                 TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (authenticated_requester_id, operation, client_idempotency_key)
);
