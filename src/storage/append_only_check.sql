-- authority-graph — verify the append-only boundary for a given LOGIN role
-- (P2A, see ROADMAP.md). Read-only; run as any role that can read the
-- catalogs. Parameter $1: the role name the application connects with.
--
-- It uses a positional parameter, so run it from a driver that binds $1
-- (tests/storage/postgresAppendOnlyBoundary.test.ts does) or substitute the
-- role name by hand in psql.
--
-- Returns one row per violation. An EMPTY result means: for that role,
-- as seen by Postgres right now (inherited roles included), the three journal
-- tables can be read and appended to, and can not be updated, deleted from,
-- truncated, or have their triggers/ownership changed. It says nothing about
-- superusers, the table owner or the database owner.
SELECT violation FROM (
  SELECT 'role does not exist' AS violation WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)
  UNION ALL
  SELECT 'role is a superuser, can bypass row security or can create roles'
    FROM pg_roles WHERE rolname = $1 AND (rolsuper OR rolbypassrls OR rolcreaterole)
  UNION ALL
  SELECT format('role owns, or inherits ownership of, %s', t.name)
    FROM unnest(ARRAY['authority_events', 'security_log', 'capability_issuance_idempotency']) AS t(name)
    JOIN pg_class c ON c.oid = to_regclass(t.name)
    WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AND pg_has_role($1, c.relowner, 'USAGE')
  UNION ALL
  SELECT format('role holds %s on %s', p.priv, t.name)
    FROM unnest(ARRAY['authority_events', 'security_log', 'capability_issuance_idempotency']) AS t(name)
    CROSS JOIN unnest(ARRAY['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p(priv)
    WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AND has_table_privilege($1, t.name, p.priv)
  UNION ALL
  SELECT format('role holds a column-level UPDATE on %s', t.name)
    FROM unnest(ARRAY['authority_events', 'security_log', 'capability_issuance_idempotency']) AS t(name)
    WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AND has_any_column_privilege($1, t.name, 'UPDATE')
  UNION ALL
  SELECT format('role lacks %s on %s', p.priv, t.name)
    FROM unnest(ARRAY['authority_events', 'security_log', 'capability_issuance_idempotency']) AS t(name)
    CROSS JOIN unnest(ARRAY['SELECT', 'INSERT']) AS p(priv)
    WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AND NOT has_table_privilege($1, t.name, p.priv)
  UNION ALL
  SELECT 'role lacks USAGE on sequence security_log_id_seq'
    WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AND NOT has_sequence_privilege($1, 'security_log_id_seq', 'USAGE')
) v;
