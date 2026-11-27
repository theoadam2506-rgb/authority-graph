#!/usr/bin/env node
/** D1 targeted mutations of the single-snapshot path: every mutant must be killed (scripts/mutation-runner.mjs). Needs TEST_DATABASE_URL (PostgreSQL). */
import { runMutants } from "./mutation-runner.mjs";

const SS = "src/storage/postgresSingleSnapshot.ts";
const SDK = "src/sdk/authority.ts";
/** [name, file, from, to, expected occurrences] */
const MUTANTS = [
  ["a failure commits instead of rolling back", SS, "      destroy = !(await safeRollback(client));\n      throw err;", '      await client.query("COMMIT");\n      throw err;', 1],
  ["the advisory lock is not taken", SS, "      await lockAuthorityEventsTable(client);\n", "", 1],
  ["the call's own append is not carried into the state", SS, "          state = result.state;\n", "", 1],
  ["the I32 schema check is skipped", SS, "await this.issuance.ensureSchema(client);", "", 1],
  ["the pre-check reads an empty journal", SDK, "      const snapshot = locked.journal();", "      const snapshot = [] as unknown as CanonicalStore;", 1],
  ["an action id reused with another call is accepted", SDK, "if (!sameCall(normalized, existing)) return", "if (false as boolean) return", 1],
  ["a rejected request append is ignored", SDK, "if (!outcome.accepted) return { status: \"DENIED\", reason: `ACTION_REQUEST_REJECTED:${outcome.reasonCode}` } as AuthorizeResult;", "", 1],
  ["the idempotency lookup is skipped in the single path", "src/storage/postgresCapabilityIssuanceTransaction.ts", "const existingRow = await lookupIdempotencyRow(client, authenticatedPrincipal, clientIdempotencyKey);", "const existingRow = undefined as Awaited<ReturnType<typeof lookupIdempotencyRow>>;", 1],
];

process.exit(runMutants({
  tests: ["tests/sdk/d1SingleSnapshot.test.ts"],
  env: { AUTHORITY_AUTHORIZE_SNAPSHOT: "single", D1_ROUNDS: "2" },
  mutants: MUTANTS,
}));
