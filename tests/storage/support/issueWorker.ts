/**
 * Child-process worker for tests/storage/postgresTicketPerAction.test.ts.
 * A real OS process with its own pg connections. Protocol (stdout lines):
 *   READY            connected and idle, waiting for a line on stdin
 *   RESULT <json>    the issuance outcome for the action, under this worker's own idempotency key
 * Usage: node --import tsx issueWorker.ts <schema> <action_id> <worker_number>
 */
import { createInterface } from "node:readline";
import { Pool } from "pg";
import { actionId, capabilityId, clientIdempotencyKey, iso8601 } from "../../../src/domain/types.js";
import { PostgresCapabilityIssuanceTransaction } from "../../../src/storage/postgresCapabilityIssuanceTransaction.js";
import { AGENT, EP, T, auth } from "../../redemption/harness.js";

const [schema, action, n] = process.argv.slice(2) as [string, string, string];
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 2 });
await pool.query("SELECT 1");

console.log("READY");
const rl = createInterface({ input: process.stdin });
await new Promise<void>((resolve) => rl.once("line", () => resolve()));
const outcome = await new PostgresCapabilityIssuanceTransaction(pool).issue(
  auth(AGENT),
  clientIdempotencyKey(`worker-${n}`),
  { action_id: actionId(action), enforcement_point_id: EP },
  { nextCapabilityId: () => capabilityId(`cap-worker-${n}`), expiresAt: (t) => iso8601(new Date(Date.parse(t) + 5 * 60_000).toISOString()) },
  T("09:10:00"),
);
console.log(`RESULT ${JSON.stringify(outcome)}`);
await pool.end();
process.exit(0);
