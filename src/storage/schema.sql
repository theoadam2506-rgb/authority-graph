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
