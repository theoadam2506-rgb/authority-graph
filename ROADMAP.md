# Roadmap

## P2A — PostgreSQL append-only boundary

**Goal.** The PostgreSQL role the application connects as can read and append
journal rows, and cannot modify or delete them.

**In scope**
- `src/storage/roles.sql`: the `authority_app` group role, with `SELECT` and
  `INSERT` only on `authority_events`, `security_log` and
  `capability_issuance_idempotency` (plus `USAGE` on `security_log`'s id
  sequence). Idempotent; revokes what earlier installations granted; refuses
  to finish when the boundary cannot hold (ownership, inherited roles).
- `src/storage/append_only_check.sql`: lists violations for the actual login role.
- An adversarial PostgreSQL test (`tests/storage/postgresAppendOnlyBoundary.test.ts`).

**Out of scope, stated plainly.** A superuser, the table owner, the database
owner and anyone controlling the infrastructure can still modify or drop the
journal. P2A is not tamper evidence: signatures, authenticated observers and
an externally anchored journal head are not part of it.

**Acceptance.** Fresh installs and re-applied existing databases end with the
application login role passing `append_only_check.sql` with no violation;
`UPDATE`, `DELETE`, `TRUNCATE`, upserts and `FOR UPDATE` on the journal tables
fail with a permission error; the stores keep working through that role.

## Later P2 milestones

Not defined yet. Nothing beyond P2A is planned or implied by this file.
