# Pack for the independent review of the PostgreSQL isolation / connection-loss fix (PR #47)

Scope: `src/storage/postgresEventStore.ts` (`beginReadCommitted`, `safeRollback`, `watchClient`, `append`), `postgresCapabilityIssuanceTransaction.ts` (`issue`), `postgresCapabilityRedemptionTransaction.ts`
(`BEGIN` only). No SPEC, public API or SQL change. Background and measurements: `PG_TRANSACTION_ISOLATION.md`.

## What to attack
1. **Is every transaction that reads the journal under the lock explicit?** `grep -rn "BEGIN" src` must show only `BEGIN_READ_COMMITTED`. Check the other stores and CLIs, the SQL files, and any caller of `pool.connect()` that opens
   a transaction by another way (`SET TRANSACTION`, savepoints).
2. **Does an explicit level really beat every configuration?** `default_transaction_isolation` (role, database, session, pool `options`) is overridden; what about a connection pooler that rewrites statements, or
   `SET SESSION CHARACTERISTICS ... READ ONLY`/`default_transaction_read_only` (a read-only default would make the writes fail — unchanged behaviour).
3. **Connection loss.** The guard attaches an `error` listener, rolls back with a rollback that cannot throw, and releases with `release(true)` when the connection broke.
   - Is there a window between `pool.connect()` and `watchClient` in which an `error` is still unhandled? (none in the code; `connect()` returns an already-connected client)
   - `release(true)` is **not** observable by the tests: node-postgres already discards a client that is no longer queryable. The guard keeps the pool correct even if a future driver version changes that. This is why there is no mutant for it.
   - Does `safeRollback` hide a *useful* error? It returns a boolean, the original failure is rethrown.
4. **The COMMIT whose acknowledgement is lost.** The caller is told `UNAVAILABLE` (append, issue) or `UNKNOWN_OUTCOME` (redemption). **The code does not know whether the transaction committed, and the tests do not claim it did not**:
   in the matrix the write is observed either way (it was committed in the runs recorded in the doc) and the retry converges to exactly one effect. Review whether the *documentation* of each result type says this precisely
   (`UNAVAILABLE` is documented as "retrying authorize is safe"; `record()` is only retry-safe when the caller supplies an explicit `eventId`, otherwise a retry creates a second event).
5. **Locks and open transactions after an interruption.** The tests count, per test schema (`application_name`), open transactions and advisory locks held after each interruption, and take the lock again within 3 s.
   A reviewer should try the cases the tests cannot reach: a server restart in the middle (not a single backend termination), a network partition (the socket stays open, no `error`), `statement_timeout` / `lock_timeout` /
   `idle_in_transaction_session_timeout` set low on the role.

## Evidence
`tests/storage/postgresIsolation.test.ts` — see the table in `PG_TRANSACTION_ISOLATION.md`; `scripts/isolation-mutation-check.sh` — 6 mutants (bare `BEGIN` in each of the three stores, wrong level, no client listener in append, in issue);
the interruption matrix covers append, issue and redemption × {before BEGIN, after BEGIN, after the lock, after the read, after the write, COMMIT sent / acknowledgement lost}.

## Known limits (not fixed here)
* A network partition that leaves the socket open produces no `error`: the call waits until the database or the OS gives up (`lock_timeout` / `statement_timeout` / TCP keep-alive are operator settings).
* `CONCURRENT_WRITE_DETECTED` / primary-key collisions remain the backstop against writers that bypass the lock.
* Session-level connection poolers (as opposed to transaction pooling) were not tested.
