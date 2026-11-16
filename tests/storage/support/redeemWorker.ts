/**
 * Child-process worker for tests/storage/postgresRedemptionProcesses.test.ts.
 * A real OS process with its own pg connections. Protocol (stdout lines):
 *   READY            connected and idle, waiting for a line on stdin
 *   RESULT <json>    the redemption result (mode "redeem")
 *   LOCKED           holds the writer advisory lock inside an open transaction (mode "hold")
 * Usage: node --import tsx redeemWorker.ts <mode> <schema> <capability_id>
 */
import { createInterface } from "node:readline";
import { Pool } from "pg";
import { capability, capabilityId } from "../../../src/domain/types.js";
import { PostgresCapabilityRedemptionTransaction } from "../../../src/storage/postgresCapabilityRedemptionTransaction.js";
import { AGENT, EP, PARAMS, T, auth } from "../../redemption/harness.js";

const [mode, schema, id] = process.argv.slice(2) as [string, string, string];
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 2 });
await pool.query("SELECT 1");

if (mode === "hold") {
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('authority_events'))");
  console.log("LOCKED");
  await new Promise(() => undefined); // until SIGKILL
} else {
  console.log("READY");
  const rl = createInterface({ input: process.stdin });
  await new Promise<void>((resolve) => rl.once("line", () => resolve()));
  const result = await new PostgresCapabilityRedemptionTransaction(pool).redeem(
    auth(AGENT),
    { capability_id: capabilityId(id), enforcement_point_id: EP, observed_capability: capability("purchase_order", "create"), observed_parameters: PARAMS },
    T("09:12:00"),
  );
  console.log(`RESULT ${JSON.stringify(result)}`);
  await pool.end();
  process.exit(0);
}
