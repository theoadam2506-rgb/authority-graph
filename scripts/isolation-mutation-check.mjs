#!/usr/bin/env node
/** Targeted mutations of the explicit READ COMMITTED and of the broken-connection guard: every mutant must be killed (scripts/mutation-runner.mjs). Needs PostgreSQL (TEST_DATABASE_URL). */
import { runMutants } from "./mutation-runner.mjs";

const ES = "src/storage/postgresEventStore.ts";
const IS = "src/storage/postgresCapabilityIssuanceTransaction.ts";
const RS = "src/storage/postgresCapabilityRedemptionTransaction.ts";
/** [name, file, from, to, expected occurrences] */
const MUTANTS = [
  ["append opens a bare BEGIN", ES, "      await beginReadCommitted(client);\n      await lockAuthorityEventsTable(client);", '      await client.query("BEGIN");\n      await lockAuthorityEventsTable(client);', 1],
  ["issue opens a bare BEGIN", IS, "await beginReadCommitted(client);", 'await client.query("BEGIN");', 1],
  ["redemption opens a bare BEGIN", RS, "await beginReadCommitted(client);", 'await client.query("BEGIN");', 1],
  ["the explicit level is REPEATABLE READ", ES, 'BEGIN ISOLATION LEVEL READ COMMITTED"', 'BEGIN ISOLATION LEVEL REPEATABLE READ"', 1],
  ["append does not watch its client (an uncaught exception on connection loss)", ES, '  client.on("error", onError);', "", 1],
  // (not a mutant: `client.release(true)` for a broken client is also what pg-pool does by itself for a client that is no longer queryable; the one-connection test covers the recovery)
  ["issue does not watch its client", IS, "const watch = watchClient(client);", "const watch = { broken: () => false, stop: () => undefined };", 1],
];

process.exit(runMutants({
  tests: ["tests/storage/postgresIsolation.test.ts"],
  mutants: MUTANTS,
}));
