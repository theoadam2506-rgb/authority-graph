# I32 compatibility note, and the procedures around it

> Status: experimental. Nothing here deletes, rewrites or migrates a real journal.
> Every procedure below is read-only until the step that says otherwise, and that
> step is yours to decide. Decision D36 ([`DECISIONS.md`](./DECISIONS.md)),
> invariant I32 (`SPEC.md`).

## 1. What changes

Before I32 the engine allowed several tickets (`CAPABILITY_ISSUED`) for one action.
Since I32 an action holds **at most one ticket, definitively**: an expired, redeemed
or burned ticket does not free it, and a new action is required. Four layers enforce
it: the issuance kernel, ingestion (so journal **replay** too), the issuance
transactions, and a PostgreSQL unique index.

What this means for data:

| Your data | Effect of I32 |
|---|---|
| A new installation | Nothing to do. |
| An existing journal where every action has at most one ticket | Compatible. Re-apply `src/storage/schema.sql` to add the index (section 5). |
| An existing journal where some action has **two or more** tickets | **Incompatible.** `schema.sql` refuses (and lists the actions); the journal no longer replays under I32 (`REPLAY_REJECTED` at the second ticket, so L3 verification fails). |
| Attestations over such a journal | L0 and L1 still pass; **L3 fails**. |
| The old published proof vectors | Incompatible (section 2). Replaced. |

The event formats, the attestation format (`authority-attestation/v1`) and the
journal hash chain are **unchanged**. Only the data of the published test fixture
changed.

**What is known and what is not.** No release, tag or npm package exists. In the
repositories reachable when this note was written, no journal dump, export or
database other than the published vectors was found. That says nothing about
databases or exports on other machines, backups, or copies held by others. Check
yours (section 3); do not assume.

## 2. The old public vectors are replaced

The vectors published in `proof/vectors/` before I32 came from a fixture that issued
**two tickets for one action** (`act-proof`: `cap-proof-1` and `cap-proof-2`). I32
rejects that journal, so the fixture now gives its second ticket its own action
(`act-proof-2`).

| | Before I32 | After I32 |
|---|---|---|
| Fixture journal | 5 events, 2 tickets for `act-proof` | 6 events, one ticket per action |
| Heads, signatures, journals | (old) | regenerated; **all values differ**; the test key is unchanged |
| `authority proof verify` with the old files, new engine | | `REJECTED` (L0 and L1 pass, **L3 fails**) |
| `authority proof verify` with the new files, new engine | | `CONSISTENT_L3` |

Rules for anyone holding old copies: **do not mix** old vectors with the new engine
or the reverse; take the files and the engine from the same commit. To verify the
old files, use the engine from before I32 (commit `397ba8c`). The new vectors are
reproducible: `npm run proof:vectors` regenerates them byte for byte and
`npm run proof:vectors -- --check` fails if they drift. They are also verified by
two independent implementations (OpenSSL and Python) in `tests/proof/interop.test.ts`.

## 3. Read-only verification of an existing journal

None of these writes anything. Run them first; keep the output.

**A. A PostgreSQL database.** One `SELECT`, run in a session forced read-only, ideally
as an account that has `SELECT` and nothing else:

```
PGOPTIONS='-c default_transaction_read_only=on' \
  psql -X -v ON_ERROR_STOP=1 -At -F ' | ' -f src/storage/check_i32_readonly.sql "$DATABASE_URL"
```

Output (`kind | subject | detail`): one `OFFENDER` line per action that holds more
than one ticket, the totals, the state of the I32 index (`MISSING`, `INVALID`,
`NOT_UNIQUE` or `PRESENT_VALID_UNIQUE`), and a last `VERDICT | I32 | COMPATIBLE` or
`INCOMPATIBLE`. A write attempted in that same session fails
(`cannot execute ... in a read-only transaction`). Use the same search path as the
application if the tables are not in `public`.

**B. An exported journal (JSON array of events).**

```
node scripts/check-journal-i32.mjs journal.json      # or "-" for stdin
```

Exit status 0 compatible, 1 incompatible (offending actions listed), 2 when the file
cannot be read or is not a journal (it never prints a verdict in that case). It
judges ticket counts only. Equivalent with `jq`:
`jq '[.[]|select(.event_type=="CAPABILITY_ISSUED")|.payload.action_id]|group_by(.)|map(select(length>1))|length' journal.json`
(a result above 0 means incompatible).

**C. An attested journal.** `authority proof verify <attestation> --keys <keys> --journal <journal>`
reports L3 `FAIL` on a journal that tickets an action twice.

These checks see the journal you point them at. They cannot see another database,
another export or a backup you did not name.

## 4. Backup before any migration

Do this **before** the migration step, even for a compatible journal. It uses
standard PostgreSQL tools and does not touch the source.

1. **Record the state** (read-only): the check output of section 3, and a row
   fingerprint to compare later:
   ```
   psql -X -At -d "$DATABASE_URL" -c "SELECT count(*), max(sequence), md5(string_agg(event_id||':'||sequence::text, ',' ORDER BY sequence)) FROM authority_events"
   ```
2. **Dump** (`pg_dump` reads one consistent snapshot, so writers need not stop;
   stop them anyway if you want the dump to match a known point):
   ```
   pg_dump --format=custom --no-owner --file=authority-pre-i32.dump "$DATABASE_URL"
   pg_dumpall --roles-only > roles.sql        # roles are cluster-wide and not in the dump
   sha256sum authority-pre-i32.dump > authority-pre-i32.dump.sha256
   ```
3. **Prove the backup restores**, in a different database, and compare:
   ```
   createdb authority_restore_check
   pg_restore --no-owner --exit-on-error -d authority_restore_check authority-pre-i32.dump
   psql -X -At -d authority_restore_check -c "<the fingerprint query of step 1>"
   ```
   The fingerprints must be identical. A backup that was never restored is not a backup.
4. **Keep it** somewhere the application account cannot write (offline or another
   account), with the checksum, the check output and the commit of the engine that
   wrote the journal.

## 5. The migration itself (only after you decide)

Preconditions: section 3 says `COMPATIBLE`, section 4 is done, writers are stopped
or you accept a short lock.

```
psql -X -v ON_ERROR_STOP=1 --single-transaction -f src/storage/schema.sql "$DATABASE_URL"
```

- It is **idempotent**, and one transaction: on any error nothing is applied.
- If an action holds several tickets it **refuses once**, with
  `I32: cannot create authority_events_ticketed_action_id_uidx: several CAPABILITY_ISSUED rows exist for the same action: <ids>`,
  and changes nothing.
- It builds the unique index with a lock that blocks writes while it runs. For a
  large journal, build it by hand first, without blocking
  (`CREATE UNIQUE INDEX CONCURRENTLY authority_events_ticketed_action_id_uidx ON authority_events ((payload ->> 'action_id')) WHERE event_type = 'CAPABILITY_ISSUED'`)
  and then apply `schema.sql`, which accepts it. If that build fails over duplicates
  it leaves an `INVALID` index: drop it and rebuild; the check reports it and the
  issuance transaction refuses to run with it.
- **Afterwards**: repeat section 3A (`PRESENT_VALID_UNIQUE`, `COMPATIBLE`) and compare
  the fingerprint of section 4 step 1: the rows must be unchanged.

**Rollback.** Either drop the index (`DROP INDEX authority_events_ticketed_action_id_uidx`;
data untouched, and the issuance transaction then refuses to run until the index
exists again) or restore the backup into a new database (section 4 step 3). Both were
dry-run on scratch databases.

## 6. If a journal is incompatible

The journal is append-only and hash-chained: **do not delete or edit the extra
ticket.** Deleting a row breaks the hash chain, every attestation over the journal
and the evidence value of everything after it. The options, in order of preference:

1. **Archive and continue.** Keep the legacy journal untouched as evidence (verify it
   with the pre-I32 engine, commit `397ba8c`), and start new traffic in a fresh
   database on the I32 schema, with new action ids. Nothing is lost and nothing is
   rewritten.
2. **Stay on the pre-I32 schema** for a legacy, read-only installation. The I32
   issuance transaction refuses to run there (fail closed); reading and explaining
   history with the pre-I32 engine keeps working.
3. **Any in-place correction** of the journal is outside this repository's
   procedures and is **not recommended**. If it is ever considered, it needs a
   separate, explicit decision by the journal's owner, a verified backup, and the
   knowledge that attestations and anchors over the old journal stop matching.

## 7. What this repository does and does not do

- It never deletes, rewrites or migrates a journal by itself: the migration is a
  statement you run, and it refuses rather than guess.
- `check_i32_readonly.sql` and `check-journal-i32.mjs` are read-only by construction
  and by test (`tests/storage/postgresTicketPerAction.test.ts`,
  `tests/scripts/check-journal-i32.test.ts`).
- It cannot inspect databases or files it is not pointed at.
