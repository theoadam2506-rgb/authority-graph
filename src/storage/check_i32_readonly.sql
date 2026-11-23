-- I32 compatibility check, READ ONLY. One SELECT: it writes nothing, creates
-- nothing and takes no lock beyond the ordinary read of a snapshot.
--
-- It answers one question for an existing journal: does any action already hold
-- MORE THAN ONE CAPABILITY_ISSUED? Such a journal cannot take the I32 unique index
-- and no longer replays under I32 (see docs/v1/COMPATIBILITY_I32.md).
--
-- Run it as an account that can only read, and force a read-only session:
--   PGOPTIONS='-c default_transaction_read_only=on' \
--     psql -X -v ON_ERROR_STOP=1 -At -F ' | ' -f src/storage/check_i32_readonly.sql "$DATABASE_URL"
--
-- Output rows: kind | subject | detail. OFFENDER rows list each action holding
-- several tickets; the last row is VERDICT = COMPATIBLE or INCOMPATIBLE. It does not
-- repair anything, and nothing in this repository deletes or rewrites a journal.
WITH tickets AS (
  SELECT payload ->> 'action_id' AS action_id
    FROM authority_events
   WHERE event_type = 'CAPABILITY_ISSUED'
), per_action AS (
  SELECT action_id, count(*) AS n FROM tickets GROUP BY action_id
), offenders AS (
  SELECT action_id, n FROM per_action WHERE n > 1
), idx AS (
  SELECT i.indisvalid, i.indisunique
    FROM pg_index i
   WHERE i.indexrelid = to_regclass('authority_events_ticketed_action_id_uidx')
)
SELECT kind, subject, detail FROM (
  SELECT 1 AS ord, 'OFFENDER'::text AS kind, action_id AS subject, n::text || ' tickets' AS detail FROM offenders
  UNION ALL SELECT 2, 'TICKETS', 'CAPABILITY_ISSUED rows', (SELECT count(*) FROM tickets)::text
  UNION ALL SELECT 3, 'ACTIONS_TICKETED', 'distinct actions', (SELECT count(*) FROM per_action)::text
  UNION ALL SELECT 4, 'OFFENDING_ACTIONS', 'actions with more than one ticket', (SELECT count(*) FROM offenders)::text
  UNION ALL SELECT 5, 'I32_INDEX', 'authority_events_ticketed_action_id_uidx',
    CASE WHEN NOT EXISTS (SELECT 1 FROM idx) THEN 'MISSING'
         WHEN (SELECT NOT indisvalid FROM idx) THEN 'INVALID'
         WHEN (SELECT NOT indisunique FROM idx) THEN 'NOT_UNIQUE'
         ELSE 'PRESENT_VALID_UNIQUE' END
  UNION ALL SELECT 6, 'VERDICT', 'I32', CASE WHEN EXISTS (SELECT 1 FROM offenders) THEN 'INCOMPATIBLE' ELSE 'COMPATIBLE' END
) r
ORDER BY ord, subject;
