# PostgreSQL transactions: explicit READ COMMITTED, and a lost connection never reaches the process

## Why the isolation level has to be explicit
Every writer (`append`, `issue`, redemption) does: `BEGIN` → `pg_advisory_xact_lock` → **one** read of the journal → decide → insert → `COMMIT`. The argument that the decision is taken on a journal state that actually
existed, including everything committed before the lock was granted, needs the read to get a snapshot **of its own, after the wait**. That is what READ COMMITTED does (each statement has its own snapshot).
A bare `BEGIN` inherits `default_transaction_isolation` of the session / role / database. In REPEATABLE READ or SERIALIZABLE the snapshot is taken by the **first statement of the transaction**, which is the lock
statement itself, i.e. *before* the wait ends: the read that follows sees the journal as it was before the writers we waited for.

Measured on a pool whose sessions default to REPEATABLE READ (a writer waits for the lock while another writer commits an event; the code of `main` before this change):

| what was committed during the wait | READ COMMITTED (intended) | bare `BEGIN` under REPEATABLE READ |
|---|---|---|
| a revocation (call needing a decision that writes) | `DENIED` (C12) | `UNAVAILABLE` — the stale decision cannot be written: the insert collides on the primary key of `sequence` |
| an approval request (the waiting writer grants the approval) | `RECORDED` | `UNAVAILABLE` (same collision) |
| a revocation, redemption waiting | `REFUSED AUTHORITY_NO_LONGER_VALID` | `REFUSED CONCURRENT_WRITE_DETECTED` |
| a mixed batch of 17 concurrent calls (10 `authorize`, 4 `record`, 3 `redeem`) | 10 authorized, 4 recorded, 1 redeemed, 2 refused | **10 of 17 `UNAVAILABLE`** (3 runs: 10, 10, 10; 1 `authorize` out of 10 succeeds) |
| (a **refusal** that writes nothing, answered after the wait; shown on the D1 prototype) | fresh answer | **stale answer, no error** |

So the primary key on `sequence` already prevented any stale decision from being *committed*; what was lost under a non-default isolation was availability, and — for decisions that write nothing — freshness, silently.

## The change
`beginReadCommitted(client)` (`BEGIN ISOLATION LEVEL READ COMMITTED`) opens the three transactions (`PostgresEventStore.append`, `PostgresCapabilityIssuanceTransaction.issue`,
`PostgresCapabilityRedemptionTransaction.redeem`). An explicit level overrides the session default. No other behaviour changes; no SQL schema change.

## A defect the interrupted-transaction tests found (same area)
When a pooled connection dies *inside* a transaction (server restart, failover, `pg_terminate_backend`), node-postgres emits `error` on the checked-out **client**. `redeem()` listened for it and destroyed
the client; `append()` and `issue()` did not, so with no listener the event is an **uncaught exception — in a host process without a global handler, a crash**. Measured: 2 uncaught exceptions per interrupted
`append()` and per interrupted `issue()` on `main`, 0 after the change. `append()` and `issue()` now do what `redeem()` did (`watchClient`, `safeRollback`, release with `destroy`), and their `ROLLBACK` can no
longer replace the original failure. The result seen by the caller is unchanged (`UNAVAILABLE`, `BACKEND_ERROR`).

## Evidence
`tests/storage/postgresIsolation.test.ts` (11 tests, PostgreSQL, pool defaulting to REPEATABLE READ): the harness really forces REPEATABLE READ for a bare `BEGIN`; every `BEGIN` the stores issue is explicit and
`SHOW transaction_isolation` inside them says `read committed`; append waiting behind an approval request / behind another writer; issue and new-action calls waiting behind a revocation; redemption waiting behind a
revocation; concurrent redemptions of one ticket; a mixed concurrent batch; a backend terminated just before the `COMMIT` of append / issue / redemption (nothing partial, lock released, no uncaught exception, a
one-connection pool recovers). Against the code of `main` 8 of the first 10 tests fail. `scripts/isolation-mutation-check.sh`: 6 mutants (bare `BEGIN` in each store, wrong level, no client listener in append or issue), all killed.
The tests stop only THEIR OWN backend (`pg_backend_pid`): the test files share one database and run in parallel.

## Limits
* The decision still rests on the advisory lock; a writer that bypasses it is outside the guarantee (the primary key keeps it from corrupting a decision, it can only make the call fail).
* `statement_timeout` / `lock_timeout` are not set by the code: a transaction blocked behind a stuck lock holder waits. Operators can set them per role.
* Connection poolers in transaction-pooling mode are compatible (the lock is a transaction-level advisory lock); session-level poolers are untested.
