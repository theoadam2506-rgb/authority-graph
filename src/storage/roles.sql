-- authority-graph — Postgres role boundary (P2A, see ROADMAP.md).
--
-- Run this file AFTER schema.sql, as the role that owns the tables (the
-- "migration role") or as a superuser. It is idempotent: it can be applied
-- to a fresh database and re-applied to an existing one. Apply it in a
-- single transaction (`psql --single-transaction -f src/storage/roles.sql`)
-- so that a refusal below leaves nothing half-applied.
--
-- Boundary: the application connects as a login role that is a MEMBER of
-- `authority_app` and nothing else. `authority_app` can SELECT and INSERT on
-- the journal tables; it has no UPDATE, DELETE, TRUNCATE, REFERENCES or
-- TRIGGER privilege on them, and no ownership. The login role must not be a
-- superuser, must not own the tables, and must not inherit any other role
-- with such privileges. This file refuses (RAISE EXCEPTION) when it can see
-- that the boundary does not hold for `authority_app`; the same check for the
-- actual login role is `src/storage/append_only_check.sql`.
--
-- This is a permission boundary against a compromised or buggy APPLICATION
-- ROLE. It is not a defense against a superuser, the table owner, the
-- database owner, or anyone who controls the infrastructure: those can
-- still modify or drop the journal.
--
-- Like schema.sql, it contains no trigger, view, or stored procedure.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authority_app') THEN
    CREATE ROLE authority_app NOLOGIN;
  END IF;
END
$$;

-- `authority_app` is a group role: the credential-bearing login role is a
-- member of it, created and given a password by the operator, e.g.
--   CREATE ROLE authority_login LOGIN PASSWORD '...' IN ROLE authority_app;
ALTER ROLE authority_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- Start from nothing, for PUBLIC and for authority_app: removes whatever an
-- earlier installation granted (ALL, UPDATE, DELETE, TRUNCATE, ...).
REVOKE ALL ON TABLE authority_events, security_log, capability_issuance_idempotency FROM PUBLIC, authority_app;
REVOKE ALL ON SEQUENCE security_log_id_seq FROM PUBLIC, authority_app;

GRANT USAGE ON SCHEMA public TO authority_app;
-- SELECT: the read paths and the full-history rebuild done on every append.
-- INSERT: events, rejected drafts, and idempotency records. Nothing else:
-- INSERT ... ON CONFLICT DO UPDATE and SELECT ... FOR UPDATE also need
-- UPDATE, so they are refused too.
GRANT SELECT, INSERT ON TABLE authority_events, security_log, capability_issuance_idempotency TO authority_app;
-- security_log.id is BIGSERIAL: inserting calls nextval on its sequence.
GRANT USAGE ON SEQUENCE security_log_id_seq TO authority_app;

-- Refuse a boundary that a REVOKE cannot enforce.
DO $$
DECLARE
  journal_tables CONSTANT text[] := ARRAY['authority_events', 'security_log', 'capability_issuance_idempotency'];
  t text;
  p text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authority_app' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'authority_app must not be a superuser or bypass row security';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
    WHERE r.rolname = 'authority_app'
  ) THEN
    RAISE EXCEPTION 'authority_app must not be a member of any other role: it would inherit privileges this file cannot see';
  END IF;
  FOREACH t IN ARRAY journal_tables LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_roles o ON o.oid = c.relowner
      WHERE c.oid = to_regclass(t) AND pg_has_role('authority_app', o.oid, 'USAGE')
    ) THEN
      RAISE EXCEPTION 'authority_app owns, or inherits ownership of, table %: a REVOKE is not a boundary against an owner; transfer ownership to the migration role', t;
    END IF;
    FOREACH p IN ARRAY ARRAY['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege('authority_app', t, p) THEN
        RAISE EXCEPTION 'authority_app still holds % on table %', p, t;
      END IF;
    END LOOP;
    IF has_any_column_privilege('authority_app', t, 'UPDATE') THEN
      RAISE EXCEPTION 'authority_app still holds a column-level UPDATE on table %', t;
    END IF;
  END LOOP;
END
$$;
